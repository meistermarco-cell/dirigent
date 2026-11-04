import { expect, test } from 'claude-code/testing'

const ID = 'aaaaaaaa-0000-4000-8000-000000000000'
const BAND = {
  plugin: 'dirigent',
  component: 'AbovePrompt',
  surface: 'desktop',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const JETZT = 1_800_000_000_000

function welt(on: any, dateien: Record<string, object>, geschrieben: Record<string, string> = {}, istMaster = true) {
  const store: Record<string, unknown> = istMaster
    ? { 'master:aaaaaaaa': { kennung: 'aaaaaaaa', sessionId: ID, seit: 'x' } }
    : { 'master:bbbbbbbb': { kennung: 'bbbbbbbb', sessionId: 'andere', seit: 'x' }, [`rolle:${ID}`]: { name: 'bau', kennung: 'bbbbbbbb' } }
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: {} }))
  on('session.id', () => ({ value: ID }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: JETZT }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: Object.keys(dateien).map(name => ({ name, mtimeMs: JETZT - 1000 })) }))
  on('fs.read', (_: any, e: any) => ({ value: JSON.stringify(dateien[e.path.split('/').pop()]) }))
  on('fs.write', (_: any, e: any) => {
    geschrieben[e.path] = e.text
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
}

const stand = (name: string, zustand: string, schritte: object[] = [], notiz = '', zuletzt = JETZT, istMaster = false) => ({
  kennung: 'aaaaaaaa', name, istMaster, zustand, schritte, notiz, zuletzt,
})

test('das Band zeigt Dirigent und Arbeits-Sessions, Wartende zuerst', async ($, on) => {
  welt(on, {
    [`aaaaaaaa-${ID}.json`]: stand('Dirigent', 'arbeitet', [{ text: 'Lage prüfen', status: 'in_progress' }], '', JETZT, true),
    'aaaaaaaa-1.json': stand('bau', 'arbeitet', [{ text: 'Alt', status: 'completed' }, { text: 'Band bauen', status: 'in_progress' }]),
    'aaaaaaaa-2.json': stand('frage', 'wartet', [], 'Welche Farbe?'),
    'aaaaaaaa-3.json': stand('weg', 'beendet'),
    'aaaaaaaa-4.json': stand('alt', 'fertig', [], 'längst fertig', JETZT - 3_600_000),
    'bbbbbbbb-5.json': { ...stand('fremd', 'arbeitet'), kennung: 'bbbbbbbb' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAND)
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  expect(text).toContain('Lage prüfen')
  expect(text).toContain('❓ frage · Welche Farbe?')
  expect(text).toContain('🔄 bau ▰▰▰▱▱ 50 % · Band bauen')
  expect(text).toContain('🔄1')
  expect(text).toContain('❓1')
  expect(text.indexOf('frage')).toBeLessThan(text.indexOf('bau'))
  expect(text).not.toContain('weg')
  expect(text).not.toContain('längst fertig')
  expect(text).not.toContain('fremd')
  await ui.unmount()
})

test('ohne Arbeits-Sessions steht das Band trotzdem da', async ($, on) => {
  welt(on, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: false } })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  expect(text).toContain('bereit')
  expect(text).toContain('Keine Arbeits-Session aktiv')
  await ui.unmount()
})

test('in einer Arbeits-Session gibt es kein Band', async ($, on) => {
  welt(on, {}, {}, false)
  on('ui.render', ($e: any, e: any) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('ein Auftrag mit breitem ＠ in der Marke macht die Session zur Arbeits-Session', async ($, on) => {
  const gesetzt: Record<string, unknown> = {}
  const store: Record<string, unknown> = { 'master:bbbbbbbb': { kennung: 'bbbbbbbb', sessionId: 'andere', seit: 'x' } }
  on('session.id', () => ({ value: ID }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => {
    gesetzt[e.key] = e.value
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'Task: ⟦dirigent:gesang＠bbbbbbbb⟧ Auftrag' } as any)
  expect(gesetzt[`rolle:${ID}`]).toEqual({ name: 'gesang', kennung: 'bbbbbbbb' })
})

test('eine Arbeits-Session meldet ihre Liste und ihren Abschluss', async ($, on) => {
  const geschrieben: Record<string, string> = {}
  welt(on, {}, geschrieben, false)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Eins', status: 'in_progress' }, { content: 'Zwei', status: 'pending' }] } as any)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as any)
  const pfad = `/h/.claude/dirigent/stand/bbbbbbbb-${ID}.json`
  let datei = JSON.parse(geschrieben[pfad])
  expect(datei.name).toBe('bau')
  expect(datei.schritte.map((s: any) => s.status)).toEqual(['completed', 'in_progress'])
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Alles fertig gebaut. Mehr Text.' } as any)
  datei = JSON.parse(geschrieben[pfad])
  expect(datei.notiz).toBe('Alles fertig gebaut.')
  expect(datei.schritte.every((s: any) => s.status === 'completed')).toBe(true)
})

const zeilenVon = async ($: any, on: any, dateien: Record<string, object>, breite: number) => {
  welt(on, dateien)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: breite } })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  await ui.unmount()
  return text
}

test('ein langer Bericht wird knapp, aber bleibt lesbar', async ($, on) => {
  const text = await zeilenVon($, on, {
    'aaaaaaaa-1.json': stand('gitarre', 'fertig', [{ text: 'A', status: 'completed' }], 'Gitarre fertig: 13 Stellen in der DI repariert, gemessen 0 abweichende Samples.'),
  }, 80)
  expect(text).toContain('✅ gitarre ▰▰▰▰▰ 100 % · 13 Stellen in der DI repariert')
  expect(text).not.toContain('gemessen')
})

test('im schmalen Fenster fällt der Balken weg, die Prozentzahl bleibt', async ($, on) => {
  const text = await zeilenVon($, on, {
    'aaaaaaaa-1.json': stand('mix', 'arbeitet', [{ text: 'Eins', status: 'completed' }, { text: 'Ketten je Spur in mix.py bauen und fitten', status: 'in_progress' }]),
  }, 40)
  expect(text).toContain('🔄 mix 50 % · ')
  expect(text).not.toContain('▰')
  expect(text).toContain('…')
})

test('Pause und Stille sind von Fertig und Arbeiten zu unterscheiden', async ($, on) => {
  const text = await zeilenVon($, on, {
    'aaaaaaaa-1.json': stand('halb', 'fertig', [{ text: 'A', status: 'completed' }, { text: 'B', status: 'pending' }]),
    'aaaaaaaa-2.json': stand('still', 'arbeitet', [{ text: 'Messen', status: 'in_progress' }], '', JETZT - 25 * 60_000),
  }, 80)
  expect(text).toContain('⏸️ halb')
  expect(text).toContain('⚠️ still ▱▱▱▱▱ 0 % · 25 Min. still · Messen')
})
