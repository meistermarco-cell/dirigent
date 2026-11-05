import { expect, mock, test } from 'claude-code/testing'

// Tests für offene Punkte, Stand nach Neustart, Gemeldet/Geprüft, Band als Anzeige, Dateikonflikte, Limit, Wirkung
// von Skill-Änderungen und Freigabe-Karten. Die Welt hat ein Dateisystem im Speicher: was die Mod schreibt,
// liest sie auch wieder, so wie nach einem Neustart.
const ID = 'aaaaaaaa-0000-4000-8000-000000000000'
const KENNUNG = 'aaaaaaaa'
const JETZT = 1_800_000_000_000
const MINUTE = 60_000
const BAND = {
  plugin: 'dirigent',
  component: 'AbovePrompt',
  surface: 'desktop',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const STAND = (kennung = KENNUNG, id = ID) => `/h/.claude/dirigent/stand/${kennung}-${id}.json`
const ZUSATZ = (name: string) => `/h/.claude/dirigent/zusatz/${KENNUNG}-${name}.json`
const OFFEN = `/h/.claude/dirigent/offen/${KENNUNG}.json`

type Welt = {
  dateien: Record<string, string>
  aufrufe: { server: string; tool: string; args: any }[]
  uhr: ReturnType<typeof mock.clock>
  store: Record<string, unknown>
  /** Was das Modell neben jeder Nachricht liest. */
  kontexte: (readonly string[] | undefined)[]
  sessionId: string
  /** Steht unter jedem Werkzeug-Aufruf, wie die Engine. */
  werkzeugAntwort: () => unknown
  freigabeAntwort: unknown
}

function welt(
  on: any,
  { rolle = 'master', dateien = {}, mcp, env = {} }: { rolle?: 'master' | 'arbeit' | 'frei'; dateien?: Record<string, unknown>; mcp?: (tool: string, args: any) => unknown; env?: Record<string, string> } = {},
): Welt {
  const w: Welt = {
    dateien: Object.fromEntries(Object.entries(dateien).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)])),
    aufrufe: [],
    uhr: mock.clock(on, { now: JETZT }),
    kontexte: [],
    sessionId: ID,
    werkzeugAntwort: () => ({ result: {} }),
    freigabeAntwort: {},
    store:
      rolle === 'master'
        ? { [`master:${KENNUNG}`]: { kennung: KENNUNG, sessionId: ID, seit: 'x' } }
        : rolle === 'arbeit'
          ? { [`master:${KENNUNG}`]: { kennung: KENNUNG, sessionId: 'andere', seit: 'x' }, [`rolle:${ID}`]: { name: 'bau', kennung: KENNUNG } }
          : {},
  }
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  on('tool.register', () => ({ value: {} }))
  on('session.id', () => ({ value: w.sessionId }))
  on('store.keys', () => ({ value: Object.keys(w.store) }))
  on('store.get', (_: any, e: any) => ({ value: w.store[e.key] }))
  on('store.set', (_: any, e: any) => {
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_: any, e: any) => {
    delete w.store[e.key]
    return { value: undefined }
  })
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : env[e.name] }))
  on('fs.exists', (_: any, e: any) => ({
    value: e.path in w.dateien || Object.keys(w.dateien).some(p => p.startsWith(`${e.path}/`)),
  }))
  on('fs.list', (_: any, e: any) => ({
    value: Object.keys(w.dateien)
      .filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'))
      .map(p => ({ name: p.slice(e.path.length + 1), mtimeMs: w.uhr.now() - 1000 })),
  }))
  on('fs.read', (_: any, e: any) => {
    if (!(e.path in w.dateien)) throw new Error('fehlt')
    return { value: w.dateien[e.path] }
  })
  on('fs.write', (_: any, e: any) => {
    w.dateien[e.path] = e.text
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('mcp.call', (_: any, e: any) => {
    w.aufrufe.push({ server: e.server, tool: e.tool, args: e.args })
    const antwort = mcp?.(e.tool, e.args)
    return { value: antwort ?? { content: [{ type: 'text', text: '{}' }], isError: false } }
  })
  on('tool.call', () => w.werkzeugAntwort())
  on('classic.PermissionRequest', () => w.freigabeAntwort)
  on('prompt.submit', (_: any, e: any) => {
    w.kontexte.push(e.context)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }))
  on('skill.prompt', () => ({ text: '' }))
  on('ui.render', ($e: any, e: any) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine</Text>
  })
  return w
}

const standDatei = (name: string, zustand: string, schritte: object[] = [], notiz = '', zuletzt = JETZT, extra: object = {}) => ({
  kennung: KENNUNG, name, istMaster: false, zustand, schritte, notiz, zuletzt, ...extra,
})
const FERTIG = [{ text: 'A', status: 'completed' }]
const bandText = async ($: any, props: object = {}) => {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props } })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  return { ui, text }
}
const bandLesen = async ($: any, props: object = {}) => {
  const { ui, text } = await bandText($, props)
  await ui.unmount()
  return text
}
const werkzeug = async ($: any, name: string, ein: object = {}) =>
  ((await $.tool.call({ tool: `mcp__dirigent__${name}`, ...ein } as any)) as any).result as string
const nachricht = ($: any, text: string, extra: object = {}) => $.prompt.submit({ text, ...extra } as any)
const rundenEnde = ($: any, answer: string, extra: object = {}) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra } as any)

// --- A. Offene Punkte ---

test('offen_merken und offen_erledigen führen die Datei, die Kopfzeile zählt mit', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  expect(await bandLesen($)).not.toContain('📌')

  expect(await werkzeug($, 'offen_merken', { text: 'Dark Mode prüfen', art: 'idee' })).toContain('p1')
  await werkzeug($, 'offen_merken', { text: 'Welche Farbe?', art: 'frage', quelle: 'bau' })
  expect(await bandLesen($)).toContain('📌 2')

  const datei = JSON.parse(w.dateien[OFFEN])
  expect(datei.punkte[1]).toMatchObject({ id: 'p2', text: 'Welche Farbe?', art: 'frage', quelle: 'bau', zeit: JETZT, status: 'offen' })

  expect(await werkzeug($, 'offen_erledigen', { id: 'p1', grund: '  ' })).toContain('grund fehlt')
  expect(JSON.parse(w.dateien[OFFEN]).punkte[0].status).toBe('offen')
  await werkzeug($, 'offen_erledigen', { id: 'p1', grund: 'Commit abc' })
  await werkzeug($, 'offen_erledigen', { id: 'p2', status: 'verworfen', grund: 'Nutzer: „lass das“' })
  const zu = JSON.parse(w.dateien[OFFEN]).punkte
  expect(zu[0]).toMatchObject({ status: 'erledigt', grund: 'Commit abc' })
  expect(zu[1]).toMatchObject({ status: 'verworfen' })
  expect(await bandLesen($)).not.toContain('📌')

  const liste = JSON.parse(await werkzeug($, 'offen_liste', { alle: true }))
  expect(liste.anzahlOffen).toBe(0)
  expect(liste.punkte).toHaveLength(2)
  expect(JSON.parse(await werkzeug($, 'offen_liste')).punkte).toHaveLength(0)

  // Eine Id wird nie neu vergeben, auch wenn alles geschlossen ist.
  expect(await werkzeug($, 'offen_merken', { text: 'Neu', art: 'aufgabe' })).toContain('p3')
})

