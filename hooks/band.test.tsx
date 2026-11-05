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

// `skills` füllt die Ordner des Skill-Protokolls (`nutzung`, `hinweise`); alles andere liest aus `dateien`.
type SkillDateien = { nutzung: Record<string, object>; hinweise: Record<string, object> }
function welt(on: any, dateien: Record<string, object>, geschrieben: Record<string, string> = {}, istMaster: boolean | null = true, skills?: SkillDateien, projekt?: string, sets?: Record<string, any>) {
  const ordner = (pfad: string) => (pfad.includes('/skills/nutzung') ? skills?.nutzung : pfad.includes('/skills/hinweise') ? skills?.hinweise : undefined) ?? dateien
  const store: Record<string, unknown> = istMaster === null
    ? {}
    : istMaster
    ? { 'master:aaaaaaaa': { kennung: 'aaaaaaaa', sessionId: ID, seit: 'x', ...(projekt ? { projekt } : {}) } }
    : { 'master:bbbbbbbb': { kennung: 'bbbbbbbb', sessionId: 'andere', seit: 'x' }, [`rolle:${ID}`]: { name: 'bau', kennung: 'bbbbbbbb' } }
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: {} }))
  on('session.id', () => ({ value: ID }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => {
    if (sets) sets[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: JETZT }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_: any, e: any) => ({ value: Object.keys(ordner(e.path)).map(name => ({ name, mtimeMs: JETZT - 1000 })) }))
  on('fs.read', (_: any, e: any) => ({ value: JSON.stringify(ordner(e.path)[e.path.split('/').pop()]) }))
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
  expect(text).not.toContain('fremd')
  await ui.unmount()
})

test('ohne Arbeits-Sessions steht das Band trotzdem da', async ($, on) => {
  welt(on, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: false } })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  expect(text).toContain('bereit')
  expect(text).toContain('keine Arbeits-Session')
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
  expect(text).toContain('☑️ gitarre ▰▰▰▰▰ 100 % · 13 Stellen in der DI repariert')
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

// --- Skill-Verwaltung ---

const TAGE = 24 * 60 * 60 * 1000
const nutzungVon = (id: string, auftrag: string, geladen: string[], zuletzt: number, extra: object = {}) => ({
  sessionId: id, kennung: 'aaaaaaaa', name: 'bau', auftrag, zugewiesen: [], ergebnis: 'fertig', zuletzt,
  geladen: geladen.map(skill => ({ skill, zeit: zuletzt })), ...extra,
})

function skillWelt(on: any, nutzung: Record<string, object>, hinweise: Record<string, object>, geschrieben: Record<string, string>, istMaster: boolean | null = false) {
  welt(on, {}, geschrieben, istMaster, { nutzung, hinweise })
  on('command.list', () => ({
    value: [
      { name: 'help', description: 'Hilfe', source: 'builtin' },
      { name: 'commit', description: 'Commit schreiben', source: 'user' },
      { name: 'plugin-authoring', description: 'Mods bauen', source: 'plugin' },
      { name: 'mcp__x__prompt', description: 'MCP', source: 'mcp' },
      { name: 'alt', description: 'Nie genutzt', source: 'user' },
    ],
  }))
  on('tool.call', () => ({ result: {} }))
}

const lage = async ($: any) => JSON.parse(((await $.tool.call({ tool: 'mcp__dirigent__skills_lage' } as any)) as any).result)

