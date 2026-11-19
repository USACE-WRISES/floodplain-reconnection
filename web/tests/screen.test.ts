import { describe, expect, it } from 'vitest'
import { WHY } from '../src/data/units'
import { hucMask, Network, refMask, refOf } from '../src/screen/model'
import { defaultCriteria, rankSites, screen, STAGE, type Criteria } from '../src/screen/screen'
import { B, M, network, T, type RowSpec } from './net'

function setup(specs: RowSpec[], area?: number[]) {
  const net = new Network()
  net.add(network(specs))
  const masks = area ? refMask(net, area.map((r) => refOf(0, r))) : [new Uint8Array(10).fill(1)]
  return { net, masks }
}

const crit = (c: Partial<Criteria> = {}): Criteria => ({ ...defaultCriteria(), daMinSqmi: null, ...c })

describe('the funnel', () => {
  it('counts the rows past each criterion', () => {
    const specs: RowSpec[] = []
    specs[0] = { q: 3 }                       // not sampled
    specs[1] = { q: 2 }                       // not enough data
    specs[2] = { q: 1 }                       // caution, passes
    specs[3] = { bhr: 140 }                   // fails BHR
    specs[4] = { er: 150 }                    // fails ER
    specs[6] = { fclass: 2 }                  // a canal
    const { net, masks } = setup(specs)
    const r = screen(net, masks, crit())
    const by = Object.fromEntries(r.funnel.map((f) => [f.key, f.reaches]))
    expect(by).toEqual({ reaches: 9, canals: 8, measured: 7, bhr: 6, er: 5 })
    expect(r.pass).toBe(5)
    expect(r.stage[0][0]).toBe(STAGE.unsampled)
    expect(r.stage[0][6]).toBe(STAGE.canal)
    expect(r.stage[0][3]).toBe(STAGE.bhr)
  })

  it('leaves out cautions and capped reaches when asked', () => {
    const specs: RowSpec[] = []
    specs[2] = { q: 1 }
    specs[5] = { bhr: 200, why: WHY.atCap }
    const { net, masks } = setup(specs)
    expect(screen(net, masks, crit({ includeCaution: false })).stage[0][2]).toBe(STAGE.unmeasured)
    expect(screen(net, masks, crit({ countCapped: false })).stage[0][5]).toBe(STAGE.bhr)
    expect(screen(net, masks, crit()).stage[0][5]).toBe(STAGE.pass)
  })

  it('holds drainage area in square miles, bounds included', () => {
    const specs: RowSpec[] = []
    specs[0] = { da: 2 * 2.589988110336 }
    specs[1] = { da: 1.9 * 2.589988110336 }
    const { net, masks } = setup(specs)
    const r = screen(net, masks, crit({ daMinSqmi: 2 }))
    expect(r.stage[0][0]).toBe(STAGE.pass)
    expect(r.stage[0][1]).toBe(STAGE.da)
  })
})

