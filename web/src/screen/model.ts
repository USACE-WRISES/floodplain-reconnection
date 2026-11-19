// The stream network the loaded HUC8 files hold: rows addressed across files, the downstream links,
// the rows upstream of each (for the upstream walk), the main paths (for joining reaches into sites)
// and study-area membership.
import { huc12Text, type UnitFile } from '../data/units'

/** A row of a loaded file: file index x ROW_SPAN + row. */
export type Ref = number
export const ROW_SPAN = 0x1000000

export const refOf = (f: number, r: number): Ref => f * ROW_SPAN + r
export const fileOf = (ref: Ref): number => Math.floor(ref / ROW_SPAN)
export const rowOf = (ref: Ref): number => ref % ROW_SPAN

/** No downstream row, or one in a file not loaded. */
export const NONE = -1
export const ELSEWHERE = -2

export class Network {
  readonly files: UnitFile[] = []
  private index = new Map<string, number>()
  private ups: Map<Ref, Ref[]> | null = null
  private mainUps: Map<Ref, Ref> | null = null

  add(f: UnitFile): number {
    const have = this.index.get(f.huc8)
    if (have !== undefined) return have
    this.files.push(f)
    this.index.set(f.huc8, this.files.length - 1)
    this.ups = null
    this.mainUps = null
    return this.files.length - 1
  }

  has(huc8: string): boolean {
    return this.index.has(huc8)
  }

  fileIndex(huc8: string): number | undefined {
    return this.index.get(huc8)
  }

  file(ref: Ref): UnitFile {
    return this.files[fileOf(ref)]
  }

  /** The row downstream of `ref`: a Ref, NONE, or ELSEWHERE (its file is not loaded). */
  dn(ref: Ref): Ref {
    const f = this.files[fileOf(ref)]
    const r = rowOf(ref)
    const code = f.dnHuc8[r]
    const row = f.dnRow[r]
    if (!code || row < 0) return NONE
    const target = code === Number(f.huc8) ? fileOf(ref) : this.index.get(String(code).padStart(8, '0'))
    return target === undefined ? ELSEWHERE : refOf(target, row)
  }

  /** Whether `ref` continues the main path into its downstream row. */
  isMain(ref: Ref): boolean {
    return this.files[fileOf(ref)].main[rowOf(ref)] === 1
  }

  private build(): void {
    const ups = new Map<Ref, Ref[]>()
    const mainUps = new Map<Ref, Ref>()
    this.files.forEach((f, fi) => {
      for (let r = 0; r < f.rows; r++) {
        const ref = refOf(fi, r)
        const d = this.dn(ref)
        if (d >= 0) {
          const list = ups.get(d)
          if (list) list.push(ref)
          else ups.set(d, [ref])
          if (f.main[r] === 1) mainUps.set(d, ref)
        }
        const div = f.div[r]
        if (div >= 0) {
          const from = refOf(fi, div)
          const list = ups.get(ref)
          if (list) list.push(from)
          else ups.set(ref, [from])
        }
      }
    })
    this.ups = ups
    this.mainUps = mainUps
  }

  /** The rows that flow into `ref` (any branch), and the line a minor branch splits from. */
  upstream(ref: Ref): Ref[] {
    if (!this.ups) this.build()
    return this.ups!.get(ref) ?? []
  }

  /** The row upstream of `ref` on its main path, or NONE. */
  mainUp(ref: Ref): Ref {
    if (!this.mainUps) this.build()
    return this.mainUps!.get(ref) ?? NONE
  }

  /** Every row upstream of `start`, itself included (breadth first). */
  walk(start: Ref): Set<Ref> {
    const seen = new Set<Ref>([start])
    const queue = [start]
    for (let i = 0; i < queue.length; i++) {
      for (const u of this.upstream(queue[i])) {
        if (!seen.has(u)) {
          seen.add(u)
          queue.push(u)
        }
      }
    }
    return seen
  }

  /** The row of a loaded file whose reach id is `id` ("<nhdplusid>-<k0>"), or the row holding the
   * last section of line `nhdplusid` when `last` is set. */
  find(nhdplusid: number, k0?: number, last = false): Ref {
    let best: Ref = NONE
    let bestK = -1
    this.files.forEach((f, fi) => {
      for (let r = 0; r < f.rows; r++) {
        if (f.id[r] !== nhdplusid) continue
        if (k0 !== undefined && f.k0[r] === k0) best = refOf(fi, r)
        else if (last && f.k0[r] > bestK) {
          bestK = f.k0[r]
          best = refOf(fi, r)
        }
      }
    })
    return best
  }
}

/** A study area: watersheds picked (HUC8, HUC10 or HUC12 codes), everything upstream of a reach,
 * a drawn box, or one reach (a site the team already has). */
export type Area =
  | { kind: 'huc', codes: string[] }
  | { kind: 'walk', huc8: string, id: string }
  | { kind: 'box', box: [number, number, number, number] }
  | { kind: 'reach', huc8: string, id: string }

/** The HUC8 files an area of picked watersheds needs. */
export function hucFiles(codes: string[]): string[] {
  return [...new Set(codes.map((c) => c.slice(0, 8)))].sort()
}

/** Per loaded file, 1 where the row is in the area of picked watersheds. */
export function hucMask(net: Network, codes: string[]): Uint8Array[] {
  const s8 = new Set(codes.filter((c) => c.length === 8))
  const s10 = new Set(codes.filter((c) => c.length === 10))
  const s12 = new Set(codes.filter((c) => c.length === 12))
  return net.files.map((f) => {
    const m = new Uint8Array(f.rows)
    for (let r = 0; r < f.rows; r++) {
      const h = huc12Text(f, r)
      if (!h) continue
      if (s12.has(h) || s10.has(h.slice(0, 10)) || s8.has(h.slice(0, 8))) m[r] = 1
    }
    return m
  })
}

/** Per loaded file, 1 where the row is in `refs`. */
export function refMask(net: Network, refs: Iterable<Ref>): Uint8Array[] {
  const masks = net.files.map((f) => new Uint8Array(f.rows))
  for (const ref of refs) masks[fileOf(ref)][rowOf(ref)] = 1
  return masks
}

/** Per loaded file, 1 where the row's extent meets a box (Web Mercator units). */
export function boxMask(net: Network, x0: number, y0: number, x1: number, y1: number): Uint8Array[] {
  return net.files.map((f) => {
    const m = new Uint8Array(f.rows)
    for (let r = 0; r < f.rows; r++) {
      const b = r * 4
      if (f.box[b] <= x1 && f.box[b + 2] >= x0 && f.box[b + 1] <= y1 && f.box[b + 3] >= y0) m[r] = 1
    }
    return m
  })
}

/** Rows in a mask. */
export function maskCount(masks: Uint8Array[]): number {
  let n = 0
  for (const m of masks) for (let i = 0; i < m.length; i++) n += m[i]
  return n
}
