import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandStand, BandZeile } from '../types'

// Steht in jedem Auftrag, den ein Master an eine Arbeits-Session schickt: `⟦dirigent:<name>@<kennung>⟧`.
// Die Kennung sagt, zu welchem Dirigenten die Session gehört; jede Session kann ihren eigenen haben.
const MARKE = '⟦dirigent'
const NAME_IN_MARKE = /⟦dirigent:([^⟧@＠]+)(?:[@＠]([0-9a-z]{8}))?⟧/
const uebergabe = (kennung: string) => `~/.claude/dirigent/uebergabe-${kennung}.md`
const marke = (kennung: string) => `⟦dirigent:<name>@${kennung}⟧`

// `$.store` ist eine Datei für alle Sessions. Darin pro Dirigent `master:<kennung>` und pro
// Arbeits-Session `rolle:<sessionId>`. Die Kennung bleibt über ein Bereinigen (/clear) gleich,
// die Session-Id des Masters nicht.
type Master = { kennung: string; sessionId: string; seit: string }
type Rolle = { name: string; kennung: string }

// Hilfsfunktionen, die `$` bekommen, müssen auf oberster Ebene stehen; sonst lehnt die Engine die Mod ab.
async function alleMaster($: EngineInterface) {
  const liste: Master[] = []
  for (const k of await $.store.keys()) {
    if (k.startsWith('master:')) liste.push((await $.store.get(k)) as Master)
  }
  return liste
}

async function meinMaster($: EngineInterface, sessionId: string) {
  return (await alleMaster($)).find(m => m.sessionId === sessionId)
}

// Frühere Fassung: ein einziger globaler Master und Rollen als Text. In das neue Format übernehmen.
async function aufraeumen($: EngineInterface) {
  const alt = (await $.store.get('master')) as { sessionId: string; seit: string } | undefined
  const kennung = alt?.sessionId.slice(0, 8)
  if (alt && kennung) {
    await $.store.set(`master:${kennung}`, { kennung, sessionId: alt.sessionId, seit: alt.seit } satisfies Master)
    await $.store.delete('master')
  }
  for (const k of await $.store.keys()) {
    if (k.startsWith('herkunft:')) await $.store.delete(k)
    if (!k.startsWith('rolle:')) continue
    const wert = await $.store.get(k)
    if (typeof wert !== 'string') continue
    if (kennung) await $.store.set(k, { name: wert, kennung } satisfies Rolle)
    else await $.store.delete(k)
  }
}

// --- Band über der Texteingabe ---------------------------------------------------------------
// Jede Session des Dirigenten schreibt ihren Stand in eine eigene Datei; der Master liest alle drei Sekunden.
// Eigene Dateien statt `$.store`: viele Prozesse schreiben gleichzeitig, und der Master muss fremde
// Änderungen sofort sehen.
type Schritt = { text: string; status: string }
type Zustand = 'arbeitet' | 'wartet' | 'fertig' | 'beendet'
type Stand = {
  kennung: string
  name: string
  istMaster: boolean
  zustand: Zustand
  schritte: Schritt[]
  notiz: string
  zuletzt: number
}

type Eigenes = { schritte: Schritt[]; notiz: string; zustand: Zustand; blockiert: boolean; gemeldet: number }

const band = atom({ plugin: 'dirigent', key: 'band' } as const, null)

const MINUTE = 60_000
const FERTIG_SICHTBAR = 30 * MINUTE
const STILL_AB = 20 * MINUTE
const VERSCHWINDET_NACH = 24 * 60 * MINUTE
const HERZSCHLAG = 15_000
const ORDNER = '/.claude/dirigent/stand'

const kurz = (text: string) => {
  const zeile = text.split('\n')[0].trim()
  const satz = /^.{12,}?[.!?](?=\s|$)/.exec(zeile)?.[0] ?? zeile
  return satz.length > 140 ? `${satz.slice(0, 139)}…` : satz
}

