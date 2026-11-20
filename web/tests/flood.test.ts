// The Flood-prone area layer's widths (src/map/flood.ts), on the synthetic network of tests/net.ts:
//
//   t0 -> t1 \                (a tributary joining at m3)
//   m0 -> m1 -> m2 -> m3 -> m4 -> m5          (the main stem)
//                b0 -> b1 -> m4             (a branch joining at m4)
import { describe, expect, it } from 'vitest'
import { Q_NODATA } from '../src/data/units'
import { bandWidths, metersPerPixel } from '../src/map/flood'
import { floodWidthM, type ReachSection } from '../src/xs/reach'
import { network } from './net'

/** A network whose rows have these flood-prone widths (m), in the files' m x 10. */
function widths(m: (number | null)[]) {
  const f = network([])
  m.forEach((v, r) => {
    f.fpw[r] = v === null ? Number.NaN : v * 10
  })
  return f
}

describe('bandWidths', () => {
  it('meets each main-stem neighbor halfway, so the band has no steps', () => {
    const f = widths([10, 20, 30, 40, 50, 60, 5, 7, 9, 11])
    const { a, b } = bandWidths(f)
    // m1: from halfway with m0 to halfway with m2
    expect(a[1]).toBeCloseTo(15)
    expect(b[1]).toBeCloseTo(25)
    // each end meets the next reach's start
    for (const r of [0, 1, 2, 3, 4]) expect(b[r]).toBeCloseTo(a[r + 1])
    // the main stem's top and the outlet keep their own width
    expect(a[0]).toBeCloseTo(10)
    expect(b[5]).toBeCloseTo(60)
  })

  it('keeps a tributary mouth at its own width', () => {
    const f = widths([10, 20, 30, 40, 50, 60, 5, 7, 9, 11])
    const { a, b } = bandWidths(f)
    // t1 joins m3 as a tributary, and b1 joins m4
    expect(b[7]).toBeCloseTo(7)
    expect(b[9]).toBeCloseTo(11)
    // up the tributary, t0 and t1 still meet
    expect(b[6]).toBeCloseTo(6)
    expect(a[7]).toBeCloseTo(6)
    // m3's top meets m2, not the tributary
    expect(a[3]).toBeCloseTo(35)
  })

  it('gives no band where a reach has no width, and its neighbors keep their own', () => {
    const f = widths([10, null, 30, 40, 50, 60, 5, 7, 9, 11])
    f.q[3] = Q_NODATA
    const { a, b } = bandWidths(f)
    expect(Number.isNaN(a[1]) && Number.isNaN(b[1])).toBe(true)
    expect(Number.isNaN(a[3]) && Number.isNaN(b[3])).toBe(true)
    expect(b[0]).toBeCloseTo(10)
    expect(a[2]).toBeCloseTo(30)
    expect(b[2]).toBeCloseTo(30)
    expect(a[4]).toBeCloseTo(50)
  })
})

describe('floodWidthM', () => {
  /** A section whose lowest ground lies t m from its point, on a 501-point profile 250 m each side. */
  const section = (t: number) => ({ det: { wide: 250, nPts: 501, thalwegI: 250 + t } }) as unknown as ReachSection

  it('keeps a width whose lowest ground is near the stream', () => {
    // a Utoy Creek section: 11 m off, 46.4 m wide
    expect(floodWidthM(section(11), 464)).toBeCloseTo(46.4)
    // a narrow width a few meters off the mapped line
    expect(floodWidthM(section(-12), 80)).toBeCloseTo(8)
  })

  it('leaves out a width that belongs to another low spot', () => {
    // a Utoy Creek section: its lowest ground 180 m off, 81.7 m wide
    expect(floodWidthM(section(-180), 817)).toBeNull()
    expect(floodWidthM(section(20), 80)).toBeNull()
  })

  it('has nothing to draw without a width', () => {
    expect(floodWidthM(section(0), null)).toBeNull()
    expect(floodWidthM(section(0), 0)).toBeNull()
  })
})

describe('metersPerPixel', () => {
  it('reads the Web Mercator scale', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03, 1)
    expect(metersPerPixel(60, 10)).toBeCloseTo(156543.03 / 2 / 1024, 3)
  })
})
