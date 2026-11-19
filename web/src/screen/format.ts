// Numbers and words as the page shows them: US customary units, the two ratios to two decimals
// ("at least 2.00" where the median bank height ratio sits at the method's cap), and each flag in
// plain words.
import { Q_CAUTION, Q_NODATA, Q_OK, Q_UNSAMPLED, WHY, type UnitFile } from '../data/units'

export const FT_PER_M = 3.28083989501312
export const SQMI_PER_SQKM = 1 / 2.589988110336
export const MI_PER_M = 1 / 1609.344

export function ft(m: number, digits = 0): string {
  return Number.isFinite(m) ? (m * FT_PER_M).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : 'n/a'
}

export function mi(m: number, digits = 1): string {
  return Number.isFinite(m) ? (m * MI_PER_M).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : 'n/a'
}

export function sqmi(km2: number): string {
  if (!Number.isFinite(km2)) return 'n/a'
  const v = km2 * SQMI_PER_SQKM
  return v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : v < 100 ? 1 : 0 })
}

export function count(n: number): string {
  return n.toLocaleString('en-US')
}

export function ratio(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : 'n/a'
}

/** A row's median bank height ratio as text ("at least 2.00" at the cap). */
export function bhrText(f: UnitFile, r: number): string {
  const v = f.bhr[r] / 100
  if (!Number.isFinite(v)) return 'n/a'
  return f.why[r] & WHY.atCap ? `at least ${v.toFixed(2)}` : v.toFixed(2)
}

export function slopeText(s: number): string {
  return Number.isFinite(s) ? `${(s * 100).toFixed(2)}%` : 'n/a'
}

export const QUALITY_LABEL: Record<number, string> = {
  [Q_OK]: 'No flags',
  [Q_CAUTION]: 'Use with caution',
  [Q_NODATA]: 'Not enough data',
  [Q_UNSAMPLED]: 'Not sampled',
}

/** The flags of a row, each in plain words. */
export function flagTexts(f: UnitFile, r: number): string[] {
  const out: string[] = []
  const w = f.why[r]
  const n = f.n[r]
  if (f.q[r] === Q_UNSAMPLED) {
    return ['The grid does not sample this line: wide rivers mapped as artificial paths, lakes and connectors have no cross-sections.']
  }
  if (w & WHY.noDem) out.push('No elevation data here.')
  else if (w & WHY.few) out.push(`Only ${f.nOk[r]} of ${n} cross-sections could be measured, too few for a reach median.`)
  if (w & WHY.bhrRange) out.push('The median bank height ratio is at or below zero, which is not physical.')
  if (w & WHY.erRange) out.push('The median entrenchment ratio is below 1, which is not physical.')
  if (w & WHY.capFloor) out.push('The bank height ratio reads 2.00 only because the channel is too shallow for the elevation data to show a bank below the cap.')
  if (w & WHY.extrapolated) out.push('Bankfull size comes from a regional curve used outside the drainage areas it was built from. Treat the ratios as rough.')
  if (w & WHY.crestOnly) out.push('No clear break in slope was found, so the bank is the highest ground beside the channel.')
  if (w & WHY.fewish) out.push(`Only ${f.nOk[r]} of ${n} cross-sections were measured.`)
  if (w & WHY.edge) out.push('The flood-prone width reaches the end of the sampled line, so the entrenchment ratio is at least the value shown.')
  if (w & WHY.coarseDem) out.push(`Measured on a ${f.res[r]} m elevation model, coarser than lidar.`)
  if (w & WHY.atCap) out.push('Bank height ratio is at least 2.00: the low bank is at or above twice the bankfull depth, where the method stops measuring.')
  const unm = f.nUnm[r] + f.nNodem[r]
  if (unm > 0 && !(w & (WHY.few | WHY.noDem))) out.push(`${unm} of ${n} cross-sections could not be measured.`)
  return out
}
