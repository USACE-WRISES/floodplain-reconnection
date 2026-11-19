// A small synthetic network for the tests, in the reach file's columns (data/README.md).
//
//   t0 -> t1 \                (a tributary joining at m3)
//   m0 -> m1 -> m2 -> m3 -> m4 -> m5          (the main stem, downstream to the right)
//                b0 -> b1 -> m4             (a minor branch that splits from m1)
//
// Rows: m0..m5 are 0..5, t0, t1 are 6, 7, b0, b1 are 8, 9. Every row is 1,000 ft (304.8 m).
import { unpack, type UnitFile } from '../src/data/units'

export interface RowSpec {
  q?: number
  why?: number
  bhr?: number
  er?: number
  da?: number
  fclass?: number
  lbh?: number
}

export const M = [0, 1, 2, 3, 4, 5]
export const T = [6, 7]
export const B = [8, 9]

export function network(specs: RowSpec[], huc8 = '01010001'): UnitFile {
  const n = 10
  const code = Number(huc8)
  const dn = [1, 2, 3, 4, 5, -1, 7, 3, 9, 4]
  const main = [1, 1, 1, 1, 1, 0, 1, 0, 1, 0]
  const div = [-1, -1, -1, -1, -1, -1, -1, -1, 1, -1]
  const col = (f: (i: number) => number) => Float64Array.from({ length: n }, (_, i) => f(i))
  const i32 = (f: (i: number) => number) => Int32Array.from({ length: n }, (_, i) => f(i))
  const u8 = (f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i))
  const s = (i: number) => specs[i] ?? {}
  return unpack(huc8, {
    id: col((i) => 1000 + i), k0: i32(() => 0), n: i32(() => 10), vpu: Array(n).fill('0101'),
    len_m: col(() => 304.8), name: Array.from({ length: n }, (_, i) => (i < 6 ? 'Main Creek' : i < 8 ? 'Side Run' : '')),
    fclass: u8((i) => s(i).fclass ?? 1), order: u8(() => 2), da_sqkm: col((i) => s(i).da ?? 20), slope: col(() => 0.004),
    huc12: col((i) => (i < 6 ? 10100010101 : 10100010102)),
    n_ok: i32(() => 10), n_unm: i32(() => 0), n_nodem: i32(() => 0), n_cap: i32(() => 0), n_floor: i32(() => 0),
    n_edge: i32(() => 0), n_ext: i32(() => 0), n_crest: i32(() => 0), res: i32(() => 1),
    bhr: col((i) => s(i).bhr ?? 160), bhr_lo: col((i) => (s(i).bhr ?? 160) - 10), bhr_hi: col((i) => (s(i).bhr ?? 160) + 10),
    er: col((i) => s(i).er ?? 250), er_lo: col((i) => (s(i).er ?? 250) - 20), er_hi: col((i) => (s(i).er ?? 250) + 20),
    bfw: col(() => 60), fpw: col(() => 150), bfd: col(() => 50), lbh: col((i) => s(i).lbh ?? 80),
    q: u8((i) => s(i).q ?? 0), why: i32((i) => s(i).why ?? 0), prof_id: col(() => NaN), prof_k: col(() => NaN),
    dn_huc8: i32((i) => (dn[i] >= 0 ? code : 0)), dn_row: i32((i) => dn[i]), main: u8((i) => main[i]), div: i32((i) => div[i]),
    x: Array.from({ length: n }, (_, i) => [-8000000 + i * 1000, -8000000 + i * 1000 + 500]),
    y: Array.from({ length: n }, () => [4000000, 4000100]),
  })
}
