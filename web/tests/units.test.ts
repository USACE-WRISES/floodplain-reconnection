// A real HUC8 reach file read through the app's own path (readColumns, then unpack), where a local copy
// of the reach layer is at hand: FPR_DATA names the folder that holds `floodplain-reconnection/`.
// Without it (as on GitHub) these tests skip.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { asyncBufferFromFile, type AsyncBuffer } from 'hyparquet'
import { describe, expect, it } from 'vitest'
import type { DataSource } from '../src/data/source'
import { loadUnits, Q_UNSAMPLED } from '../src/data/units'
import { Network, refOf } from '../src/screen/model'

const ROOT = process.env.FPR_DATA ? join(process.env.FPR_DATA, 'floodplain-reconnection') : ''
const INDEX = ROOT ? join(ROOT, 'web-index.json.gz') : ''
const have = Boolean(INDEX && existsSync(INDEX))

/** A stand-in for DataSource over the local folder (the reading path past it is the app's own). */
async function localSource(): Promise<{ src: DataSource, files: Record<string, [string, number, string]> }> {
  const index = JSON.parse(gunzipSync(readFileSync(INDEX)).toString('utf-8'))
  const files = index.files as Record<string, [string, number, string]>
  const buffers = new Map<string, AsyncBuffer>()
  for (const logical of Object.keys(files).filter((k) => k.startsWith('units/')).sort().slice(0, 1)) {
    buffers.set(logical, await asyncBufferFromFile(join(ROOT, files[logical][0])))
  }
  const src = {
    base: 'local/',
    ready: async () => index,
    entry: (logical: string) => ({ path: files[logical][0], bytes: files[logical][1], sha256: files[logical][2] }),
    file: (logical: string) => buffers.get(logical)!,
  } as unknown as DataSource
  return { src, files }
}

describe.skipIf(!have)('a real HUC8 file', () => {
  it('unpacks with sane values and pointers that resolve', async () => {
    const { src, files } = await localSource()
    const huc8 = Object.keys(files).filter((k) => k.startsWith('units/')).map((k) => k.slice(6, 14)).sort()[0]
    const f = await loadUnits(src, huc8)
    expect(f.rows).toBeGreaterThan(0)
    let sampled = 0
    for (let r = 0; r < f.rows; r++) {
      expect(f.q[r]).toBeLessThanOrEqual(Q_UNSAMPLED)
      expect(f.off[r + 1]).toBeGreaterThan(f.off[r] + 1)
      expect(f.box[r * 4]).toBeGreaterThan(0)
      expect(f.box[r * 4 + 2]).toBeLessThan(1)
      if (f.q[r] < 2) {
        sampled++
        expect(Number.isFinite(f.bhr[r]) && Number.isFinite(f.er[r])).toBe(true)
      }
      if (f.dnHuc8[r] === Number(huc8)) expect(f.dnRow[r]).toBeLessThan(f.rows)
    }
    expect(sampled).toBeGreaterThan(0)
    const net = new Network()
    net.add(f)
    for (let r = 0; r < f.rows; r++) expect(net.mainUp(refOf(0, r))).not.toBe(refOf(0, r))
  })
})
