export type BandZeile = {
  name: string
  zustand: 'arbeitet' | 'wartet' | 'fertig'
  zeichen: string
  /** Erledigte Schritte in Prozent; null, solange die Session keine Liste hat. */
  prozent: number | null
  /** Skill der Session: `[name]` geladen, `[name?]` zugewiesen, aber noch nicht geladen. */
  skill?: string
  /** Steht ungekürzt vor dem Text, zum Beispiel wie lange eine Session schon still ist. */
  vorsatz?: string
  text: string
}

export type BandKonflikt = {
  datei: string
  sessions: string[]
}

export type BandStand = {
  /** Was der Dirigent selbst gerade tut (aktueller Schritt seiner Liste), falls bekannt. */
  eigenerSchritt: string
  zeilen: BandZeile[]
  /** Name des übergeordneten Projekts; fehlt, solange der Master nicht benannt ist. */
  projekt?: string
  /** Anzahl offener Punkte aus `~/.claude/dirigent/offen/`. */
  offen?: number
  /** 5-Stunden-Limit in Prozent; fehlt, wenn die Abfrage scheitert. */
  limit?: number
  /** Dateien, die mehrere noch nicht geprüfte Sessions dieses Masters geändert haben. */
  konflikte?: BandKonflikt[]
}

declare module 'claude-code' {
  interface PluginState {
    dirigent: { band: BandStand | null }
  }
}