test('verworfene Vorschläge kommen mit Grund nur auf Wunsch aus offen_liste, auch nach einem Neustart', async ($, on) => {
  welt(on, { dateien: { [OFFEN]: { punkte: [
    { id: 'p1', text: 'Skill foo vorschlagen', art: 'idee', quelle: 'recherche', zeit: 1, status: 'offen' },
  ] } } })
  await $.session.start(START)
  await werkzeug($, 'offen_erledigen', { id: 'p1', status: 'verworfen', grund: 'Nutzer: „brauche ich nicht“' })

  await $.session.start(START)
  expect(JSON.parse(await werkzeug($, 'offen_liste')).punkte).toEqual([])
  const [punkt] = JSON.parse(await werkzeug($, 'offen_liste', { alle: true })).punkte
  expect(punkt).toMatchObject({ id: 'p1', text: 'Skill foo vorschlagen', status: 'verworfen', grund: 'Nutzer: „brauche ich nicht“' })
})

test('derselbe Punkt wird nicht doppelt gemerkt, Unfug wird abgelehnt', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  await werkzeug($, 'offen_merken', { text: 'Dark Mode prüfen', art: 'idee' })
  expect(await werkzeug($, 'offen_merken', { text: 'dark mode prüfen', art: 'idee' })).toContain('schon')
  expect(await werkzeug($, 'offen_merken', { text: ' ', art: 'idee' })).toContain('Text fehlt')
  expect(await werkzeug($, 'offen_merken', { text: 'x', art: 'wunsch' })).toContain('art muss')
  expect(JSON.parse(w.dateien[OFFEN]).punkte).toHaveLength(1)
})

test('nur der Master schreibt offene Punkte', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit' })
  await $.session.start(START)
  expect(await werkzeug($, 'offen_merken', { text: 'x', art: 'idee' })).toContain('Nur der Master')
  expect(w.dateien[OFFEN]).toBeUndefined()
})

test('eine Arbeits-Session bekommt die Liste nicht', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit', dateien: { [OFFEN]: { punkte: [{ id: 'p1', text: 'x', art: 'idee', quelle: 'chat', zeit: 1, status: 'offen' }] } } })
  await nachricht($, 'hallo')
  expect(w.kontexte[0]).toBeUndefined()
})

test('jede Nachricht an den Master trägt die offene Liste', async ($, on) => {
  const w = welt(on, { dateien: { [OFFEN]: { punkte: [
    { id: 'p1', text: 'Dark Mode prüfen', art: 'idee', quelle: 'chat', zeit: 1, status: 'offen' },
    { id: 'p2', text: 'Schon fertig', art: 'idee', quelle: 'chat', zeit: 1, status: 'erledigt', grund: 'x' },
  ] } } })
  await nachricht($, 'hallo')
  expect(w.kontexte[0]?.join('\n')).toContain('p1 [idee] Dark Mode prüfen')
  expect(w.kontexte[0]?.join('\n')).not.toContain('Schon fertig')
})

test('ohne offene Punkte hängt die Mod keinen Kontext an', async ($, on) => {
  const w = welt(on)
  await nachricht($, 'hallo')
  expect(w.kontexte[0]).toBeUndefined()
})

test('das Netz erinnert einmal an einen Vorschlag ohne offen_merken und trägt nichts selbst ein', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  await rundenEnde($, 'Fertig. Ich empfehle, später noch die Doku zu ergänzen.')
  expect(JSON.parse(w.dateien[OFFEN]).punkte).toEqual([])

  await nachricht($, 'weiter')
  expect(w.kontexte[0]?.join('\n')).toContain('Ich empfehle')
  expect(w.kontexte[0]?.join('\n')).toContain('offen_merken')
  await nachricht($, 'noch was')
  expect(w.kontexte[1]).toBeUndefined()
})

test('das Netz schweigt, wenn offen_merken lief oder die Antwort nichts Offenes hat', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)

  await werkzeug($, 'offen_merken', { text: 'Doku', art: 'idee' })
  await rundenEnde($, 'Ich empfehle, später die Doku zu ergänzen.')
  expect(JSON.parse(w.dateien[OFFEN]).nachholen).toEqual([])

  await rundenEnde($, 'Band gebaut, 21 Tests bestehen.')
  await rundenEnde($, '📌 3 offen, noch offen ist die Doku.')
  await rundenEnde($, 'Beispiel:\n```\nspäter noch offen?\n```\nFertig.')
  expect(JSON.parse(w.dateien[OFFEN]).nachholen).toEqual([])

  // Nach einer Runde mit offen_merken zählt die nächste wieder für sich.
  await rundenEnde($, 'Soll ich auch die Tests umbauen?')
  expect(JSON.parse(w.dateien[OFFEN]).nachholen).toEqual(['Soll ich auch die Tests umbauen?'])
})

test('das Netz prüft keinen Unteragenten', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  await rundenEnde($, 'Soll ich?', { agentId: 'a1' })
  expect(w.dateien[OFFEN]).toBeUndefined()
})

test('eine Arbeits-Session schreibt auch beim Rundenende nichts in die offene Liste', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit' })
  await $.session.start(START)
  await rundenEnde($, 'Soll ich?')
  expect(w.dateien[OFFEN]).toBeUndefined()
})

test('die offene Liste übersteht /clear und eine Nachricht danach nennt sie', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  await werkzeug($, 'offen_merken', { text: 'Dark Mode prüfen', art: 'idee' })
  await $.session.end({ reason: 'clear', sessionId: ID, resume: {} } as any)
  w.sessionId = 'bbbbbbbb-neu'
  await nachricht($, 'weiter')
  const kontext = w.kontexte[0]?.join('\n')
  expect(kontext).toContain('uebergabe-aaaaaaaa')
  expect(kontext).toContain('Dark Mode prüfen')
  expect((w.store[`master:${KENNUNG}`] as any).sessionId).toBe('bbbbbbbb-neu')
})

test('eine kaputte Datei wird beiseitegelegt und nie überschrieben', async ($, on) => {
  const w = welt(on, { dateien: { [OFFEN]: '{ "punkte": [ {"id": "p1", halb' } })
  await $.session.start(START)
  expect(await bandLesen($)).toContain('🎼 Dirigent')
  expect(await werkzeug($, 'offen_merken', { text: 'Neu', art: 'idee' })).toContain('.defekt')
  const beiseite = Object.keys(w.dateien).find(p => p.includes('.defekt-')) as string
  expect(w.dateien[beiseite]).toContain('halb')
  expect(JSON.parse(w.dateien[OFFEN]).punkte).toHaveLength(1)
})

test('offene Punkte aus einer älteren Fassung ohne Felder bleiben lesbar', async ($, on) => {
  welt(on, { dateien: { [OFFEN]: { punkte: [{ id: 'p7', text: 'Alt' }, { kaputt: true }, 'nix'] } } })
  await $.session.start(START)
  expect(await bandLesen($)).toContain('📌 1')
  const liste = JSON.parse(await werkzeug($, 'offen_liste'))
  expect(liste.punkte[0]).toMatchObject({ id: 'p7', art: 'idee', quelle: 'chat', status: 'offen' })
  expect(await werkzeug($, 'offen_merken', { text: 'Neu', art: 'idee' })).toContain('p8')
})

// --- 1. Stand nach Neustart ---

