// A stored cross-section from STAF's browser layout (the same Hugging Face dataset): the national
// grid keeps one exact profile per stream line (`xs/xs-<vpu>-median.parquet`, STAF's
// tools/xs-grid/xsgrid/release.py), the line's median section. Read on request for a reach's card.
// The decoding is STAF's (apps/staf-web/src/xs/codec.ts, copied): each float32 as an
// order-preserving uint32, then second differences in wrap-around arithmetic.
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

/** float32 samples from the stored int32 codes (two cumulative sums mod 2^32, then the key undone). */
export function decode(codes: ArrayLike<number>): Float32Array {
  const n = codes.length
  const k = new Uint32Array(n)
  let acc = 0
  for (let i = 0; i < n; i++) {
    acc = (acc + (codes[i] >>> 0)) >>> 0
    k[i] = acc
  }
  acc = 0
  for (let i = 0; i < n; i++) {
    acc = (acc + k[i]) >>> 0
    k[i] = acc
  }
  for (let i = 0; i < n; i++) {
    const v = k[i]
    k[i] = (v & 0x80000000 ? v ^ 0x80000000 : ~v) >>> 0
  }
  return new Float32Array(k.buffer)
}

/** `numpy.linspace(-wide, wide, n)`: `i * step + start`, the last exactly `stop`. */
export function stations(wide: number, n: number): Float64Array {
  const out = new Float64Array(n)
  if (n === 1) {
    out[0] = -wide
    return out
  }
  const step = (2 * wide) / (n - 1)
  for (let i = 0; i < n; i++) out[i] = i * step - wide
  out[n - 1] = wide
  return out
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
