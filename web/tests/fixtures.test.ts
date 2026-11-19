// The app screens as the builder does: the builder's fixtures (data/run.py fixtures: two HUC8 files,
// and the funnel, sites and upstream walks it computed for the Utoy Creek and Coosawhatchie River
// study areas under each preset) read through the app's own path and screened by the app's code.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, type AsyncBuffer } from 'hyparquet'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DataSource } from '../src/data/source'
import { loadUnits } from '../src/data/units'
import { hucMask, Network, refOf, rowOf, type Ref } from '../src/screen/model'
import { screen, STAGE, type Criteria } from '../src/screen/screen'

const DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))
const expected = JSON.parse(readFileSync(`${DIR}expected.json`, 'utf-8'))

const buffers = new Map<string, AsyncBuffer>()
const src = {
  base: 'fixtures/',
  ready: async () => ({}),
  entry: () => ({ path: '', bytes: 0, sha256: '' }),
  file: (logical: string) => buffers.get(logical)!,
} as unknown as DataSource

const net = new Network()

beforeAll(async () => {
  for (const huc8 of expected.files as string[]) {
    buffers.set(`units/${huc8}.parquet`, await asyncBufferFromFile(`${DIR}units/${huc8}.parquet`))
    net.add(await loadUnits(src, huc8))
  }
})

function areaCodes(area: Record<string, string[]>): string[] {
  return [...(area.huc12 ?? []), ...(area.huc10 ?? []), ...(area.huc8 ?? [])]
}

const keyOf = (ref: Ref) => `${net.file(ref).huc8}/${rowOf(ref)}`

describe('the app screens as the builder does', () => {
  for (const [area, byPreset] of Object.entries(expected.results as Record<string, Record<string, any>>)) {
    for (const [preset, want] of Object.entries(byPreset)) {
      it(`${area}, preset ${preset}`, () => {
        const p = expected.presets[preset]
        const c: Criteria = { ...expected.criteria, bhrMin: p.bhrMin, erMin: p.erMin }
        const masks = hucMask(net, areaCodes(expected.areas[area]))
        const r = screen(net, masks, c)
        const past = (min: number) => r.stage.reduce((n, s) => n + s.filter((v) => v >= min).length, 0)
        const funnel = {
          reaches: past(STAGE.canal), canals: past(STAGE.unmeasured), measured: past(STAGE.da), da: past(STAGE.bhr),
          bhr: past(STAGE.er), er: past(STAGE.pass), qualifying: past(STAGE.pass), sites: r.sites.length,
        }
        expect(funnel).toEqual(want.funnel)
        const got = Object.fromEntries(r.sites.map((s) => [s.id, {
          rows: s.refs.length, qualifying: s.pass.filter(Boolean).length, first: keyOf(s.refs[0]), last: keyOf(s.refs[s.refs.length - 1]),
          length: Math.round(s.lengthM), qual: Math.round(s.passLengthM),
        }]))
        const wantSites = Object.fromEntries((want.sites as any[]).map((s) => [s.id, {
          rows: s.rows, qualifying: s.qualifying, first: s.first, last: s.last, length: Math.round(s.length_m), qual: Math.round(s.qual_length_m),
        }]))
        expect(got).toEqual(wantSites)
      })
    }
  }

  for (const [area, w] of Object.entries(expected.walks as Record<string, any>)) {
    it(`walks upstream from the ${area} outlet`, () => {
      const fi = net.fileIndex(w.start.huc8)!
      const start = refOf(fi, w.start.row)
      expect(`${net.file(start).id[w.start.row]}-${net.file(start).k0[w.start.row]}`).toBe(w.start.id)
      const reached = net.walk(start)
      expect(reached.size).toBe(w.rows)
      let length = 0
      let sections = 0
      for (const ref of reached) {
        length += net.file(ref).lenM[rowOf(ref)]
        sections += net.file(ref).n[rowOf(ref)]
      }
      expect(length).toBeCloseTo(w.length_m, -1)
      expect(sections).toBe(w.sections)
    })
  }
})