test('ein Neustart stellt Liste, Skills, Auftrag und Zuweisung wieder her', async ($, on) => {
  const w = welt(on, {
    rolle: 'arbeit',
    dateien: {
      [STAND()]: standDatei('bau', 'beendet', [{ text: 'Eins', status: 'completed' }, { text: 'Zwei', status: 'in_progress' }], 'zuletzt', JETZT - 5000, { geladen: ['commit'], zugewiesen: ['commit', 'mod'] }),
      [`/h/.claude/dirigent/skills/nutzung/${ID}.json`]: {
        sessionId: ID, kennung: KENNUNG, name: 'bau', auftrag: 'Mod bauen', zugewiesen: ['commit', 'mod'],
        geladen: [{ skill: 'commit', zeit: JETZT - 9000 }], ergebnis: 'laeuft', zuletzt: JETZT - 5000,
      },
    },
  })
  await $.session.start(START)

  const stand = JSON.parse(w.dateien[STAND()])
  expect(stand.zustand).toBe('fertig')
  expect(stand.schritte.map((s: any) => s.text)).toEqual(['Eins', 'Zwei'])
  expect(stand.notiz).toBe('zuletzt')
  expect(stand.zugewiesen).toEqual(['commit', 'mod'])
  expect(stand.geladen).toEqual(['commit'])

  // Der nächste Fortschritt rechnet auf der wiederhergestellten Liste weiter.
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as any)
  expect(JSON.parse(w.dateien[STAND()]).schritte.every((s: any) => s.status === 'completed')).toBe(true)

  // Das Protokoll wird fortgesetzt statt geleert: Auftrag und Ladezeit bleiben.
  await rundenEnde($, 'Fertig.')
  const nutzung = JSON.parse(w.dateien[`/h/.claude/dirigent/skills/nutzung/${ID}.json`])
  expect(nutzung.auftrag).toBe('Mod bauen')
  expect(nutzung.geladen).toEqual([{ skill: 'commit', zeit: JETZT - 9000 }])
})

test('eine wartende Session wartet nach dem Neustart weiter', async ($, on) => {
  const w = welt(on, {
    rolle: 'arbeit',
    dateien: { [STAND()]: standDatei('bau', 'beendet', FERTIG, 'Welche Farbe?', JETZT - 5000, { blockiert: true }) },
  })
  await $.session.start(START)
  expect(JSON.parse(w.dateien[STAND()])).toMatchObject({ zustand: 'wartet', notiz: 'Welche Farbe?', blockiert: true })
})

test('ein unveränderter Stand wird beim Neuladen nicht neu geschrieben', async ($, on) => {
  const original = standDatei('bau', 'fertig', FERTIG, 'fertig', JETZT - 60_000)
  const w = welt(on, { rolle: 'arbeit', dateien: { [STAND()]: original } })
  await $.session.start(START)
  expect(JSON.parse(w.dateien[STAND()]).zuletzt).toBe(JETZT - 60_000)
})

test('eine andere Session-Id beginnt leer, auch mit einem alten Stand derselben Kennung', async ($, on) => {
  const w = welt(on, {
    rolle: 'arbeit',
    dateien: { [STAND(KENNUNG, 'andere-id')]: standDatei('bau', 'beendet', FERTIG, 'fremd') },
  })
  await $.session.start(START)
  await nachricht($, 'los')
  expect(JSON.parse(w.dateien[STAND()]).schritte).toEqual([])
  expect(JSON.parse(w.dateien[STAND()]).notiz).toBe('')
})

test('ein Stand einer älteren Fassung ohne neue Felder wird trotzdem aufgenommen', async ($, on) => {
  const w = welt(on, {
    rolle: 'arbeit',
    dateien: { [STAND()]: { kennung: KENNUNG, name: 'bau', istMaster: false, zustand: 'beendet', schritte: [{ text: 'Eins', status: 'in_progress' }], notiz: '', zuletzt: JETZT - 1 } },
  })
  await $.session.start(START)
  expect(JSON.parse(w.dateien[STAND()])).toMatchObject({ zustand: 'fertig', blockiert: false })
})

test('eine kaputte Stand-Datei hält den Start nicht auf', async ($, on) => {
  welt(on, { rolle: 'arbeit', dateien: { [STAND()]: '{ kaputt' } })
  await $.session.start(START)
  await nachricht($, 'los')
})

// --- 2. Gemeldet und geprüft ---

test('fertig gemeldet heißt ☑️ und bleibt; erst session_geprueft macht ✅, das nach 30 Minuten geht', async ($, on) => {
  const w = welt(on, { dateien: { [STAND(KENNUNG, 'eins')]: standDatei('bau', 'fertig', FERTIG, 'Band gebaut', JETZT - 3 * 3_600_000) } })
  await $.session.start(START)
  let text = await bandLesen($)
  expect(text).toContain('☑️ bau')
  expect(text).toContain('☑️1')

  expect(await werkzeug($, 'session_geprueft', { session: 'bau' })).toContain('✅')
  text = await bandLesen($)
  expect(text).toContain('✅ bau')
  expect(text).not.toContain('☑️')

  await w.uhr.advance(29 * MINUTE)
  expect(await bandLesen($)).toContain('✅ bau')
  await w.uhr.advance(2 * MINUTE)
  expect(await bandLesen($)).not.toContain('bau')
})

test('neue Arbeit nach der Prüfung hebt ✅ auf', async ($, on) => {
  const pfad = STAND(KENNUNG, 'eins')
  const w = welt(on, { dateien: { [pfad]: standDatei('bau', 'fertig', FERTIG, 'Band gebaut', JETZT - 1000) } })
  await $.session.start(START)
  await werkzeug($, 'session_geprueft', { session: 'bau' })
  await w.uhr.advance(5000)
  w.dateien[pfad] = JSON.stringify(standDatei('bau', 'fertig', FERTIG, 'Mehr gebaut', w.uhr.now()))
  await w.uhr.advance(3000)
  expect(await bandLesen($)).toContain('☑️ bau')
})

test('session_geprueft lehnt Laufendes, Pausiertes und Unbekanntes ab', async ($, on) => {
  const w = welt(on, { dateien: {
    [STAND(KENNUNG, 'a')]: standDatei('laeuft', 'arbeitet', [{ text: 'X', status: 'in_progress' }]),
    [STAND(KENNUNG, 'b')]: standDatei('pause', 'fertig', [{ text: 'X', status: 'pending' }]),
  } })
  await $.session.start(START)
  expect(await werkzeug($, 'session_geprueft', { session: 'laeuft' })).toContain('noch nicht fertig')
  expect(await werkzeug($, 'session_geprueft', { session: 'pause' })).toContain('noch nicht fertig')
  const weg = await werkzeug($, 'session_geprueft', { session: 'gibtsnicht' })
  expect(weg).toContain('laeuft')
  expect(Object.keys(w.dateien).some(p => p.includes('/geprueft/'))).toBe(false)
})

test('nur der Master darf prüfen', async ($, on) => {
  welt(on, { rolle: 'arbeit' })
  await $.session.start(START)
  expect(await werkzeug($, 'session_geprueft', { session: 'bau' })).toContain('Nur der Master')
})

test('Stand-Dateien älterer Fassungen ohne Prüfung zeigen ☑️, ein abgestürztes Arbeiten verschwindet nach einem Tag', async ($, on) => {
  welt(on, { dateien: {
    [STAND(KENNUNG, 'a')]: standDatei('alt', 'fertig', [], '', JETZT - 2 * 86_400_000),
    [STAND(KENNUNG, 'b')]: standDatei('tot', 'arbeitet', [{ text: 'X', status: 'in_progress' }], '', JETZT - 2 * 86_400_000),
  } })
  await $.session.start(START)
  const text = await bandLesen($)
  expect(text).toContain('☑️ alt')
  expect(text).not.toContain('tot')
})

// --- 3. Band als reine Anzeige ---

