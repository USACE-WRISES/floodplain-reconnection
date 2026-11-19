// A HUC8's reach file (`units/<huc8>.parquet`, data/README.md): one row per reach of about 1,000 ft,
// or per stream line the grid does not sample, read whole and held as typed arrays. Geometry is kept
// in Web Mercator units (0 to 1 across the world), the map's own projection, so drawing a view is a
// multiply and a subtract per vertex.
import { readColumns } from './parquet'
import type { DataSource } from './source'

/** Quality tiers (`q`). */
export const Q_OK = 0
export const Q_CAUTION = 1
export const Q_NODATA = 2
export const Q_UNSAMPLED = 3

/** `why` bits (data/README.md). */
export const WHY = {
  few: 1,
  bhrRange: 2,
  erRange: 4,
  capFloor: 8,
  extrapolated: 16,
  crestOnly: 32,
  fewish: 64,
  edge: 128,
  coarseDem: 256,
  atCap: 512,
  noDem: 1024,
} as const

/** Line classes (`fclass`). */
export const FCLASS = { stream: 1, canal: 2, artificial: 3, connector: 4 } as const

export interface UnitFile {
  huc8: string
  rows: number
  id: Float64Array
  k0: Int32Array
  n: Int32Array
  vpu: string[]
  lenM: Float64Array
  name: string[]
  fclass: Uint8Array
  order: Uint8Array
  da: Float64Array
  slope: Float64Array
  huc12: Float64Array
  nOk: Int32Array
  nUnm: Int32Array
  nNodem: Int32Array
  nCap: Int32Array
  nFloor: Int32Array
  nEdge: Int32Array
  nExt: Int32Array
  nCrest: Int32Array
  res: Int32Array
  /** ratios x100 (NaN where none) */
  bhr: Float64Array
  bhrLo: Float64Array
  bhrHi: Float64Array
  er: Float64Array
  erLo: Float64Array
  erHi: Float64Array
  /** widths in m x10, depths in m x100 (NaN where none) */
  bfw: Float64Array
  fpw: Float64Array
  bfd: Float64Array
  lbh: Float64Array
  q: Uint8Array
  why: Int32Array
  profId: Float64Array
  profK: Float64Array
  dnHuc8: Int32Array
  dnRow: Int32Array
  main: Uint8Array
  div: Int32Array
  /** vertex offsets: row i's vertices are off[i] to off[i + 1] */
  off: Uint32Array
  mx: Float64Array
  my: Float64Array
  /** per row: min mx, min my, max mx, max my */
  box: Float64Array
}

const F64 = ['id', 'len_m', 'da_sqkm', 'slope', 'huc12', 'bhr', 'bhr_lo', 'bhr_hi', 'er', 'er_lo', 'er_hi',
  'bfw', 'fpw', 'bfd', 'lbh', 'prof_id', 'prof_k']
const I32 = ['k0', 'n', 'n_ok', 'n_unm', 'n_nodem', 'n_cap', 'n_floor', 'n_edge', 'n_ext', 'n_crest', 'res', 'why',
  'dn_huc8', 'dn_row', 'div']
const U8 = ['fclass', 'order', 'q', 'main']
const NAN = ['slope', 'bhr', 'bhr_lo', 'bhr_hi', 'er', 'er_lo', 'er_hi', 'bfw', 'fpw', 'bfd', 'lbh', 'prof_id', 'prof_k']
const PLAIN = ['vpu', 'name', 'x', 'y']

/** Web Mercator, 0 to 1 across (x east, y south), as Leaflet's EPSG:3857 before its pixel scale. */
export function mercX(lon: number): number {
  return (lon + 180) / 360
}

const MAX_LAT = 85.0511287798
export function mercY(lat: number): number {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)
}

/** Degrees from Web Mercator units (the exports' coordinates, 5 decimals as stored). */
export function lonOf(mx: number): number {
  return Math.round((mx * 360 - 180) * 1e5) / 1e5
}

export function latOf(my: number): number {
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI
  return Math.round(lat * 1e5) / 1e5
}

