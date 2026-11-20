// The Flood-prone area layer (the owner, 2026-11-20): a band along each reach as wide as its flood-prone
// width, the median of its cross-sections' (the reach files hold no section's own width; a reach's
// popup draws those). Each end of a reach's band takes the mean with its main-stem neighbor there, so
// the band widens or narrows from reach to reach with no steps. The data hold widths, not edges, so the
// band is centered on the stream. No Leaflet here, so the tests read it as it is.
import { Q_NODATA, type UnitFile } from '../data/units'

/** The layer draws from this zoom in: below it most bands are narrower than their reach's line. */
export const FLOOD_ZOOM = 13

export type BandRows = Pick<UnitFile, 'rows' | 'huc8' | 'fpw' | 'q' | 'dnRow' | 'dnHuc8' | 'main'>

/** Each row's band width in meters at its upstream end (a) and its downstream end (b), NaN where the
 * row has none (no flood-prone width, or too little data). An end meets a main-stem neighbor in the
 * same file halfway; a tributary's mouth, a reach's top and a neighbor in another file keep its own. */
export function bandWidths(f: BandRows): { a: Float32Array, b: Float32Array } {
  const n = f.rows
  const code = Number(f.huc8)
  const w = new Float32Array(n)
  for (let r = 0; r < n; r++) w[r] = f.q[r] < Q_NODATA && f.fpw[r] > 0 ? f.fpw[r] / 10 : Number.NaN
  // the next row down the main stem, in this file (-1: none)
  const down = (r: number): number => {
    const d = f.dnRow[r]
    return f.main[r] === 1 && d >= 0 && d < n && f.dnHuc8[r] === code ? d : -1
  }
  // the main-stem row that flows into each row
  const up = new Int32Array(n).fill(-1)
  for (let r = 0; r < n; r++) {
    const d = down(r)
    if (d >= 0) up[d] = r
  }
  const meet = (own: number, other: number): number => (Number.isFinite(own) && Number.isFinite(other) ? (own + other) / 2 : own)
  const a = new Float32Array(n)
  const b = new Float32Array(n)
  for (let r = 0; r < n; r++) {
    const d = down(r)
    a[r] = meet(w[r], up[r] >= 0 ? w[up[r]] : Number.NaN)
    b[r] = meet(w[r], d >= 0 ? w[d] : Number.NaN)
  }
  return { a, b }
}

/** Ground meters per CSS pixel at a latitude and zoom (Web Mercator, 256 px tiles). */
export function metersPerPixel(lat: number, zoom: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, zoom))
}