const mitHostId = (name: string, zustand: string, extra: object = {}, id = name) => ({
  [STAND(KENNUNG, id)]: standDatei(name, zustand, FERTIG, 'Text', JETZT, extra),
  [ZUSATZ(id)]: { hostId: `local_0000-${name}`, pfade: [] },
})
const standZeilen = async (ui: any) =>
  (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string).filter((t: string) => /^(❓|⚠️|🔄|⏸️|☑️|✅|…)/u.test(t))

test('eine Arbeits-Session schreibt ihre local-Id, außerhalb der App keine', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit', env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_abc' } })
  await $.session.start(START)
  await nachricht($, 'los')
  expect(JSON.parse(w.dateien[ZUSATZ(ID)]).hostId).toBe('local_abc')
})

test('ohne Host-Id steht auch keine in der Zusatz-Datei', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit' })
  await $.session.start(START)
  await nachricht($, 'los')
  expect(JSON.parse(w.dateien[ZUSATZ(ID)]).hostId).toBeUndefined()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`das Band hat im Fenster ${surface} keine Bedienelemente und ruft nichts auf`, async ($, on) => {
    const w = welt(on, { dateien: { ...mitHostId('frage', 'wartet', { blockiert: true }), ...mitHostId('bau', 'arbeitet') } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Input' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
    expect((await standZeilen(ui)).length).toBe(2)
    expect(w.aufrufe.filter(a => ['open_session_in', 'stop_session', 'send_message'].includes(a.tool))).toHaveLength(0)
    await ui.unmount()
  })
}

test('das Band bleibt bei vielen Sessions kompakt, das Dringendste steht oben, der Rest ist gezählt', async ($, on) => {
  const dateien = Object.assign(
    {},
    mitHostId('s-frage', 'wartet'),
    ...['a', 'b', 'c'].map(n => mitHostId(`s-${n}`, 'arbeitet')),
    ...['d', 'e'].map(n => mitHostId(`s-${n}`, 'fertig')),
  )
  welt(on, { dateien })
  await $.session.start(START)
  // Auf dem Desktop ist `maxRows` immer 12: Es darf das Band nicht größer machen.
  const ui = await $.ui.mount(BAND)
  const zeilen = await standZeilen(ui)
  expect(zeilen).toHaveLength(4)
  expect(zeilen[0]).toContain('❓ s-frage')
  expect(zeilen[3]).toBe('… und 3 weitere: 🔄1 ☑️2')
  await ui.unmount()
})

test('genau so viele Sessions wie Platz brauchen keine Sammelzeile', async ($, on) => {
  welt(on, { dateien: Object.assign({}, ...['a', 'b', 'c', 'd'].map(n => mitHostId(`s-${n}`, 'arbeitet'))) })
  await $.session.start(START)
  const ui = await $.ui.mount(BAND)
  const zeilen = await standZeilen(ui)
  expect(zeilen).toHaveLength(4)
  expect(zeilen.join('\n')).not.toContain('weitere')
  await ui.unmount()
})

test('ein kleines maxRows verkleinert das Band weiter', async ($, on) => {
  welt(on, { dateien: Object.assign({}, ...['a', 'b', 'c'].map(n => mitHostId(`s-${n}`, 'arbeitet'))) })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 2 } })
  expect(await standZeilen(ui)).toEqual(['… 3 weitere: 🔄3'])
  await ui.unmount()
})

// --- 4. Dateikonflikte ---

test('Write, Edit und NotebookEdit schreiben ihre Pfade in die Zusatz-Datei, auch von Unteragenten', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit' })
  await $.session.start(START)
  await $.tool.call({ tool: 'Write', file_path: '/p/a.ts', content: 'x' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/p/a.ts', old_string: 'x', new_string: 'y' } as any)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/p/n.ipynb' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/p/agent.ts', agentId: 'a1' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/p/nur-gelesen.ts' } as any)
  expect(JSON.parse(w.dateien[ZUSATZ(ID)]).pfade).toEqual(['/p/a.ts', '/p/n.ipynb', '/p/agent.ts'])
})

test('ein abgelehnter Aufruf zählt nicht als Änderung', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit' })
  w.werkzeugAntwort = () => ({ deny: 'nein' })
  await $.session.start(START)
  await nachricht($, 'los')
  await $.tool.call({ tool: 'Write', file_path: '/p/a.ts', content: 'x' } as any).catch(() => undefined)
  expect(JSON.parse(w.dateien[ZUSATZ(ID)]).pfade).toEqual([])
})

test('zwei laufende Sessions mit derselben Datei ergeben ⚠️ mit Datei und Namen', async ($, on) => {
  welt(on, { dateien: {
    [STAND(KENNUNG, 'a')]: standDatei('bau', 'arbeitet', [{ text: 'X', status: 'in_progress' }]),
    [ZUSATZ('a')]: { pfade: ['/p/gemeinsam.ts', '/p/a.ts'] },
    [STAND(KENNUNG, 'b')]: standDatei('text', 'wartet'),
    [ZUSATZ('b')]: { pfade: ['/p/gemeinsam.ts'] },
  } })
  await $.session.start(START)
  const text = await bandLesen($)
  expect(text).toContain('⚠️ Dateikonflikt bau + text: gemeinsam.ts')
  expect(text).not.toContain('a.ts')
})

test('A wartet, B meldet fertig: die Warnung bleibt, bis beide geprüft sind', async ($, on) => {
  const w = welt(on, { dateien: {
    [STAND(KENNUNG, 'a')]: standDatei('probe-a', 'wartet', [], 'Frage'),
    [ZUSATZ('a')]: { pfade: ['/p/gemeinsam.ts'] },
    [STAND(KENNUNG, 'b')]: standDatei('probe-b', 'arbeitet', [{ text: 'X', status: 'in_progress' }]),
    [ZUSATZ('b')]: { pfade: ['/p/gemeinsam.ts'] },
  } })
  await $.session.start(START)
  expect(await bandLesen($)).toContain('⚠️ Dateikonflikt')

  // B überschreibt die Datei und meldet sich fertig: genau dann darf die Warnung nicht verschwinden.
  await w.uhr.advance(3000)
  w.dateien[STAND(KENNUNG, 'b')] = JSON.stringify(standDatei('probe-b', 'fertig', FERTIG, 'Fertig', w.uhr.now()))
  await w.uhr.advance(3000)
  let text = await bandLesen($)
  expect(text).toContain('☑️ probe-b')
  expect(text).toContain('⚠️ Dateikonflikt probe-a + probe-b: gemeinsam.ts')

  // Auch wenn beide sich fertig gemeldet haben, ist noch nichts geprüft.
  w.dateien[STAND(KENNUNG, 'a')] = JSON.stringify(standDatei('probe-a', 'fertig', FERTIG, 'Fertig', w.uhr.now()))
  await w.uhr.advance(3000)
  expect(await bandLesen($)).toContain('⚠️ Dateikonflikt')

  // Eine geprüfte Session fällt aus dem Vergleich; mit nur einer Session gibt es keinen Konflikt mehr.
  await werkzeug($, 'session_geprueft', { session: 'probe-b' })
  expect(await bandLesen($)).not.toContain('Dateikonflikt')
  await werkzeug($, 'session_geprueft', { session: 'probe-a' })
  text = await bandLesen($)
  expect(text).toContain('✅ probe-a')
  expect(text).not.toContain('Dateikonflikt')
})

