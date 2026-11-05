import type { EngineInterface } from 'claude-code'

// Skill-Verwaltung des Dirigenten: Nutzung mitschreiben und auswerten. Alles bleibt in lokalen Dateien.
// Jede Session schreibt nur ihre eigene Datei, damit sich gleichzeitige Prozesse nicht überschreiben.
const WURZEL = '/.claude/dirigent/skills'
const TAG = 24 * 60 * 60 * 1000
const FRIST = 30 * TAG

export type Nutzung = {
  sessionId: string
  kennung: string | null
  name: string | null
  auftrag: string
  zugewiesen: string[]
  geladen: { skill: string; zeit: number }[]
  ergebnis: 'laeuft' | 'fertig' | 'pausiert'
  zuletzt: number
}

export type Hinweis = { skill: string; art: string; text: string; zeit: number }
export type SkillInfo = { name: string; description: string }
/** Eine eingebaute Skill-Änderung: ab `zeit` zählt alles als „nachher“; `sicherung` ist der Stand davor. */
export type Aenderung = { skill: string; zeit: number; sicherung: string }

// Unter so vielen Nutzungen je Seite ist eine Quote Zufall.
const GENUG_NUTZUNGEN = 5

// Liest aus einem Auftrag, was die Mod braucht: die Zeilen `Aufgabe:` und `Skills:`.
// `zugewiesen` ist null, wenn die Nachricht keine Zeile `Skills:` hat (eine Folgenachricht ändert dann nichts).
export function auftragLesen(text: string) {
  const aufgabe = /^Aufgabe:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
  const zeile = /^Skills:[ \t]*(.*)$/m.exec(text)?.[1]
  const zugewiesen =
    zeile === undefined
      ? null
      : zeile
          .split(',')
          .map(s => s.trim())
          .filter(s => s && !/^(keiner|keine|-)$/i.test(s))
  return { auftrag: aufgabe.slice(0, 160), zugewiesen }
}

function seite(nutzungen: Nutzung[], hinweise: Hinweis[], skill: string, von: number, bis: number) {
  const treffer = nutzungen.flatMap(n =>
    n.geladen.filter(g => g.skill === skill && g.zeit >= von && g.zeit < bis).map(() => n.ergebnis),
  )
  // Was noch läuft, hat kein Ergebnis und zählt nicht gegen den Skill.
  const beendet = treffer.filter(e => e !== 'laeuft')
  return {
    nutzungen: beendet.length,
    erfolgsquote: beendet.length ? Math.round((100 * beendet.filter(e => e === 'fertig').length) / beendet.length) : null,
    hinweise: hinweise.filter(h => h.skill === skill && h.zeit >= von && h.zeit < bis).length,
  }
}

// Vergleicht je Änderung die Nutzung seit der vorigen Änderung mit der bis zur nächsten.
export function wirkung(aenderungen: Aenderung[], nutzungen: Nutzung[], hinweise: Hinweis[]) {
  const sortiert = [...aenderungen].sort((a, b) => a.zeit - b.zeit)
  return sortiert.map(a => {
    const gleicherSkill = sortiert.filter(x => x.skill === a.skill)
    const nr = gleicherSkill.indexOf(a)
    const von = nr > 0 ? gleicherSkill[nr - 1].zeit : 0
    const bis = gleicherSkill[nr + 1]?.zeit ?? Number.MAX_SAFE_INTEGER
    const vorher = seite(nutzungen, hinweise, a.skill, von, a.zeit)
    const nachher = seite(nutzungen, hinweise, a.skill, a.zeit, bis)
    const genug = vorher.nutzungen >= GENUG_NUTZUNGEN && nachher.nutzungen >= GENUG_NUTZUNGEN
    const quote = (nachher.erfolgsquote ?? 0) - (vorher.erfolgsquote ?? 0)
    const hinweisRate = nachher.hinweise / Math.max(nachher.nutzungen, 1) - vorher.hinweise / Math.max(vorher.nutzungen, 1)
    const trend = !genug ? null : quote <= -10 || hinweisRate >= 0.2 ? 'schlechter' : quote >= 10 ? 'besser' : 'gleich'
    return {
      skill: a.skill,
      datum: new Date(a.zeit).toISOString().slice(0, 10),
      sicherung: a.sicherung,
      vorher,
      nachher,
      trend,
      ...(genug ? {} : { hinweis: `zu wenig Daten: je Seite braucht es ${GENUG_NUTZUNGEN} Nutzungen` }),
    }
  })
}

export function auswerten(skills: SkillInfo[], nutzungen: Nutzung[], hinweise: Hinweis[], jetzt: number, aenderungen: Aenderung[] = []) {
  const seit = nutzungen.reduce((frueh, n) => Math.min(frueh, n.geladen[0]?.zeit ?? n.zuletzt), jetzt)
  const tabelle = skills.map(skill => {
    const treffer = nutzungen.flatMap(n => n.geladen.filter(g => g.skill === skill.name).map(g => ({ ...g, ergebnis: n.ergebnis })))
    const letzte = treffer.reduce((spaet, t) => Math.max(spaet, t.zeit), 0)
    return {
      name: skill.name,
      beschreibung: skill.description.slice(0, 160),
      geladen: treffer.length,
      fertig: treffer.filter(t => t.ergebnis === 'fertig').length,
      letzteNutzungVorTagen: letzte ? Math.floor((jetzt - letzte) / TAG) : null,
      zugewiesenNichtGeladen: nutzungen.filter(n => n.zugewiesen.includes(skill.name) && !n.geladen.some(g => g.skill === skill.name)).length,
      offeneHinweise: hinweise.filter(h => h.skill === skill.name).length,
    }
  })
  return {
    protokollSeitTagen: Math.floor((jetzt - seit) / TAG),
    skills: tabelle,
    // Rohstoff für Lücken: Aufträge ohne geladenen Skill. Ob sie sich ähneln, beurteilt der Dirigent.
    auftraegeOhneSkill: nutzungen
      .filter(n => n.auftrag && n.geladen.length === 0 && jetzt - n.zuletzt < FRIST)
      .map(n => ({ auftrag: n.auftrag, vorTagen: Math.floor((jetzt - n.zuletzt) / TAG) })),
    hinweise: hinweise.map(h => ({ skill: h.skill, art: h.art, text: h.text, vorTagen: Math.floor((jetzt - h.zeit) / TAG) })),
    aenderungen: wirkung(aenderungen, nutzungen, hinweise),
    // Erst nach einem vollen Monat Protokoll aussagekräftig.
    aufraeumKandidaten:
      jetzt - seit < FRIST
        ? []
        : tabelle.filter(t => t.letzteNutzungVorTagen === null || t.letzteNutzungVorTagen * TAG >= FRIST).map(t => t.name),
  }
}