/** Reads and unpacks one HUC8's file. */
export async function loadUnits(src: DataSource, huc8: string): Promise<UnitFile> {
  const logical = `units/${huc8}.parquet`
  const typed: Record<string, 'f64' | 'i32' | 'u8'> = {}
  for (const c of F64) typed[c] = 'f64'
  for (const c of I32) typed[c] = 'i32'
  for (const c of U8) typed[c] = 'u8'
  const cols = await readColumns(src, logical, [...F64, ...I32, ...U8, ...PLAIN], 0, undefined, typed, NAN)
  return unpack(huc8, cols)
}

/** Columns (as readColumns gives them) into a UnitFile: exported for the tests. */
export function unpack(huc8: string, cols: Record<string, any>): UnitFile {
  const rows = (cols.id as Float64Array).length
  const xs = cols.x as ArrayLike<number>[]
  const ys = cols.y as ArrayLike<number>[]
  const off = new Uint32Array(rows + 1)
  for (let i = 0; i < rows; i++) off[i + 1] = off[i] + (xs[i]?.length ?? 0)
  const nv = off[rows]
  const mx = new Float64Array(nv)
  const my = new Float64Array(nv)
  const box = new Float64Array(rows * 4)
  for (let i = 0; i < rows; i++) {
    const x = xs[i]
    const y = ys[i]
    let a = Infinity
    let b = Infinity
    let c = -Infinity
    let d = -Infinity
    for (let j = 0, v = off[i]; j < (x?.length ?? 0); j++, v++) {
      const px = mercX(Number(x[j]) / 1e5)
      const py = mercY(Number(y[j]) / 1e5)
      mx[v] = px
      my[v] = py
      if (px < a) a = px
      if (py < b) b = py
      if (px > c) c = px
      if (py > d) d = py
    }
    box[i * 4] = a
    box[i * 4 + 1] = b
    box[i * 4 + 2] = c
    box[i * 4 + 3] = d
  }
  const str = (a: unknown[] | undefined): string[] => Array.from(a ?? [], (v) => (v === null || v === undefined ? '' : String(v)))
  return {
    huc8,
    rows,
    id: cols.id,
    k0: cols.k0,
    n: cols.n,
    vpu: str(cols.vpu),
    lenM: cols.len_m,
    name: str(cols.name),
    fclass: cols.fclass,
    order: cols.order,
    da: cols.da_sqkm,
    slope: cols.slope,
    huc12: cols.huc12,
    nOk: cols.n_ok,
    nUnm: cols.n_unm,
    nNodem: cols.n_nodem,
    nCap: cols.n_cap,
    nFloor: cols.n_floor,
    nEdge: cols.n_edge,
    nExt: cols.n_ext,
    nCrest: cols.n_crest,
    res: cols.res,
    bhr: cols.bhr,
    bhrLo: cols.bhr_lo,
    bhrHi: cols.bhr_hi,
    er: cols.er,
    erLo: cols.er_lo,
    erHi: cols.er_hi,
    bfw: cols.bfw,
    fpw: cols.fpw,
    bfd: cols.bfd,
    lbh: cols.lbh,
    q: cols.q,
    why: cols.why,
    profId: cols.prof_id,
    profK: cols.prof_k,
    dnHuc8: cols.dn_huc8,
    dnRow: cols.dn_row,
    main: cols.main,
    div: cols.div,
    off,
    mx,
    my,
    box,
  }
}

/** A row's reach id, as exports and saved files name it: "<nhdplusid>-<k0>". */
export function reachId(f: UnitFile, row: number): string {
  return `${f.id[row]}-${f.k0[row]}`
}

/** The HUC8 code of an integer HUC8 (zero-padded). */
export function huc8Text(code: number): string {
  return String(code).padStart(8, '0')
}

/** The HUC12 code of a row ('' when none). */
export function huc12Text(f: UnitFile, row: number): string {
  const v = f.huc12[row]
  return v > 0 ? String(v).padStart(12, '0') : ''
}