// Wendet einen Aufruf von update_plan auf die Schritte an: items ersetzt, advance rückt vor,
// done und start zählen ab 1.
function planAnwenden(schritte: Schritt[], ein: Record<string, unknown>): Schritt[] {
  if (Array.isArray(ein.items)) {
    return ein.items.map(i => {
      const punkt = i as { content?: unknown; status?: unknown }
      return { text: String(punkt.content ?? ''), status: String(punkt.status ?? 'pending') }
    })
  }
  const neu = schritte.map(s => ({ ...s }))
  if (ein.advance === true) {
    const jetzt = neu.findIndex(s => s.status === 'in_progress')
    if (jetzt >= 0) neu[jetzt].status = 'completed'
    const danach = neu.findIndex(s => s.status === 'pending')
    if (danach >= 0) neu[danach].status = 'in_progress'
  }
  if (Array.isArray(ein.done)) {
    for (const nr of ein.done) if (neu[Number(nr) - 1]) neu[Number(nr) - 1].status = 'completed'
  }
  if (typeof ein.start === 'number' && neu[ein.start - 1]) {
    for (const s of neu) if (s.status === 'in_progress') s.status = 'pending'
    neu[ein.start - 1].status = 'in_progress'
  }
  return neu
}

// Kürzt auf das Wesentliche: Vorspann bis zum Doppelpunkt und alles nach dem ersten Satzteil fällt weg,
// der Rest wird an einer Wortgrenze abgeschnitten, wenn er nicht in die Zeile passt.
function knapp(text: string, max: number) {
  const ganz = text.trim()
  const ohneVorspann = /^[^:]{1,25}:\s+(.+)$/.exec(ganz)?.[1] ?? ganz
  const teil = ohneVorspann.split(/[.!;,](?:\s|$)|\s[–—-]\s/)[0].trim() || ohneVorspann
  if (teil.length <= max) return teil
  const schnitt = teil.slice(0, Math.max(max - 1, 1))
  const leer = schnitt.lastIndexOf(' ')
  return `${leer > max / 2 ? schnitt.slice(0, leer) : schnitt}…`
}

const balken = (prozent: number) => {
  const voll = Math.round(prozent / 20)
  return '▰'.repeat(voll) + '▱'.repeat(5 - voll)
}

function zeileAus(stand: Stand, jetzt: number): BandZeile | undefined {
  if (stand.zustand === 'beendet') return undefined
  const alter = jetzt - stand.zuletzt
  if (stand.zustand === 'fertig' && alter > FERTIG_SICHTBAR) return undefined

  const aktiv = stand.schritte.find(s => s.status === 'in_progress')
  const erledigt = stand.schritte.filter(s => s.status === 'completed').length
  const prozent = stand.schritte.length ? Math.round((100 * erledigt) / stand.schritte.length) : null
  const basis = { name: stand.name, zustand: stand.zustand, prozent }

  if (stand.zustand === 'wartet') {
    return { ...basis, zustand: 'wartet', zeichen: '❓', text: stand.notiz || 'wartet auf dich' }
  }
  if (stand.zustand === 'fertig') {
    // Runde zu Ende, Liste aber nicht: das ist kein Fertig, sondern eine Pause.
    if (prozent !== null && prozent < 100) {
      return { ...basis, zustand: 'fertig', zeichen: '⏸️', text: stand.notiz || aktiv?.text || 'pausiert' }
    }
    return { ...basis, zustand: 'fertig', zeichen: '✅', text: stand.notiz || 'fertig' }
  }
  if (alter > STILL_AB) {
    return { ...basis, zustand: 'arbeitet', zeichen: '⚠️', vorsatz: `${Math.round(alter / MINUTE)} Min. still`, text: aktiv?.text ?? 'keine Meldung' }
  }
  return { ...basis, zustand: 'arbeitet', zeichen: '🔄', text: aktiv?.text ?? 'arbeitet' }
}

const RANG: Record<BandZeile['zustand'], number> = { wartet: 0, arbeitet: 1, fertig: 2 }

