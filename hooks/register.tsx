import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandKonflikt, BandStand, BandZeile } from '../types'
import {
  nachholenAnfuegen,
  nochOffen,
  offenAnzeichen,
  offenDatei,
  offenKontext,
  offenLesen,
  offenSchreiben,
  punktMerken,
  punktSchliessen,
} from './offen'
import { aenderungSchreiben, auftragLesen, ausblendenBefehl, hinweisSchreiben, nutzungLesen, nutzungSchreiben, nutzungUmziehen, skillsLage } from './skills'
import type { Nutzung } from './skills'

// Steht in jedem Auftrag, den ein Master an eine Arbeits-Session schickt: `⟦dirigent:<name>@<kennung>⟧`.
// Die Kennung sagt, zu welchem Dirigenten die Session gehört; jede Session kann ihren eigenen haben.
const MARKE = '⟦dirigent'
const NAME_IN_MARKE = /⟦dirigent:([^⟧@＠]+)(?:[@＠]([0-9a-z]{8}))?⟧/
const uebergabe = (kennung: string) => `~/.claude/dirigent/uebergabe-${kennung}.md`
const marke = (kennung: string) => `⟦dirigent:<name>@${kennung}⟧`
const markeFuer = (name: string, kennung: string) => `⟦dirigent:${name}@${kennung}⟧`
const START_SESSION = 'mcp__ccd_session__start_session'

// Name einer Arbeits-Session für die Marke: der `name` von start_session, sonst aus dem Titel gebildet.
function sessionName(name: unknown, titel: unknown) {
  const roh = typeof name === 'string' && name.trim() ? name : typeof titel === 'string' ? titel : ''
  const sauber = roh
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '')
  return sauber || 'session'
}

// Merkt sich, welche Host-Id start_session für welchen Namen vergeben hat, damit Folge-Nachrichten die Marke
// bekommen, auch bevor die neue Session ihren Auftrag gelesen hat.
async function zielMerken($: EngineInterface, kennung: string, name: string, antwort: unknown) {
  try {
    const text = JSON.stringify(antwort ?? '')
    const hostId = /local_[0-9a-f-]{36}/.exec(text)?.[0]
    if (hostId) await $.store.set(`ziel:${hostId}`, { name, kennung })
  } catch {
    // Dann bekommt nur der erste Auftrag die Marke; die Session meldet sich trotzdem an.
  }
}

// Name der Arbeits-Session hinter einer `local_…`-Id, wenn sie zu diesem Master gehört.
async function zielName($: EngineInterface, kennung: string, an: unknown) {
  if (typeof an !== 'string' || !an.startsWith('local_')) return undefined
  const ziel = (await $.store.get(`ziel:${an}`)) as Rolle | undefined
  if (ziel?.kennung === kennung) return ziel.name
  for (const k of await $.store.keys()) {
    if (!k.startsWith('rolle:')) continue
    const rolle = (await $.store.get(k)) as Rolle | undefined
    if (rolle?.hostId === an && rolle.kennung === kennung) return rolle.name
  }
  return undefined
}

// `$.store` ist eine Datei für alle Sessions. Darin pro Dirigent `master:<kennung>` und pro
// Arbeits-Session `rolle:<sessionId>`. Die Kennung bleibt über ein Bereinigen (/clear) gleich,
// die Session-Id des Masters nicht.
// Die Session-Id wechselt auch, wenn die App eine Session nach einem Neustart fortsetzt. Dauerhaft ist nur die
// Host-Id der App (`local_…`); sie erkennt eine Session wieder. Im Terminal gibt es keine.
type Master = { kennung: string; sessionId: string; seit: string; projekt?: string; hostId?: string }
type Rolle = { name: string; kennung: string; hostId?: string }

// Titel der Master-Session: `🎼 <Projekt>`, höchstens 40 Zeichen Projektname, ein vorhandenes 🎼 fällt weg.
function projektName(roh: unknown) {
  const name = String(roh ?? '').replace(/🎼\uFE0F?/gu, '').replace(/\s+/g, ' ').trim()

  return name.length > 40 ? `${name.slice(0, 39).trimEnd()}…` : name
}

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

async function hostIdLesen($: EngineInterface) {
  try {
    const id = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
    return id?.startsWith('local_') ? id : undefined
  } catch {
    return undefined
  }
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
  geladen?: string[]
  zugewiesen?: string[]
  /** Die Runde endete mit einer Frage: `wartet` ist dann eine Nachricht wert, keine Karte. */
  blockiert?: boolean
}

// Was nur die Mod weiß, in einer eigenen Datei: ein Einstellungs-Hook, der die Stand-Datei mitschreibt,
// überschreibt dort jedes Feld, das er nicht kennt.
type Zusatz = { hostId?: string; pfade?: string[] }

type Eigenes = {
  schritte: Schritt[]
  notiz: string
  zustand: Zustand
  blockiert: boolean
  gemeldet: number
  auftrag: string
  zugewiesen: string[]
  geladen: { skill: string; zeit: number }[]
  /** Für diese Session-Id ist der Stand schon wiederhergestellt. */
  fuer?: string
  hostId?: string
  pfade: string[]
  zusatzGeschrieben?: string
  wartetAufFreigabe: boolean
  offenGemerkt: boolean
}

const neuesEigenes = (): Eigenes => ({
  schritte: [],
  notiz: '',
  zustand: 'fertig',
  blockiert: false,
  gemeldet: 0,
  auftrag: '',
  zugewiesen: [],
  geladen: [],
  pfade: [],
  wartetAufFreigabe: false,
  offenGemerkt: false,
})

const band = atom({ plugin: 'dirigent', key: 'band' } as const, null)

const MINUTE = 60_000
const GEPRUEFT_SICHTBAR = 30 * MINUTE
const STILL_AB = 20 * MINUTE
const VERSCHWINDET_NACH = 24 * 60 * MINUTE
const LESEFRIST = 7 * VERSCHWINDET_NACH
const HERZSCHLAG = 15_000
const ORDNER = '/.claude/dirigent/stand'
const ZUSATZ = '/.claude/dirigent/zusatz'
const GEPRUEFT = '/.claude/dirigent/geprueft'
const PFADE_MAX = 200
const LIMIT_WARNUNG = 80
// Höchstens so viele Zeilen hat das Band, Kopfzeile mitgezählt. Die App legt die Eingabespalte samt Band über das Ende
// des Chats und hält nur das Ende frei, solange der Chat mitläuft (siehe README, „Grenzen“). `maxRows` schützt davor
// nicht: Auf dem Desktop ist es immer 12. Jede Zeile weniger ist also Chat, der sichtbar bleibt.
const BAND_MAX_ZEILEN = 5

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

