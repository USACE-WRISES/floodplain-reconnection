// The Screen step's four rows (the owner, 2026-11-20): a checkbox turns each criterion on or off, and
// the row keeps its typed value while it is off. The screen reads the criteria as before (screen.ts): a
// row that is off is null there, or 0 for the site length, so the builder and every saved screening
// keep one meaning. The values the rows hold while off travel beside the criteria (a saved file's
// `held`).
import { defaultCriteria, type Criteria } from './screen'

export type RowKey = 'daMinSqmi' | 'bhrMin' | 'erMin' | 'minSiteFt'
export const ROW_KEYS: readonly RowKey[] = ['daMinSqmi', 'bhrMin', 'erMin', 'minSiteFt']
/** Each row's typed value, kept while the row is off. */
export type Held = Record<RowKey, number>

/** The shortest site when its row is turned on. The row starts off: reaches run about 1,000 ft and
 * over half are a little shorter, so one reach alone would often fall short of 1,000 ft. */
export const SITE_FT = 1000

/** The starting values: the starting criteria's, or the first placeholders where a starting value is
 * off, and SITE_FT for the site length. */
export function heldStart(): Held {
  const c = defaultCriteria()
  return { daMinSqmi: c.daMinSqmi ?? 2, bhrMin: c.bhrMin ?? 1.5, erMin: c.erMin ?? 2.2, minSiteFt: c.minSiteFt > 0 ? c.minSiteFt : SITE_FT }
}

/** Is a row on? A criterion that is set, or a site length above 0. */
export function rowOn(c: Criteria, k: RowKey): boolean {
  return k === 'minSiteFt' ? c.minSiteFt > 0 : c[k] !== null
}

/** A value a row can hold: a number of 0 or more, and more than 0 for the site length (0 ft is the
 * same as off, and its checkbox says that). */
export function holdable(k: RowKey, v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && (k === 'minSiteFt' ? v > 0 : v >= 0)
}

/** The criteria and the held values after a row's checkbox or box changes. An empty or unreadable box
 * keeps the value held. */
export function applyRow(c: Criteria, held: Held, k: RowKey, on: boolean, typed?: number | null): { criteria: Criteria, held: Held } {
  const v = holdable(k, typed) ? typed : held[k]
  const criteria = { ...c }
  if (k === 'minSiteFt') criteria.minSiteFt = on ? v : 0
  else criteria[k] = on ? v : null
  return { criteria, held: { ...held, [k]: v } }
}

/** The values the rows hold when a saved screening opens: a row that is on holds its criterion's value;
 * one that is off, the file's held value (screenings saved before 0.3.2 have none), else the start. */
export function heldFrom(c: Criteria, saved?: Partial<Record<RowKey, unknown>> | null): Held {
  const held = heldStart()
  for (const k of ROW_KEYS) {
    if (rowOn(c, k)) held[k] = k === 'minSiteFt' ? c.minSiteFt : c[k] as number
    else if (holdable(k, saved?.[k])) held[k] = saved![k] as number
  }
  return held
}

/** A saved file's held values are readable: an object whose row keys, where present, hold numbers. */
export function readableHeld(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return ROW_KEYS.every((k) => (v as Record<string, unknown>)[k] === undefined || holdable(k, (v as Record<string, unknown>)[k]))
}