async function bandAktualisieren($: EngineInterface, kennung: string) {
  try {
    const heim = await $.env.get('HOME')
    const ordner = `${heim}${ORDNER}`
    const jetzt = await $.clock.now()
    const zeilen: BandZeile[] = []
    let eigenerSchritt = ''
    if (await $.fs.exists(ordner)) {
      for (const datei of await $.fs.list(ordner)) {
        if (!datei.name.startsWith(`${kennung}-`) || jetzt - datei.mtimeMs > VERSCHWINDET_NACH) continue
        const stand = JSON.parse(await $.fs.read(`${ordner}/${datei.name}`)) as Stand
        if (stand.istMaster) {
          if (stand.zustand === 'arbeitet') eigenerSchritt = stand.schritte.find(s => s.status === 'in_progress')?.text ?? ''
          continue
        }
        const zeile = zeileAus(stand, jetzt)
        if (zeile) zeilen.push(zeile)
      }
    }
    zeilen.sort((a, b) => RANG[a.zustand] - RANG[b.zustand] || a.name.localeCompare(b.name))
    const neu: BandStand = { eigenerSchritt, zeilen }
    const alt = await read($, band)
    if (JSON.stringify(alt) !== JSON.stringify(neu)) await update($, band, () => neu)
  } catch {
    // Das Band darf den Dirigenten nie stören; beim nächsten Takt neu.
  }
}

// Hält den einen Takt, der das Band des Masters neu liest.
type Takt = { uhr?: { cancel: () => void } }

async function bandStarten($: EngineInterface, takt: Takt, kennung: string) {
  takt.uhr?.cancel()
  await bandAktualisieren($, kennung)
  takt.uhr = $.clock.every(3000, () => {
    void bandAktualisieren($, kennung)
  })
}

// Schreibt den Stand dieser Session, wenn sie zu einem Dirigenten gehört. Andere Sessions schreiben nichts.
async function melden($: EngineInterface, eigenes: Eigenes) {
  try {
    const sessionId = await $.session.id()
    const master = await meinMaster($, sessionId)
    const rolle = (await $.store.get(`rolle:${sessionId}`)) as Rolle | undefined
    const kennung = master?.kennung ?? rolle?.kennung
    if (!kennung) return

    const jetzt = await $.clock.now()
    eigenes.gemeldet = jetzt
    const stand: Stand = {
      kennung,
      name: master ? 'Dirigent' : (rolle?.name ?? 'Session'),
      istMaster: Boolean(master),
      zustand: eigenes.zustand,
      schritte: eigenes.schritte,
      notiz: eigenes.notiz,
      zuletzt: jetzt,
    }
    const heim = await $.env.get('HOME')
    await $.fs.write(`${heim}${ORDNER}/${kennung}-${sessionId}.json`, JSON.stringify(stand))
  } catch {
    // Melden darf die Arbeit nie aufhalten.
  }
}

