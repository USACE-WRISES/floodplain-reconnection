// A reach's cross-sections from STAF's browser layout: the sections the reach layer cut the reach from
// (data/fprdata/region.py), line `id` from section `k0`, then on down the stream lines it continues
// into, `n` in all. The next line is the one the current line flows into (STAF's topology file,
// `topo/hr_<vpu>.parquet`: row + dn_step), read only for a reach on more than one line (about one reach
// in five to ten). Each section comes with the grid's numbers, what drawing or pulling it needs, and
// whether the release stores its profile (one per line).
import { readColumns, readObjectsWhere } from '../data/parquet'
import type { DataSource } from '../data/source'
import { sectionDetails, sectionNumbers, type XsNumbers, type XsSection } from './grid'
import { pyRound, pyRoundTo } from './pyfixed'

export interface ReachSection {
  vpu: string
  /** the stream line and the section's index along it (upstream to downstream) */
  id: bigint
  k: number
  /** where it sits along the reach, 0 to 1 (its middle) */
  at: number
  num: XsNumbers
  det: XsSection | null
  /** the release stores this section's profile */
  stored: boolean
}

export type ReachSections =
  | { ok: true, sections: ReachSection[] }
  /** region: the data host has no cross-sections for the region; short: the walk found fewer sections */
  | { ok: false, reason: 'region' | 'short' }

const SCORED = new Set(['ok', 'ok_reference'])

/** Whether a section has the grid's numbers (scored). */
export function scored(s: ReachSection): boolean {
  return SCORED.has(s.num.status) && s.num.er !== null && s.num.bhr !== null
}

/** A section's flood-prone width for the map, m (fpw10: m x 10, the grid's, an edit's or one being
 * dragged): null when it has none, or when its lowest ground lies away from this stream, farther than
 * half the width and 15 m, so the width is another low spot's (the owner, 2026-11-20). */
export function floodWidthM(s: ReachSection, fpw10: number | null): number | null {
  if (fpw10 === null || !(fpw10 > 0)) return null
  const w = fpw10 / 10
  const d = s.det
  if (d && d.thalwegI !== null && d.nPts > 1) {
    const t = -d.wide + d.thalwegI * ((2 * d.wide) / (d.nPts - 1))
    if (Math.abs(t) > Math.max(w / 2, 15)) return null
  }
  return w
}

/** Whether a section can be pulled from USGS 3DEP: its tiles and read grids are recorded. */
export function pullable(s: ReachSection): boolean {
  return Boolean(s.det && s.det.tiles && s.det.reads.length && s.num.res > 0)
}

const topos = new Map<string, Promise<{ ids: Float64Array, dn: Int32Array }>>()

function topoOf(src: DataSource, vpu: string): Promise<{ ids: Float64Array, dn: Int32Array }> {
  let got = topos.get(vpu)
  if (!got) {
    got = readColumns(src, `topo/hr_${vpu}.parquet`, ['nhdplusid', 'dn_step'], 0, undefined, { nhdplusid: 'f64', dn_step: 'i32' })
      .then((t) => ({ ids: t.nhdplusid as Float64Array, dn: t.dn_step as Int32Array }))
    got.catch(() => topos.delete(vpu))
    topos.set(vpu, got)
  }
  return got
}

/** The stored profile's section of a line ({part, k}), or null: the key columns only. */
async function storedKey(src: DataSource, vpu: string, id: bigint): Promise<{ part: number, k: number } | null> {
  const logical = `xs/xs-${vpu}-median.parquet`
  if (!src.has(logical)) return null
  const rows = await readObjectsWhere(src, logical, ['nhdplusid', 'part', 'k'], { nhdplusid: { $eq: id } })
  const r = rows.find((o) => BigInt(o.nhdplusid) === id)
  return r ? { part: Number(r.part), k: Number(r.k) } : null
}

/** A reach's sections, in order from its upstream end. */
export async function reachSections(src: DataSource, vpu: string, id: number, k0: number, n: number): Promise<ReachSections> {
  await src.ready()
  if (!src.has(`xs/xs-${vpu}.parquet`) || !src.has(`xs/xs-${vpu}-sections.parquet`)) return { ok: false, reason: 'region' }
  const out: ReachSection[] = []
  let line = BigInt(id)
  let from = k0
  for (let hop = 0; hop < 64 && out.length < n; hop++) {
    const [nums, dets, key] = await Promise.all([sectionNumbers(src, vpu, line), sectionDetails(src, vpu, line), storedKey(src, vpu, line)])
    const byK = new Map(dets.map((d) => [`${d.part}:${d.k}`, d]))
    for (const s of nums) {
      if (s.k < from || out.length >= n) continue
      out.push({ vpu, id: line, k: s.k, at: 0, num: s, det: byK.get(`${s.part}:${s.k}`) ?? null,
        stored: key !== null && key.part === s.part && key.k === s.k })
    }
    if (out.length >= n) break
    // on into the line this one flows into
    const t = await topoOf(src, vpu)
    const target = Number(line)
    let row = -1
    for (let r = 0; r < t.ids.length; r++) {
      if (t.ids[r] === target) {
        row = r
        break
      }
    }
    if (row < 0 || t.dn[row] === 0) break
    line = BigInt(t.ids[row + t.dn[row]])
    from = 0
  }
  if (out.length !== n) return { ok: false, reason: 'short' }
  out.forEach((s, i) => {
    s.at = (i + 0.5) / n
  })
  return { ok: true, sections: out }
}

/** The median of ratios x100 as the reach layer's builder takes it (data/fprdata/stats.py ratio_stats:
 * Python's round(statistics.median(values / 100), 2), x100). */
export function ratioMedian(x100: number[]): number | null {
  const v = [...x100].sort((a, b) => a - b)
  const n = v.length
  if (!n) return null
  if (n % 2) return v[(n - 1) / 2]
  const a = v[n / 2 - 1] / 100
  const b = v[n / 2] / 100
  return pyRound(pyRoundTo((a + b) / 2, 2) * 100)
}

/** The plain median then rint, as the builder takes widths, depths and the low-bank height. */
export function plainMedian(values: number[]): number | null {
  const v = [...values].sort((a, b) => a - b)
  const n = v.length
  if (!n) return null
  return pyRound(n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2)
}
