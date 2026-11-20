import { describe, expect, it } from 'vitest'
import { chipsOf, toggleUnit, unitOf } from '../src/screen/hucs'

// Two HUC8s: 03130002, with HUC10 0313000201 (three HUC12s) and 0313000202 (two), and 03130003, with
// one HUC10 of a single HUC12.
const ALL = ['031300020101', '031300020102', '031300020103', '031300020201', '031300020202', '031300030101']
const HUC8 = ALL.slice(0, 5)
const HUC10 = ALL.slice(0, 3)
const under = (code: string): string[] => ALL.filter((c) => c.startsWith(code))

describe('unitOf', () => {
  it('a HUC12, or every HUC12 of its HUC10 or HUC8', () => {
    expect(unitOf('031300020102', 12, ALL)).toEqual(['031300020102'])
    expect(unitOf('031300020102', 10, ALL)).toEqual(HUC10)
    expect(unitOf('031300020102', 8, ALL)).toEqual(HUC8)
  })

  it('a code the outlines do not hold is a unit of its own', () => {
    expect(unitOf('031300029901', 10, ALL)).toEqual(['031300029901'])
  })
})

describe('toggleUnit', () => {
  it('adds a unit none of which is picked', () => {
    const codes = new Set<string>()
    expect(toggleUnit(codes, HUC10)).toBe('added')
    expect([...codes].sort()).toEqual(HUC10)
  })

  it('completes a unit picked in part', () => {
    const codes = new Set(['031300020102', '031300030101'])
    expect(toggleUnit(codes, HUC10)).toBe('added')
    expect([...codes].sort()).toEqual([...HUC10, '031300030101'])
  })

  it('takes out a unit picked in full, and nothing else', () => {
    const codes = new Set([...HUC10, '031300030101'])
    expect(toggleUnit(codes, HUC10)).toBe('removed')
    expect([...codes]).toEqual(['031300030101'])
  })
})

describe('chipsOf', () => {
  it('a whole HUC8 is one chip', () => {
    expect(chipsOf(HUC8, under)).toEqual([{ size: 8, code: '03130002', codes: HUC8 }])
  })

  it('a whole HUC10 in a HUC8 picked in part, then the HUC12s left one each', () => {
    expect(chipsOf(['031300020201', '031300020103', '031300020101', '031300020102'], under)).toEqual([
      { size: 10, code: '0313000201', codes: HUC10 },
      { size: 12, code: '031300020201', codes: ['031300020201'] },
    ])
  })

  it('outlines not loaded: one chip per HUC12', () => {
    expect(chipsOf(HUC10, () => null).map((c) => c.code)).toEqual(HUC10)
  })

  it('a HUC8 or HUC10 of a single HUC12 stays that HUC12', () => {
    expect(chipsOf(['031300030101'], under)).toEqual([{ size: 12, code: '031300030101', codes: ['031300030101'] }])
  })
})
