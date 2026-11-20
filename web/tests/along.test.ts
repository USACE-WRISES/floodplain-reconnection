// Where the Cross-sections layer and a reach popup's small map put a reach's sections, from its line
// alone (src/map/along.ts).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, type AsyncBuffer } from 'hyparquet'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DataSource } from '../src/data/source'
import { loadUnits, type UnitFile } from '../src/data/units'
import { eachTick, floodRing, latLngsOf, markOf, marksAlong, sectionsAlong, spanOf } from '../src/map/along'
import { network } from './net'

/** The places and directions sectionsAlong wrote, as [x, y, ux, uy] rows. */
function placed(xs: number[], ys: number[], n: number, a = 0, e = xs.length): number[][] {
  const out = new Float64Array(4 * n)
  const got = sectionsAlong(xs, ys, a, e, n, out)
  return Array.from({ length: got }, (_, i) => [...out.subarray(4 * i, 4 * i + 4)])
}

function expectRows(got: number[][], want: number[][]): void {
  expect(got.length).toBe(want.length)
  got.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(want[i][j], 9)))
}

describe('sectionsAlong', () => {
  it('spaces a straight line evenly', () => {
    expectRows(placed([0, 10], [0, 0], 10), Array.from({ length: 10 }, (_, i) => [i + 0.5, 0, 1, 0]))
  })

  it('follows a bend: six sections on the first leg, four on the second', () => {
    // 6 east, then 4 south
    const want = [
      ...Array.from({ length: 6 }, (_, i) => [i + 0.5, 0, 1, 0]),
      ...Array.from({ length: 4 }, (_, i) => [6, i + 0.5, 0, 1]),
    ]
    expectRows(placed([0, 6, 6], [0, 0, 4], 10), want)
  })

  it('places nothing for no sections, or a line of one vertex', () => {
    const out = new Float64Array(8).fill(7)
    expect(sectionsAlong([0, 10], [0, 0], 0, 2, 0, out)).toBe(0)
    expect(sectionsAlong([0], [0], 0, 1, 2, out)).toBe(0)
    expect([...out]).toEqual(new Array(8).fill(7))
  })

  it('reads one row of a packed array', () => {
    expectRows(placed([99, 0, 10, 99], [99, 0, 0, 99], 2, 1, 3), [[2.5, 0, 1, 0], [7.5, 0, 1, 0]])
  })

  it('steps over a repeated vertex', () => {
    expectRows(placed([0, 5, 5, 10], [0, 0, 0, 0], 2), [[2.5, 0, 1, 0], [7.5, 0, 1, 0]])
  })

  it('puts every section of a line of no length on its point, with no direction', () => {
    expectRows(placed([3, 3], [3, 3], 3), [[3, 3, 0, 0], [3, 3, 0, 0], [3, 3, 0, 0]])
  })

  it('starts at the first vertex, upstream', () => {
    expectRows(placed([10, 0], [0, 0], 2), [[7.5, 0, -1, 0], [2.5, 0, -1, 0]])
  })
})

describe('eachTick', () => {
  it('ticks the drawn rows that have sections, across their lines', () => {
    const f = network([])
    const ids = new Uint16Array(f.rows)
    for (const r of [0, 1, 2, 3, 4]) ids[r] = 1
    f.n[2] = 0
    const seen = new Set<number>()
    let across = 0
    const count = eachTick([f], [ids], 0, 0, 1, 1, (_x, _y, ax, ay, _fi, r) => {
      seen.add(r)
      const a = f.off[r]
      const dx = f.mx[a + 1] - f.mx[a]
      const dy = f.my[a + 1] - f.my[a]
      across = Math.max(across, Math.abs(Math.hypot(ax, ay) - 1), Math.abs(ax * dx + ay * dy) / Math.hypot(dx, dy))
    })
    expect(count).toBe(40)
    expect([...seen].sort()).toEqual([0, 1, 3, 4])
    expect(across).toBeLessThan(1e-9)
  })

  it('ticks only the rows whose box meets the view', () => {
    const f = network([])
    const ids = new Uint16Array(f.rows).fill(1)
    expect(eachTick([f], [ids], f.box[0], f.box[1], f.box[2], f.box[3], () => {})).toBe(10)
  })
})

