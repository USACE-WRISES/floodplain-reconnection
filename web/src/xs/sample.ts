/**
 * A cross-section pulled again from USGS's 3DEP tile files, exactly as the national grid sampled it
 * (copied from STAF's static web app, apps/staf-web/src/xs/sample.ts: STAF's tools/xs-grid/xsgrid/sample.py,
 * sampling rule `xsgrid-1`, read on the grids the build recorded for each section).
 *
 * Each sample point (EPSG:5070, along the section's transect) is transformed to the tile's own CRS with
 * PROJ's arithmetic (projExact.ts) and interpolated bilinearly between the four nearest cell centers of
 * the build's read grid, then rounded to float32. A sample the browser's math could round the other way
 * is settled by the section's stored checksum, so a verified pull is the grid's own samples, bit for bit.
 * The tiles are read by HTTP range (geotiff.js), each read held to the bytes it asked for.
 */
import { BaseClient, BaseResponse, fromCustomClient, type GeoTIFF, type GeoTIFFImage } from 'geotiff'
import { fetchRange } from '../data/range'
import { stations } from './codec'
import { profileCrc } from './crc32'
import { registerLzw } from './lzw'
import { from5070 } from './projExact'
import { pyRound } from './pyfixed'

registerLzw()

/** A checked range read handed to geotiff.js. */
class CheckedResponse extends BaseResponse {
  constructor(private readonly data: ArrayBuffer) {
    super()
  }

  get status(): number {
    return 206
  }

  getHeader(): string | undefined {
    return undefined
  }

  async getData(): Promise<ArrayBuffer> {
    return this.data
  }
}

/** geotiff.js's tile reads, each held to the bytes it asked for (`fetchRange`): a block that arrives
 * short is read again rather than decoded. */
class CheckedClient extends BaseClient {
  async request(options: RequestInit = {}): Promise<BaseResponse> {
    const range = new Headers(options.headers).get('range') ?? ''
    const m = /^bytes=(\d+)-(\d+)$/.exec(range)
    if (!m) throw new Error(`${this.url}: a tile read without a byte range (${range})`)
    const data = await fetchRange(this.url, Number(m[1]), Number(m[2]) + 1, { signal: options.signal ?? undefined })
    return new CheckedResponse(data)
  }
}

const BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/'

/** The recorded source of a section (`source`, `tiles` from the release's sections file). */
export interface SectionSource {
  /** DEM cell size, m: 1, 3, 10 (0: none) */
  res: number
  /** the 1 m project, or the 1/9 or 1/3 arc-second product */
  source: string
  /** `;`-joined tile names, as the build recorded them */
  tiles: string
}

/** The files a section was sampled from, in the build's merge order. The build pastes tiles in catalog
 * order, and both catalogs are sorted by name, while a section records its 1 m tiles newest first:
 * sorting the names restores the paste order. */
export function tileUrls(src: SectionSource): string[] {
  const names = src.tiles.split(';').filter(Boolean).sort()
  if (src.res === 1) return names.map((n) => `${BASE}1m/Projects/${src.source}/TIFF/${n}`)
  if (src.res === 3) return names.map((n) => `${BASE}19/TILES/${n}/${n}.img`)
  if (src.res === 10) return names.map((n) => `${BASE}13/TIFF/current/${n.replace(/^USGS_13_/, '').replace(/\.tif$/, '')}/${n}`)
  return []
}

interface OpenTile {
  url: string
  image: GeoTIFFImage
  epsg: number
  c: number
  f: number
  a: number
  e: number
  width: number
  height: number
  nodata: number | null
}

const opened = new Map<string, Promise<OpenTile>>()

/** A tile's header (cached for the page's life): grid, CRS and nodata. */
function openTile(url: string): Promise<OpenTile> {
  let p = opened.get(url)
  if (!p) {
    p = (async () => {
      const tiff: GeoTIFF = await fromCustomClient(new CheckedClient(url), { allowFullFile: false })
      const image = await tiff.getImage()
      const [c, f] = image.getOrigin()
      const [a, e] = image.getResolution()
      const keys = image.getGeoKeys() ?? {}
      const epsg = Number(keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey ?? 0)
      const nd = image.getGDALNoData()
      return { url, image, epsg, c, f, a, e, width: image.getWidth(), height: image.getHeight(), nodata: nd }
    })()
    opened.set(url, p)
    p.catch(() => opened.delete(url))
  }
  return p
}