test('auch eine pausierte Session zählt für den Konflikt, eine beendete nicht', async ($, on) => {
  const w = welt(on, { dateien: {
    [STAND(KENNUNG, 'a')]: standDatei('bau', 'arbeitet', [{ text: 'X', status: 'in_progress' }]),
    [ZUSATZ('a')]: { pfade: ['/p/gemeinsam.ts'] },
    [STAND(KENNUNG, 'b')]: standDatei('pause', 'fertig', [{ text: 'X', status: 'pending' }]),
    [ZUSATZ('b')]: { pfade: ['/p/gemeinsam.ts'] },
  } })
  await $.session.start(START)
  expect(await bandLesen($)).toContain('⚠️ Dateikonflikt bau + pause')
  w.dateien[STAND(KENNUNG, 'b')] = JSON.stringify(standDatei('pause', 'beendet', [{ text: 'X', status: 'pending' }]))
  await w.uhr.advance(3000)
  expect(await bandLesen($)).not.toContain('Dateikonflikt')
})

test('ein neuer Auftrag nimmt alte Dateien einer fertigen Session aus dem Vergleich', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit', dateien: { [STAND()]: standDatei('bau', 'fertig', FERTIG), [ZUSATZ(ID)]: { pfade: ['/p/gemeinsam.ts'] } } })
  await $.session.start(START)
  expect(JSON.parse(w.dateien[ZUSATZ(ID)]).pfade).toEqual(['/p/gemeinsam.ts'])
  await nachricht($, `⟦dirigent:bau＠${KENNUNG}⟧ Auftrag\nAufgabe: Etwas Neues`)
  expect(JSON.parse(w.dateien[ZUSATZ(ID)]).pfade).toEqual([])
})

test('Geprüftes, andere Pfade und Stände ohne Zusatz ergeben keinen Konflikt', async ($, on) => {
  welt(on, { dateien: {
    [STAND(KENNUNG, 'a')]: standDatei('bau', 'arbeitet', [{ text: 'X', status: 'in_progress' }]),
    [ZUSATZ('a')]: { pfade: ['/p/gemeinsam.ts'] },
    [STAND(KENNUNG, 'b')]: standDatei('fertig', 'fertig', FERTIG, '', JETZT - 1000),
    [ZUSATZ('b')]: { pfade: ['/p/gemeinsam.ts'] },
    [`/h/.claude/dirigent/geprueft/${KENNUNG}.json`]: { b: JETZT },
    [STAND(KENNUNG, 'c')]: standDatei('alt', 'arbeitet', [{ text: 'X', status: 'in_progress' }]),
    [ZUSATZ('c')]: { pfade: ['/worktree/gemeinsam.ts'] },
    [STAND(KENNUNG, 'd')]: standDatei('uralt', 'arbeitet', [{ text: 'X', status: 'in_progress' }]),
  } })
  await $.session.start(START)
  expect(await bandLesen($)).not.toContain('Dateikonflikt')
})

test('ein neuer Auftrag beginnt die Pfad-Liste neu', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit' })
  await $.session.start(START)
  await nachricht($, `⟦dirigent:bau＠${KENNUNG}⟧ Auftrag\nAufgabe: Eins`)
  await $.tool.call({ tool: 'Write', file_path: '/p/alt.ts', content: 'x' } as any)
  await nachricht($, `⟦dirigent:bau＠${KENNUNG}⟧ Folge ohne Aufgabe`)
  expect(JSON.parse(w.dateien[ZUSATZ(ID)]).pfade).toEqual(['/p/alt.ts'])
  await nachricht($, `⟦dirigent:bau＠${KENNUNG}⟧ Auftrag\nAufgabe: Zwei`)
  expect(JSON.parse(w.dateien[ZUSATZ(ID)]).pfade).toEqual([])
})

test('die Pfade überstehen einen Neustart und werden nicht geleert', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit', dateien: {
    [STAND()]: standDatei('bau', 'beendet', FERTIG),
    [ZUSATZ(ID)]: { pfade: ['/p/alt.ts'] },
  } })
  await $.session.start(START)
  expect(JSON.parse(w.dateien[ZUSATZ(ID)]).pfade).toEqual(['/p/alt.ts'])
})

// --- 5. Limits ---

const nutzung = (prozent: number) => ({
  content: [{ type: 'text', text: JSON.stringify({ plan: { status: 'ok', windows: [
    { label: 'Weekly · all models', percentUsed: 99 },
    { label: '5-hour limit', percentUsed: prozent },
  ] } }) }],
  isError: false,
})

test('die Kopfzeile zeigt das 5-Stunden-Limit, ab 80 % hervorgehoben', async ($, on) => {
  let prozent = 25
  const w = welt(on, { mcp: tool => (tool === 'get_usage' ? nutzung(prozent) : undefined) })
  await $.session.start(START)
  await w.uhr.advance(3000)
  let text = await bandLesen($)
  expect(text).toContain('5h 25 %')
  expect(text).not.toContain('⚠️')

  prozent = 82
  await w.uhr.advance(MINUTE + 3000)
  text = await bandLesen($)
  expect(text).toContain('⚠️ 5h 82 %')
  expect(text).not.toContain('5h 25 %')
})

test('get_usage läuft höchstens einmal pro Minute', async ($, on) => {
  const w = welt(on, { mcp: tool => (tool === 'get_usage' ? nutzung(10) : undefined) })
  await $.session.start(START)
  await w.uhr.advance(57_000)
  expect(w.aufrufe.filter(a => a.tool === 'get_usage')).toHaveLength(1)
  await w.uhr.advance(3000)
  expect(w.aufrufe.filter(a => a.tool === 'get_usage')).toHaveLength(2)
})

for (const [fall, antwort] of [
  ['eine Ausnahme', () => { throw new Error('weg') }],
  ['einen Fehler', () => ({ content: [], isError: true })],
  ['kein JSON', () => ({ content: [{ type: 'text', text: 'kein json' }], isError: false })],
  ['keinen Plan', () => ({ content: [{ type: 'text', text: '{"plan":{"status":"not_applicable"}}' }], isError: false })],
] as const) {
  test(`liefert get_usage ${fall}, zeigt das Band nichts dazu und läuft weiter`, async ($, on) => {
    const w = welt(on, { mcp: tool => (tool === 'get_usage' ? antwort() : undefined) })
    await $.session.start(START)
    await w.uhr.advance(MINUTE)
    const text = await bandLesen($)
    expect(text).toContain('🎼 Dirigent')
    expect(text).not.toContain('5h')
  })
}

test('fällt die Abfrage später aus, verschwindet die alte Zahl', async ($, on) => {
  let geht = true
  const w = welt(on, { mcp: tool => {
    if (tool !== 'get_usage') return undefined
    if (!geht) throw new Error('weg')
    return nutzung(70)
  } })
  await $.session.start(START)
  await w.uhr.advance(3000)
  expect(await bandLesen($)).toContain('5h 70 %')
  geht = false
  await w.uhr.advance(MINUTE + 3000)
  expect(await bandLesen($)).not.toContain('5h')
})

test('die Kopfzeile bleibt eine Zeile: Wichtiges zuerst, der Text zuletzt', async ($, on) => {
  const w = welt(on, {
    mcp: tool => (tool === 'get_usage' ? nutzung(90) : undefined),
    dateien: {
      [OFFEN]: { punkte: [{ id: 'p1', text: 'x', art: 'idee', quelle: 'chat', zeit: 1, status: 'offen' }] },
      [STAND(KENNUNG, ID)]: { ...standDatei('Dirigent', 'arbeitet', [{ text: 'Ein sehr langer Schritt, der nicht mehr in die schmale Kopfzeile passt', status: 'in_progress' }]), istMaster: true },
      [STAND(KENNUNG, 'a')]: standDatei('frage', 'wartet'),
    },
  })
  await $.session.start(START)
  await nachricht($, 'los')
  await werkzeug($, 'master_benennen', { projekt: 'Musik' })
  await w.uhr.advance(3000)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true, bodyColumns: 44 } })
  const kopf = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).find((t: string) => t.startsWith('🎼')) as string
  await ui.unmount()
  expect(kopf).not.toContain('\n')
  const reihe = ['🎼 Musik', '📌 1', '⚠️ 5h 90 %', '❓1'].map(t => kopf.indexOf(t))
  expect(reihe.every(i => i >= 0)).toBe(true)
  expect(reihe).toEqual([...reihe].sort((a, b) => a - b))
  expect(kopf.indexOf('Ein sehr')).toBeGreaterThan(reihe[3])
})