describe('marks', () => {
  it('turn across the stream on the screen', () => {
    // a line due east: its sections run north and south, a quarter turn on the screen
    const marks = marksAlong([0.25, 0.2501], [0.4, 0.4], 0, 2, 2)
    expect(marks).toHaveLength(2)
    expect(marks[0]!.angle).toBeCloseTo(Math.PI / 2)
    expect(marks[0]!.ends).toBeNull()
    expect(marks[0]!.exact).toBe(false)
  })

  it('stand empty where the line places none', () => {
    expect(marksAlong([0.25], [0.4], 0, 1, 3)).toEqual([null, null, null])
  })

  it('from the exact ends: the angle on the screen, and the ends when the width is known', () => {
    expect(markOf([0, 0], [0, -1], [0, 1], true, 100).angle).toBeCloseTo(0)
    // north to south: y grows southward on the screen
    expect(markOf([0, 0], [1, 0], [-1, 0], true, 100).angle).toBeCloseTo(Math.PI / 2)
    expect(markOf([0, 0], [0, -1], [0, 1], true, 100).ends).toEqual([[0, -1], [0, 1]])
    expect(markOf([0, 0], [0, -1], [0, 1], false, 100).ends).toBeNull()
    // a meter across: toward the +station end, over the half-length
    expect(markOf([0, 0], [0, -1], [0, 1], true, 100).perM).toEqual([0, 0.01])
  })

  it('measure a meter across the stream toward its left bank', () => {
    // flowing east: the left bank is north, and a meter is 1 / 111,319 of a degree of latitude
    const east = marksAlong([0.25, 0.2501], [0.4, 0.4], 0, 2, 1)[0]!
    expect(east.perM[0]).toBeCloseTo(1 / 111319.49, 12)
    expect(east.perM[1]).toBeCloseTo(0, 12)
    // flowing north: the left bank is west, a meter of longitude wider by 1 / cos(latitude)
    const north = marksAlong([0.25, 0.25], [0.4, 0.3999], 0, 2, 1)[0]!
    const lat = (north.at[0] * Math.PI) / 180
    expect(north.perM[0]).toBeCloseTo(0, 12)
    expect(north.perM[1]).toBeCloseTo(-1 / (111319.49 * Math.cos(lat)), 9)
  })
})

describe('the flood-prone area', () => {
  /** A section on a line due east at (0, lon): a meter is 0.001 of a degree here, for easy numbers. */
  const at = (lon: number) => ({ at: [0, lon] as [number, number], angle: Math.PI / 2, ends: null, exact: false, perM: [0.001, 0] as [number, number] })

  it('puts a width half to each side, right bank first', () => {
    const [r, l] = spanOf(at(5), 20)
    expect(r).toEqual([-0.01, 5])
    expect(l).toEqual([0.01, 5])
  })

  it('joins the widths down one bank and back up the other', () => {
    const ring = floodRing([at(0), at(1), at(2)], [10, 20, 30])
    expect(ring).toEqual([[-0.005, 0], [-0.01, 1], [-0.015, 2], [0.015, 2], [0.01, 1], [0.005, 0]])
  })

  it('joins across a section with no width or no place', () => {
    const ring = floodRing([at(0), at(1), null, at(3)], [10, null, 40, 30])
    expect(ring.map((p) => p[1])).toEqual([0, 3, 3, 0])
  })

  it('draws nothing for fewer than two widths', () => {
    expect(floodRing([at(0), at(1)], [10, null])).toEqual([])
    expect(floodRing([], [])).toEqual([])
  })
})

describe('latLngsOf', () => {
  it('a line in lat, lon', () => {
    const line = latLngsOf([0.5, 0.75], [0.5, 0.5], 0, 2)
    expect(line[0][0]).toBeCloseTo(0)
    expect(line[0][1]).toBeCloseTo(0)
    expect(line[1][1]).toBeCloseTo(90)
  })
})

// every reach of the builder's two fixture files: each section lands on its reach's line, no farther from
// the one before than the line's length over n
const DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))
const expected = JSON.parse(readFileSync(`${DIR}expected.json`, 'utf-8'))
const buffers = new Map<string, AsyncBuffer>()
const src = {
  base: 'fixtures/',
  ready: async () => ({}),
  entry: () => ({ path: '', bytes: 0, sha256: '' }),
  file: (logical: string) => buffers.get(logical)!,
} as unknown as DataSource
const files: UnitFile[] = []

beforeAll(async () => {
  for (const huc8 of expected.files as string[]) {
    buffers.set(`units/${huc8}.parquet`, await asyncBufferFromFile(`${DIR}units/${huc8}.parquet`))
    files.push(await loadUnits(src, huc8))
  }
})

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  return Math.hypot(ax + t * dx - px, ay + t * dy - py)
}

describe('the fixture reaches', () => {
  it('have every section on the line, spaced no wider than the line over n', () => {
    let rows = 0
    let off = 0
    let wide = 0
    let short = 0
    const out = new Float64Array(4 * 64)
    for (const f of files) {
      for (let r = 0; r < f.rows; r++) {
        const n = f.n[r]
        const a = f.off[r]
        const e = f.off[r + 1]
        if (n < 1 || e - a < 2) continue
        rows++
        if (sectionsAlong(f.mx, f.my, a, e, n, out) !== n) short++
        let total = 0
        for (let v = a; v < e - 1; v++) total += Math.hypot(f.mx[v + 1] - f.mx[v], f.my[v + 1] - f.my[v])
        for (let i = 0; i < n; i++) {
          let d = Infinity
          for (let v = a; v < e - 1; v++) d = Math.min(d, segDist(out[4 * i], out[4 * i + 1], f.mx[v], f.my[v], f.mx[v + 1], f.my[v + 1]))
          off = Math.max(off, d)
          if (i > 0) wide = Math.max(wide, Math.hypot(out[4 * i] - out[4 * i - 4], out[4 * i + 1] - out[4 * i - 3]) - total / n)
        }
      }
    }
    expect(rows).toBeGreaterThan(1000)
    expect(short).toBe(0)
    expect(off).toBeLessThan(1e-12)
    expect(wide).toBeLessThan(1e-12)
  })
})