function zeileAus(stand: Stand, jetzt: number, geprueftAm?: number): BandZeile | undefined {
  if (stand.zustand === 'beendet') return undefined
  const alter = jetzt - stand.zuletzt

  const schritte = Array.isArray(stand.schritte) ? stand.schritte : []
  const aktiv = schritte.find(s => s.status === 'in_progress')
  const erledigt = schritte.filter(s => s.status === 'completed').length
  const prozent = schritte.length ? Math.round((100 * erledigt) / schritte.length) : null
  // Geladener Skill in Klammern; zugewiesen, aber noch nicht geladen, mit Fragezeichen.
  const geladen = stand.geladen ?? []
  const fehlt = (stand.zugewiesen ?? []).filter(s => !geladen.includes(s))
  const skill = geladen[0] ? `[${geladen[0]}]` : fehlt[0] ? `[${fehlt[0]}?]` : undefined
  const basis = { name: stand.name, zustand: stand.zustand, prozent, skill }

  if (stand.zustand === 'wartet') {
    return { ...basis, zustand: 'wartet', zeichen: '❓', text: stand.notiz || 'wartet auf dich' }
  }
  if (stand.zustand === 'fertig') {
    // Runde zu Ende, Liste aber nicht: das ist kein Fertig, sondern eine Pause.
    if (prozent !== null && prozent < 100) {
      return { ...basis, zustand: 'fertig', zeichen: '⏸️', text: stand.notiz || aktiv?.text || 'pausiert' }
    }
    // Gemeldet ist nicht geprüft: nur was der Master nach der letzten Meldung angesehen hat, ist ✅ und darf gehen.
    if (geprueftAm !== undefined && geprueftAm >= stand.zuletzt) {
      if (jetzt - geprueftAm > GEPRUEFT_SICHTBAR) return undefined
      return { ...basis, zustand: 'fertig', zeichen: '✅', text: stand.notiz || 'geprüft' }
    }
    return { ...basis, zustand: 'fertig', zeichen: '☑️', text: stand.notiz || 'fertig gemeldet' }
  }
  // Abgestürzt: niemand meldet sich mehr.
  if (alter > VERSCHWINDET_NACH) return undefined
  if (alter > STILL_AB) {
    return { ...basis, zustand: 'arbeitet', zeichen: '⚠️', vorsatz: `${Math.round(alter / MINUTE)} Min. still`, text: aktiv?.text ?? 'keine Meldung' }
  }
  return { ...basis, zustand: 'arbeitet', zeichen: '🔄', text: aktiv?.text ?? 'arbeitet' }
}

const REIHENFOLGE = ['❓', '⚠️', '🔄', '⏸️', '☑️', '✅']
// Für den Dateikonflikt zählt alles, was der Master noch nicht geprüft hat: Wer eben eine Datei überschrieben
// und sich fertig gemeldet hat, ist der gefährlichste Fall. Erst ✅ oder das Ausblenden nimmt eine Session heraus.
const UNGEPRUEFT = ['❓', '⚠️', '🔄', '⏸️', '☑️']

// Die Zeilen sind nach Dringlichkeit sortiert: Passen nicht alle ins Band, fällt das Unwichtigste in eine Sammelzeile.
function bandZeilen(zeilen: BandZeile[], platz: number) {
  if (zeilen.length <= platz) return { sichtbar: zeilen, rest: '' }
  const sichtbar = zeilen.slice(0, Math.max(platz - 1, 0))
  const uebrig = zeilen.slice(sichtbar.length)
  const zeichen = REIHENFOLGE.filter(z => uebrig.some(s => s.zeichen === z)).map(z => `${z}${uebrig.filter(s => s.zeichen === z).length}`)
  return { sichtbar, rest: `… ${sichtbar.length ? 'und ' : ''}${uebrig.length} weitere: ${zeichen.join(' ')}` }
}

function konflikteAus(sessions: { name: string; pfade: string[] }[]): BandKonflikt[] {
  const wer = new Map<string, string[]>()
  for (const session of sessions) {
    for (const pfad of session.pfade) wer.set(pfad, [...(wer.get(pfad) ?? []), session.name])
  }
  return [...wer.entries()]
    .filter(([, namen]) => namen.length > 1)
    .map(([pfad, namen]) => ({ datei: pfad.split('/').pop() ?? pfad, sessions: namen }))
    .sort((a, b) => a.datei.localeCompare(b.datei))
}

async function jsonOderNichts<T>($: EngineInterface, pfad: string) {
  try {
    if (!(await $.fs.exists(pfad))) return undefined
    return JSON.parse(await $.fs.read(pfad)) as T
  } catch {
    // Halb geschrieben oder kaputt: beim nächsten Mal.
    return undefined
  }
}

// Holt das 5-Stunden-Limit aus der Antwort von get_usage; alles andere heißt: nichts anzeigen.
function fuenfStunden(antwort: { content: unknown[]; isError: boolean }) {
  if (antwort.isError) return undefined
  const block = antwort.content.find(c => (c as { type?: string }).type === 'text') as { text?: string } | undefined
  const fenster = (JSON.parse(block?.text ?? '{}') as { plan?: { status?: string; windows?: { label?: string; percentUsed?: unknown }[] } }).plan
  if (fenster?.status !== 'ok') return undefined
  const wert = fenster.windows?.find(w => /5.?hour/i.test(w.label ?? ''))?.percentUsed
  return typeof wert === 'number' ? Math.round(wert) : undefined
}

// Höchstens einmal pro Minute und unabhängig vom Takt: eine hängende Abfrage darf das Band nicht anhalten.
async function limitHolen($: EngineInterface, takt: Takt, jetzt: number) {
  if (takt.limitAbgefragt !== undefined && jetzt - takt.limitAbgefragt < MINUTE) return
  takt.limitAbgefragt = jetzt
  try {
    takt.limit = fuenfStunden(await $.mcp.call('ccd_session_mgmt', 'get_usage', {}))
  } catch {
    takt.limit = undefined
  }
}

async function bandAktualisieren($: EngineInterface, takt: Takt, kennung: string) {
  try {
    const heim = await $.env.get('HOME')
    const ordner = `${heim}${ORDNER}`
    const jetzt = await $.clock.now()
    void limitHolen($, takt, jetzt)
    const geprueft = (await jsonOderNichts<Record<string, number>>($, `${heim}${GEPRUEFT}/${kennung}.json`)) ?? {}
    const zeilen: BandZeile[] = []
    const ungeprueft: { name: string; pfade: string[] }[] = []
    let eigenerSchritt = ''
    if (await $.fs.exists(ordner)) {
      for (const datei of await $.fs.list(ordner)) {
        if (!datei.name.startsWith(`${kennung}-`) || !datei.name.endsWith('.json') || jetzt - datei.mtimeMs > LESEFRIST) continue
        const stand = await jsonOderNichts<Stand>($, `${ordner}/${datei.name}`)
        if (!stand) continue
        if (stand.istMaster) {
          if (stand.zustand === 'arbeitet') eigenerSchritt = stand.schritte?.find(s => s.status === 'in_progress')?.text ?? ''
          continue
        }
        const sessionId = datei.name.slice(kennung.length + 1, -'.json'.length)
        const zeile = zeileAus(stand, jetzt, geprueft[sessionId])
        if (!zeile) continue
        const zusatz = await jsonOderNichts<Zusatz>($, `${heim}${ZUSATZ}/${datei.name}`)
        zeilen.push(zeile)
        if (UNGEPRUEFT.includes(zeile.zeichen) && Array.isArray(zusatz?.pfade)) ungeprueft.push({ name: stand.name, pfade: zusatz.pfade })
      }
    }
    zeilen.sort((a, b) => REIHENFOLGE.indexOf(a.zeichen) - REIHENFOLGE.indexOf(b.zeichen) || a.name.localeCompare(b.name))
    const master = (await $.store.get(`master:${kennung}`)) as Master | undefined
    const offen = nochOffen(await offenLesen($, kennung)).length
    const konflikte = konflikteAus(ungeprueft)
    const neu: BandStand = {
      eigenerSchritt,
      zeilen,
      offen,
      ...(master?.projekt ? { projekt: master.projekt } : {}),
      ...(takt.limit !== undefined ? { limit: takt.limit } : {}),
      ...(konflikte.length ? { konflikte } : {}),
    }
    const alt = await read($, band)
    if (JSON.stringify(alt) !== JSON.stringify(neu)) await update($, band, () => neu)
  } catch {
    // Das Band darf den Dirigenten nie stören; beim nächsten Takt neu.
  }
}

