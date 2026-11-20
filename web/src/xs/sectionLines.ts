// The exact places of a reach's cross-sections, for a reach popup's small map (the owner, 2026-11-20):
// each section's middle and its two ends, from the grid's own position and direction (`sectionPulls`,
// release format 3) and its sampled half-width, projected from EPSG:5070. Loaded only with a popup,
// with projExact, so neither weighs on the main bundle.
import type { XsPull } from './grid'
import { albersToLonLat } from './projExact'
import type { ReachSection } from './reach'

export type LatLon = [number, number]

/** A section's middle and its ends (lat, lon) at -wide and +wide. full: the sampled width; else a stub. */
export interface SectionLine { mid: LatLon, a: LatLon, b: LatLon, full: boolean }

/** A stub's half-length where the sampled width is unknown, m. */
const STUB_M = 10

function latLon(x: number, y: number): LatLon {
  const [lon, lat] = albersToLonLat(x, y)
  return [lat, lon]
}

/** A section's line from its grid position and direction, across its sampled half-width (m). */
export function lineOf(p: Pick<XsPull, 'x' | 'y' | 'nx' | 'ny'>, wide: number | null): SectionLine {
  const full = wide !== null && wide > 0
  const w = full ? wide : STUB_M
  return { mid: latLon(p.x, p.y), a: latLon(p.x - p.nx * w, p.y - p.ny * w), b: latLon(p.x + p.nx * w, p.y + p.ny * w), full }
}

/** Each section's line, in the reach's order: null where the grid has no place for it, and null for all
 * when no stream line has places (a release before format 3). pullsOf reads one stream line's places;
 * a line that fails leaves only its own sections out. */
export async function sectionLines(sections: readonly ReachSection[],
  pullsOf: (vpu: string, id: bigint) => Promise<XsPull[] | null>): Promise<(SectionLine | null)[] | null> {
  const lines = new Map<string, { vpu: string, id: bigint }>()
  for (const s of sections) lines.set(`${s.vpu}:${s.id}`, { vpu: s.vpu, id: s.id })
  const byKey = new Map<string, XsPull>()
  let any = false
  await Promise.all([...lines].map(async ([line, { vpu, id }]) => {
    const pulls = await Promise.resolve().then(() => pullsOf(vpu, id)).catch(() => null)
    if (!pulls) return
    any = true
    // k starts again on each line: a section is known by its line, part and k
    for (const p of pulls) byKey.set(`${line}:${p.part}:${p.k}`, p)
  }))
  if (!any) return null
  return sections.map((s) => {
    const p = byKey.get(`${s.vpu}:${s.id}:${s.num.part}:${s.k}`)
    return p ? lineOf(p, s.det?.wide ?? null) : null
  })
}
