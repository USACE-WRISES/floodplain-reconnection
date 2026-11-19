// The cross-section codec and the pull's tile addresses against the Python they mirror (STAF's fixtures,
// apps/staf-web/tests/fixtures/xs_ref.json, its codec and linspace cases, from STAF's
// parity/make_fixtures.py).
import { describe, expect, it } from 'vitest'
import ref from './fixtures/xs_ref.json'
import { decode, encode, stations } from '../src/xs/codec'
import { tileUrls } from '../src/xs/sample'

const fromHex = (h: string): number => new DataView(Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16))).buffer).getFloat64(0)

describe('codec', () => {
  it('decodes archive transects bit for bit', () => {
    for (const c of ref.codec) {
      const z = decode(c.codes)
      expect(Array.from(new Uint32Array(z.buffer))).toEqual(c.bits)
    }
  })
  it('encodes back to the same codes', () => {
    for (const c of ref.codec) {
      const z = new Float32Array(Uint32Array.from(c.bits).buffer)
      expect(Array.from(encode(z))).toEqual(c.codes)
    }
  })
})

describe('stations', () => {
  it('are numpy.linspace bit for bit', () => {
    for (const l of ref.linspace) {
      const got = stations(l.wide, l.n)
      expect(Array.from(got)).toEqual(l.hex.map(fromHex))
    }
  })
})

describe('tile addresses', () => {
  it("are built in the build's paste order", () => {
    expect(tileUrls({ res: 1, source: 'IA_X_2019', tiles: 'USGS_1M_15_x41y462_IA_X_2019.tif;USGS_1M_15_x40y462_IA_X_2019.tif' }))
      .toEqual(['https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/IA_X_2019/TIFF/USGS_1M_15_x40y462_IA_X_2019.tif',
                'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/IA_X_2019/TIFF/USGS_1M_15_x41y462_IA_X_2019.tif'])
    expect(tileUrls({ res: 10, source: '3dep-13', tiles: 'USGS_13_n42w094.tif' }))
      .toEqual(['https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n42w094/USGS_13_n42w094.tif'])
    expect(tileUrls({ res: 3, source: '3dep-19', tiles: 'ned19_n33x00_w088x75_ms_x' }))
      .toEqual(['https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/19/TILES/ned19_n33x00_w088x75_ms_x/ned19_n33x00_w088x75_ms_x.img'])
  })
})