// Hält den einen Takt, der das Band des Masters neu liest.
type Takt = { uhr?: { cancel: () => void }; limit?: number; limitAbgefragt?: number }

async function bandStarten($: EngineInterface, takt: Takt, kennung: string) {
  takt.uhr?.cancel()
  await bandAktualisieren($, takt, kennung)
  takt.uhr = $.clock.every(3000, () => {
    void bandAktualisieren($, takt, kennung)
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
      geladen: eigenes.geladen.map(g => g.skill),
      zugewiesen: eigenes.zugewiesen,
      blockiert: eigenes.blockiert,
    }
    const heim = await $.env.get('HOME')
    await $.fs.write(`${heim}${ORDNER}/${kennung}-${sessionId}.json`, JSON.stringify(stand))

    if (eigenes.hostId === undefined) eigenes.hostId = (await hostIdLesen($)) ?? ''
    const zusatz: Zusatz = { pfade: eigenes.pfade, ...(eigenes.hostId ? { hostId: eigenes.hostId } : {}) }
    const text = JSON.stringify(zusatz)
    if (text !== eigenes.zusatzGeschrieben) {
      await $.fs.write(`${heim}${ZUSATZ}/${kennung}-${sessionId}.json`, text)
      eigenes.zusatzGeschrieben = text
    }
  } catch {
    // Melden darf die Arbeit nie aufhalten.
  }
}

// Sucht den Eintrag, den diese Session unter ihrer früheren Id hinterlassen hat: zuerst über die Host-Id im
// Eintrag; ältere Einträge haben keine und werden über ihre Zusatz-Datei erkannt. Eine fremde Host-Id zählt nie.
async function fruehererEintrag($: EngineInterface, hostId: string) {
  const heim = await $.env.get('HOME')
  const master = await alleMaster($)
  const rollen: { id: string; rolle: Rolle }[] = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith('rolle:')) continue
    const rolle = (await $.store.get(k)) as Rolle
    if (rolle && typeof rolle === 'object' && master.some(m => m.kennung === rolle.kennung)) rollen.push({ id: k.slice('rolle:'.length), rolle })
  }
  const passt = async (kennung: string, id: string) =>
    (await jsonOderNichts<Zusatz>($, `${heim}${ZUSATZ}/${kennung}-${id}.json`))?.hostId === hostId

  const direkt = master.find(m => m.hostId === hostId)
  if (direkt) return { master: direkt }
  const direkteRolle = rollen.find(r => r.rolle.hostId === hostId)
  if (direkteRolle) return direkteRolle
  for (const m of master) if (!m.hostId && (await passt(m.kennung, m.sessionId))) return { master: m }
  for (const r of rollen) if (!r.rolle.hostId && (await passt(r.rolle.kennung, r.id))) return r
  return undefined
}

// Übernimmt Stand, Zusatz, Prüfung und Protokoll der alten Id. Die alten Dateien bleiben als `beendet` und leer
// zurück: `$.fs` kann nichts löschen, und so steht die Session nicht zweimal im Band.
async function umziehen($: EngineInterface, kennung: string, alteId: string, neueId: string) {
  const heim = await $.env.get('HOME')
  const standAlt = `${heim}${ORDNER}/${kennung}-${alteId}.json`
  const standNeu = `${heim}${ORDNER}/${kennung}-${neueId}.json`
  const stand = await jsonOderNichts<Stand>($, standAlt)
  if (stand) {
    // Ein Einstellungs-Hook kann unter der neuen Id schon eine Liste geschrieben haben; sie ist dann die neuere.
    if (!(await jsonOderNichts<Stand>($, standNeu))?.schritte?.length) await $.fs.write(standNeu, JSON.stringify(stand))
    await $.fs.write(standAlt, JSON.stringify({ ...stand, zustand: 'beendet' }))
  }

  const zusatzAlt = `${heim}${ZUSATZ}/${kennung}-${alteId}.json`
  const zusatz = await jsonOderNichts<Zusatz>($, zusatzAlt)
  if (zusatz) {
    await $.fs.write(`${heim}${ZUSATZ}/${kennung}-${neueId}.json`, JSON.stringify(zusatz))
    await $.fs.write(zusatzAlt, JSON.stringify({ pfade: [] }))
  }

  const pruefPfad = `${heim}${GEPRUEFT}/${kennung}.json`
  const geprueft = await jsonOderNichts<Record<string, number>>($, pruefPfad)
  if (geprueft?.[alteId] !== undefined) {
    geprueft[neueId] = geprueft[alteId]
    delete geprueft[alteId]
    await $.fs.write(pruefPfad, JSON.stringify(geprueft))
  }

  await nutzungUmziehen($, alteId, neueId)
}

// Erkennt diese Session über die Host-Id wieder, wenn ihre Session-Id keinen Eintrag mehr hat, und zieht alles
// unter die neue Id um. Danach läuft sie weiter, als wäre nichts gewesen. Ohne Host-Id geschieht nichts.
async function wiedererkennen($: EngineInterface, sessionId: string) {
  try {
    const hostId = await hostIdLesen($)
    if (!hostId) return undefined
    const master = await meinMaster($, sessionId)
    if (master) {
      if (master.hostId !== hostId) await $.store.set(`master:${master.kennung}`, { ...master, hostId } satisfies Master)
      return undefined
    }
    const rolle = (await $.store.get(`rolle:${sessionId}`)) as Rolle | undefined
    if (rolle) {
      if (rolle.hostId !== hostId) await $.store.set(`rolle:${sessionId}`, { ...rolle, hostId } satisfies Rolle)
      return undefined
    }

    const frueher = await fruehererEintrag($, hostId)
    if (!frueher) return undefined
    if ('master' in frueher && frueher.master) {
      await umziehen($, frueher.master.kennung, frueher.master.sessionId, sessionId)
      const neu: Master = { ...frueher.master, sessionId, hostId }
      await $.store.set(`master:${neu.kennung}`, neu)
      return neu
    }
    if ('rolle' in frueher && frueher.rolle) {
      await umziehen($, frueher.rolle.kennung, frueher.id, sessionId)
      await $.store.set(`rolle:${sessionId}`, { ...frueher.rolle, hostId } satisfies Rolle)
      await $.store.delete(`rolle:${frueher.id}`)
    }
    return undefined
  } catch {
    // Dann bleibt die Session unerkannt, arbeitet aber ungestört.
    return undefined
  }
}

