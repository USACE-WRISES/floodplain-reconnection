// A stored cross-section from STAF's browser layout (the same Hugging Face dataset): the national
// grid keeps one exact profile per stream line (`xs/xs-<vpu>-median.parquet`, STAF's
// tools/xs-grid/xsgrid/release.py), the line's median section. Read on request for a site's card.
// The decoding is STAF's (xs/codec.ts).
import { decode, stations } from '../xs/codec'
import { readObjectsWhere } from './parquet'
import type { DataSource } from './source'

export interface StoredProfile {
  nhdplusid: number
  k: number
  /** DEM cell size, m */
  res: number
  /** half-width of the sampled line, m */
  wide: number
  /** elevations, m (NaN where none) */
  z: Float32Array
  /** stations, m from the line's center */
  s: Float64Array
  thalweg: number | null
  thalwegI: number | null
  /** bankfull and low-bank heights above the thalweg, m */
  bfM: number | null
  lbM: number | null
}

export function medianLogical(vpu: string): string {
  return `xs/xs-${vpu}-median.parquet`
}

/** The stored profile of line `nhdplusid` in region `vpu`, or null where STAF's copy has none. */
export async function storedProfile(src: DataSource, vpu: string, nhdplusid: number): Promise<StoredProfile | null> {
  await src.ready()
  const logical = medianLogical(vpu)
  if (!src.has(logical)) return null
  const id = BigInt(nhdplusid)
  const rows = await readObjectsWhere(src, logical,
    ['nhdplusid', 'part', 'k', 'res', 'wide_cm', 'n_pts', 'thalweg', 'thalweg_i', 'bf_m', 'lb_m', 'z'],
    { nhdplusid: { $eq: id } })
  const r = rows.find((o) => BigInt(o.nhdplusid) === id)
  if (!r) return null
  const z = decode(Int32Array.from(r.z as ArrayLike<number>))
  const wide = Number(r.wide_cm) / 100
  return {
    nhdplusid, k: Number(r.k), res: Number(r.res), wide, z, s: stations(wide, z.length),
    thalweg: r.thalweg ?? null, thalwegI: r.thalweg_i ?? null, bfM: r.bf_m ?? null, lbM: r.lb_m ?? null,
  }
}
