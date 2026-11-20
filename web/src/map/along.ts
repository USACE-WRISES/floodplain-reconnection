// Where a reach's cross-sections sit along its line, from the line alone (the owner, 2026-11-20: show
// where the sections that make a reach are). Section i of a reach of n sits at (i + 0.5)/n of the line's
// length, across it. That is within 0.7 m of the grid's own point on the 91% of reaches that lie on one
// stream line, and a few meters (at most 23 m) on reaches that run onto the next line, whose sections are
// spaced by each line's own count. The Cross-sections layer draws these (unitLayer.ts), and a reach
// popup's small map starts from them until the grid's exact places come (xs/sectionLines.ts). No Leaflet
// here, so the tests read it as it is.
import { latOf, lonOf, mercX, mercY, type UnitFile } from '../data/units'

export type LatLon = [number, number]
export type TickRows = Pick<UnitFile, 'rows' | 'n' | 'off' | 'mx' | 'my' | 'box'>

/** Places n sections along the line of vertices a to e (e excluded) of xs and ys: out[4i] and out[4i+1]
 * the place, out[4i+2] and out[4i+3] the unit direction of the line there (0, 0 on a line of no length).
 * Returns how many it placed: n, or 0 when n is below 1 or the line has fewer than two vertices. */
export function sectionsAlong(xs: ArrayLike<number>, ys: ArrayLike<number>, a: number, e: number, n: number, out: Float64Array): number {
  if (n < 1 || e - a < 2) return 0
  let total = 0
  for (let v = a; v < e - 1; v++) total += Math.hypot(xs[v + 1] - xs[v], ys[v + 1] - ys[v])
  let v = a
  let before = 0
  let seg = Math.hypot(xs[a + 1] - xs[a], ys[a + 1] - ys[a])
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * total
    // a segment of no length never holds a section
    while (v < e - 2 && (seg === 0 || before + seg < t)) {
      before += seg
      v++
      seg = Math.hypot(xs[v + 1] - xs[v], ys[v + 1] - ys[v])
    }
    const dx = xs[v + 1] - xs[v]
    const dy = ys[v + 1] - ys[v]
    const u = seg > 0 ? Math.min(1, Math.max(0, (t - before) / seg)) : 0
    out[4 * i] = xs[v] + u * dx
    out[4 * i + 1] = ys[v] + u * dy
    out[4 * i + 2] = seg > 0 ? dx / seg : 0
    out[4 * i + 3] = seg > 0 ? dy / seg : 0
  }
  return n
}

let scratch = new Float64Array(64)

/** Every section of every drawn row (a style id above 0, and sections) whose box meets the view box x0,
 * y0 to x1, y1 (Web Mercator): tick(x, y, ax, ay, fi, r), with (ax, ay) the unit vector across the line.
 * Returns how many. */
export function eachTick(files: readonly TickRows[], ids: readonly (ArrayLike<number> | undefined)[],
  x0: number, y0: number, x1: number, y1: number,
  tick: (x: number, y: number, ax: number, ay: number, fi: number, r: number) => void): number {
  let count = 0
  files.forEach((f, fi) => {
    const id = ids[fi]
    if (!id) return
    for (let r = 0; r < f.rows; r++) {
      const n = f.n[r]
      if (!id[r] || n < 1) continue
      const b = r * 4
      if (f.box[b] > x1 || f.box[b + 2] < x0 || f.box[b + 1] > y1 || f.box[b + 3] < y0) continue
      if (scratch.length < 4 * n) scratch = new Float64Array(4 * n)
      const got = sectionsAlong(f.mx, f.my, f.off[r], f.off[r + 1], n, scratch)
      for (let i = 0; i < got; i++) {
        const ux = scratch[4 * i + 2]
        const uy = scratch[4 * i + 3]
        if (ux === 0 && uy === 0) continue
        tick(scratch[4 * i], scratch[4 * i + 1], -uy, ux, fi, r)
        count++
      }
    }
  })
  return count
}