// --- 6. Wirkung von Skill-Änderungen ---

const TAG = 86_400_000
const genutzt = (id: string, skill: string, zeit: number, ergebnis: string) => ({
  [`/h/.claude/dirigent/skills/nutzung/${id}.json`]: { sessionId: id, kennung: KENNUNG, name: 'x', auftrag: 'a', zugewiesen: [], ergebnis, zuletzt: zeit, geladen: [{ skill, zeit }] },
})
const viele = (skill: string, von: number, fertig: number, pausiert: number, prefix: string) => {
  const dateien: Record<string, object> = {}
  for (let i = 0; i < fertig + pausiert; i++) Object.assign(dateien, genutzt(`${prefix}${i}`, skill, von + i * 1000, i < fertig ? 'fertig' : 'pausiert'))
  return dateien
}
const SICHERUNG = '/h/.claude/dirigent/skill-sicherung/commit-1'

function skillWelt(on: any, dateien: Record<string, object> = {}) {
  const w = welt(on, { dateien: { [`${SICHERUNG}/SKILL.md`]: 'alt', ...dateien } })
  on('command.list', () => ({ value: [{ name: 'commit', description: 'd', source: 'user' }] }))
  return w
}
const aenderungenLesen = async ($: any) => JSON.parse(await werkzeug($, 'skills_lage')).aenderungen

test('skill_aenderung merkt Skill, Datum und Sicherung und ändert selbst nichts', async ($, on) => {
  const w = skillWelt(on)
  await $.session.start(START)
  const vorher = Object.keys(w.dateien).filter(p => !p.includes('/aenderungen/') && !p.includes('/stand/') && !p.includes('/zusatz/'))
  await werkzeug($, 'skill_aenderung', { skill: 'commit', sicherung: SICHERUNG })
  const pfad = Object.keys(w.dateien).find(p => p.includes('/skills/aenderungen/')) as string
  expect(JSON.parse(w.dateien[pfad])).toEqual({ skill: 'commit', sicherung: SICHERUNG, zeit: JETZT })
  expect(Object.keys(w.dateien).filter(p => !p.includes('/aenderungen/') && !p.includes('/stand/') && !p.includes('/zusatz/'))).toEqual(vorher)
})

test('skill_aenderung braucht einen vorhandenen Sicherungsordner und einen gültigen Namen', async ($, on) => {
  const w = skillWelt(on)
  await $.session.start(START)
  expect(await werkzeug($, 'skill_aenderung', { skill: 'commit', sicherung: '/gibtsnicht' })).toContain('gibt es nicht')
  expect(await werkzeug($, 'skill_aenderung', { skill: '../x', sicherung: SICHERUNG })).toContain('Nichts gemerkt')
  expect(Object.keys(w.dateien).some(p => p.includes('/aenderungen/'))).toBe(false)
  expect(await werkzeug($, 'skill_aenderung', { skill: 'commit', sicherung: '~/.claude/dirigent/skill-sicherung/commit-1' })).toContain('gemerkt')
})

test('skills_lage zeigt die Wirkung: schlechter nach der Änderung', async ($, on) => {
  const AM = JETZT - 10 * TAG
  skillWelt(on, {
    ...viele('commit', AM - 5 * TAG, 5, 0, 'v'),
    ...viele('commit', AM + TAG, 2, 3, 'n'),
    [`/h/.claude/dirigent/skills/hinweise/1-commit.json`]: { skill: 'commit', art: 'fehler', text: 'x', zeit: AM + 2 * TAG },
    [`/h/.claude/dirigent/skills/aenderungen/1-commit.json`]: { skill: 'commit', sicherung: SICHERUNG, zeit: AM },
  })
  await $.session.start(START)
  const [a] = await aenderungenLesen($)
  expect(a).toMatchObject({
    skill: 'commit',
    sicherung: SICHERUNG,
    vorher: { nutzungen: 5, erfolgsquote: 100, hinweise: 0 },
    nachher: { nutzungen: 5, erfolgsquote: 40, hinweise: 1 },
    trend: 'schlechter',
  })
  expect(a.hinweis).toBeUndefined()
})

test('unter 5 Nutzungen je Seite gibt es kein Urteil, nur den Hinweis auf zu wenig Daten', async ($, on) => {
  const AM = JETZT - 10 * TAG
  skillWelt(on, {
    ...viele('commit', AM - TAG, 5, 0, 'v'),
    ...viele('commit', AM + TAG, 1, 3, 'n'),
    [`/h/.claude/dirigent/skills/aenderungen/1-commit.json`]: { skill: 'commit', sicherung: SICHERUNG, zeit: AM },
  })
  await $.session.start(START)
  const [a] = await aenderungenLesen($)
  expect(a.trend).toBeNull()
  expect(a.hinweis).toContain('zu wenig Daten')
})

test('laufende Sessions zählen nicht, zwei Änderungen teilen die Zeit auf', async ($, on) => {
  const A1 = JETZT - 20 * TAG
  const A2 = JETZT - 10 * TAG
  skillWelt(on, {
    ...viele('commit', A1 - TAG, 5, 0, 'a'),
    ...viele('commit', A1 + TAG, 5, 0, 'b'),
    ...viele('commit', A2 + TAG, 5, 0, 'c'),
    ...genutzt('laeuft', 'commit', A2 + 2 * TAG, 'laeuft'),
    [`/h/.claude/dirigent/skills/aenderungen/1-commit.json`]: { skill: 'commit', sicherung: SICHERUNG, zeit: A1 },
    [`/h/.claude/dirigent/skills/aenderungen/2-commit.json`]: { skill: 'commit', sicherung: `${SICHERUNG}b`, zeit: A2 },
  })
  await $.session.start(START)
  const liste = await aenderungenLesen($)
  expect(liste.map((a: any) => [a.vorher.nutzungen, a.nachher.nutzungen])).toEqual([[5, 5], [5, 5]])
  expect(liste[1].trend).toBe('gleich')
})

test('ohne Änderungen ist die Liste leer', async ($, on) => {
  skillWelt(on)
  await $.session.start(START)
  expect(await aenderungenLesen($)).toEqual([])
})

// --- 7. Freigabe-Karten ---

const FREIGABE = { hook_event_name: 'PermissionRequest', session_id: ID, transcript_path: '/t', cwd: '/', tool_name: 'Bash', tool_input: {} }

test('eine Freigabe-Karte macht ❓, nach der Antwort läuft die Session weiter', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit' })
  let zustandWaehrendDesAufrufs: any
  w.werkzeugAntwort = async () => {
    await $.classic.PermissionRequest(FREIGABE as any)
    zustandWaehrendDesAufrufs = JSON.parse(w.dateien[STAND()])
    return { result: {} }
  }
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(zustandWaehrendDesAufrufs).toMatchObject({ zustand: 'wartet', notiz: 'wartet auf deine Freigabe', blockiert: false })
  expect(JSON.parse(w.dateien[STAND()])).toMatchObject({ zustand: 'arbeitet', notiz: '' })
})