/** A 3 m quad's file can be named `img<name>_19.img` (105 of 8,345). */
async function openTileOrAlternate(url: string): Promise<OpenTile> {
  try {
    return await openTile(url)
  } catch (err) {
    const m = /\/19\/TILES\/([^/]+)\/\1\.img$/.exec(url)
    if (!m) throw err
    return openTile(url.replace(/\/([^/]+)\.img$/, `/img${m[1]}_19.img`))
  }
}

export interface PullSection {
  x: number
  y: number
  nx: number
  ny: number
  wide: number
  nPts: number
}

/** One read the build made of a section: its CRS and the corner and pixel size of the window (the
 * release's `grid_epsg`, `grid_c`, `grid_f`, `grid_a`, `grid_e`). */
export interface ReadGrid {
  epsg: number
  c: number
  f: number
  a: number
  e: number
}

/** How far this page's projection of a sample can land from the build's (PROJ on the Windows C runtime):
 * projExact.ts follows PROJ's arithmetic, but the browser's sin, cos, atan2, asin, log and asinh round
 * differently now and then (measured on 400,000 points: at most 1.1e-8 m and 1e-13 degrees). Ten times
 * that, per unit of the read's CRS. */
const PROJECTION_SLACK = { meters: 1.1e-7, degrees: 1e-12 }

/** EPSG:5070 to a read's CRS: PROJ's arithmetic for the tiles' CRSs (NAD83 UTM, NAD83 geographic), the
 * only ones the grid's releases record. */
function project(epsg: number, X: Float64Array, Y: Float64Array): [ArrayLike<number>, ArrayLike<number>] {
  if (epsg === 4269 || (epsg > 26900 && epsg <= 26923)) return from5070(epsg, X, Y)
  throw new Error(`the section was read in EPSG:${epsg}, which this page does not project`)
}

/** A section's samples pulled on the grids the build read it on: per read, its recorded tiles of that
 * CRS pasted at the build's offsets from the recorded corner and interpolated with the build's
 * arithmetic, filling what earlier reads left missing; each sample's slack bounds what the browser's
 * math functions can move it (the local slope times the projection's error). */
async function pullCore(sec: PullSection, src: SectionSource, reads: ReadGrid[]): Promise<{ z64: Float64Array, slack: Float64Array }> {
  const ts = stations(sec.wide, sec.nPts)
  const X = new Float64Array(sec.nPts)
  const Y = new Float64Array(sec.nPts)
  for (let i = 0; i < sec.nPts; i++) {
    X[i] = sec.x + sec.nx * ts[i]
    Y[i] = sec.y + sec.ny * ts[i]
  }
  const urls = tileUrls(src)
  const tiles = await Promise.all(urls.map(openTileOrAlternate))
  const z = new Float64Array(sec.nPts).fill(NaN)
  const slack = new Float64Array(sec.nPts)
  for (const g of reads) {
    const mine = tiles.filter((t) => (src.res === 1 ? t.epsg === g.epsg : true))
    if (!mine.length) continue
    const [u, v] = project(g.epsg, X, Y)
    const off = g.epsg === 4269 ? PROJECTION_SLACK.degrees : PROJECTION_SLACK.meters
    const px = Math.max(off / Math.abs(g.a), off / Math.abs(g.e)) // in pixels
    let j0 = Infinity
    let j1 = -Infinity
    let i0 = Infinity
    let i1 = -Infinity
    const fj = new Float64Array(u.length)
    const fi = new Float64Array(u.length)
    for (let i = 0; i < u.length; i++) {
      fj[i] = (u[i] - g.c) / g.a - 0.5
      fi[i] = (v[i] - g.f) / g.e - 0.5
      j0 = Math.min(j0, Math.floor(fj[i]))
      j1 = Math.max(j1, Math.floor(fj[i]) + 2)
      i0 = Math.min(i0, Math.floor(fi[i]))
      i1 = Math.max(i1, Math.floor(fi[i]) + 2)
    }
    const width = j1 - j0
    const height = i1 - i0
    const buf = new Float32Array(width * height).fill(NaN)
    const got = await Promise.all(mine.map(async (t) => {
      const dc = pyRound((t.c - g.c) / g.a)
      const dr = pyRound((t.f - g.f) / g.e)
      const c0 = Math.max(j0, dc)
      const c1 = Math.min(j1, dc + t.width)
      const r0 = Math.max(i0, dr)
      const r1 = Math.min(i1, dr + t.height)
      if (c1 <= c0 || r1 <= r0) return null
      const win = [c0 - dc, r0 - dr, c1 - dc, r1 - dr]
      let values
      try {
        values = await t.image.readRasters({ window: win, samples: [0], interleave: true })
      } catch (err) {
        throw new Error(`${t.url} window ${win.join(',')}: ${String(err)}`)
      }
      return { t, c0, c1, r0, r1, values: values as unknown as ArrayLike<number> }
    }))
    for (const one of got) {
      if (!one) continue // in name order: the first tile with data keeps a pixel
      const { t, c0, c1, r0, r1, values } = one
      const nd = t.nodata === null ? null : Math.fround(t.nodata)
      const w = c1 - c0
      for (let r = r0; r < r1; r++) {
        for (let col = c0; col < c1; col++) {
          const val = Math.fround(values[(r - r0) * w + (col - c0)])
          const masked = !Number.isFinite(val) || val <= -1e30 || (nd !== null && val === nd)
          const o = (r - i0) * width + (col - j0)
          if (!masked && Number.isNaN(buf[o])) buf[o] = val
        }
      }
    }
    for (let i = 0; i < u.length; i++) {
      if (Number.isFinite(z[i])) continue
      const jj = Math.floor(fj[i])
      const ii = Math.floor(fi[i])
      const tx = fj[i] - jj
      const ty = fi[i] - ii
      const b = (ii - i0) * width + (jj - j0)
      const z00 = buf[b]
      const z01 = buf[b + 1]
      const z10 = buf[b + width]
      const z11 = buf[b + width + 1]
      const val = (1.0 - ty) * ((1.0 - tx) * z00 + tx * z01) + ty * ((1.0 - tx) * z10 + tx * z11)
      if (Number.isFinite(val)) {
        z[i] = val
        const steep = Math.abs(z01 - z00) + Math.abs(z11 - z10) + Math.abs(z10 - z00) + Math.abs(z11 - z01)
        slack[i] = steep * px + Math.abs(val) * 2 ** -48
      }
    }
  }
  return { z64: z, slack }
}

