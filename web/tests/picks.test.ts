import { describe, expect, it } from 'vitest'
import { readSaved } from '../src/app/exports'
import { mercX, mercY, Q_UNSAMPLED } from '../src/data/units'
import { boxMask, Network, refMask, refOf } from '../src/screen/model'
import { addBox, pickedFiles, picksFromBox, resolvePicks, savedPicks, togglePick, type Picks } from '../src/screen/picks'
import { defaultCriteria, screen } from '../src/screen/screen'
import { network, type RowSpec } from './net'

// The synthetic rows run from (-80 + 0.01 i, 40.000) to (-79.995 + 0.01 i, 40.001), in degrees.
function net(specs: RowSpec[] = []): Network {
  const n = new Network()
  n.add(network(specs))
  return n
}

const ids = (p: Picks) => [...p.keys()].sort()

describe('picked reaches', () => {
  it('toggle one at a time', () => {
    const n = net()
    const picks: Picks = new Map()
    expect(togglePick(n, picks, refOf(0, 2))).toBe('added')
    expect(togglePick(n, picks, refOf(0, 3))).toBe('added')
    expect(ids(picks)).toEqual(['1002-0', '1003-0'])
    expect(togglePick(n, picks, refOf(0, 2))).toBe('removed')
    expect(ids(picks)).toEqual(['1003-0'])
  })

  it('never pick a line that was not sampled', () => {
    const n = net([{}, { q: Q_UNSAMPLED }])
    const picks: Picks = new Map()
    expect(togglePick(n, picks, refOf(0, 1))).toBe('not sampled')
    expect(picks.size).toBe(0)
    expect(ids(picksFromBox(n, [-80.001, 39.99, -79.976, 40.01]))).toEqual(['1000-0', '1002-0'])
  })

  it('take every reach a box meets, and add box to box', () => {
    const n = net()
    const picks = picksFromBox(n, [-80.001, 39.99, -79.976, 40.01])
    expect(ids(picks)).toEqual(['1000-0', '1001-0', '1002-0'])
    // a second box adds to the first, and a box again adds nothing new
    expect(addBox(n, picks, mercX(-79.971), mercY(40.01), mercX(-79.956), mercY(39.99))).toBe(2)
    expect(ids(picks)).toEqual(['1000-0', '1001-0', '1002-0', '1003-0', '1004-0'])
    expect(addBox(n, picks, mercX(-80.001), mercY(40.01), mercX(-79.976), mercY(39.99))).toBe(0)
  })

  it('take a reach only when its line runs through the box, not just its extent', () => {
    const n = net()
    const box = (w: number, s: number, e: number, nn: number) => {
      const picks: Picks = new Map()
      addBox(n, picks, mercX(w), mercY(nn), mercX(e), mercY(s))
      return picks
    }
    // inside row 0's extent but above its line (which is at 40.0004 there)
    expect(box(-80.0002, 40.0008, -79.998, 40.002).size).toBe(0)
    // across its line
    expect(ids(box(-79.998, 40.0, -79.997, 40.001))).toEqual(['1000-0'])
    // a box saved by 0.2 still takes the reaches its extent meets, as 0.2 did
    expect(ids(picksFromBox(n, [-80.0002, 40.0008, -79.998, 40.002]))).toEqual(['1000-0'])
  })

  it('open a 0.2 box with the numbers 0.2 screened it to', () => {
    const n = net([{ bhr: 120 }, { q: Q_UNSAMPLED }, {}, {}, { bhr: 130 }])
    const box: [number, number, number, number] = [-80.001, 39.99, -79.946, 40.01]
    const c = { ...defaultCriteria(), daMinSqmi: null }
    const before = screen(n, boxMask(n, mercX(box[0]), mercY(box[3]), mercX(box[2]), mercY(box[1])), c)
    const now = screen(n, refMask(n, picksFromBox(n, box).values()), c)
    expect(now.funnel).toEqual(before.funnel)
    expect(now.sites.map((s) => [s.id, s.lengthM])).toEqual(before.sites.map((s) => [s.id, s.lengthM]))
  })

  it('save the picks in a fixed order, whatever the clicking order', () => {
    const n = net()
    const a: Picks = new Map()
    const b: Picks = new Map()
    for (const r of [5, 0, 9, 2]) togglePick(n, a, refOf(0, r))
    for (const r of [9, 2, 0, 5]) togglePick(n, b, refOf(0, r))
    expect(savedPicks(n, a)).toEqual(savedPicks(n, b))
    expect(savedPicks(n, a).map((x) => x.id)).toEqual(['1000-0', '1002-0', '1005-0', '1009-0'])
  })

  it('say which files the picks come from', () => {
    const n = new Network()
    n.add(network([], '01010001'))
    n.add(network([], '01010002'))
    expect(pickedFiles(n, new Map([['a', refOf(1, 0)], ['b', refOf(0, 4)], ['c', refOf(1, 2)]]))).toEqual(['01010001', '01010002'])
  })

  it('save and open again, dropping what the data no longer hold', () => {
    const n = net([{}, {}, {}, {}, { q: Q_UNSAMPLED }])
    const picks: Picks = new Map()
    togglePick(n, picks, refOf(0, 3))
    togglePick(n, picks, refOf(0, 5))
    const reaches = savedPicks(n, picks)
    const text = JSON.stringify({ format: 'fpr-screening', version: 2, area: { mode: 'reach', codes: [], walk: null, box: null, reaches }, criteria: defaultCriteria() })
    const saved = readSaved(text)
    expect(saved.area.mode).toBe('reach')
    const again = resolvePicks(n, saved.area.reaches!)
    expect(ids(again.picks)).toEqual(['1003-0', '1005-0'])
    expect(again.missing).toBe(0)
    // a reach gone from the data, and one no longer sampled, are missing
    const gone = resolvePicks(n, [...saved.area.reaches!, { huc8: '01010001', id: '9999-0' }, { huc8: '01010001', id: '1004-0' }])
    expect([gone.picks.size, gone.missing]).toEqual([2, 2])
  })
})
