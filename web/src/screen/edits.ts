// The user's cross-section edits, and the values they give a reach. The owner (2026-11-19): a reach whose
// cross-sections the user edited is screened on those sections (their median when several, by the reach
// layer's own rules in data/fprdata/stats.py); clearing the edits returns the grid's reach median. The
// user's heights are a reading, not a detection, so no cap applies and the grid's detection flags drop:
// an edited reach is "not enough data" only when its ratios are not physical, and "use with caution"
// only when the median section's flood-prone width runs off the profile or the elevation model is
// coarser than lidar.
//
// The loaded files' value arrays are patched in place, the grid's values kept aside, so every reader of a
// reach's values (the criteria, the sites, the map, the cards, the exports) uses the edited ones, and
// with no edits nothing changes. Edits are keyed by reach id (stable across loads) and re-applied to a
// file each time it loads.
import { reachId, tierOf, WHY, type UnitFile } from '../data/units'
import { plainMedian, ratioMedian } from '../xs/reach'

/** One edited section: the user's heights above the thalweg (m) and the numbers they give, in the units
 * of the grid's numbers file (ratios x100, depth m x100, widths m x10; the low-bank height m x100). */
export interface SectionEdit {
  /** the stream line (NHDPlus HR id, as text) and the section's index along it */
  line: string
  k: number
  /** the section's place in the reach, 0 at its upstream end */
  i: number
  bfM: number
  lbM: number
  er: number | null
  bhr: number | null
  bfd: number | null
  bfw: number | null
  fpw: number | null
  lbh: number | null
  edge: boolean
  /** DEM cell size, m */
  res: number
  /** where its profile came from: the release's stored one, or a pull from USGS 3DEP */
  profile: 'stored' | '3dep'
}

export interface ReachEdit {
  huc8: string
  vpu: string
  /** the reach's section count: a reach of another count in the data is not this reach */
  n: number
  sections: SectionEdit[]
}

/** The values of a row the screen uses (the arrays' units; NaN where none). */
export interface RowValues {
  bhr: number
  bhrLo: number
  bhrHi: number
  er: number
  erLo: number
  erHi: number
  bfw: number
  fpw: number
  bfd: number
  lbh: number
  q: number
  why: number
}

const KEYS = ['bhr', 'bhrLo', 'bhrHi', 'er', 'erLo', 'erHi', 'bfw', 'fpw', 'bfd', 'lbh', 'q', 'why'] as const

function rowOf(f: UnitFile, r: number): RowValues {
  return { bhr: f.bhr[r], bhrLo: f.bhrLo[r], bhrHi: f.bhrHi[r], er: f.er[r], erLo: f.erLo[r], erHi: f.erHi[r], bfw: f.bfw[r], fpw: f.fpw[r],
    bfd: f.bfd[r], lbh: f.lbh[r], q: f.q[r], why: f.why[r] }
}

function write(f: UnitFile, r: number, v: RowValues): void {
  for (const k of KEYS) (f[k] as { [i: number]: number })[r] = v[k]
}

const nan = (v: number | null): number => (v === null ? NaN : v)

/** The values of a reach screened on its edited sections. */
export function reachValues(sections: SectionEdit[]): RowValues {
  const bhrs = sections.map((s) => s.bhr).filter((v): v is number => v !== null)
  const ers = sections.map((s) => s.er).filter((v): v is number => v !== null)
  const num = (key: 'bfw' | 'fpw' | 'bfd' | 'lbh') => nan(plainMedian(sections.map((s) => s[key]).filter((v): v is number => v !== null)))
  const bhr = nan(ratioMedian(bhrs))
  const er = nan(ratioMedian(ers))
  // geomorph.median_edge_limited: a section holding the median entrenchment ratio (the middle one, or
  // either middle one of an even count, in reach order among equals) is edge-limited
  const byEr = sections.filter((s) => s.er !== null).map((s, i) => ({ er: s.er as number, i, edge: s.edge }))
    .sort((a, b) => a.er - b.er || a.i - b.i)
  const m = byEr.length
  const edge = m > 0 && (m % 2 ? byEr[(m - 1) / 2].edge : byEr[m / 2 - 1].edge || byEr[m / 2].edge)
  let why = 0
  if (bhr <= 0) why |= WHY.bhrRange
  if (er < 100) why |= WHY.erRange
  if (edge) why |= WHY.edge
  if (sections.some((s) => s.res > 1)) why |= WHY.coarseDem
  return {
    bhr, bhrLo: bhrs.length ? Math.min(...bhrs) : NaN, bhrHi: bhrs.length ? Math.max(...bhrs) : NaN,
    er, erLo: ers.length ? Math.min(...ers) : NaN, erHi: ers.length ? Math.max(...ers) : NaN,
    bfw: num('bfw'), fpw: num('fpw'), bfd: num('bfd'), lbh: num('lbh'), q: tierOf(why), why,
  }
}

