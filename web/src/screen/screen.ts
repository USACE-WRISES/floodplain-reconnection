// The screen: which reaches of a study area pass the team's criteria, how each criterion narrows
// them (the funnel), and the candidate sites the passing reaches make along the main paths. The
// builder's report (data/fprdata) applies the same rules; tests/fixtures.test.ts holds the two to
// the same counts.
import { FCLASS, Q_CAUTION, Q_OK, Q_UNSAMPLED, WHY } from '../data/units'
import { fileOf, NONE, refOf, rowOf, type Network, type Ref } from './model'

export const SQKM_PER_SQMI = 2.589988110336
export const M_PER_FT = 0.3048

export interface Criteria {
  includeCaution: boolean
  skipCanals: boolean
  daMinSqmi: number | null
  daMaxSqmi: number | null
  bhrMin: number | null
  countCapped: boolean
  erMin: number | null
  minSiteFt: number
  gapReaches: number
}

export interface Preset { id: string, label: string, criteria: Criteria }

const BASE: Criteria = {
  includeCaution: true, skipCanals: true, daMinSqmi: 2, daMaxSqmi: null, bhrMin: 1.5, countCapped: true,
  erMin: 2.2, minSiteFt: 1000, gapReaches: 1,
}

/** Starting values for the team to set in Task 2 (named by their numbers, not by condition). */
export const PRESETS: Preset[] = [
  { id: 'A', label: 'BHR 1.5 or more, ER 2.2 or more', criteria: { ...BASE } },
  { id: 'B', label: 'BHR 1.5 or more', criteria: { ...BASE, erMin: null } },
  { id: 'C', label: 'BHR 1.3 or more, ER 2.2 or more', criteria: { ...BASE, bhrMin: 1.3 } },
]

export function defaultCriteria(): Criteria {
  return { ...PRESETS[0].criteria }
}

export function presetOf(c: Criteria): Preset | null {
  return PRESETS.find((p) => sameCriteria(p.criteria, c)) ?? null
}

export function sameCriteria(a: Criteria, b: Criteria): boolean {
  return (Object.keys(a) as (keyof Criteria)[]).every((k) => a[k] === b[k])
}

/** Where a study-area row stops in the funnel (STAGE.pass: it passes every criterion). */
export const STAGE = {
  outside: 0,
  unsampled: 1,
  canal: 2,
  unmeasured: 3,
  da: 4,
  bhr: 5,
  er: 6,
  pass: 7,
} as const

export interface FunnelStep {
  key: string
  label: string
  /** rows that pass this step and every one before it */
  reaches: number
  /** their length, m */
  lengthM: number
}

export interface Site {
  /** "<nhdplusid>-<k0>" of its downstream-most row */
  id: string
  /** rows, upstream to downstream (gap rows included) */
  refs: Ref[]
  /** per row, whether it passes (false for a gap row) */
  pass: boolean[]
  lengthM: number
  passLengthM: number
  name: string
  huc12: string
  bhr: number
  bhrLo: number
  bhrHi: number
  /** passing rows whose median BHR reads "at least 2.00" */
  bhrAtCap: number
  er: number
  erLo: number
  erHi: number
  lbhM: number
  bfwM: number
  fpwM: number
  daSqkm: number
  slope: number
  caution: number
}

export interface ScreenResult {
  stage: Uint8Array[]
  funnel: FunnelStep[]
  pass: number
  sites: Site[]
  /** passing rows in sites shorter than the minimum */
  shortRuns: number
}

/** The funnel stage of one row (outside the area: STAGE.outside). */
export function stageOf(net: Network, ref: Ref, inArea: boolean, c: Criteria): number {
  if (!inArea) return STAGE.outside
  const f = net.file(ref)
  const r = rowOf(ref)
  const q = f.q[r]
  if (q === Q_UNSAMPLED) return STAGE.unsampled
  if (c.skipCanals && f.fclass[r] === FCLASS.canal) return STAGE.canal
  if (!(q === Q_OK || (q === Q_CAUTION && c.includeCaution))) return STAGE.unmeasured
  const da = f.da[r] / SQKM_PER_SQMI
  if ((c.daMinSqmi !== null && !(da >= c.daMinSqmi)) || (c.daMaxSqmi !== null && !(da <= c.daMaxSqmi))) return STAGE.da
  if (c.bhrMin !== null) {
    if (!(f.bhr[r] >= Math.round(c.bhrMin * 100))) return STAGE.bhr
    if (!c.countCapped && (f.why[r] & WHY.atCap)) return STAGE.bhr
  }
  if (c.erMin !== null && !(f.er[r] >= Math.round(c.erMin * 100))) return STAGE.er
  return STAGE.pass
}

