// A reach's cross-sections read from real data, where local copies are at hand: FPR_DATA names the folder
// holding `floodplain-reconnection/` (the reach layer) and FPR_STAF_DATA the folder of STAF's browser
// layout (its web-index.json.gz, xs/ and topo/). Without both (as on GitHub) these tests skip.
//
// Checked on a sample of the reaches of 03050208 (Coosawhatchie) and 03130002 (Utoy Creek): the walk finds
// each reach's sections, the grid's numbers give back the reach's medians by the builder's rule, and a
// stored profile measured as the grid measured it gives the grid's numbers to the digit.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { asyncBufferFromFile, type AsyncBuffer } from 'hyparquet'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DataSource } from '../src/data/source'
import { loadUnits, Q_UNSAMPLED, type UnitFile } from '../src/data/units'
import { medianProfile } from '../src/xs/grid'
import { ratioMedian, reachSections, scored } from '../src/xs/reach'
import { defaultHeights, measure, profileFrom } from '../src/xs/section'

const FPR = process.env.FPR_DATA ? join(process.env.FPR_DATA, 'floodplain-reconnection') : ''
const STAF = process.env.FPR_STAF_DATA ?? ''
const have = Boolean(FPR && STAF && existsSync(join(FPR, 'web-index.json.gz')) && existsSync(join(STAF, 'web-index.json.gz')))
const CASES = [{ huc8: '03050208', vpu: '0305' }, { huc8: '03130002', vpu: '0313' }]

/** A stand-in for DataSource over a local folder and its index (the reading path past it is the app's). */
async function localSource(root: string, base: string, wanted: (logical: string) => boolean): Promise<DataSource> {
  const index = JSON.parse(gunzipSync(readFileSync(join(root, 'web-index.json.gz'))).toString('utf-8'))
  const files = index.files as Record<string, [string, number, string?]>
  const buffers = new Map<string, AsyncBuffer>()
  for (const logical of Object.keys(files).filter(wanted)) buffers.set(logical, await asyncBufferFromFile(join(root, files[logical][0])))
  return {
    base,
    ready: async () => index,
    has: (logical: string) => logical in files,
    entry: (logical: string) => ({ path: files[logical][0], bytes: files[logical][1], sha256: files[logical][2] ?? '', footer: index.footers?.[logical] }),
    file: (logical: string) => {
      const b = buffers.get(logical)
      if (!b) throw new Error(`not opened: ${logical}`)
      return b
    },
  } as unknown as DataSource
}

describe.skipIf(!have)('cross-sections of real reaches', () => {
  let staf: DataSource
  const files: UnitFile[] = []
  beforeAll(async () => {
    const vpus = CASES.map((c) => c.vpu)
    staf = await localSource(STAF, 'local-staf/', (l) => vpus.some((v) => l === `xs/xs-${v}.parquet` || l === `xs/xs-${v}-sections.parquet`
      || l === `xs/xs-${v}-median.parquet` || l === `topo/hr_${v}.parquet`))
    const fpr = await localSource(FPR, 'local-fpr/', (l) => CASES.some((c) => l === `units/${c.huc8}.parquet`))
    for (const c of CASES) files.push(await loadUnits(fpr, c.huc8))
  }, 120_000)

  it('walks each reach to its sections, whose numbers give back its medians', async () => {
    let multi = 0
    let checked = 0
    for (const [i, c] of CASES.entries()) {
      const f = files[i]
      const step = Math.max(1, Math.floor(f.rows / 150))
      for (let r = 0; r < f.rows; r += step) {
        if (f.q[r] === Q_UNSAMPLED || f.n[r] === 0) continue
        const got = await reachSections(staf, c.vpu, f.id[r], f.k0[r], f.n[r])
        expect(got.ok, `${c.huc8} row ${r}`).toBe(true)
        if (!got.ok) continue
        if (new Set(got.sections.map((s) => s.id)).size > 1) multi++
        const ok = got.sections.filter(scored)
        expect(ok.length, `${c.huc8} row ${r} n_ok`).toBe(f.nOk[r])
        if (ok.length) {
          expect(ratioMedian(ok.map((s) => Math.round(s.num.bhr! * 100))), `${c.huc8} row ${r} bhr`).toBe(f.bhr[r])
          expect(ratioMedian(ok.map((s) => Math.round(s.num.er! * 100))), `${c.huc8} row ${r} er`).toBe(f.er[r])
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(200)
    expect(multi).toBeGreaterThan(0)
  }, 300_000)

  it('measures each stored profile met as the grid did', async () => {
    let profiles = 0
    for (const [i, c] of CASES.entries()) {
      const f = files[i]
      const step = Math.max(1, Math.floor(f.rows / 120))
      for (let r = 0; r < f.rows; r += step) {
        if (f.q[r] === Q_UNSAMPLED || f.n[r] === 0) continue
        const got = await reachSections(staf, c.vpu, f.id[r], f.k0[r], f.n[r])
        if (!got.ok) continue
        for (const s of got.sections.filter((x) => x.stored && scored(x) && x.det)) {
          const m = await medianProfile(staf, c.vpu, s.id)
          expect(m && m.k).toBe(s.k)
          const p = profileFrom(m!.z, s.det!, s.num.res)
          const where = `${s.id}:${s.k}`
          expect(p, where).not.toBeNull()
          const g = p!.grid
          expect([g.er, g.bhr, g.bfd, g.bfw, g.fpw], where).toEqual([s.num.er, s.num.bhr, s.num.bfd, s.num.bfw, s.num.fpw]
            .map((v, j) => (v === null ? null : Math.round(v * (j < 3 ? 100 : 10)))))
          expect([g.capped, g.edge], where).toEqual([Boolean(s.num.flags & 1), Boolean(s.num.flags & 2)])
          // the stages the release stores (float32 above the thalweg)
          expect([Math.fround(p!.bfStage - p!.thalweg), Math.fround(p!.lbStage - p!.thalweg)], where).toEqual([s.det!.bfM, s.det!.lbM])
          // the user's heights at the defaults measure the same
          const [bf, lb] = defaultHeights(p!)
          const u = measure(p!, bf, lb)
          expect([u.er, u.bhr, u.bfw, u.fpw, u.edge], where).toEqual([g.er, g.bhr, g.bfw, g.fpw, g.edge])
          profiles++
        }
      }
    }
    expect(profiles).toBeGreaterThan(30)
  }, 300_000)
})