describe('candidate sites', () => {
  it('join passing reaches along the main stem across short gaps', () => {
    const specs: RowSpec[] = []
    specs[2] = { er: 150 }                    // a gap
    specs[4] = { bhr: 120 }
    specs[5] = { bhr: 120 }
    for (const r of [...T, ...B]) specs[r] = { bhr: 100 }
    const { net, masks } = setup(specs)
    const one = screen(net, masks, crit({ gapReaches: 1, minSiteFt: 0 }))
    expect(one.sites.map((s) => s.refs.length)).toEqual([4])
    expect(one.sites[0].pass).toEqual([true, true, false, true])
    expect(one.sites[0].id).toBe('1003-0')
    const none = screen(net, masks, crit({ gapReaches: 0, minSiteFt: 0 }))
    expect(none.sites.map((s) => s.refs.length).sort()).toEqual([1, 2])
  })

  it('keep a tributary apart from the stem it joins', () => {
    const specs: RowSpec[] = []
    for (const r of [0, 1, 2]) specs[r] = { bhr: 100 }
    for (const r of [...B, 4, 5]) specs[r] = { bhr: 100 }
    const { net, masks } = setup(specs)
    const r = screen(net, masks, crit({ minSiteFt: 0 }))
    const sets = r.sites.map((s) => s.refs.map((x) => x % 0x1000000).join(','))
    expect(sets.sort()).toEqual(['3', '6,7'])
  })

  it('end at a reach outside the area or not sampled, and keep only long enough sites', () => {
    const specs: RowSpec[] = []
    specs[2] = { q: 3 }
    for (const r of [...T, ...B]) specs[r] = { bhr: 100 }
    const { net } = setup(specs)
    const masks = refMask(net, [0, 1, 2, 3, 4, 5].map((r) => refOf(0, r)))
    const all = screen(net, masks, crit({ minSiteFt: 0 }))
    expect(all.sites.map((s) => s.refs.length).sort()).toEqual([2, 3])
    const long = screen(net, masks, crit({ minSiteFt: 2500 }))
    expect(long.sites.map((s) => s.refs.length)).toEqual([3])
    expect(long.shortRuns).toBe(2)
  })

  it('carry site values and rank by the chosen key', () => {
    const specs: RowSpec[] = []
    specs[0] = { bhr: 150, er: 300, lbh: 100 }
    specs[1] = { bhr: 170, er: 260, lbh: 120 }
    specs[2] = { bhr: 200, er: 240, why: WHY.atCap }
    specs[3] = { bhr: 100 }
    for (const r of [...T, ...B]) specs[r] = { bhr: 100 }
    specs[6] = { bhr: 190, er: 400 }
    const { net, masks } = setup(specs)
    const r = screen(net, masks, crit({ minSiteFt: 0, gapReaches: 0 }))
    const stem = r.sites.find((s) => s.refs.length === 3)!
    expect(stem.bhr).toBeCloseTo(1.7)
    expect(stem.bhrLo).toBeCloseTo(1.5)
    expect(stem.bhrHi).toBeCloseTo(2.0)
    expect(stem.bhrAtCap).toBe(1)
    expect(stem.er).toBeCloseTo(2.6)
    expect(stem.lengthM).toBeCloseTo(914.4)
    expect(rankSites(r.sites, 'length')[0]).toBe(stem)
    expect(rankSites(r.sites, 'er')[0].refs.length).toBe(1)
  })
})

describe('study areas', () => {
  it('walk upstream through every branch and the minor branch head', () => {
    const { net } = setup([])
    const all = net.walk(refOf(0, 5))
    expect([...all].map((x) => x % 0x1000000).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const branch = net.walk(refOf(0, 9))
    expect([...branch].map((x) => x % 0x1000000).sort((a, b) => a - b)).toEqual([0, 1, 8, 9])
    const trib = net.walk(refOf(0, 7))
    expect([...trib].map((x) => x % 0x1000000).sort((a, b) => a - b)).toEqual([6, 7])
  })

  it('pick rows by HUC12, HUC10 or HUC8', () => {
    const { net } = setup([])
    expect([...hucMask(net, ['010100010101'])[0]]).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 0])
    expect([...hucMask(net, ['0101000101'])[0]].every((v) => v === 1)).toBe(true)
    expect([...hucMask(net, ['01010002'])[0]].every((v) => v === 0)).toBe(true)
  })

  it('resolve links into files loaded later', () => {
    const net = new Network()
    const up = network([], '01010001')
    up.dnHuc8[5] = 1010002
    up.dnRow[5] = 0
    up.main[5] = 1
    net.add(up)
    expect(net.dn(refOf(0, 5))).toBe(-2)
    net.add(network([], '01010002'))
    expect(net.dn(refOf(0, 5))).toBe(refOf(1, 0))
    expect(net.upstream(refOf(1, 0))).toContain(refOf(0, 5))
    expect(net.walk(refOf(1, 0)).size).toBe(11)
  })
})
