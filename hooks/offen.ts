import type { EngineInterface } from 'claude-code'

// Offene Punkte des Dirigenten: Ideen, Fragen, Aufgaben und Entscheidungen aus dem Chat, die nicht verloren
// gehen sollen. Eine Datei je Dirigent, keine Session-Id darin: sie übersteht /clear und Neustart.
// Nur der Master schreibt, deshalb genügt lesen, ändern, ganz zurückschreiben.
const ORDNER = '/.claude/dirigent/offen'
const TEXT_MAX = 500
const IM_KONTEXT = 12
const IM_KONTEXT_TEXT = 100
const NACHHOLEN_MAX = 3

export const ARTEN = ['idee', 'frage', 'aufgabe', 'entscheidung'] as const
export type Art = (typeof ARTEN)[number]

export type Punkt = {
  id: string
  text: string
  art: Art
  /** `chat` oder der Name der Session, aus deren Schlussmeldung der Punkt stammt. */
  quelle: string
  zeit: number
  status: 'offen' | 'erledigt' | 'verworfen'
  grund?: string
  geschlossen?: number
}

export type OffenDatei = {
  punkte: Punkt[]
  /** Stellen aus Antworten, in deren Runde nichts gemerkt wurde; die nächste Nachricht erinnert daran. */
  nachholen: string[]
  /** Die Datei war nicht lesbar. Vor dem nächsten Schreiben wird ihr Inhalt zur Seite gelegt. */
  defekt?: string
}

export const offenDatei = (kennung: string) => `~/.claude/dirigent/offen/${kennung}.json`

function punkteLesen(roh: unknown): Punkt[] {
  if (!Array.isArray(roh)) return []
  const punkte: Punkt[] = []
  for (const eintrag of roh as Partial<Punkt>[]) {
    if (!eintrag || typeof eintrag.id !== 'string' || typeof eintrag.text !== 'string') continue
    punkte.push({
      ...eintrag,
      id: eintrag.id,
      text: eintrag.text,
      art: ARTEN.includes(eintrag.art as Art) ? (eintrag.art as Art) : 'idee',
      quelle: typeof eintrag.quelle === 'string' ? eintrag.quelle : 'chat',
      zeit: typeof eintrag.zeit === 'number' ? eintrag.zeit : 0,
      status: eintrag.status === 'erledigt' || eintrag.status === 'verworfen' ? eintrag.status : 'offen',
    })
  }
  return punkte
}

export async function offenLesen($: EngineInterface, kennung: string): Promise<OffenDatei> {
  const heim = await $.env.get('HOME')
  const pfad = `${heim}${ORDNER}/${kennung}.json`
  if (!(await $.fs.exists(pfad))) return { punkte: [], nachholen: [] }
  const roh = await $.fs.read(pfad)
  try {
    const wert = JSON.parse(roh) as { punkte?: unknown; nachholen?: unknown }
    return {
      punkte: punkteLesen(wert.punkte),
      nachholen: Array.isArray(wert.nachholen) ? wert.nachholen.filter(n => typeof n === 'string') : [],
    }
  } catch {
    return { punkte: [], nachholen: [], defekt: roh }
  }
}

export async function offenSchreiben($: EngineInterface, kennung: string, datei: OffenDatei) {
  const heim = await $.env.get('HOME')
  // Eine kaputte Datei kann noch lesbare Punkte enthalten; sie wird nie einfach überschrieben.
  if (datei.defekt !== undefined) {
    await $.fs.write(`${heim}${ORDNER}/${kennung}.defekt-${await $.clock.now()}.txt`, datei.defekt)
  }
  await $.fs.write(`${heim}${ORDNER}/${kennung}.json`, JSON.stringify({ punkte: datei.punkte, nachholen: datei.nachholen }))
}

export const nochOffen = (datei: OffenDatei) => datei.punkte.filter(p => p.status === 'offen')

const kuerzen = (text: string, max: number) => {
  const zeile = text.replace(/\s+/g, ' ').trim()
  return zeile.length > max ? `${zeile.slice(0, max - 1).trimEnd()}…` : zeile
}

// Vergibt die nächste Nummer; auch geschlossene Punkte zählen, damit eine Id nie zweimal vorkommt.
function naechsteId(punkte: Punkt[]) {
  const hoechste = punkte.reduce((max, p) => Math.max(max, Number(/^p(\d+)$/.exec(p.id)?.[1] ?? 0)), 0)
  return `p${hoechste + 1}`
}