test('hat ein Einstellungs-Hook die Frage beantwortet, wartet niemand', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit' })
  w.freigabeAntwort = { decision: { behavior: 'allow' } }
  await $.session.start(START)
  await nachricht($, 'los')
  await $.classic.PermissionRequest(FREIGABE as any)
  expect(JSON.parse(w.dateien[STAND()]).zustand).toBe('arbeitet')
})

test('die Karte eines Unteragenten ändert den Stand nicht', async ($, on) => {
  const w = welt(on, { rolle: 'arbeit' })
  await $.session.start(START)
  await nachricht($, 'los')
  await $.classic.PermissionRequest({ ...FREIGABE, agent_id: 'a1' } as any)
  expect(JSON.parse(w.dateien[STAND()]).zustand).toBe('arbeitet')
})

// --- Wiedererkennen nach einem Neustart: neue Session-Id, gleiche Host-Id ---

const NEU = 'cccccccc-0000-4000-8000-000000000000'
const ALT = 'dddddddd-0000-4000-8000-000000000000'
const HOST = 'local_11111111'
const ENV = { CLAUDE_CODE_HOST_SESSION_ID: HOST }
const NUTZUNG = (id: string) => `/h/.claude/dirigent/skills/nutzung/${id}.json`
const offenMit = (text: string) => ({ punkte: [{ id: 'p1', text, art: 'idee', quelle: 'chat', zeit: 1, status: 'offen' }] })

function alterMaster(w: Welt, extra: object = {}) {
  w.store[`master:${KENNUNG}`] = { kennung: KENNUNG, sessionId: ALT, seit: 'x', projekt: 'Musik', ...extra }
  w.sessionId = NEU
}
function alteRolle(w: Welt, extra: object = {}) {
  delete w.store[`rolle:${ID}`]
  w.store[`rolle:${ALT}`] = { name: 'bau', kennung: KENNUNG, ...extra }
  w.sessionId = NEU
}

test('ein Master mit neuer Id und gleicher Host-Id wird wiedererkannt: Band, Projekt, offene Punkte bleiben', async ($, on) => {
  const w = welt(on, { env: ENV, dateien: {
    [OFFEN]: offenMit('Dark Mode prüfen'),
    [STAND(KENNUNG, ALT)]: { ...standDatei('Dirigent', 'beendet', [{ text: 'Plan', status: 'in_progress' }]), istMaster: true },
    [STAND(KENNUNG, 'arbeit')]: standDatei('bau', 'arbeitet', [{ text: 'X', status: 'in_progress' }]),
  } })
  alterMaster(w, { hostId: HOST })
  await $.session.start(START)

  expect(w.store[`master:${KENNUNG}`]).toEqual({ kennung: KENNUNG, sessionId: NEU, seit: 'x', projekt: 'Musik', hostId: HOST })
  const text = await bandLesen($)
  expect(text).toContain('🎼 Musik')
  expect(text).toContain('📌 1')
  expect(text).toContain('🔄 bau')
  expect(JSON.parse(await werkzeug($, 'lage'))).toMatchObject({ istMaster: true, kennung: KENNUNG, offenePunkte: 1 })

  await nachricht($, 'weiter')
  expect(w.kontexte[0]?.join('\n')).toContain('Dark Mode prüfen')
  expect(JSON.parse(w.dateien[STAND(KENNUNG, NEU)]).schritte[0].text).toBe('Plan')
  expect(JSON.parse(w.dateien[STAND(KENNUNG, ALT)]).zustand).toBe('beendet')
})

test('ein alter Master-Eintrag ohne Host-Id wird über zusatz geheilt und bekommt sie', async ($, on) => {
  const w = welt(on, { env: ENV, dateien: { [OFFEN]: offenMit('x'), [ZUSATZ(ALT)]: { pfade: [], hostId: HOST } } })
  alterMaster(w)
  await $.session.start(START)
  expect(w.store[`master:${KENNUNG}`]).toMatchObject({ sessionId: NEU, hostId: HOST, projekt: 'Musik' })
  expect(await bandLesen($)).toContain('📌 1')
})

test('master_werden legt nach einem Neustart keine neue Kennung an', async ($, on) => {
  const w = welt(on, { env: ENV, dateien: { [ZUSATZ(ALT)]: { pfade: [], hostId: HOST } } })
  alterMaster(w)
  expect(await werkzeug($, 'master_werden')).toContain(`Kennung: ${KENNUNG}`)
  expect(Object.keys(w.store).filter(k => k.startsWith('master:'))).toEqual([`master:${KENNUNG}`])
})

test('auch prompt.submit heilt, wenn kein session.start kam, und startet das Band', async ($, on) => {
  const w = welt(on, { env: ENV, dateien: { [OFFEN]: offenMit('Dark Mode prüfen') } })
  alterMaster(w, { hostId: HOST })
  await nachricht($, 'weiter')
  expect((w.store[`master:${KENNUNG}`] as any).sessionId).toBe(NEU)
  expect(w.kontexte[0]?.join('\n')).toContain('Dark Mode prüfen')
  expect(await bandLesen($)).toContain('🎼 Musik')
})

test('eine Arbeits-Session mit neuer Id übernimmt Rolle, Liste, Skills und Pfade und steht nur einmal im Band', async ($, on) => {
  const w = welt(on, { env: ENV, rolle: 'arbeit', dateien: {
    [STAND(KENNUNG, ALT)]: standDatei('bau', 'beendet', [{ text: 'Eins', status: 'in_progress' }], '', JETZT - 1000, { zugewiesen: ['commit'] }),
    [ZUSATZ(ALT)]: { pfade: ['/p/a.ts'], hostId: HOST },
    [NUTZUNG(ALT)]: { sessionId: ALT, kennung: KENNUNG, name: 'bau', auftrag: 'Mod bauen', zugewiesen: ['commit'], geladen: [{ skill: 'commit', zeit: 5 }], ergebnis: 'laeuft', zuletzt: 5 },
    [`/h/.claude/dirigent/geprueft/${KENNUNG}.json`]: { [ALT]: 7, anderes: 8 },
  } })
  alteRolle(w, { hostId: HOST })
  await $.session.start(START)

  expect(w.store[`rolle:${NEU}`]).toEqual({ name: 'bau', kennung: KENNUNG, hostId: HOST })
  expect(w.store[`rolle:${ALT}`]).toBeUndefined()
  expect(JSON.parse(w.dateien[STAND(KENNUNG, ALT)]).zustand).toBe('beendet')
  expect(JSON.parse(w.dateien[STAND(KENNUNG, NEU)])).toMatchObject({ name: 'bau', zustand: 'fertig', zugewiesen: ['commit'], geladen: ['commit'] })
  expect(JSON.parse(w.dateien[ZUSATZ(NEU)])).toEqual({ pfade: ['/p/a.ts'], hostId: HOST })
  expect(JSON.parse(w.dateien[ZUSATZ(ALT)]).pfade).toEqual([])
  expect(JSON.parse(w.dateien[`/h/.claude/dirigent/geprueft/${KENNUNG}.json`])).toEqual({ [NEU]: 7, anderes: 8 })

  // Das Protokoll zählt nicht doppelt.
  expect(JSON.parse(w.dateien[NUTZUNG(NEU)])).toMatchObject({ sessionId: NEU, auftrag: 'Mod bauen', geladen: [{ skill: 'commit', zeit: 5 }] })
  expect(JSON.parse(w.dateien[NUTZUNG(ALT)])).toMatchObject({ auftrag: '', geladen: [] })

  // Aus Sicht eines Masters steht sie genau einmal da.
  w.store[`master:${KENNUNG}`] = { kennung: KENNUNG, sessionId: NEU, seit: 'x' }
  await werkzeug($, 'master_benennen', { projekt: 'x' })
  const zeilen = (await bandLesen($)).split('\n').filter(z => z.includes(' bau'))
  expect(zeilen).toHaveLength(1)
})

