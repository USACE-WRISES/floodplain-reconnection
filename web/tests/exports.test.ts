import { describe, expect, it } from 'vitest'
import { csv, readSaved, reachesCsv, shortlistCsv, shortlistGeojson, type ReportContext } from '../src/app/exports'
import { Network, refMask, refOf } from '../src/screen/model'
import { defaultCriteria, rankSites, screen } from '../src/screen/screen'
import { network } from './net'

function context(): ReportContext {
  const net = new Network()
  net.add(network([]))
  const masks = refMask(net, Array.from({ length: 10 }, (_, r) => refOf(0, r)))
  const criteria = { ...defaultCriteria(), daMinSqmi: null }
  const result = screen(net, masks, criteria)
  const ranked = rankSites(result.sites, 'length')
  return {
    areaText: 'Test area', dataVersion: 'fpr1-test', criteria, criteriaText: ['Bank height ratio 1.50 or more'], result, ranked,
    decisions: new Map([[ranked[0].id, { keep: false, note: 'Road, "private"' }]]), net, masks, made: new Date(0),
  }
}

describe('downloads', () => {
  it('quote CSV cells that need it', () => {
    expect(csv(['a', 'b'], [['x,y', 'say "hi"'], [1, null]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n1,\r\n')
  })

  it('write the shortlist with its decisions', () => {
    const ctx = context()
    const lines = shortlistCsv(ctx).trim().split('\r\n')
    expect(lines[0].startsWith('rank,site_id,keep,note,stream')).toBe(true)
    expect(lines).toHaveLength(ctx.ranked.length + 1)
    expect(lines[1]).toContain(',no,"Road, ""private""",')
    expect(lines[1].endsWith(',fpr1-test')).toBe(true)
  })

  it('write the shortlist as GeoJSON lines in degrees', () => {
    const ctx = context()
    const gj = JSON.parse(shortlistGeojson(ctx))
    expect(gj.type).toBe('FeatureCollection')
    expect(gj.features).toHaveLength(ctx.ranked.length)
    const f = gj.features[0]
    expect(f.geometry.type).toBe('MultiLineString')
    expect(f.geometry.coordinates[0][0][0]).toBeCloseTo(-80, 4)
    expect(f.geometry.coordinates[0][0][1]).toBeCloseTo(40, 4)
    expect(f.properties.keep).toBe('no')
  })

  it('write every reach of the area', () => {
    const ctx = context()
    const lines = reachesCsv(ctx).trim().split('\r\n')
    expect(lines).toHaveLength(11)
    expect(lines[1].startsWith('1000-0,')).toBe(true)
  })

  it('open only screenings this tool saved', () => {
    expect(() => readSaved('{"format": "other"}')).toThrow()
    const ok = readSaved(JSON.stringify({ format: 'fpr-screening', version: 1, area: { mode: 'huc', codes: [] }, criteria: defaultCriteria() }))
    expect(ok.area.mode).toBe('huc')
  })
})
