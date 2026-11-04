export type BandZeile = {
  name: string
  zustand: 'arbeitet' | 'wartet' | 'fertig'
  zeichen: string
  /** Erledigte Schritte in Prozent; null, solange die Session keine Liste hat. */
  prozent: number | null
  /** Steht ungekürzt vor dem Text, zum Beispiel wie lange eine Session schon still ist. */
  vorsatz?: string
  text: string
}

export type BandStand = {
  /** Was der Dirigent selbst gerade tut (aktueller Schritt seiner Liste), falls bekannt. */
  eigenerSchritt: string
  zeilen: BandZeile[]
}

declare module 'claude-code' {
  interface PluginState {
    dirigent: { band: BandStand | null }
  }
}
