// One cross-section, measured as STAF's grid measured it (STAF's tools/xs-grid/xsgrid/derive.py; the
// chain copied from STAF's static web app, apps/staf-web/src/tools/easi/xscard.ts `summarized`): the
// samples trimmed to a height-balanced band around the thalweg and thinned, then the bankfull stage for
// the section's regional (Bieger) area, the default low bank and the ratios. At its own stages a section
// gives the grid's numbers to the digit, so the user's heights are measured on the same profile.
//
// The user's heights are not capped: the bank height ratio is the low-bank height over the bankfull
// depth even above 2.00 (the owner, 2026-11-19). Only the grid's own detected low bank stops at twice
// the bankfull depth, where its detector stops looking.
import { stations as linspace } from './codec'
import { balancedProfile, deriveFromStages, flowArea, simplifyProfile, summarizeProfile } from './geomorph'
import type { XsSection } from './grid'
import { pyRound, pyRoundTo } from './pyfixed'

/** A section's numbers in the units of the grid's numbers file: ratios x100, the bankfull depth m x100,
 * widths m x10 (null where none). `lbh` is the low-bank height above the thalweg, m x100 (unrounded:
 * a reach rounds its median, as the reach layer's builder does). */
export interface Measured {
  er: number | null
  bhr: number | null
  bfd: number | null
  bfw: number | null
  fpw: number | null
  lbh: number | null
  /** the channel's cross-section area below bankfull, m2 */
  bfArea: number | null
  /** the flood-prone width reaches the end of the profile, so the entrenchment ratio is a floor */
  edge: boolean
  /** the grid's low bank sits at its cap, twice the bankfull depth (never for the user's heights) */
  capped: boolean
}

/** A section's profile as measured: the trimmed, thinned samples (stations in m from the thalweg,
 * elevations in m), the grid's own stages and its numbers at them. */
export interface Profile {
  st: number[]
  el: number[]
  thalweg: number
  bfStage: number
  lbStage: number
  grid: Measured
  bankDetection: string
  /** the regional curve's division (Bieger), null where none */
  division: string | null
  /** DEM cell size, m */
  res: number
}

const x100 = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : pyRound(v * 100))
const x10 = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : pyRound(v * 10))

/** derive.metrics' chain on one transect (`n_pts` float32 samples across `wide` either side): the
 * summarize_profile record, or null when the transect cannot be scored. */
export function summarized(z: Float32Array, sec: XsSection, res: number): Record<string, any> | null {
  const ts = linspace(sec.wide, sec.nPts)
  const st: number[] = []
  const el: number[] = []
  for (let i = 0; i < z.length; i++) {
    if (Number.isFinite(z[i])) {
      st.push(ts[i])
      el.push(z[i])
    }
  }
  if (st.length < 7) return null
  const bal = balancedProfile(st, el)
  if (!bal) return null
  const [s2, e2] = simplifyProfile(bal[0], bal[1])
  return summarizeProfile(s2, e2, sec.daSqkm || 1.0, { bankfull: [sec.rcWidth, sec.rcDepth], bankfullAreaM2: sec.rcArea,
    division: sec.division, demResM: res })
}

/** A section's profile from its samples, or null when the grid could not have scored it. */
export function profileFrom(z: Float32Array, sec: XsSection, res: number): Profile | null {
  const s = summarized(z, sec, res)
  const dBf = s?.bankfull_depth_m
  if (!s || !s.profile || s.thalweg === null || s.thalweg === undefined || !dBf) return null
  const thalweg: number = s.thalweg
  const fp = s.fp_stage_m || thalweg + 2.0 * dBf
  const bfStage: number = s.bankfull_stage_m ?? thalweg + dBf
  let lbStage: number | null | undefined = s.low_bank_stage_m
  if (lbStage === null || lbStage === undefined) lbStage = Math.min(Math.max(s.top_of_bank_m || fp, thalweg + dBf), fp)
  const st: number[] = s.profile.stations
  const el: number[] = s.profile.elevs
  const [area] = flowArea(st, el, bfStage)
  return {
    st, el, thalweg, bfStage, lbStage, bankDetection: s.bank_detection, division: s.bankfull_division ?? null, res,
    grid: {
      er: x100(s.entrenchment_ratio), bhr: x100(s.bank_height_ratio), bfd: x100(dBf), bfw: x10(s.bankfull_width_m),
      fpw: x10(s.flood_prone_width_m), lbh: (lbStage - thalweg) * 100, bfArea: area > 0 ? area : null,
      edge: Boolean(s.edge_limited), capped: Boolean(s.low_bank_capped),
    },
  }
}

/** A section's numbers with the bankfull and low-bank heights above the thalweg (m) set by the user. */
export function measure(p: Profile, bfM: number, lbM: number): Measured {
  const bf = p.thalweg + bfM
  const d = deriveFromStages(p.st, p.el, p.thalweg, bf, p.thalweg + lbM)
  const [area] = flowArea(p.st, p.el, bf)
  return {
    er: x100(d.entrenchment_ratio), bhr: x100(d.bank_height_ratio), bfd: bfM > 0 ? pyRound(pyRoundTo(bfM, 2) * 100) : null,
    bfw: x10(d.bankfull_width_m), fpw: x10(d.flood_prone_width_m), lbh: lbM * 100, bfArea: area > 0 ? area : null,
    edge: Boolean(d.edge_limited), capped: false,
  }
}

/** The grid's default heights of a profile above its thalweg, m. */
export function defaultHeights(p: Profile): [number, number] {
  return [p.bfStage - p.thalweg, p.lbStage - p.thalweg]
}
