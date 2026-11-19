// The user's cross-section edits (src/screen/edits.ts): an edited reach's values by the reach layer's own
// rules (medians checked against Python's numbers from data/fprdata/stats.py's formula), its quality,
// the patch and its exact revert, edits re-applied as a file loads, and the screen they change.
import { describe, expect, it } from 'vitest'
import { Q_CAUTION, Q_NODATA, Q_OK, WHY, type UnitFile } from '../src/data/units'
import { Edits, reachValues, type SectionEdit } from '../src/screen/edits'
import { Network, refMask, refOf } from '../src/screen/model'
import { defaultCriteria, screen, type Criteria } from '../src/screen/screen'
import { plainMedian, ratioMedian } from '../src/xs/reach'
import { network, type RowSpec } from './net'

const sec = (o: Partial<SectionEdit> = {}): SectionEdit => ({ line: '1004', k: 0, i: 0, bfM: 0.5, lbM: 0.85, er: 250, bhr: 170, bfd: 50, bfw: 60,
  fpw: 150, lbh: 85, edge: false, res: 1, profile: 'stored', ...o })

/** Every value array of a file, copied (to compare a revert bit for bit). */
const snapshot = (f: UnitFile) => ['bhr', 'bhrLo', 'bhrHi', 'er', 'erLo', 'erHi', 'bfw', 'fpw', 'bfd', 'lbh', 'q', 'why', 'edited']
  .map((k) => Array.from((f as any)[k] as ArrayLike<number>))

describe('the reach rule over edited sections', () => {
  it('takes medians as the builder does (Python numbers)', () => {
    const cases: [number[], number][] = [[[150, 120, 180], 150], [[120, 150], 135], [[101, 102], 102], [[125, 126], 125],
      [[201, 240], 221], [[100, 103, 105, 109], 104], [[37, 38], 38]]
    for (const [v, want] of cases) expect(ratioMedian(v), v.join(',')).toBe(want)
    expect([[12.5], [13.5], [600, 601], [81, 81.5]].map(plainMedian)).toEqual([12, 14, 600, 81])
    expect(ratioMedian([])).toBeNull()
  })

  it('one edit gives that section; several give their medians and range', () => {
    const one = reachValues([sec({ bhr: 240, er: 180 })])
    expect([one.bhr, one.bhrLo, one.bhrHi, one.er]).toEqual([240, 240, 240, 180])
    const two = reachValues([sec({ i: 0, bhr: 120, er: 300, bfw: 50, lbh: 60.4 }), sec({ i: 3, k: 3, bhr: 150, er: 200, bfw: 61, lbh: 75.2 })])
    expect([two.bhr, two.bhrLo, two.bhrHi, two.er, two.erLo, two.erHi, two.bfw, two.lbh]).toEqual([135, 120, 150, 250, 200, 300, 56, 68])
  })

  it("sets only the flags that still mean something for the user's heights", () => {
    expect(reachValues([sec()])).toMatchObject({ q: Q_OK, why: 0 })
    expect(reachValues([sec({ bhr: 0 })])).toMatchObject({ q: Q_NODATA, why: WHY.bhrRange })
    expect(reachValues([sec({ er: 90 })])).toMatchObject({ q: Q_NODATA, why: WHY.erRange })
    expect(reachValues([sec({ edge: true })])).toMatchObject({ q: Q_CAUTION, why: WHY.edge })
    expect(reachValues([sec({ res: 3 })])).toMatchObject({ q: Q_CAUTION, why: WHY.coarseDem })
    // an even count: either middle section edge-limited makes the median edge-limited
    expect(reachValues([sec({ er: 200 }), sec({ i: 1, k: 1, er: 250, edge: true })]).why).toBe(WHY.edge)
    // a capped grid median does not carry over: the user's ratio is a reading
    expect(reachValues([sec({ bhr: 260 })]).why & WHY.atCap).toBe(0)
  })
})

describe('edits on loaded files', () => {
  it('patch a row and revert it exactly', () => {
    const f = network([])
    const before = snapshot(f)
    const edits = new Edits()
    edits.setSection(f, 4, '0101', sec({ bhr: 240 }))
    expect([f.bhr[4], f.edited[4], edits.size]).toEqual([240, 1, 1])
    expect(edits.grid(f, 4).bhr).toBe(160)
    edits.setSection(f, 4, '0101', sec({ k: 5, i: 5, bhr: 120 }))
    expect([f.bhr[4], f.edited[4]]).toEqual([180, 2])
    edits.setSection(f, 4, '0101', sec({ k: 5, i: 5, bhr: 140 }))
    expect([f.bhr[4], f.edited[4]]).toEqual([190, 2])
    edits.clearSection(f, 4, '1004', 0)
    expect([f.bhr[4], f.edited[4]]).toEqual([140, 1])
    edits.clearReach(f, 4)
    expect(snapshot(f)).toEqual(before)
    expect(edits.size).toBe(0)
  })

  it('come back when a file loads, and drop a reach the data no longer holds', () => {
    const edits = new Edits()
    edits.load(JSON.parse(JSON.stringify({
      '1004-0': { huc8: '01010001', vpu: '0101', n: 10, sections: [sec({ bhr: 240 })] },
      '1003-0': { huc8: '01010001', vpu: '0101', n: 9, sections: [sec({ line: '1003' })] },
      '9999-0': { huc8: '01010001', vpu: '0101', n: 10, sections: [sec({ line: '9999' })] },
      '5555-0': { huc8: '02020002', vpu: '0202', n: 10, sections: [sec({ line: '5555' })] },
    })))
    const f = network([])
    expect(edits.applyFile(f).sort()).toEqual(['1003-0', '9999-0'])
    expect([f.bhr[4], f.edited[4], f.bhr[3]]).toEqual([240, 1, 160])
    expect(Object.keys(edits.toJSON()).sort()).toEqual(['1004-0', '5555-0'])
    const again = new Edits()
    again.load(JSON.parse(JSON.stringify(edits.toJSON())))
    expect(again.toJSON()).toEqual(edits.toJSON())
    edits.clearAll([f])
    expect([f.bhr[4], f.edited[4], edits.size]).toEqual([160, 0, 0])
  })

  it('change the screen: an edit lifts a reach over the threshold and joins two sites', () => {
    const specs: RowSpec[] = []
    specs[4] = { bhr: 120 }
    const f = network(specs)
    const net = new Network()
    net.add(f)
    const masks = refMask(net, [0, 1, 2, 3, 4, 5].map((r) => refOf(0, r)))
    const crit: Criteria = { ...defaultCriteria(), daMinSqmi: null, gapReaches: 0, minSiteFt: 0 }
    const sizes = () => screen(net, masks, crit).sites.map((s) => s.refs.length).sort()
    expect(sizes()).toEqual([1, 4])
    const edits = new Edits()
    edits.setSection(f, 4, '0101', sec({ bhr: 170 }))
    expect(sizes()).toEqual([6])
    edits.clearReach(f, 4)
    expect(sizes()).toEqual([1, 4])
  })
})