function median(values: number[]): number {
  if (!values.length) return NaN
  const v = [...values].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

export function screen(net: Network, masks: Uint8Array[], c: Criteria): ScreenResult {
  const stage = net.files.map((f, fi) => {
    const s = new Uint8Array(f.rows)
    const m = masks[fi]
    for (let r = 0; r < f.rows; r++) s[r] = stageOf(net, refOf(fi, r), m?.[r] === 1, c)
    return s
  })
  // the funnel: rows past each step
  const steps: { key: string, label: string, min: number, show: boolean }[] = [
    { key: 'reaches', label: 'Reaches in the study area', min: STAGE.canal, show: true },
    { key: 'canals', label: 'Not canals or ditches', min: STAGE.unmeasured, show: c.skipCanals },
    { key: 'measured', label: c.includeCaution ? 'Measured, with or without cautions' : 'Measured, no cautions', min: STAGE.da, show: true },
    { key: 'da', label: daLabel(c), min: STAGE.bhr, show: c.daMinSqmi !== null || c.daMaxSqmi !== null },
    { key: 'bhr', label: c.bhrMin === null ? 'Bank height ratio' : `Bank height ratio ${c.bhrMin.toFixed(2)} or more`, min: STAGE.er, show: c.bhrMin !== null },
    { key: 'er', label: c.erMin === null ? 'Entrenchment ratio' : `Entrenchment ratio ${c.erMin.toFixed(2)} or more`, min: STAGE.pass, show: c.erMin !== null },
  ]
  const funnel: FunnelStep[] = []
  for (const st of steps) {
    if (!st.show) continue
    let n = 0
    let len = 0
    net.files.forEach((f, fi) => {
      const s = stage[fi]
      for (let r = 0; r < f.rows; r++) {
        if (s[r] >= st.min) {
          n++
          len += f.lenM[r]
        }
      }
    })
    funnel.push({ key: st.key, label: st.label, reaches: n, lengthM: len })
  }
  const pass = funnel.length ? funnel[funnel.length - 1].reaches : 0
  const { sites, shortRuns } = findSites(net, stage, c)
  return { stage, funnel, pass, sites, shortRuns }
}

function daLabel(c: Criteria): string {
  if (c.daMinSqmi !== null && c.daMaxSqmi !== null) return `Draining ${c.daMinSqmi} to ${c.daMaxSqmi} sq mi`
  if (c.daMinSqmi !== null) return `Draining ${c.daMinSqmi} sq mi or more`
  if (c.daMaxSqmi !== null) return `Draining ${c.daMaxSqmi} sq mi or less`
  return 'Drainage area'
}

/** A row that can sit inside a site: in the area and measured or failing a criterion, not unsampled. */
function eligible(stage: Uint8Array[], ref: Ref): boolean {
  return stage[fileOf(ref)][rowOf(ref)] >= STAGE.canal
}

function passes(stage: Uint8Array[], ref: Ref): boolean {
  return stage[fileOf(ref)][rowOf(ref)] === STAGE.pass
}

/** Sites: along each main path, runs of passing rows that bridge up to `gapReaches` rows that fail a
 * criterion or lack data; a site never starts or ends on a gap row, and an unsampled row or a row
 * outside the area always ends one. Kept when at least `minSiteFt` long. */
export function findSites(net: Network, stage: Uint8Array[], c: Criteria): { sites: Site[], shortRuns: number } {
  const sites: Site[] = []
  let shortRuns = 0
  const minM = c.minSiteFt * M_PER_FT
  net.files.forEach((f, fi) => {
    for (let r = 0; r < f.rows; r++) {
      const start = refOf(fi, r)
      if (!eligible(stage, start)) continue
      const up = net.mainUp(start)
      if (up !== NONE && eligible(stage, up)) continue          // not the head of its segment
      // the segment: eligible rows linked downstream by main links
      const seg: Ref[] = [start]
      let at = start
      while (net.isMain(at)) {
        const d = net.dn(at)
        if (d < 0 || !eligible(stage, d) || net.mainUp(d) !== at) break
        seg.push(d)
        at = d
      }
      let i = 0
      while (i < seg.length) {
        if (!passes(stage, seg[i])) {
          i++
          continue
        }
        let end = i
        let gap = 0
        for (let j = i + 1; j < seg.length; j++) {
          if (passes(stage, seg[j])) {
            end = j
            gap = 0
          } else if (++gap > c.gapReaches) break
        }
        const run = seg.slice(i, end + 1)
        const site = makeSite(net, stage, run)
        if (site.lengthM >= minM - 1e-9) sites.push(site)
        else shortRuns += site.pass.filter(Boolean).length
        i = end + 1
      }
    }
  })
  return { sites, shortRuns }
}

function makeSite(net: Network, stage: Uint8Array[], refs: Ref[]): Site {
  const pass = refs.map((ref) => passes(stage, ref))
  let lengthM = 0
  let passLengthM = 0
  const bhr: number[] = []
  const er: number[] = []
  const lbh: number[] = []
  const bfw: number[] = []
  const fpw: number[] = []
  const slope: number[] = []
  let atCap = 0
  let caution = 0
  const names = new Map<string, number>()
  refs.forEach((ref, i) => {
    const f = net.file(ref)
    const r = rowOf(ref)
    lengthM += f.lenM[r]
    if (!pass[i]) return
    passLengthM += f.lenM[r]
    bhr.push(f.bhr[r] / 100)
    er.push(f.er[r] / 100)
    if (Number.isFinite(f.lbh[r])) lbh.push(f.lbh[r] / 100)
    if (Number.isFinite(f.bfw[r])) bfw.push(f.bfw[r] / 10)
    if (Number.isFinite(f.fpw[r])) fpw.push(f.fpw[r] / 10)
    if (Number.isFinite(f.slope[r])) slope.push(f.slope[r])
    if (f.why[r] & WHY.atCap) atCap++
    if (f.q[r] === Q_CAUTION) caution++
    if (f.name[r]) names.set(f.name[r], (names.get(f.name[r]) ?? 0) + f.lenM[r])
  })
  const last = refs[refs.length - 1]
  const lf = net.file(last)
  const lr = rowOf(last)
  const name = [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ''
  const h = lf.huc12[lr]
  return {
    id: `${lf.id[lr]}-${lf.k0[lr]}`,
    refs,
    pass,
    lengthM,
    passLengthM,
    name,
    huc12: h > 0 ? String(h).padStart(12, '0') : '',
    bhr: median(bhr),
    bhrLo: Math.min(...bhr),
    bhrHi: Math.max(...bhr),
    bhrAtCap: atCap,
    er: median(er),
    erLo: Math.min(...er),
    erHi: Math.max(...er),
    lbhM: median(lbh),
    bfwM: median(bfw),
    fpwM: median(fpw),
    daSqkm: lf.da[lr],
    slope: median(slope),
    caution,
  }
}

export type SortKey = 'length' | 'bhr' | 'er' | 'lbh' | 'da' | 'name'

export const SORTS: { key: SortKey, label: string }[] = [
  { key: 'length', label: 'Length, longest first' },
  { key: 'bhr', label: 'Bank height ratio, highest first' },
  { key: 'er', label: 'Entrenchment ratio, highest first' },
  { key: 'lbh', label: 'Low-bank height, highest first' },
  { key: 'da', label: 'Drainage area, largest first' },
  { key: 'name', label: 'Stream name' },
]

/** Sites in rank order: the chosen sort, ties by site id. */
export function rankSites(sites: Site[], key: SortKey): Site[] {
  const v = (s: Site): number => {
    switch (key) {
      case 'length': return s.lengthM
      case 'bhr': return s.bhr
      case 'er': return s.er
      case 'lbh': return Number.isFinite(s.lbhM) ? s.lbhM : -Infinity
      case 'da': return s.daSqkm
      default: return 0
    }
  }
  return [...sites].sort((a, b) => {
    if (key === 'name') return (a.name || '~').localeCompare(b.name || '~') || a.id.localeCompare(b.id)
    return v(b) - v(a) || a.id.localeCompare(b.id)
  })
}