/** Meters in a degree of latitude, or of longitude at the equator (Web Mercator's sphere). */
const M_PER_DEG = 111319.49

/** A section's mark on a reach popup's small map: where it is, the angle across the stream (radians on
 * the screen, clockwise from east), its two ends when the grid's exact line is known, and the degrees of
 * latitude and longitude a meter across the stream takes, toward the left bank looking downstream (the
 * grid's +station side). */
export interface SectionMark { at: LatLon, angle: number, ends: [LatLon, LatLon] | null, exact: boolean, perM: LatLon }

/** The marks of a reach's n sections along its line, one per section (null where the line places none).
 * They have no ends: the line alone does not tell how wide the grid sampled. */
export function marksAlong(xs: ArrayLike<number>, ys: ArrayLike<number>, a: number, e: number, n: number): (SectionMark | null)[] {
  const out = new Float64Array(4 * Math.max(0, n))
  const got = sectionsAlong(xs, ys, a, e, n, out)
  const marks: (SectionMark | null)[] = []
  for (let i = 0; i < n; i++) {
    if (i >= got) {
      marks.push(null)
      continue
    }
    const ux = out[4 * i + 2]
    const uy = out[4 * i + 3]
    const lat = latOf(out[4 * i + 1])
    // left of the flow (ux, uy) on the screen, whose y runs south, is (uy, -ux): north is up
    const perM: LatLon = [ux / M_PER_DEG, uy / (M_PER_DEG * Math.cos((lat * Math.PI) / 180))]
    marks.push({ at: [lat, lonOf(out[4 * i])], angle: Math.atan2(ux, -uy), ends: null, exact: false, perM })
  }
  return marks
}

/** A mark from the grid's exact line: its middle, its two ends (lat, lon) at half meters each side,
 * and whether the ends are the sampled width (full) or a stub where the width is unknown. */
export function markOf(mid: LatLon, a: LatLon, b: LatLon, full: boolean, half: number): SectionMark {
  // Web Mercator and the screen both run y southward, so this is the angle on the screen
  const angle = Math.atan2(mercY(b[0]) - mercY(a[0]), mercX(b[1]) - mercX(a[1]))
  const perM: LatLon = half > 0 ? [(b[0] - mid[0]) / half, (b[1] - mid[1]) / half] : [0, 0]
  return { at: mid, angle, ends: full ? [a, b] : null, exact: true, perM }
}

/** A section's span of w meters across the stream, centered on its point: its right-bank end, then its
 * left-bank end. */
export function spanOf(m: SectionMark, w: number): [LatLon, LatLon] {
  const h = w / 2
  return [[m.at[0] - m.perM[0] * h, m.at[1] - m.perM[1] * h], [m.at[0] + m.perM[0] * h, m.at[1] + m.perM[1] * h]]
}

/** A reach's flood-prone area (the owner, 2026-11-20): each section's width across the stream, the ends
 * joined from section to section, down one bank and back up the other. A section with no width is
 * joined across. Empty when fewer than two sections have one. */
export function floodRing(marks: readonly (SectionMark | null)[], widths: readonly (number | null)[]): LatLon[] {
  const right: LatLon[] = []
  const left: LatLon[] = []
  marks.forEach((m, i) => {
    const w = widths[i]
    if (!m || w === null || w === undefined || !(w > 0)) return
    const [r, l] = spanOf(m, w)
    right.push(r)
    left.push(l)
  })
  return right.length < 2 ? [] : [...right, ...left.reverse()]
}

/** A reach's line as lat, lon points. */
export function latLngsOf(xs: ArrayLike<number>, ys: ArrayLike<number>, a: number, e: number): LatLon[] {
  const out: LatLon[] = []
  for (let v = a; v < e; v++) out.push([latOf(ys[v]), lonOf(xs[v])])
  return out
}