async function jsonDateien($: EngineInterface, ordner: string) {
  const liste: unknown[] = []
  if (!(await $.fs.exists(ordner))) return liste
  for (const datei of await $.fs.list(ordner)) {
    if (!datei.name.endsWith('.json')) continue
    try {
      liste.push(JSON.parse(await $.fs.read(`${ordner}/${datei.name}`)))
    } catch {
      // Eine halb geschriebene Datei zählt erst beim nächsten Mal.
    }
  }
  return liste
}

export async function nutzungSchreiben($: EngineInterface, nutzung: Nutzung) {
  try {
    const heim = await $.env.get('HOME')
    await $.fs.write(`${heim}${WURZEL}/nutzung/${nutzung.sessionId}.json`, JSON.stringify(nutzung))
  } catch {
    // Das Protokoll darf die Arbeit nie aufhalten.
  }
}

export async function hinweisSchreiben($: EngineInterface, hinweis: Hinweis) {
  const heim = await $.env.get('HOME')
  const name = `${hinweis.zeit}-${hinweis.skill.replace(/[^\w.-]/g, '_')}.json`
  await $.fs.write(`${heim}${WURZEL}/hinweise/${name}`, JSON.stringify(hinweis))
}

export async function aenderungSchreiben($: EngineInterface, aenderung: Aenderung) {
  const heim = await $.env.get('HOME')
  const name = `${aenderung.zeit}-${aenderung.skill.replace(/[^\w.-]/g, '_')}.json`
  await $.fs.write(`${heim}${WURZEL}/aenderungen/${name}`, JSON.stringify(aenderung))
}

// Das eigene Protokoll einer Session, um es nach einem Neustart fortzusetzen statt zu überschreiben.
export async function nutzungLesen($: EngineInterface, sessionId: string) {
  const heim = await $.env.get('HOME')
  const pfad = `${heim}${WURZEL}/nutzung/${sessionId}.json`
  if (!(await $.fs.exists(pfad))) return undefined
  return JSON.parse(await $.fs.read(pfad)) as Partial<Nutzung>
}

// Eine fortgesetzte Session bekommt eine neue Id. Ihr Protokoll zieht mit um; die alte Datei bleibt leer zurück,
// sonst zählten ihre Nutzungen doppelt und ihr Auftrag als „ohne Skill“.
export async function nutzungUmziehen($: EngineInterface, alteId: string, neueId: string) {
  const alt = await nutzungLesen($, alteId)
  if (!alt) return
  const heim = await $.env.get('HOME')
  if (!(await nutzungLesen($, neueId))) {
    await $.fs.write(`${heim}${WURZEL}/nutzung/${neueId}.json`, JSON.stringify({ ...alt, sessionId: neueId }))
  }
  await $.fs.write(`${heim}${WURZEL}/nutzung/${alteId}.json`, JSON.stringify({ ...alt, auftrag: '', zugewiesen: [], geladen: [] }))
}

export async function skillsLage($: EngineInterface) {
  const heim = await $.env.get('HOME')
  const jetzt = await $.clock.now()
  const befehle = await $.command.list()
  const skills = befehle
    .filter(c => (c.source as string) !== 'builtin' && (c.source as string) !== 'mcp')
    .map(c => ({ name: c.name, description: c.description }))
  const nutzungen = (await jsonDateien($, `${heim}${WURZEL}/nutzung`)) as Nutzung[]
  const hinweise = (await jsonDateien($, `${heim}${WURZEL}/hinweise`)) as Hinweis[]
  const aenderungen = (await jsonDateien($, `${heim}${WURZEL}/aenderungen`)) as Aenderung[]
  return auswerten(skills, nutzungen, hinweise, jetzt, aenderungen)
}

// Baut den Befehl, mit dem der Nutzer Skills selbst ausblendet. `name-only` lässt sie nutzbar,
// spart aber die Beschreibung im Kontext jeder Session. Die Mod ändert keine Einstellungen.
export function ausblendenBefehl(namen: unknown) {
  const liste = Array.isArray(namen) ? namen.map(String) : []
  const gueltig = liste.filter(n => /^[\w:.-]+$/.test(n))
  const abgelehnt = liste.filter(n => !gueltig.includes(n))
  if (gueltig.length === 0) return { befehl: null, abgelehnt }
  const eintraege = gueltig.map(n => `"${n}":"name-only"`).join(',')
  const datei = '~/.claude/settings.json'
  return {
    befehl: `cp ${datei} ${datei}.vor-skill-aufraeumen && jq '.skillOverrides = ((.skillOverrides // {}) + {${eintraege}})' ${datei} > ${datei}.neu && mv ${datei}.neu ${datei}`,
    abgelehnt,
  }
}