// Nimmt den eigenen Stand nach einem Neustart oder Neuladen wieder auf. Die Session-Id steckt im Dateinamen:
// eine neue Session (auch nach /clear) findet nichts. Was gerade lief, läuft jetzt nicht mehr.
async function wiederherstellen($: EngineInterface, eigenes: Eigenes, sessionId: string) {
  eigenes.fuer = sessionId
  try {
    const nutzung = await nutzungLesen($, sessionId).catch(() => undefined)
    if (nutzung) {
      if (Array.isArray(nutzung.geladen)) eigenes.geladen = nutzung.geladen
      if (Array.isArray(nutzung.zugewiesen)) eigenes.zugewiesen = nutzung.zugewiesen
      if (typeof nutzung.auftrag === 'string') eigenes.auftrag = nutzung.auftrag
    }

    const master = await meinMaster($, sessionId)
    const rolle = (await $.store.get(`rolle:${sessionId}`)) as Rolle | undefined
    const kennung = master?.kennung ?? rolle?.kennung
    if (!kennung) return
    const heim = await $.env.get('HOME')
    const stand = await jsonOderNichts<Stand>($, `${heim}${ORDNER}/${kennung}-${sessionId}.json`)
    const zusatz = await jsonOderNichts<Zusatz>($, `${heim}${ZUSATZ}/${kennung}-${sessionId}.json`)
    if (Array.isArray(zusatz?.pfade)) eigenes.pfade = zusatz.pfade
    if (!stand) return

    if (Array.isArray(stand.schritte)) eigenes.schritte = stand.schritte
    if (typeof stand.notiz === 'string') eigenes.notiz = stand.notiz
    if (eigenes.geladen.length === 0 && Array.isArray(stand.geladen)) {
      eigenes.geladen = stand.geladen.map(skill => ({ skill, zeit: stand.zuletzt }))
    }
    if (eigenes.zugewiesen.length === 0 && Array.isArray(stand.zugewiesen)) eigenes.zugewiesen = stand.zugewiesen
    eigenes.blockiert = stand.blockiert === true
    eigenes.zustand = eigenes.blockiert ? 'wartet' : 'fertig'
    // Unverändert nicht schreiben: `zuletzt` bliebe sonst nicht die Zeit der letzten Meldung, und ✅ fiele auf ☑️ zurück.
    if (stand.zustand !== eigenes.zustand) await melden($, eigenes)
  } catch {
    // Dann beginnt die Session eben leer.
  }
}

// Setzt ✅ für die laufenden Stände mit diesem Namen. Eine Datei je Master; außer ihm ändert sie nur `umziehen`.
async function geprueftSetzen($: EngineInterface, takt: Takt, kennung: string, name: string) {
  const heim = await $.env.get('HOME')
  const ordner = `${heim}${ORDNER}`
  const jetzt = await $.clock.now()
  const pfad = `${heim}${GEPRUEFT}/${kennung}.json`
  const geprueft = (await jsonOderNichts<Record<string, number>>($, pfad)) ?? {}
  const namen: string[] = []
  const treffer: string[] = []
  let nochNicht: BandZeile | undefined
  for (const datei of (await $.fs.exists(ordner)) ? await $.fs.list(ordner) : []) {
    if (!datei.name.startsWith(`${kennung}-`) || !datei.name.endsWith('.json') || jetzt - datei.mtimeMs > LESEFRIST) continue
    const stand = await jsonOderNichts<Stand>($, `${ordner}/${datei.name}`)
    if (!stand || stand.istMaster) continue
    const zeile = zeileAus(stand, jetzt)
    if (!zeile) continue
    namen.push(stand.name)
    if (stand.name !== name) continue
    if (zeile.zeichen === '☑️') treffer.push(datei.name.slice(kennung.length + 1, -'.json'.length))
    else nochNicht = zeile
  }
  if (treffer.length === 0) {
    if (nochNicht) return `${name} ist noch nicht fertig gemeldet (${nochNicht.zeichen} ${nochNicht.text}); nichts geändert.`
    return `Keine Session „${name}“ ist fertig gemeldet. Im Band stehen: ${namen.join(', ') || 'keine'}.`
  }
  for (const sessionId of treffer) geprueft[sessionId] = jetzt
  for (const [id, zeit] of Object.entries(geprueft)) if (jetzt - zeit > LESEFRIST) delete geprueft[id]
  await $.fs.write(pfad, JSON.stringify(geprueft))
  await bandAktualisieren($, takt, kennung)
  return `${name} ist geprüft (✅) und verschwindet nach 30 Minuten aus dem Band.`
}

// Kurzfassung der offenen Punkte für eine Nachricht; die Erinnerung ans Nachholen gilt genau einmal.
async function offenFuerNachricht($: EngineInterface, kennung: string) {
  const datei = await offenLesen($, kennung)
  const kontext = offenKontext(datei, kennung)
  if (datei.nachholen.length > 0 && datei.defekt === undefined) await offenSchreiben($, kennung, { ...datei, nachholen: [] })
  return kontext
}

// Prüft am Ende einer Master-Runde, ob die Antwort etwas Offenes anspricht. Trägt nie selbst etwas ein.
async function netzPruefen($: EngineInterface, kennung: string, antwort: string) {
  const stelle = offenAnzeichen(antwort)
  if (!stelle) return
  const datei = await offenLesen($, kennung)
  nachholenAnfuegen(datei, stelle)
  await offenSchreiben($, kennung, datei)
}

const geaenderterPfad = (werkzeug: string, ein: Record<string, unknown>) => {
  const pfad = werkzeug === 'Write' || werkzeug === 'Edit' ? ein.file_path : werkzeug === 'NotebookEdit' ? ein.notebook_path : undefined
  return typeof pfad === 'string' && pfad.startsWith('/') ? pfad : undefined
}

// Merkt, welche Datei diese Session geändert hat. Ein abgelehnter Aufruf hat nichts geändert.
async function pfadMerken($: EngineInterface, eigenes: Eigenes, werkzeug: string, ein: Record<string, unknown>, antwort: unknown) {
  const pfad = geaenderterPfad(werkzeug, ein)
  const ergebnis = antwort as { deny?: unknown; isError?: unknown } | undefined
  if (!pfad || ergebnis?.deny || ergebnis?.isError || eigenes.pfade.includes(pfad)) return
  eigenes.pfade = [...eigenes.pfade, pfad].slice(-PFADE_MAX)
  await melden($, eigenes)
}