export class Edits {
  /** by reach id */
  private readonly reaches = new Map<string, ReachEdit>()
  /** the grid's values of each row showing edits */
  private readonly kept = new WeakMap<UnitFile, Map<number, RowValues>>()

  get size(): number {
    return this.reaches.size
  }

  /** The edits of a reach (undefined: none). */
  of(f: UnitFile, r: number): ReachEdit | undefined {
    return this.reaches.get(reachId(f, r))
  }

  /** Every edited reach, by id. */
  entries(): [string, ReachEdit][] {
    return [...this.reaches.entries()]
  }

  /** The grid's values of a row (its own while it shows none of the user's). */
  grid(f: UnitFile, r: number): RowValues {
    return this.kept.get(f)?.get(r) ?? rowOf(f, r)
  }

  /** Sets one section's edit (replacing an earlier one of the same section). */
  setSection(f: UnitFile, r: number, vpu: string, edit: SectionEdit): void {
    const id = reachId(f, r)
    const reach = this.reaches.get(id) ?? { huc8: f.huc8, vpu, n: f.n[r], sections: [] }
    reach.sections = [...reach.sections.filter((s) => !(s.line === edit.line && s.k === edit.k)), edit]
      .sort((a, b) => sectionOrder(a, b))
    this.reaches.set(id, reach)
    this.patch(f, r)
  }

  /** Drops one section's edit. */
  clearSection(f: UnitFile, r: number, line: string, k: number): void {
    const id = reachId(f, r)
    const reach = this.reaches.get(id)
    if (!reach) return
    reach.sections = reach.sections.filter((s) => !(s.line === line && s.k === k))
    if (!reach.sections.length) this.reaches.delete(id)
    this.patch(f, r)
  }

  /** Drops every edit of a reach. */
  clearReach(f: UnitFile, r: number): void {
    this.reaches.delete(reachId(f, r))
    this.patch(f, r)
  }

  /** Drops every edit, putting the grid's values back in the loaded files. */
  clearAll(files: UnitFile[]): void {
    this.reaches.clear()
    for (const f of files) {
      const rows = this.kept.get(f)
      if (!rows) continue
      for (const [r, v] of rows) {
        write(f, r, v)
        f.edited[r] = 0
      }
      this.kept.delete(f)
    }
  }

  /** Applies the edits of a file just loaded; returns the reach ids of its HUC8 that match no row (a
   * reach the data no longer holds, or holds with another section count). */
  applyFile(f: UnitFile): string[] {
    const mine = [...this.reaches.entries()].filter(([, e]) => e.huc8 === f.huc8)
    if (!mine.length) return []
    const rows = new Map<string, number>()
    for (let r = 0; r < f.rows; r++) rows.set(reachId(f, r), r)
    const missing: string[] = []
    for (const [id, e] of mine) {
      const r = rows.get(id)
      if (r === undefined || f.n[r] !== e.n) {
        missing.push(id)
        this.reaches.delete(id)
        continue
      }
      this.patch(f, r)
    }
    return missing
  }

  /** Every edit, for a saved screening. */
  toJSON(): Record<string, ReachEdit> {
    return Object.fromEntries(this.reaches)
  }

  /** Edits from a saved screening (before any file loads; applyFile patches each file as it loads). */
  load(saved: Record<string, ReachEdit>): void {
    this.reaches.clear()
    for (const [id, e] of Object.entries(saved)) {
      if (e && Array.isArray(e.sections) && e.sections.length) this.reaches.set(id, { ...e, sections: [...e.sections].sort(sectionOrder) })
    }
  }

  /** The row's values: the edited sections' while it has any, else the grid's. */
  private patch(f: UnitFile, r: number): void {
    const e = this.reaches.get(reachId(f, r))
    let rows = this.kept.get(f)
    if (e && e.sections.length) {
      if (!rows) {
        rows = new Map()
        this.kept.set(f, rows)
      }
      if (!rows.has(r)) rows.set(r, rowOf(f, r))
      write(f, r, reachValues(e.sections))
      f.edited[r] = e.sections.length
      return
    }
    const v = rows?.get(r)
    if (v) {
      write(f, r, v)
      rows!.delete(r)
    }
    f.edited[r] = 0
  }
}

/** Reach order, upstream to downstream. */
function sectionOrder(a: SectionEdit, b: SectionEdit): number {
  return a.i - b.i
}
