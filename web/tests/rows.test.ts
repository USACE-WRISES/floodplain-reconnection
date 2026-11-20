import { describe, expect, it } from 'vitest'
import { applyRow, heldFrom, heldStart, readableHeld, rowOn, SITE_FT } from '../src/screen/rows'
import { defaultCriteria, presetOf } from '../src/screen/screen'

describe('the starting rows', () => {
  it('start on, but the site length, which holds 1,000 ft for when it is turned on', () => {
    const c = defaultCriteria()
    expect(rowOn(c, 'daMinSqmi')).toBe(true)
    expect(rowOn(c, 'bhrMin')).toBe(true)
    expect(rowOn(c, 'erMin')).toBe(true)
    expect(rowOn(c, 'minSiteFt')).toBe(false)
    expect(c.minSiteFt).toBe(0)
    expect(heldStart()).toEqual({ daMinSqmi: 2, bhrMin: 1.5, erMin: 2.2, minSiteFt: SITE_FT })
    expect(presetOf(c)?.id).toBe('A')
  })
})

describe('applyRow', () => {
  it('turns a row off and back on, keeping its value', () => {
    const start = { criteria: defaultCriteria(), held: heldStart() }
    const off = applyRow(start.criteria, start.held, 'bhrMin', false, 1.7)
    expect(off.criteria.bhrMin).toBeNull()
    expect(off.held.bhrMin).toBe(1.7)
    const on = applyRow(off.criteria, off.held, 'bhrMin', true, 1.7)
    expect(on.criteria.bhrMin).toBe(1.7)
  })

  it('reads the site length off as 0, and on as its value', () => {
    const c = defaultCriteria()
    const on = applyRow(c, heldStart(), 'minSiteFt', true, 2500)
    expect(on.criteria.minSiteFt).toBe(2500)
    expect(rowOn(on.criteria, 'minSiteFt')).toBe(true)
    const off = applyRow(on.criteria, on.held, 'minSiteFt', false, 2500)
    expect(off.criteria.minSiteFt).toBe(0)
    expect(off.held.minSiteFt).toBe(2500)
  })

  it('keeps the value held for an empty or unreadable box, and for 0 ft', () => {
    const c = defaultCriteria()
    const h = heldStart()
    expect(applyRow(c, h, 'erMin', true, null).criteria.erMin).toBe(2.2)
    expect(applyRow(c, h, 'erMin', true, Number.NaN).criteria.erMin).toBe(2.2)
    expect(applyRow(c, h, 'minSiteFt', true, 0).criteria.minSiteFt).toBe(SITE_FT)
    // a ratio may be 0: on, and nothing is left out
    expect(applyRow(c, h, 'bhrMin', true, 0).criteria.bhrMin).toBe(0)
  })

  it('leaves the other criteria alone', () => {
    const c = defaultCriteria()
    const out = applyRow(c, heldStart(), 'daMinSqmi', false, 2).criteria
    expect({ ...out, daMinSqmi: c.daMinSqmi }).toEqual(c)
  })
})

describe('heldFrom', () => {
  it('opens a screening saved before 0.3.2 as it was screened', () => {
    // 1,000 ft sites and BHR off, with no held values
    const c = { ...defaultCriteria(), minSiteFt: 1000, bhrMin: null }
    const held = heldFrom(c, undefined)
    expect(rowOn(c, 'minSiteFt')).toBe(true)
    expect(held.minSiteFt).toBe(1000)
    expect(rowOn(c, 'bhrMin')).toBe(false)
    expect(held.bhrMin).toBe(1.5)
  })

  it('takes a row that is on from its criterion, and one that is off from the file', () => {
    const c = { ...defaultCriteria(), daMinSqmi: 0.1, erMin: null }
    const held = heldFrom(c, { daMinSqmi: 5, erMin: 1.3, minSiteFt: 3000 })
    expect(held.daMinSqmi).toBe(0.1)
    expect(held.erMin).toBe(1.3)
    expect(held.minSiteFt).toBe(3000)
  })

  it('skips held values it cannot hold', () => {
    const c = { ...defaultCriteria(), erMin: null }
    expect(heldFrom(c, { erMin: -1, minSiteFt: 0 }).erMin).toBe(2.2)
    expect(heldFrom(c, { minSiteFt: 0 }).minSiteFt).toBe(SITE_FT)
  })
})

describe('readableHeld', () => {
  it('reads an object of numbers, some keys missing', () => {
    expect(readableHeld({ bhrMin: 1.5, minSiteFt: 1000 })).toBe(true)
    expect(readableHeld({})).toBe(true)
  })

  it('refuses anything else', () => {
    expect(readableHeld(null)).toBe(false)
    expect(readableHeld([1, 2])).toBe(false)
    expect(readableHeld({ bhrMin: '1.5' })).toBe(false)
    expect(readableHeld({ minSiteFt: 0 })).toBe(false)
  })
})