// Schreibt das Skill-Protokoll dieser Session. Sessions ohne Dirigent zählen nur, wenn sie einen Skill geladen haben.
async function protokollieren($: EngineInterface, eigenes: Eigenes) {
  try {
    const sessionId = await $.session.id()
    const master = await meinMaster($, sessionId)
    const rolle = (await $.store.get(`rolle:${sessionId}`)) as Rolle | undefined
    const kennung = master?.kennung ?? rolle?.kennung ?? null
    if (!kennung && eigenes.geladen.length === 0) return

    const offen = eigenes.schritte.some(s => s.status !== 'completed')
    const ergebnis: Nutzung['ergebnis'] = eigenes.zustand === 'arbeitet' ? 'laeuft' : offen ? 'pausiert' : 'fertig'
    await nutzungSchreiben($, {
      sessionId,
      kennung,
      name: master ? 'Dirigent' : (rolle?.name ?? null),
      auftrag: eigenes.auftrag,
      zugewiesen: eigenes.zugewiesen,
      geladen: eigenes.geladen,
      ergebnis,
      zuletzt: await $.clock.now(),
    })
  } catch {
    // Das Protokoll darf die Arbeit nie aufhalten.
  }
}

// Meldet die Werkzeuge der Mod an und bringt alte Einträge in `$.store` in das heutige Format.
async function startVorbereiten($: EngineInterface) {
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

  await $.tool.register({
    name: 'master_benennen',
    description:
      'Dirigent: benennt diese Master-Session nach dem übergeordneten Projekt (Titel „🎼 <Projekt>“, Band-Kopfzeile). Nur für Master.',
    inputSchema: {
      type: 'object',
      properties: { projekt: { type: 'string', description: 'Name des übergeordneten Projekts, höchstens 40 Zeichen' } },
      required: ['projekt'],
    },
  })
  await $.tool.register({
    name: 'skills_lage',
    description:
      'Dirigent: listet alle Skills mit Nutzung und Erfolg, Aufträge ohne Skill, offene Hinweise und Kandidaten zum Aufräumen. Vor dem Zuweisen von Skills aufrufen.',
  })
  await $.tool.register({
    name: 'skill_hinweis',
    description:
      'Dirigent: merkt sich, was an einem Skill fehlte oder falsch war, aus der Rückmeldung einer Session oder einer Korrektur des Nutzers. Ändert den Skill nicht.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Name des Skills' },
        art: { type: 'string', enum: ['korrektur', 'fehler', 'luecke'] },
        text: { type: 'string', description: 'Ein Satz: was fehlte oder falsch war' },
      },
      required: ['skill', 'art', 'text'],
    },
  })
  await $.tool.register({
    name: 'skills_ausblenden',
    description:
      'Dirigent: baut den Befehl, mit dem der Nutzer selten genutzte Skills selbst ausblenden kann. Ändert nichts und führt nichts aus.',
    inputSchema: {
      type: 'object',
      properties: { skills: { type: 'array', items: { type: 'string' } } },
      required: ['skills'],
    },
  })
  await $.tool.register({
    name: 'offen_merken',
    description:
      'Dirigent: hält einen offenen Punkt aus dem Chat fest, damit er nicht verloren geht: eigener Vorschlag, unbeantwortete Frage, Zurückgestelltes, offene Frage aus einer Schlussmeldung. Nur für Master.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Der Punkt in einem Satz, ohne den Chat verständlich' },
        art: { type: 'string', enum: ['idee', 'frage', 'aufgabe', 'entscheidung'] },
        quelle: { type: 'string', description: '„chat“ oder der Name der Session, aus deren Meldung der Punkt stammt' },
      },
      required: ['text', 'art'],
    },
  })
  await $.tool.register({
    name: 'offen_erledigen',
    description:
      'Dirigent: schließt einen offenen Punkt. Nur mit Beleg (erledigt) oder auf das Wort des Nutzers (verworfen). Nur für Master.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id des Punkts, zum Beispiel p3' },
        status: { type: 'string', enum: ['erledigt', 'verworfen'], description: 'Ohne Angabe: erledigt' },
        grund: { type: 'string', description: 'Der Beleg (Datei, Commit, Ergebnis) oder die Worte des Nutzers' },
      },
      required: ['id', 'grund'],
    },
  })
  await $.tool.register({
    name: 'offen_liste',
    description: 'Dirigent: listet die offenen Punkte dieses Masters, mit alle: true auch die geschlossenen samt Grund. Nur für Master.',
    inputSchema: { type: 'object', properties: { alle: { type: 'boolean' } } },
  })
  await $.tool.register({
    name: 'session_geprueft',
    description:
      'Dirigent: markiert eine fertig gemeldete Session (☑️) als geprüft (✅). Erst aufrufen, nachdem du ihr Ergebnis selbst angesehen hast. Nur für Master.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Name der Session, wie ihn das Band zeigt' } },
      required: ['session'],
    },
  })
  await $.tool.register({
    name: 'skill_aenderung',
    description:
      'Dirigent: merkt sich, dass ein Skill auf das Wort des Nutzers geändert wurde (Skill, Datum, Sicherungsordner), damit skills_lage die Wirkung vergleichen kann. Ändert selbst nichts.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Name des Skills' },
        sicherung: { type: 'string', description: 'Ordner mit dem Stand vor der Änderung' },
        datum: { type: 'string', description: 'ISO-Datum der Änderung; ohne Angabe: jetzt' },
      },
      required: ['skill', 'sicherung'],
    },
  })
}