test('eine alte Rolle ohne Host-Id wird über zusatz geheilt', async ($, on) => {
  const w = welt(on, { env: ENV, rolle: 'arbeit', dateien: { [ZUSATZ(ALT)]: { pfade: [], hostId: HOST } } })
  alteRolle(w)
  await $.session.start(START)
  expect(w.store[`rolle:${NEU}`]).toEqual({ name: 'bau', kennung: KENNUNG, hostId: HOST })
})

test('eine Liste, die unter der neuen Id schon steht, wird nicht überschrieben', async ($, on) => {
  const w = welt(on, { env: ENV, rolle: 'arbeit', dateien: {
    [STAND(KENNUNG, ALT)]: standDatei('bau', 'beendet', [{ text: 'Alt', status: 'in_progress' }]),
    [STAND(KENNUNG, NEU)]: standDatei('bau', 'fertig', [{ text: 'Neu', status: 'in_progress' }]),
  } })
  alteRolle(w, { hostId: HOST })
  await $.session.start(START)
  expect(JSON.parse(w.dateien[STAND(KENNUNG, NEU)]).schritte[0].text).toBe('Neu')
})

test('eine fremde Host-Id übernimmt nichts, weder aus dem Store noch aus zusatz', async ($, on) => {
  const w = welt(on, { env: ENV, rolle: 'frei', dateien: {
    [OFFEN]: offenMit('x'),
    [STAND(KENNUNG, ALT)]: standDatei('Dirigent', 'beendet'),
    [ZUSATZ(ALT)]: { pfade: [], hostId: 'local_fremd' },
    [ZUSATZ('andere')]: { pfade: [], hostId: 'local_fremd' },
  } })
  w.store[`master:${KENNUNG}`] = { kennung: KENNUNG, sessionId: ALT, seit: 'x' }
  w.store[`master:bbbbbbbb`] = { kennung: 'bbbbbbbb', sessionId: 'x', seit: 'x', hostId: 'local_fremd' }
  w.store[`rolle:andere`] = { name: 'bau', kennung: KENNUNG }
  w.sessionId = NEU
  await $.session.start(START)
  expect(w.store[`master:${KENNUNG}`]).toEqual({ kennung: KENNUNG, sessionId: ALT, seit: 'x' })
  expect(w.store[`rolle:${NEU}`]).toBeUndefined()
  expect(JSON.parse(await werkzeug($, 'lage')).istMaster).toBe(false)
  expect(JSON.parse(w.dateien[STAND(KENNUNG, ALT)]).zustand).toBe('beendet')
  expect(w.dateien[STAND(KENNUNG, NEU)]).toBeUndefined()
})

test('die Rolle eines beendeten Dirigenten wird nicht übernommen', async ($, on) => {
  const w = welt(on, { env: ENV, rolle: 'frei' })
  w.store[`rolle:${ALT}`] = { name: 'bau', kennung: 'weggewesen', hostId: HOST }
  w.sessionId = NEU
  await $.session.start(START)
  expect(w.store[`rolle:${NEU}`]).toBeUndefined()
})

test('ohne Host-Id bleibt alles wie bisher, ohne Fehler', async ($, on) => {
  const w = welt(on, { dateien: { [ZUSATZ(ALT)]: { pfade: [], hostId: HOST } } })
  alterMaster(w)
  await $.session.start(START)
  await nachricht($, 'hallo')
  expect((w.store[`master:${KENNUNG}`] as any).sessionId).toBe(ALT)
  expect(JSON.parse(await werkzeug($, 'lage')).istMaster).toBe(false)
})

test('master_werden und ein Auftrag speichern die Host-Id, ein bestehender Eintrag bekommt sie nachgetragen', async ($, on) => {
  const w = welt(on, { env: ENV, rolle: 'frei' })
  await werkzeug($, 'master_werden')
  expect(w.store[`master:${ID.slice(0, 8)}`]).toMatchObject({ sessionId: ID, hostId: HOST })

  delete w.store[`master:${ID.slice(0, 8)}`]
  w.store[`master:${KENNUNG}`] = { kennung: KENNUNG, sessionId: 'andere', seit: 'x' }
  await nachricht($, `⟦dirigent:bau＠${KENNUNG}⟧ Auftrag\nAufgabe: Eins`)
  expect(w.store[`rolle:${ID}`]).toEqual({ name: 'bau', kennung: KENNUNG, hostId: HOST })

  w.store[`rolle:${ID}`] = { name: 'bau', kennung: KENNUNG }
  await $.session.start(START)
  expect(w.store[`rolle:${ID}`]).toEqual({ name: 'bau', kennung: KENNUNG, hostId: HOST })
})

test('/clear beim Master mit Host-Id läuft wie bisher: Erinnerung, gleiche Kennung, keine doppelte Zeile', async ($, on) => {
  const w = welt(on, { env: ENV, dateien: { [OFFEN]: offenMit('Dark Mode prüfen') } })
  await $.session.start(START)
  await $.session.end({ reason: 'clear', sessionId: ID, resume: {} } as any)
  w.sessionId = NEU
  await nachricht($, 'weiter')
  const kontext = w.kontexte[0]?.join('\n')
  expect(kontext).toContain('uebergabe-aaaaaaaa')
  expect(kontext).toContain('Dark Mode prüfen')
  expect(w.store[`master:${KENNUNG}`]).toMatchObject({ sessionId: NEU, hostId: HOST })
  expect(JSON.parse(w.dateien[STAND(KENNUNG, ID)]).zustand).toBe('beendet')
})

test('/clear bei einer Arbeits-Session bringt den alten Stand nicht zurück', async ($, on) => {
  const w = welt(on, { env: ENV, rolle: 'arbeit' })
  await $.session.start(START)
  await nachricht($, `⟦dirigent:bau＠${KENNUNG}⟧ Auftrag\nAufgabe: Eins`)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Alt', status: 'in_progress' }] } as any)
  await $.session.end({ reason: 'clear', sessionId: ID, resume: {} } as any)
  w.sessionId = NEU
  await nachricht($, 'etwas anderes')
  expect(w.store[`rolle:${NEU}`]).toBeUndefined()
  expect(w.dateien[STAND(KENNUNG, NEU)]).toBeUndefined()
  expect(JSON.parse(w.dateien[STAND(KENNUNG, ID)]).zustand).toBe('beendet')
})

// --- Robustheit ---

test('ohne jedes Dateisystem kommt eine Nachricht trotzdem durch', async ($, on) => {
  const seen: string[] = []
  on('session.id', () => ({ value: ID }))
  on('store.keys', () => ({ value: [`master:${KENNUNG}`] }))
  on('store.get', () => ({ value: { kennung: KENNUNG, sessionId: ID, seit: 'x' } }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: JETZT }))
  on('fs.exists', () => {
    throw new Error('kaputt')
  })
  on('fs.read', () => {
    throw new Error('kaputt')
  })
  on('fs.write', () => {
    throw new Error('kaputt')
  })
  on('prompt.submit', (_: any, e: any) => {
    seen.push(e.text)
    return { text: e.text }
  })
  await nachricht($, 'hallo')
  expect(seen).toEqual(['hallo'])
})
