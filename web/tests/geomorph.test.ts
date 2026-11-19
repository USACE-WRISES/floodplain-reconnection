// The cross-section math (src/xs/geomorph.ts) against STAF's Python geomorph.py: STAF's own fixture
// cases (apps/staf-web/tests/fixtures/easi_ref.json, its `geomorph` part, made by STAF's
// make_easi_fixtures.py from seven grid sections and four synthetic ones), and Python's rounding.
import { describe, expect, it } from 'vitest'
import { balancedProfile, deriveFromStages, displayWindow, flowArea, simplifyProfile, summarizeProfile, topOfBankElev } from '../src/xs/geomorph'
import { pyFixed, pyRound } from '../src/xs/pyfixed'
import ref from './fixtures/geomorph_ref.json'

describe('cross-section math as geomorph.py', () => {
  it('trims, thins, summarizes and measures every case exactly', () => {
    for (const g of ref as any[]) {
      const bal = balancedProfile(g.stations, g.elevs)
      expect(bal, g.source).toEqual(g.balanced)
      const simp = bal ? simplifyProfile(bal[0], bal[1]) : null
      expect(simp, g.source).toEqual(g.simplified)
      const [st, el] = simp ?? [g.stations, g.elevs]
      expect(summarizeProfile(st, el, g.da, { bankfull: g.bankfull, bankfullAreaM2: g.area, division: g.summary.bankfull_division ?? null,
        demResM: g.res }), g.source).toEqual(g.summary)
      const th = Math.min(...el)
      let k = 0
      for (const b of g.stages) {
        for (const f of [-0.3, 0.0, 0.8]) expect(deriveFromStages(st, el, th, b, b + f), `${g.source} ${b} ${f}`).toEqual(g.derived[k++])
      }
      expect(g.stages.map((s: number) => flowArea(st, el, s)), g.source).toEqual(g.flowArea)
      expect(g.stages.map((s: number) => displayWindow(st, el, s)), g.source).toEqual(g.window)
      expect(topOfBankElev(st, el), g.source).toEqual(g.topOfBank)
    }
  })
})

describe("Python's rounding", () => {
  it('pyFixed rounds the exact binary value, ties to even', () => {
    expect(pyFixed(39.5, 4)).toBe('39.5000')
    expect(pyFixed(-98.35, 4)).toBe('-98.3500')
    expect(pyFixed(0.1, 1)).toBe('0.1')
    expect(pyFixed(2.675, 2)).toBe('2.67')
    expect(pyFixed(39.03125, 4)).toBe('39.0312')
    expect(pyFixed(-39.03125, 4)).toBe('-39.0312')
    expect(pyFixed(0.125, 2)).toBe('0.12')
    expect(pyFixed(0.375, 2)).toBe('0.38')
    expect(pyFixed(2.5, 0)).toBe('2')
    expect(pyFixed(3.5, 0)).toBe('4')
    expect(pyFixed(0.5, 0)).toBe('0')
  })
  it('pyRound rounds half to even', () => {
    expect([0.5, 1.5, 2.5, -1.5, 2.4999, 2.5001].map(pyRound)).toEqual([0, 2, 2, -2, 2, 3])
  })
})
