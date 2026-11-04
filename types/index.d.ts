export type BandZeile = {
  name: string
  zustand: 'arbeitet' | 'wartet' | 'fertig'
  fortschritt: string
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
