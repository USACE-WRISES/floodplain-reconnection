// A reach popup's small map: each section's exact line from the grid's position, direction and width
// (src/xs/sectionLines.ts).
import { describe, expect, it } from 'vitest'
import type { XsPull } from '../src/xs/grid'
import { albersForward } from '../src/xs/projExact'
import type { ReachSection } from '../src/xs/reach'
import { lineOf, sectionLines } from '../src/xs/sectionLines'

const [X, Y] = albersForward(-84.49, 33.73)

/** A reach's section on a line, its part and k, and its sampled half-width. */
const section = (id: number, k: number, wide: number | null = 250, part = 0) =>
  ({ vpu: '0313', id: BigInt(id), k, at: 0, num: { part }, det: wide === null ? null : { wide }, stored: false }) as unknown as ReachSection

/** A line's places: every k from 0 to 9, a meter apart going north, crossing east to west. */
const pulls = (x0: number): XsPull[] => Array.from({ length: 10 }, (_, k) => ({ part: 0, k, x: x0, y: Y + k, nx: 1, ny: 0, zCrc: null }))

describe('lineOf', () => {
  it('runs the section across its width, through the exact projection', () => {
    const l = lineOf({ x: X, y: Y, nx: 0.6, ny: 0.8 }, 50)
    expect(l.full).toBe(true)
    const back = (p: [number, number]) => albersForward(p[1], p[0])
    const near = (p: [number, number], x: number, y: number) => {
      const [bx, by] = back(p)
      expect(Math.abs(bx - x)).toBeLessThan(1e-4)
      expect(Math.abs(by - y)).toBeLessThan(1e-4)
    }
    near(l.mid, X, Y)
    near(l.a, X - 30, Y - 40)
    near(l.b, X + 30, Y + 40)
  })

  it('gives a stub where the width is unknown', () => {
    expect(lineOf({ x: X, y: Y, nx: 1, ny: 0 }, null).full).toBe(false)
    expect(lineOf({ x: X, y: Y, nx: 1, ny: 0 }, 0).full).toBe(false)
  })
})

describe('sectionLines', () => {
  it('matches each section on its own line, k starting again on each', async () => {
    // the reach's last three sections of line 1, then the first two of line 2
    const sections = [section(1, 7), section(1, 8), section(1, 9), section(2, 0), section(2, 1)]
    const lines = await sectionLines(sections, async (_vpu, id) => pulls(id === 1n ? X : X + 1000))
    expect(lines).toHaveLength(5)
    const east = (i: number) => albersForward(lines![i]!.mid[1], lines![i]!.mid[0])[0]
    expect(Math.abs(east(2) - X)).toBeLessThan(1e-4)
    expect(Math.abs(east(3) - (X + 1000))).toBeLessThan(1e-4)
  })

  it('reads each line once', async () => {
    const asked: bigint[] = []
    await sectionLines([section(1, 0), section(1, 1), section(2, 0)], async (_vpu, id) => {
      asked.push(id)
      return pulls(X)
    })
    expect(asked.sort()).toEqual([1n, 2n])
  })

  it('gives null for all when no line has places (a release before format 3)', async () => {
    expect(await sectionLines([section(1, 0)], async () => null)).toBeNull()
  })

  it('leaves out only the sections of a line that fails, or that has no row', async () => {
    const sections = [section(1, 0), section(2, 0), section(1, 42)]
    const lines = await sectionLines(sections, async (_vpu, id) => {
      if (id === 2n) throw new Error('no read')
      return pulls(X)
    })
    expect(lines![0]).not.toBeNull()
    expect(lines![1]).toBeNull()
    expect(lines![2]).toBeNull()
  })

  it('draws a stub for a section the release holds no width for', async () => {
    const lines = await sectionLines([section(1, 0, null)], async () => pulls(X))
    expect(lines![0]!.full).toBe(false)
  })
})