export const register: Register = on => {
  // Session-Id des Masters vor einem /clear. Danach läuft der Prozess unter einer neuen Id weiter.
  let vorDemBereinigen: string | undefined
  // Hat der Master in diesem Prozess den Skill dirigent geladen oder schon einmal daran erinnert bekommen?
  // `eigenes.geladen` taugt dafür nicht: Es kommt nach einem Neustart aus dem alten Stand zurück.
  let skillErinnert = false
  const takt: Takt = {}
  const eigenes = neuesEigenes()

  on('session.start', async ($, e, next) => {
    try {
      await startVorbereiten($)
    } catch {
      // Ohne Werkzeuge bleibt die Session eine gewöhnliche Session.
    }

    const sessionId = await $.session.id()
    await wiedererkennen($, sessionId)
    await wiederherstellen($, eigenes, sessionId)
    const master = await meinMaster($, sessionId)
    if (master) {
      $.ui.status('Dirigent · Master')
      await bandStarten($, takt, master.kennung)
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__dirigent__master_werden' }, async $ => {
    const sessionId = await $.session.id()
    // Fortgesetzt unter neuer Id: derselbe Dirigent, keine neue Kennung.
    await wiedererkennen($, sessionId)
    const bisher = await meinMaster($, sessionId)
    const kennung = bisher?.kennung ?? sessionId.slice(0, 8)
    const hostId = await hostIdLesen($)
    await $.store.set(`master:${kennung}`, { kennung, sessionId, seit: bisher?.seit ?? new Date().toISOString(), ...(bisher?.projekt ? { projekt: bisher.projekt } : {}), ...(hostId ? { hostId } : {}) } satisfies Master)
    await $.store.delete(`rolle:${sessionId}`)
    $.ui.status('Dirigent · Master')
    await bandStarten($, takt, kennung)

    return {
      result: `Diese Session ist ${bisher ? 'weiterhin' : 'jetzt'} ein Dirigent-Master. Kennung: ${kennung}. Auftrags-Marke (genau so in jeden Auftrag und jede Folge-Nachricht): ${marke(kennung)}. Übergabe-Datei: ${uebergabe(kennung)}. Offene Punkte: ${offenDatei(kennung)}. Andere Dirigenten in anderen Sessions laufen unabhängig weiter.`,
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

    const offen = nochOffen(await offenLesen($, master.kennung).catch(() => ({ punkte: [], nachholen: [] }))).length
    const rest = offen ? ` ${offen} offene Punkte bleiben in ${offenDatei(master.kennung)}.` : ''
    return { result: `Dirigent ${master.kennung} beendet; ${frei} Arbeits-Session(s) freigegeben.${rest}` }
  })

  on('tool.call', { tool: 'mcp__dirigent__lage' }, async $ => {
    const sessionId = await $.session.id()
    const master = await meinMaster($, sessionId)
    const rolle = (await $.store.get(`rolle:${sessionId}`)) as Rolle | undefined
    const offen = master ? nochOffen(await offenLesen($, master.kennung).catch(() => ({ punkte: [], nachholen: [] }))).length : 0
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
        offenePunkte: offen,
      }),
    }
  })

  on('tool.call', { tool: 'mcp__dirigent__master_benennen' }, async ($, e) => {
    const projekt = projektName((e as unknown as { projekt?: unknown }).projekt)
    const master = await meinMaster($, await $.session.id())
    if (!master) return { result: 'Diese Session ist kein Dirigent-Master; nichts benannt.' }
    if (!projekt) return { result: 'Kein Projektname angegeben; nichts benannt.' }
    await $.store.set(`master:${master.kennung}`, { ...master, projekt } satisfies Master)
    await bandAktualisieren($, takt, master.kennung)

    const titel = `🎼 ${projekt}`
    try {
      const antwort = await $.mcp.call('ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: titel })
      if (!antwort.isError) return { result: `Titel gesetzt: ${titel}` }
    } catch {
      // Der Server ist für die Mod nicht erreichbar: der Master setzt den Titel selbst.
    }

    return { result: `Band benannt. Titel noch nicht gesetzt: set_session_title mit session_id "self" und title "${titel}" selbst aufrufen.` }
  })

  on('tool.call', { tool: 'mcp__dirigent__offen_merken' }, async ($, e) => {
    const master = await meinMaster($, await $.session.id())
    if (!master) return { result: 'Nur der Master führt offene Punkte; nichts gemerkt.' }
    const datei = await offenLesen($, master.kennung)
    const ergebnis = punktMerken(datei, e as unknown as Record<string, unknown>, await $.clock.now())
    if ('fehler' in ergebnis) return { result: ergebnis.fehler }
    if (!ergebnis.schonDa) await offenSchreiben($, master.kennung, datei)
    eigenes.offenGemerkt = true
    await bandAktualisieren($, takt, master.kennung)
    const stand = `${ergebnis.punkt.id}; offen: ${nochOffen(datei).length}.`
    const beiseite = datei.defekt === undefined ? '' : ' Die alte Datei war nicht lesbar und liegt daneben als .defekt-Datei.'
    return { result: `${ergebnis.schonDa ? 'War schon gemerkt als' : 'Gemerkt als'} ${stand}${beiseite}` }
  })

  on('tool.call', { tool: 'mcp__dirigent__offen_erledigen' }, async ($, e) => {
    const master = await meinMaster($, await $.session.id())
    if (!master) return { result: 'Nur der Master führt offene Punkte; nichts geschlossen.' }
    const datei = await offenLesen($, master.kennung)
    const ergebnis = punktSchliessen(datei, e as unknown as Record<string, unknown>, await $.clock.now())
    if ('fehler' in ergebnis) return { result: ergebnis.fehler }
    await offenSchreiben($, master.kennung, datei)
    await bandAktualisieren($, takt, master.kennung)
    return { result: `${ergebnis.punkt.id} ist ${ergebnis.punkt.status}; offen: ${nochOffen(datei).length}.` }
  })

  on('tool.call', { tool: 'mcp__dirigent__offen_liste' }, async ($, e) => {
    const master = await meinMaster($, await $.session.id())
    if (!master) return { result: 'Nur der Master führt offene Punkte.' }
    const datei = await offenLesen($, master.kennung)
    const offen = nochOffen(datei)
    const alle = (e as unknown as { alle?: unknown }).alle === true
    return {
      result: JSON.stringify({
        datei: offenDatei(master.kennung),
        anzahlOffen: offen.length,
        punkte: alle ? datei.punkte : offen,
        ...(datei.defekt === undefined ? {} : { warnung: 'Die Datei ist nicht lesbar; beim nächsten offen_merken wird sie zur Seite gelegt.' }),
      }),
    }
  })

  on('tool.call', { tool: 'mcp__dirigent__session_geprueft' }, async ($, e) => {
    const master = await meinMaster($, await $.session.id())
    if (!master) return { result: 'Nur der Master prüft Sessions; nichts geändert.' }
    const name = String((e as unknown as { session?: unknown }).session ?? '').trim()
    if (!name) return { result: 'Kein Name der Session angegeben; nichts geändert.' }
    return { result: await geprueftSetzen($, takt, master.kennung, name) }
  })

  on('tool.call', { tool: 'mcp__dirigent__skill_aenderung' }, async ($, e) => {
    const ein = e as unknown as { skill?: unknown; sicherung?: unknown; datum?: unknown }
    const skill = String(ein.skill ?? '')
    const sicherung = String(ein.sicherung ?? '').trim()
    if (!/^[\w:.-]+$/.test(skill) || !sicherung) {
      return { result: 'Nichts gemerkt: Skill-Name (nur Buchstaben, Ziffern, : . _ -) und Sicherungsordner sind nötig.' }
    }
    const heim = await $.env.get('HOME')
    if (!(await $.fs.exists(sicherung.replace(/^~(?=\/)/, heim ?? '~')))) {
      return { result: `Nichts gemerkt: Den Sicherungsordner ${sicherung} gibt es nicht. Ohne Sicherung lässt sich die Änderung nicht zurückspielen.` }
    }
    const datum = Date.parse(String(ein.datum ?? ''))
    await aenderungSchreiben($, { skill, sicherung, zeit: Number.isNaN(datum) ? await $.clock.now() : datum })

    return { result: `Änderung an ${skill} gemerkt; skills_lage vergleicht ab jetzt vorher und nachher.` }
  })

  on('tool.call', { tool: 'mcp__dirigent__skills_lage' }, async $ => ({ result: JSON.stringify(await skillsLage($)) }))

  on('tool.call', { tool: 'mcp__dirigent__skill_hinweis' }, async ($, e) => {
    const ein = e as unknown as { skill?: unknown; art?: unknown; text?: unknown }
    if (!/^[\w:.-]+$/.test(String(ein.skill ?? '')) || !String(ein.text ?? '').trim()) {
      return { result: 'Kein Hinweis gemerkt: Skill-Name (nur Buchstaben, Ziffern, : . _ -) und Text sind nötig.' }
    }
    await hinweisSchreiben($, {
      skill: String(ein.skill ?? ''),
      art: String(ein.art ?? 'fehler'),
      text: String(ein.text ?? '').slice(0, 300),
      zeit: await $.clock.now(),
    })

    return { result: 'Hinweis gemerkt; der Skill bleibt unverändert.' }
  })

  on('tool.call', { tool: 'mcp__dirigent__skills_ausblenden' }, async (_, e) => {
    return { result: JSON.stringify(ausblendenBefehl((e as unknown as { skills?: unknown }).skills)) }
  })

  on('skill.prompt', async ($, e, next) => {
    const antwort = await next(e)
    if (e.skill === 'dirigent' || e.skill.endsWith(':dirigent')) skillErinnert = true
    if (!eigenes.geladen.some(g => g.skill === e.skill)) {
      eigenes.geladen = [...eigenes.geladen, { skill: e.skill, zeit: await $.clock.now() }]
      await melden($, eigenes)
      await protokollieren($, eigenes)
    }

    return antwort
  })

  on('session.end', async ($, e, next) => {
    eigenes.zustand = 'beendet'
    eigenes.wartetAufFreigabe = false
    await melden($, eigenes)
    await protokollieren($, eigenes)
    try {
      if (e.reason === 'clear') {
        skillErinnert = false
        if (await meinMaster($, e.sessionId)) vorDemBereinigen = e.sessionId
        // Eine bereinigte Arbeits-Session gehört erst mit dem nächsten Auftrag wieder dazu; die Host-Id darf ihr
        // den alten Stand nicht zurückbringen. Erst nach dem Melden: ohne Rolle schriebe es nichts mehr.
        else await $.store.delete(`rolle:${e.sessionId}`)
      }
    } catch {
      // Dann erinnert nach dem Bereinigen niemand an die Übergabe; die Arbeit geht vor.
    }
    Object.assign(eigenes, neuesEigenes(), { hostId: eigenes.hostId, fuer: undefined, zusatzGeschrieben: undefined })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Eine Fehlfunktion der Mod darf die Nachricht nie aufhalten: alles hier, dann in jedem Fall `next`.
    const kontext: string[] = []
    try {
      const sessionId = await $.session.id()
      eigenes.wartetAufFreigabe = false

      // Master nach /clear: neue Session-Id unter derselben Kennung eintragen und an die Übergabe erinnern.
      let nachBereinigen: Master | undefined
      if (vorDemBereinigen && vorDemBereinigen !== sessionId) {
        nachBereinigen = await meinMaster($, vorDemBereinigen)
        vorDemBereinigen = undefined
      }
      if (nachBereinigen) {
        await $.store.set(`master:${nachBereinigen.kennung}`, { ...nachBereinigen, sessionId } satisfies Master)
        $.ui.status('Dirigent · Master')
        eigenes.fuer = sessionId
        eigenes.zustand = 'arbeitet'
        skillErinnert = true
        await melden($, eigenes)
        await bandStarten($, takt, nachBereinigen.kennung)
        kontext.push(
          `Du bist weiterhin die Dirigent-Master-Session mit der Kennung ${nachBereinigen.kennung} (Auftrags-Marke ${marke(nachBereinigen.kennung)}); der Chat wurde nach einer Übergabe bereinigt. Lade zuerst den Skill dirigent und lies ${uebergabe(nachBereinigen.kennung)}, dann bearbeite diese Nachricht.`,
          ...(await offenFuerNachricht($, nachBereinigen.kennung)),
        )
      } else {
        // Fortgesetzt ohne session.start: dieselbe Session nimmt ihren Stand wieder auf.
        if (eigenes.fuer !== sessionId) {
          const erkannt = await wiedererkennen($, sessionId)
          await wiederherstellen($, eigenes, sessionId)
          if (erkannt) {
            $.ui.status('Dirigent · Master')
            await bandStarten($, takt, erkannt.kennung)
          }
        }

        // Ein Auftrag eines Masters macht diese Session zu dessen Arbeits-Session; ein Master wird nie eine.
        // Was der Nutzer in einer Arbeits-Session tippt, bleibt immer in dieser Session.
        eigenes.zustand = 'arbeitet'
        eigenes.blockiert = false
        eigenes.notiz = ''
        const master = await meinMaster($, sessionId)
        if (master) {
          await melden($, eigenes)
          if (!e.isMeta && !skillErinnert) {
            skillErinnert = true
            kontext.push(
              `Du bist die Dirigent-Master-Session mit der Kennung ${master.kennung} (Auftrags-Marke ${marke(master.kennung)}). Ist der Skill dirigent in diesem Chat noch nicht geladen, lade ihn jetzt, bevor du diese Nachricht bearbeitest.`,
            )
          }
          if (!e.isMeta) kontext.push(...(await offenFuerNachricht($, master.kennung)))
        } else if (!e.text.includes(MARKE)) {
          await melden($, eigenes)
        } else {
          const treffer = NAME_IN_MARKE.exec(e.text)
          const name = treffer?.[1]?.trim()
          const alle = await alleMaster($)
          // Ohne Kennung (ältere Aufträge) nur zuordnen, wenn es genau einen Dirigenten gibt.
          const kennung = treffer?.[2] ?? (alle.length === 1 ? alle[0].kennung : undefined)
          if (name && kennung && alle.some(m => m.kennung === kennung)) {
            const hostId = await hostIdLesen($)
            await $.store.set(`rolle:${sessionId}`, { name, kennung, ...(hostId ? { hostId } : {}) } satisfies Rolle)
            $.ui.status('Dirigent · Arbeits-Session')
            const gelesen = auftragLesen(e.text)
            // Ein neuer Auftrag beginnt neu: alte Dateien sind kein Konflikt mit dem, was jetzt läuft.
            if (gelesen.auftrag && gelesen.auftrag !== eigenes.auftrag) eigenes.pfade = []
            eigenes.auftrag = gelesen.auftrag || eigenes.auftrag
            if (gelesen.zugewiesen) eigenes.zugewiesen = [...new Set(gelesen.zugewiesen)]
          }
          await melden($, eigenes)
          await protokollieren($, eigenes)
        }
      }
    } catch {
      // Die Nachricht geht auch ohne Stand und Kontext durch.
    }

    return next(kontext.length ? { ...e, context: [...(e.context ?? []), ...kontext] } : e)
  })

  // Wartet die Session auf eine Freigabe-Karte? Die Karte selbst zeichnet die App erst nach dieser Kette.
  // Ein Einstellungs-Hook kann die Frage schon beantwortet haben; dann wartet niemand.
  on('classic.PermissionRequest', async ($, e, next) => {
    const antwort = await next(e)
    if (!e.agent_id && !antwort.decision) {
      eigenes.wartetAufFreigabe = true
      eigenes.zustand = 'wartet'
      eigenes.blockiert = false
      eigenes.notiz = 'wartet auf deine Freigabe'
      await melden($, eigenes)
    }

    return antwort
  })

  // Die Marke setzt die Mod selbst: Ein Master, der den Skill nach einem Neustart nicht geladen hat, vergisst sie
  // sonst, und seine Arbeits-Sessions fehlen im Band.
  on('tool.call', { tool: START_SESSION }, async ($, e, next) => {
    const ein = e as unknown as Record<string, unknown>
    const master = await meinMaster($, await $.session.id())
    if (!master || typeof ein.prompt !== 'string') return next(e)
    const name = sessionName(ein.name, ein.title)
    const mitMarke = ein.prompt.includes(MARKE) ? ein.prompt : `${markeFuer(name, master.kennung)} ${ein.prompt}`
    const antwort = await next({ ...e, prompt: mitMarke } as typeof e)
    await zielMerken($, master.kennung, name, antwort)
    return antwort
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const ein = e as unknown as Record<string, unknown>
    if (typeof ein.message !== 'string' || ein.message.includes(MARKE)) return next(e)
    const master = await meinMaster($, await $.session.id())
    if (!master) return next(e)
    const name = await zielName($, master.kennung, ein.to)
    if (!name) return next(e)
    return next({ ...e, message: `${markeFuer(name, master.kennung)} ${ein.message}` } as typeof e)
  })

  // Aufgabenliste, Fragen und Lebenszeichen dieser Session mitschreiben.
  on('tool.call', async ($, e, next) => {
    const werkzeug = String(e.tool)
    const ein = e as unknown as Record<string, unknown>
    if (e.agentId) {
      // Auch ein Unteragent ändert die Dateien dieser Session.
      const vonAgent = await next(e)
      await pfadMerken($, eigenes, werkzeug, ein, vonAgent)
      return vonAgent
    }

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
    // Ein paralleler Aufruf hebt das Warten auf eine Karte nicht auf.
    if (!eigenes.wartetAufFreigabe && (eigenes.zustand !== 'arbeitet' || jetzt - eigenes.gemeldet > HERZSCHLAG)) {
      eigenes.zustand = 'arbeitet'
      await melden($, eigenes)
    }

    const antwort = await next(e)

    // Der Aufruf kam zurück, also ist die Karte beantwortet.
    if (eigenes.wartetAufFreigabe) {
      eigenes.wartetAufFreigabe = false
      eigenes.zustand = 'arbeitet'
      eigenes.notiz = ''
      await melden($, eigenes)
    }
    await pfadMerken($, eigenes, werkzeug, ein, antwort)

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
      eigenes.wartetAufFreigabe = false
      eigenes.zustand = eigenes.blockiert ? 'wartet' : 'fertig'
      await melden($, eigenes)
      await protokollieren($, eigenes)
      try {
        const master = await meinMaster($, await $.session.id())
        if (master && e.reason === 'answer' && !eigenes.offenGemerkt) await netzPruefen($, master.kennung, e.answer)
      } catch {
        // Das Netz ist eine Hilfe, keine Bedingung.
      }
      eigenes.offenGemerkt = false
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const stand = await read($, band)
    if (stand === null || e.props.hasSurvey) return next(e)

    // Reine Anzeige: Antworten, Stoppen und Steuern laufen über das Textfeld des Dirigenten.
    const { Box, Text } = $.ui.resolve(e)
    const breite = e.props.bodyColumns
    const mitBalken = breite >= 56
    const anzeige = (prozent: number | null | undefined) =>
      typeof prozent === 'number' ? `${mitBalken ? `${balken(prozent)} ` : ''}${prozent} %` : ''

    // Kopfzeile: Wichtiges zuerst, der Text zuletzt. So schneidet ein schmales Fenster zuerst den Text ab.
    const eigen = e.props.isWorking ? stand.eigenerSchritt || 'arbeitet' : 'bereit'
    const zahl = (z: BandZeile['zeichen']) => stand.zeilen.filter(s => s.zeichen === z).length
    const zaehler = REIHENFOLGE.filter(z => zahl(z) > 0).map(z => `${z}${zahl(z)}`).join(' ')
    const mitListe = stand.zeilen.filter(z => typeof z.prozent === 'number')
    const gesamt = mitListe.length
      ? Math.round(mitListe.reduce((summe, z) => summe + (z.prozent ?? 0), 0) / mitListe.length)
      : null
    const offen = stand.offen ?? 0
    const limit = stand.limit
    const limitHoch = limit !== undefined && limit >= LIMIT_WARNUNG
    const limitWarnung = limitHoch ? `⚠️ 5h ${limit} %` : ''
    const links = [
      `🎼 ${stand.projekt || 'Dirigent'}`,
      offen > 0 ? `📌 ${offen}` : '',
      limitWarnung,
      zaehler,
      anzeige(gesamt),
      limit !== undefined && !limitHoch && breite >= 40 ? `5h ${limit} %` : '',
    ].filter(Boolean)
    const textPlatz = Math.max(breite - links.join('  ').length - 2, 8)

    const konflikte = stand.konflikte ?? []
    const konflikt = konflikte[0]
    const konfliktText = konflikt
      ? `${konflikt.datei}${konflikte.length > 1 ? ` und ${konflikte.length - 1} weitere` : ''}`
      : ''

    const platz = Math.max(Math.min(BAND_MAX_ZEILEN, e.props.maxRows) - 1 - (konflikt ? 1 : 0), 1)
    const { sichtbar, rest } = bandZeilen(stand.zeilen, platz)

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{links[0]}</Text>
          {links.slice(1).map(teil =>
            teil === limitWarnung ? <Text bold color="warning">{`  ${teil}`}</Text> : `  ${teil}`,
          )}
          {`  ${knapp(eigen, textPlatz)}${stand.zeilen.length === 0 ? ' · keine Arbeits-Session' : ''}`}
        </Text>
        {konflikt ? (
          <Text wrap="truncate-end" bold color="warning">
            ⚠️ Dateikonflikt {konflikt.sessions.join(' + ')}: {konfliktText}
          </Text>
        ) : null}
        {sichtbar.map(z => {
          const vorn = [`${z.zeichen} ${[z.name, z.skill, anzeige(z.prozent)].filter(Boolean).join(' ')}`, z.vorsatz].filter(Boolean).join(' · ')

          return (
            <Text wrap="truncate-end" dimColor={z.zeichen === '✅'} bold={z.zeichen === '❓' || z.zeichen === '⚠️'}>
              {vorn} · {knapp(z.text, Math.max(breite - vorn.length - 5, 10))}
            </Text>
          )
        })}
        {rest ? <Text wrap="truncate-end" dimColor>{rest}</Text> : null}
      </Box>
    )
  })
}
