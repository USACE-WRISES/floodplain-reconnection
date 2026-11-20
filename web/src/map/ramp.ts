// The map's colors: continuous ramps for the two ratios (no condition classes: the colors run with
// the raw value), and the colors of the Sites view.

/** Blue (connected) to red (incised), the ramp of the project's decks (1.0 to 2.0). */
export const RAMP = ['#3e7cb1', '#9cc3d5', '#e9c46a', '#d9822b', '#a63d2a']
/** A median bank height ratio that reads "at least 2.00". */
export const AT_CAP = '#6e2418'
/** A reach with no value to color: too little data, or not sampled (one gray: the owner, 2026-11-20). */
export const NO_DATA = '#a3acb9'

/** The Sites view draws two kinds of reach (the owner, 2026-11-20): in a candidate site, a gap the site
 * bridges included, or not. */
export const MATCH = {
  site: '#c2410c',
  /** a dark neutral: the basemap draws its own streams in light blue */
  other: '#5b6678',
} as const

export interface RampSpec {
  key: 'bhr' | 'er'
  title: string
  lo: number
  hi: number
  /** true: high values are blue (ER), false: high values are red (BHR) */
  highIsBlue: boolean
  loLabel: string
  hiLabel: string
}

export const RAMPS: Record<'bhr' | 'er', RampSpec> = {
  bhr: { key: 'bhr', title: 'Bank height ratio, reach median', lo: 1, hi: 2, highIsBlue: false, loLabel: '1.0 connected', hiLabel: '2.0 incised' },
  er: { key: 'er', title: 'Entrenchment ratio, reach median', lo: 1, hi: 3, highIsBlue: true, loLabel: '1.0 confined', hiLabel: '3.0 or more wide' },
}

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
}

function mix(a: string, b: string, t: number): string {
  const x = hex(a)
  const y = hex(b)
  const v = x.map((ai, i) => Math.round(ai + (y[i] - ai) * t))
  return '#' + v.map((n) => n.toString(16).padStart(2, '0')).join('')
}

/** The ramp's color at fraction t (0 to 1). */
export function rampColor(t: number): string {
  const u = Math.max(0, Math.min(1, t)) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(u))
  return mix(RAMP[i], RAMP[i + 1], u - i)
}

/** Bins a ramp is drawn in (one stroke per bin). */
export const BINS = 24

export function binOf(spec: RampSpec, value: number): number {
  let t = (value - spec.lo) / (spec.hi - spec.lo)
  if (spec.highIsBlue) t = 1 - t
  return Math.max(0, Math.min(BINS - 1, Math.floor(Math.max(0, Math.min(1, t)) * BINS)))
}

export function binColor(bin: number): string {
  return rampColor((bin + 0.5) / BINS)
}

/** CSS gradient of a ramp, as its legend draws it. */
export function rampGradient(spec: RampSpec): string {
  const stops = spec.highIsBlue ? [...RAMP].reverse() : RAMP
  return `linear-gradient(to right, ${stops.join(', ')})`
}