test('skills_lage zählt Nutzung, nennt Aufträge ohne Skill und Hinweise, räumt aber erst nach 30 Tagen auf', async ($, on) => {
  skillWelt(on, {
    'a.json': nutzungVon('a', 'Mod bauen', ['commit', 'plugin-authoring'], JETZT - 5 * TAGE),
    'b.json': nutzungVon('b', 'Texte kürzen', [], JETZT - 2 * TAGE),
    'c.json': nutzungVon('c', 'Texte glätten', [], JETZT - 1 * TAGE, { zugewiesen: ['commit'] }),
  }, { 'h.json': { skill: 'commit', art: 'korrektur', text: 'Stil', zeit: JETZT - TAGE } }, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const l = await lage($)
  const commit = l.skills.find((s: any) => s.name === 'commit')
  expect(l.skills.map((s: any) => s.name).sort()).toEqual(['alt', 'commit', 'plugin-authoring'])
  expect(commit).toMatchObject({ geladen: 1, fertig: 1, letzteNutzungVorTagen: 5, zugewiesenNichtGeladen: 1, offeneHinweise: 1 })
  expect(l.auftraegeOhneSkill.map((a: any) => a.auftrag).sort()).toEqual(['Texte glätten', 'Texte kürzen'])
  expect(l.hinweise).toHaveLength(1)
  expect(l.aufraeumKandidaten).toEqual([])
})

test('nach 30 Tagen Protokoll nennt skills_lage ungenutzte Skills zum Aufräumen', async ($, on) => {
  skillWelt(on, { 'a.json': nutzungVon('a', 'Mod bauen', ['commit', 'plugin-authoring'], JETZT - 40 * TAGE) }, {}, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const l = await lage($)
  expect(l.protokollSeitTagen).toBe(40)
  expect(l.aufraeumKandidaten.sort()).toEqual(['alt', 'commit', 'plugin-authoring'])
})

test('skill.prompt schreibt Protokoll und Stand einer Arbeits-Session', async ($, on) => {
  const geschrieben: Record<string, string> = {}
  skillWelt(on, {}, {}, geschrieben)
  on('skill.prompt', () => ({ text: 'Skilltext' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const antwort = await $.skill.prompt({ skill: 'commit', text: '' })
  expect(antwort.text).toBe('Skilltext')
  await $.skill.prompt({ skill: 'commit', text: '' })
  const nutzung = JSON.parse(geschrieben[`/h/.claude/dirigent/skills/nutzung/${ID}.json`])
  expect(nutzung.geladen.map((g: any) => g.skill)).toEqual(['commit'])
  expect(nutzung).toMatchObject({ sessionId: ID, kennung: 'bbbbbbbb', name: 'bau', ergebnis: 'fertig' })
  const stand = JSON.parse(geschrieben[`/h/.claude/dirigent/stand/bbbbbbbb-${ID}.json`])
  expect(stand.geladen).toEqual(['commit'])
})

test('eine Session ohne Dirigent und ohne Skill schreibt kein Protokoll', async ($, on) => {
  const geschrieben: Record<string, string> = {}
  skillWelt(on, {}, {}, geschrieben, null)
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'hallo' } as any)
  expect(Object.keys(geschrieben).filter(p => p.includes('/skills/'))).toEqual([])
})

test('der Auftrag legt die zugewiesenen Skills fest, "keiner" weist nichts zu', async ($, on) => {
  const geschrieben: Record<string, string> = {}
  skillWelt(on, {}, {}, geschrieben)
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  const stand = () => JSON.parse(geschrieben[`/h/.claude/dirigent/stand/bbbbbbbb-${ID}.json`])
  const nutzung = () => JSON.parse(geschrieben[`/h/.claude/dirigent/skills/nutzung/${ID}.json`])
  await $.prompt.submit({ text: '⟦dirigent:bau＠bbbbbbbb⟧ Auftrag\nAufgabe: Mod bauen\nSkills: plugin-authoring, commit\nOrt: x' } as any)
  expect(stand().zugewiesen).toEqual(['plugin-authoring', 'commit'])
  expect(nutzung()).toMatchObject({ auftrag: 'Mod bauen', zugewiesen: ['plugin-authoring', 'commit'] })

  await $.prompt.submit({ text: '⟦dirigent:bau＠bbbbbbbb⟧ Auftrag\nAufgabe: Texte kürzen\nSkills: keiner\nOrt: x' } as any)
  expect(stand().zugewiesen).toEqual([])
  await $.prompt.submit({ text: '⟦dirigent:bau＠bbbbbbbb⟧ Folge\nAufgabe: Weiter\nSkills: commit' } as any)
  await $.prompt.submit({ text: '⟦dirigent:bau＠bbbbbbbb⟧ Noch eine Frage ohne Skill-Zeile' } as any)
  expect(stand().zugewiesen).toEqual(['commit'])
})

test('skill_hinweis schreibt eine Datei und lässt den Skill unberührt', async ($, on) => {
  const geschrieben: Record<string, string> = {}
  skillWelt(on, {}, {}, geschrieben, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__dirigent__skill_hinweis', skill: 'commit', art: 'korrektur', text: 'Betreff zu lang' } as any)
  const pfade = Object.keys(geschrieben)
  expect(pfade).toEqual([`/h/.claude/dirigent/skills/hinweise/${JETZT}-commit.json`])
  expect(JSON.parse(geschrieben[pfade[0]])).toMatchObject({ skill: 'commit', art: 'korrektur', text: 'Betreff zu lang', zeit: JETZT })
})

test('skill_hinweis ohne gültigen Skill-Namen schreibt nichts', async ($, on) => {
  const geschrieben: Record<string, string> = {}
  skillWelt(on, {}, {}, geschrieben, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__dirigent__skill_hinweis', skill: '../x', art: 'fehler', text: 'a' } as any)
  await $.tool.call({ tool: 'mcp__dirigent__skill_hinweis', skill: 'commit', art: 'fehler', text: '  ' } as any)
  expect(geschrieben).toEqual({})
})

test('skills_ausblenden lehnt Sonderzeichen ab und ändert nichts', async ($, on) => {
  const geschrieben: Record<string, string> = {}
  skillWelt(on, {}, {}, geschrieben, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const antwort = async (skills: string[]) => JSON.parse((await $.tool.call({ tool: 'mcp__dirigent__skills_ausblenden', skills } as any) as any).result)
  const schlecht = await antwort(['x"; rm -rf ~ #', '$(boese)'])
  expect(schlecht.befehl).toBeNull()
  expect(schlecht.abgelehnt).toHaveLength(2)
  const gemischt = await antwort(['alt', 'a b'])
  expect(gemischt.befehl).toContain('"alt":"name-only"')
  expect(gemischt.befehl).not.toContain('a b')
  expect(gemischt.abgelehnt).toEqual(['a b'])
  expect(Object.keys(geschrieben).filter(p => !p.includes('/dirigent/'))).toEqual([])
})

test('das Band zeigt [name] für geladene und [name?] für nicht geladene Skills', async ($, on) => {
  const text = await zeilenVon($, on, {
    'aaaaaaaa-1.json': { ...stand('bau', 'arbeitet', [{ text: 'Eins', status: 'in_progress' }]), geladen: ['commit'], zugewiesen: ['commit'] },
    'aaaaaaaa-2.json': { ...stand('text', 'arbeitet', [{ text: 'Zwei', status: 'in_progress' }]), zugewiesen: ['schreiben'] },
    'aaaaaaaa-3.json': stand('roh', 'arbeitet', [{ text: 'Drei', status: 'in_progress' }]),
  }, 80)
  expect(text).toContain('bau [commit] ▱')
  expect(text).toContain('text [schreiben?] ▱')
  expect(text).toContain('roh ▱')
  expect(text).not.toMatch(/roh \[/)
})

// --- Master benennen ---

test('master_benennen kürzt den Namen, entfernt ein doppeltes 🎼 und setzt den Titel', async ($, on) => {
  const gesetzt: Record<string, any> = {}
  const aufrufe: any[] = []
  welt(on, {}, {}, true, undefined, undefined, gesetzt)
  on('mcp.call', (_: any, e: any) => {
    aufrufe.push(e)
    return { value: { content: [], isError: false } }
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const lang = '🎼 ' + 'x'.repeat(60)
  const antwort = ((await $.tool.call({ tool: 'mcp__dirigent__master_benennen', projekt: lang } as any)) as any).result
  const projekt = gesetzt['master:aaaaaaaa'].projekt as string
  expect(projekt).toBe('x'.repeat(39) + '…')
  expect(projekt.length).toBe(40)
  expect(projekt).not.toContain('🎼')
  expect(antwort).toContain(`🎼 ${projekt}`)
  const titel = aufrufe.find(a => a.tool === 'set_session_title')
  expect(titel.args).toEqual({ session_id: 'self', title: `🎼 ${projekt}` })
})

test('kann die Mod den Titel nicht setzen, nennt das Werkzeug den fertigen Titel', async ($, on) => {
  welt(on, {})
  on('mcp.call', () => {
    throw new Error('nicht verbunden')
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const antwort = ((await $.tool.call({ tool: 'mcp__dirigent__master_benennen', projekt: 'Musik' } as any)) as any).result
  expect(antwort).toContain('"🎼 Musik"')
  expect(antwort).toContain('selbst')
})

test('das Band zeigt den Projektnamen, ein Master ohne Namen zeigt Dirigent', async ($, on) => {
  welt(on, {}, {}, true, undefined, 'Musik')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAND)
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  expect(text).toContain('🎼 Musik')
  expect(text).not.toContain('🎼 Dirigent')
  await ui.unmount()
})

test('ein Master ohne Namen zeigt 🎼 Dirigent', async ($, on) => {
  const text = await zeilenVon($, on, {}, 80)
  expect(text).toContain('🎼 Dirigent')
})