export interface ExactPull {
  z: Float32Array
  /** the profile's checksum is the release's: the grid's samples bit for bit */
  verified: boolean
  /** samples rounded the other way to meet the checksum */
  adjusted: number
  /** samples whose rounding the projection's slack left open */
  open: number
}

/** A pull settled by the release's profile checksum (`z_crc`): a sample whose float64 value lies within
 * its slack of a float32 rounding boundary could have rounded either way in the build, so each such
 * choice is tried until the profile's checksum is the grid's. Usually none is open and the checksum just
 * confirms the pull. */
export async function pullExact(sec: PullSection, src: SectionSource, reads: ReadGrid[], crc: number | null): Promise<ExactPull> {
  const core = await pullCore(sec, src, reads)
  return resolveByChecksum(core.z64, core.slack, crc)
}

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)

/** The float32 next to `f` toward +Infinity (`up`) or -Infinity. */
export function nextFloat32(f: number, up: boolean): number {
  if (f === 0) return up ? 1.401298464324817e-45 : -1.401298464324817e-45
  F32[0] = f
  U32[0] += (f > 0) === up ? 1 : -1
  return F32[0]
}

/** The checksum search of `pullExact`, on values already pulled: tries the open samples' other rounding
 * (at most 2^12 combinations), then once more with ten times the slack. */
export function resolveByChecksum(z64: Float64Array, slack: Float64Array, crc: number | null): ExactPull {
  const z = Float32Array.from(z64)
  if (crc === null) return { z, verified: false, adjusted: 0, open: 0 }
  if (profileCrc(z) === crc) return { z, verified: true, adjusted: 0, open: 0 }
  let open = 0
  for (const widen of [1, 10]) {
    const at: number[] = []
    const other: number[] = []
    for (let i = 0; i < z64.length; i++) {
      const v = z64[i]
      if (!Number.isFinite(v)) continue
      const f = z[i]
      const alt = nextFloat32(f, v >= f)
      if (Math.abs(v - (f + alt) / 2) <= slack[i] * widen) {
        at.push(i)
        other.push(alt)
      }
    }
    open = at.length
    if (!open || open > 12) continue
    const trial = z.slice()
    for (let mask = 1; mask < 1 << open; mask++) {
      let changed = 0
      for (let j = 0; j < open; j++) {
        const flip = (mask >> j) & 1
        trial[at[j]] = flip ? other[j] : z[at[j]]
        changed += flip
      }
      if (profileCrc(trial) === crc) return { z: trial, verified: true, adjusted: changed, open }
    }
  }
  return { z, verified: false, adjusted: 0, open }
}
