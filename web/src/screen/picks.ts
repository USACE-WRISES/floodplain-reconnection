// Picked reaches: a study area made of the reaches a team already has in mind (the owner, 2026-11-19),
// clicked one at a time or taken a box at a time. Pure helpers, so the tests can hold them.
import { mercX, mercY, Q_UNSAMPLED, reachId, type UnitFile } from '../data/units'
import { boxMask, refOf, rowOf, type Network, type Ref } from './model'

/** Picked reaches by reach id ("<nhdplusid>-<k0>"). The Refs stay valid: the network only adds files. */
export type Picks = Map<string, Ref>

/** A line that was not sampled has no values to screen, so it is never picked. */
export function pickable(net: Network, ref: Ref): boolean {
  return net.file(ref).q[rowOf(ref)] !== Q_UNSAMPLED
}

/** Adds the reach, or takes it out when it is picked already. */
export function togglePick(net: Network, picks: Picks, ref: Ref): 'added' | 'removed' | 'not sampled' {
  const id = reachId(net.file(ref), rowOf(ref))
  if (picks.delete(id)) return 'removed'
  if (!pickable(net, ref)) return 'not sampled'
  picks.set(id, ref)
  return 'added'
}

/** Adds every pickable reach whose line runs through a box (Web Mercator units, x0 < x1 and y0 < y1,
 * y growing southward), or, with `exact` off, whose extent meets it (as version 0.2's drawn box took
 * them). Returns how many were added. */
export function addBox(net: Network, picks: Picks, x0: number, y0: number, x1: number, y1: number, exact = true): number {
  const masks = boxMask(net, x0, y0, x1, y1)
  let added = 0
  net.files.forEach((f, fi) => {
    const m = masks[fi]
    for (let r = 0; r < f.rows; r++) {
      if (!m[r] || f.q[r] === Q_UNSAMPLED || (exact && !lineMeetsBox(f, r, x0, y0, x1, y1))) continue
      const id = reachId(f, r)
      if (picks.has(id)) continue
      picks.set(id, refOf(fi, r))
      added++
    }
  })
  return added
}

/** The picks a box saved by version 0.2 makes (degrees: west, south, east, north): every reach whose
 * extent meets it, as 0.2 screened it, so the screening opens with the numbers it was saved with. */
export function picksFromBox(net: Network, box: [number, number, number, number]): Picks {
  const [w, s, e, n] = box
  const picks: Picks = new Map()
  addBox(net, picks, mercX(w), mercY(n), mercX(e), mercY(s), false)
  return picks
}

/** The picks as a screening file holds them: by HUC8 then reach id, whatever order they were picked in. */
export function savedPicks(net: Network, picks: Picks): { huc8: string, id: string }[] {
  return [...picks].map(([id, ref]) => ({ huc8: net.file(ref).huc8, id }))
    .sort((a, b) => a.huc8.localeCompare(b.huc8) || a.id.localeCompare(b.id, 'en', { numeric: true }))
}

/** Picks from a saved list. The ids the loaded files no longer hold (or no longer sample) are missing. */
export function resolvePicks(net: Network, saved: { huc8: string, id: string }[]): { picks: Picks, missing: number } {
  const want = new Set(saved.map((s) => s.id))
  const files = new Set(saved.map((s) => s.huc8))
  const picks: Picks = new Map()
  net.files.forEach((f, fi) => {
    if (!files.has(f.huc8)) return
    for (let r = 0; r < f.rows; r++) {
      if (f.q[r] === Q_UNSAMPLED) continue
      const id = reachId(f, r)
      if (want.has(id)) picks.set(id, refOf(fi, r))
    }
  })
  return { picks, missing: want.size - picks.size }
}

/** The HUC8 files the picks come from. */
export function pickedFiles(net: Network, picks: Picks): string[] {
  return [...new Set([...picks.values()].map((ref) => net.file(ref).huc8))].sort()
}

/** Whether row r's line passes through the box: a segment crossing it, or a lone vertex inside it. */
function lineMeetsBox(f: UnitFile, r: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const a = f.off[r]
  const b = f.off[r + 1]
  if (b - a === 1) return f.mx[a] >= x0 && f.mx[a] <= x1 && f.my[a] >= y0 && f.my[a] <= y1
  for (let v = a; v < b - 1; v++) {
    if (segmentMeetsBox(f.mx[v], f.my[v], f.mx[v + 1], f.my[v + 1], x0, y0, x1, y1)) return true
  }
  return false
}

/** Liang and Barsky's clip: whether the segment from (ax, ay) to (bx, by) meets the box. */
function segmentMeetsBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay)
}