export const register: Register = on => {
  // Session-Id des Masters vor einem /clear. Danach läuft der Prozess unter einer neuen Id weiter.
  let vorDemBereinigen: string | undefined
  const takt: Takt = {}
  const eigenes: Eigenes = { schritte: [], notiz: '', zustand: 'fertig', blockiert: false, gemeldet: 0 }

  on('session.start', async ($, e, next) => {
    await aufraeumen($)
    await $.tool.register({
      name: 'master_werden',
      description:
        'Macht diese Session zu einer Dirigent-Master-Session mit eigener Kennung; andere Dirigenten bleiben unberührt. Nur aufrufen, wenn der Skill dirigent das verlangt.',
    })
    await $.tool.register({
      name: 'master_beenden',
      description:
        'Beendet den Dirigenten dieser Session: ihre Arbeits-Sessions gehören danach zu keinem Dirigenten mehr. Nur aufrufen, wenn der Nutzer den Dirigenten beenden will.',
    })
    await $.tool.register({
      name: 'lage',
      description:
        'Dirigent: sagt, ob diese Session ein Master (mit Kennung und Auftrags-Marke) oder eine Arbeits-Session ist, und listet die Arbeits-Sessions dieses Masters.',
    })

    const sessionId = await $.session.id()
    const master = await meinMaster($, sessionId)
    if (master) {
      $.ui.status('Dirigent · Master')
      await bandStarten($, takt, master.kennung)
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__dirigent__master_werden' }, async $ => {
    const sessionId = await $.session.id()
    const bisher = await meinMaster($, sessionId)
    const kennung = bisher?.kennung ?? sessionId.slice(0, 8)
    await $.store.set(`master:${kennung}`, { kennung, sessionId, seit: bisher?.seit ?? new Date().toISOString() } satisfies Master)
    await $.store.delete(`rolle:${sessionId}`)
    $.ui.status('Dirigent · Master')
    await bandStarten($, takt, kennung)

    return {
      result: `Diese Session ist ${bisher ? 'weiterhin' : 'jetzt'} ein Dirigent-Master. Kennung: ${kennung}. Auftrags-Marke (genau so in jeden Auftrag und jede Folge-Nachricht): ${marke(kennung)}. Übergabe-Datei: ${uebergabe(kennung)}. Andere Dirigenten in anderen Sessions laufen unabhängig weiter.`,
    }
  })

  on('tool.call', { tool: 'mcp__dirigent__master_beenden' }, async $ => {
    const sessionId = await $.session.id()
    const master = await meinMaster($, sessionId)
    if (!master) return { result: 'Diese Session ist kein Dirigent-Master.' }

    await $.store.delete(`master:${master.kennung}`)
    let frei = 0
    for (const k of await $.store.keys()) {
      if (!k.startsWith('rolle:')) continue
      const rolle = (await $.store.get(k)) as Rolle
      if (rolle.kennung !== master.kennung) continue
      await $.store.delete(k)
      frei++
    }
    $.ui.status(undefined)
    takt.uhr?.cancel()
    takt.uhr = undefined
    await update($, band, () => null)

    return { result: `Dirigent ${master.kennung} beendet; ${frei} Arbeits-Session(s) freigegeben.` }
  })

  on('tool.call', { tool: 'mcp__dirigent__lage' }, async $ => {
    const sessionId = await $.session.id()
    const master = await meinMaster($, sessionId)
    const rolle = (await $.store.get(`rolle:${sessionId}`)) as Rolle | undefined
    const arbeitsSessions = []
    if (master) {
      for (const k of await $.store.keys()) {
        if (!k.startsWith('rolle:')) continue
        const r = (await $.store.get(k)) as Rolle
        if (r.kennung === master.kennung) arbeitsSessions.push({ sessionId: k.slice('rolle:'.length), name: r.name })
      }
    }

    return {
      result: JSON.stringify({
        istMaster: Boolean(master),
        kennung: master?.kennung ?? null,
        marke: master ? marke(master.kennung) : null,
        arbeitsSessionVon: rolle ?? null,
        arbeitsSessions,
      }),
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && (await meinMaster($, e.sessionId))) vorDemBereinigen = e.sessionId
    eigenes.zustand = 'beendet'
    await melden($, eigenes)
    eigenes.schritte = []
    eigenes.notiz = ''

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const sessionId = await $.session.id()

    // Master nach /clear: neue Session-Id unter derselben Kennung eintragen und an die Übergabe erinnern.
    if (vorDemBereinigen && vorDemBereinigen !== sessionId) {
      const master = await meinMaster($, vorDemBereinigen)
      vorDemBereinigen = undefined
      if (master) {
        await $.store.set(`master:${master.kennung}`, { ...master, sessionId } satisfies Master)
        $.ui.status('Dirigent · Master')
        eigenes.zustand = 'arbeitet'
        await melden($, eigenes)
        await bandStarten($, takt, master.kennung)

        return next({
          ...e,
          context: [
            ...(e.context ?? []),
            `Du bist weiterhin die Dirigent-Master-Session mit der Kennung ${master.kennung} (Auftrags-Marke ${marke(master.kennung)}); der Chat wurde nach einer Übergabe bereinigt. Lade zuerst den Skill dirigent und lies ${uebergabe(master.kennung)}, dann bearbeite diese Nachricht.`,
          ],
        })
      }
    }

    // Ein Auftrag eines Masters macht diese Session zu dessen Arbeits-Session; ein Master wird nie eine.
    // Was der Nutzer in einer Arbeits-Session tippt, bleibt immer in dieser Session.
    eigenes.zustand = 'arbeitet'
    eigenes.blockiert = false
    eigenes.notiz = ''
    if (!e.text.includes(MARKE) || (await meinMaster($, sessionId))) {
      await melden($, eigenes)
      return next(e)
    }

    const treffer = NAME_IN_MARKE.exec(e.text)
    const name = treffer?.[1]?.trim()
    const alle = await alleMaster($)
    // Ohne Kennung (ältere Aufträge) nur zuordnen, wenn es genau einen Dirigenten gibt.
    const kennung = treffer?.[2] ?? (alle.length === 1 ? alle[0].kennung : undefined)
    if (name && kennung && alle.some(m => m.kennung === kennung)) {
      await $.store.set(`rolle:${sessionId}`, { name, kennung } satisfies Rolle)
      $.ui.status('Dirigent · Arbeits-Session')
    }
    await melden($, eigenes)

    return next(e)
  })

  // Aufgabenliste, Fragen und Lebenszeichen dieser Session mitschreiben.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    const werkzeug = String(e.tool)
    const ein = e as unknown as Record<string, unknown>

    if (werkzeug === 'AskUserQuestion') {
      eigenes.zustand = 'wartet'
      eigenes.notiz = 'hat eine Frage an dich'
      await melden($, eigenes)
      const antwort = await next(e)
      eigenes.zustand = 'arbeitet'
      eigenes.notiz = ''
      await melden($, eigenes)
      return antwort
    }

    const jetzt = await $.clock.now()
    if (eigenes.zustand !== 'arbeitet' || jetzt - eigenes.gemeldet > HERZSCHLAG) {
      eigenes.zustand = 'arbeitet'
      await melden($, eigenes)
    }

    const antwort = await next(e)

    if (werkzeug.endsWith('__update_plan')) {
      eigenes.schritte = planAnwenden(eigenes.schritte, ein)
      await melden($, eigenes)
    } else if (werkzeug.endsWith('__wrap_up')) {
      eigenes.schritte = eigenes.schritte.map(s => ({ ...s, status: 'completed' }))
      eigenes.blockiert = ein.blocked === true
      const frage = typeof ein.ask === 'string' ? ein.ask : ''
      const bericht = typeof ein.recap === 'string' ? ein.recap : ''
      eigenes.notiz = kurz(eigenes.blockiert && frage ? frage : bericht)
      await melden($, eigenes)
    }

    return antwort
  })

  on('turn.complete', async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) {
      eigenes.zustand = eigenes.blockiert ? 'wartet' : 'fertig'
      await melden($, eigenes)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const stand = await read($, band)
    if (stand === null || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const breite = e.props.bodyColumns
    const mitBalken = breite >= 56
    const anzeige = (prozent: number | null | undefined) =>
      typeof prozent === 'number' ? `${mitBalken ? `${balken(prozent)} ` : ''}${prozent} %` : ''

    const eigen = e.props.isWorking ? stand.eigenerSchritt || 'arbeitet' : 'bereit'
    const zahl = (z: BandZeile['zeichen']) => stand.zeilen.filter(s => s.zeichen === z).length
    const zaehler = ['❓', '⚠️', '🔄', '⏸️', '✅'].filter(z => zahl(z) > 0).map(z => `${z}${zahl(z)}`).join(' ')
    const mitListe = stand.zeilen.filter(z => typeof z.prozent === 'number')
    const gesamt = mitListe.length
      ? Math.round(mitListe.reduce((summe, z) => summe + (z.prozent ?? 0), 0) / mitListe.length)
      : null
    const kopfRechts = [zaehler, anzeige(gesamt)].filter(Boolean).join('  ')

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>🎼 Dirigent</Text> {knapp(eigen, Math.max(breite - kopfRechts.length - 18, 8))}
          {kopfRechts ? `  ${kopfRechts}` : ''}
        </Text>
        {stand.zeilen.length === 0 ? <Text dimColor>Keine Arbeits-Session aktiv</Text> : null}
        {stand.zeilen.map(z => {
          const vorn = [`${z.zeichen} ${z.name}${anzeige(z.prozent) ? ` ${anzeige(z.prozent)}` : ''}`, z.vorsatz].filter(Boolean).join(' · ')

          return (
            <Text wrap="truncate-end" dimColor={z.zeichen === '✅'} bold={z.zeichen === '❓' || z.zeichen === '⚠️'}>
              {vorn} · {knapp(z.text, Math.max(breite - vorn.length - 5, 10))}
            </Text>
          )
        })}
      </Box>
    )
  })
}