export function punktMerken(datei: OffenDatei, ein: { text?: unknown; art?: unknown; quelle?: unknown }, zeit: number) {
  const text = String(ein.text ?? '').trim().slice(0, TEXT_MAX)
  if (!text) return { fehler: 'Nichts gemerkt: Text fehlt.' }
  if (!ARTEN.includes(ein.art as Art)) return { fehler: `Nichts gemerkt: art muss eine von ${ARTEN.join(', ')} sein.` }
  const gleich = nochOffen(datei).find(p => p.text.toLowerCase() === text.toLowerCase())
  if (gleich) return { punkt: gleich, schonDa: true }
  const quelle = kuerzen(String(ein.quelle ?? ''), 40) || 'chat'
  const punkt: Punkt = { id: naechsteId(datei.punkte), text, art: ein.art as Art, quelle, zeit, status: 'offen' }
  datei.punkte.push(punkt)
  return { punkt, schonDa: false }
}

export function punktSchliessen(datei: OffenDatei, ein: { id?: unknown; grund?: unknown; status?: unknown }, zeit: number) {
  const grund = String(ein.grund ?? '').trim().slice(0, 300)
  if (!grund) return { fehler: 'Nichts geschlossen: grund fehlt (Beleg für „erledigt“ oder das Wort des Nutzers).' }
  const punkt = datei.punkte.find(p => p.id === ein.id)
  if (!punkt) return { fehler: `Nichts geschlossen: Punkt ${String(ein.id)} gibt es nicht.` }
  if (punkt.status !== 'offen') return { fehler: `Punkt ${punkt.id} ist schon ${punkt.status}.` }
  punkt.status = ein.status === 'verworfen' ? 'verworfen' : 'erledigt'
  punkt.grund = grund
  punkt.geschlossen = zeit
  return { punkt }
}

// Kurzfassung für den Kontext jeder Nachricht. Der Nutzer sieht sie nicht; der Master soll sie sehen.
export function offenKontext(datei: OffenDatei, kennung: string) {
  const teile: string[] = []
  const offen = nochOffen(datei)
  if (offen.length > 0) {
    const zeilen = offen
      .slice(0, IM_KONTEXT)
      .map(p => `- ${p.id} [${p.art}${p.quelle === 'chat' ? '' : `, ${p.quelle}`}] ${kuerzen(p.text, IM_KONTEXT_TEXT)}`)
    const mehr = offen.length > IM_KONTEXT ? [`- … und ${offen.length - IM_KONTEXT} weitere (offen_liste)`] : []
    teile.push(
      [
        `Offene Punkte des Dirigenten (${offen.length}, Datei ${offenDatei(kennung)}). Nenne am Ende deiner Antwort die Anzahl in einer Zeile; passt die Nachricht zu einem Punkt oder klärt ihn, sag es.`,
        ...zeilen,
        ...mehr,
      ].join('\n'),
    )
  }
  if (datei.nachholen.length > 0) {
    teile.push(
      `Erinnerung der Mod (nur eine Stichwortprüfung): In deiner letzten Antwort stand etwas, das nach Vorschlag, Empfehlung oder offener Frage klingt, und in dieser Runde lief offen_merken nicht. Prüfe das und hole mit offen_merken nach, was wirklich offen ist; alles andere ignorieren. Stellen: ${datei.nachholen.map(n => `„${n}“`).join(' · ')}`,
    )
  }
  return teile
}

const ANZEICHEN =
  /\b(vorschlag|vorschläge\w*|vorschlagen|schlage\b.*\bvor|empfehl\w*|später|noch offen|bleibt offen|offene frage\w*|zurückgestellt|zurückstellen|könnten wir|sollten wir|sollen wir|nächste[rn]? schritte?|follow-?up|recommend\w*|suggest\w*|later)\b/i

// Findet die erste Stelle, die nach etwas Offenem klingt. Nur ein Hinweis an den Master, nie ein Eintrag:
// Code zählt nicht, und die Zeile mit der Anzahl (📌) auch nicht, sonst erinnerte sie an sich selbst.
export function offenAnzeichen(antwort: string) {
  const text = antwort
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter(zeile => !zeile.trim().startsWith('📌') && !zeile.trim().startsWith('>'))
    .join('\n')
  for (const satz of text.split(/(?<=[.!?…])\s+|\n+/)) {
    const klar = satz.trim()
    if (klar && (klar.endsWith('?') || ANZEICHEN.test(klar))) return kuerzen(klar, 120)
  }
  return null
}

export function nachholenAnfuegen(datei: OffenDatei, stelle: string) {
  if (!datei.nachholen.includes(stelle)) datei.nachholen = [...datei.nachholen, stelle].slice(-NACHHOLEN_MAX)
}
