import { describe, expect, it } from 'vitest'
import { csv, printable, readSaved, reachesCsv, shortlistCsv, shortlistGeojson, type ReportContext } from '../src/app/exports'
import { Edits, type SectionEdit } from '../src/screen/edits'
import { Network, refMask, refOf } from '../src/screen/model'
import { defaultCriteria, rankSites, screen } from '../src/screen/screen'
import { network } from './net'

const sec: SectionEdit = { line: '1004', k: 0, i: 0, bfM: 0.5, lbM: 0.85, er: 250, bhr: 170, bfd: 50, bfw: 60, fpw: 150, lbh: 85,
  edge: false, res: 1, profile: '3dep' }

function context(edit = false): ReportContext {
  const net = new Network()
  const f = network([])
  net.add(f)
  const edits = new Edits()
  if (edit) edits.setSection(f, 4, '0101', sec)
  const masks = refMask(net, Array.from({ length: 10 }, (_, r) => refOf(0, r)))
  const criteria = { ...defaultCriteria(), daMinSqmi: null }
  const result = screen(net, masks, criteria)
  const ranked = rankSites(result.sites, 'length')
  return {
    areaText: 'Test area', dataVersion: 'fpr1-test', criteria, criteriaText: ['Bank height ratio 1.50 or more'], result, ranked,
    decisions: new Map([[ranked[0].id, { keep: false, note: 'Road, "private"' }]]), net, masks, edits, made: new Date(0),
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
    expect(f.properties.reaches_edited).toBe(0)
  })

  it('write every reach of the area', () => {
    const ctx = context()
    const lines = reachesCsv(ctx).trim().split('\r\n')
    expect(lines).toHaveLength(11)
    expect(lines[1].startsWith('1000-0,')).toBe(true)
  })

  it('say which reaches are screened on cross-section edits, with the grid beside them', () => {
    const ctx = context(true)
    const rows = reachesCsv(ctx).trim().split('\r\n').map((l) => l.split(','))
    const head = rows[0]
    const at = (row: string[], key: string) => row[head.indexOf(key)]
    const edited = rows.find((r) => r[0] === '1004-0')!
    expect([at(edited, 'values_from'), at(edited, 'sections_edited'), at(edited, 'bhr_median'), at(edited, 'grid_bhr_median')])
      .toEqual(['your cross-section edits', '1', '1.70', '1.60'])
    const plain = rows.find((r) => r[0] === '1003-0')!
    expect([at(plain, 'values_from'), at(plain, 'sections_edited'), at(plain, 'grid_bhr_median')]).toEqual(['grid', '0', '1.60'])
    const site = JSON.parse(shortlistGeojson(ctx)).features.find((x: any) => x.properties.reaches > 1)
    expect(site.properties.reaches_edited).toBe(1)
    expect(printable(ctx)).toContain('Edited cross-sections (1 reach)')
    expect(printable(context())).not.toContain('Edited cross-sections')
  })

  it('open only screenings this tool saved, version 1 or 2', () => {
    expect(() => readSaved('{"format": "other"}')).toThrow()
    const base = { format: 'fpr-screening', area: { mode: 'huc', codes: [] }, criteria: defaultCriteria() }
    expect(readSaved(JSON.stringify({ ...base, version: 1 })).area.mode).toBe('huc')
    expect(() => readSaved(JSON.stringify({ ...base, version: 3 }))).toThrow()
    expect(() => readSaved(JSON.stringify({ ...base, version: 2, edits: [] }))).toThrow()
    // a study area this tool does not know, or picked reaches it cannot read
    expect(() => readSaved(JSON.stringify({ ...base, version: 2, area: { mode: 'circle', codes: [] } }))).toThrow()
    expect(() => readSaved(JSON.stringify({ ...base, version: 2, area: { mode: 'reach', codes: [], reaches: [{ id: 5 }] } }))).toThrow()
    expect(readSaved(JSON.stringify({ ...base, version: 2, area: { mode: 'box', codes: [], box: [-80, 39, -79, 40] } })).area.mode).toBe('box')
    const ctx = context(true)
    const saved = readSaved(JSON.stringify({ ...base, version: 2, edits: ctx.edits.toJSON() }))
    const again = new Edits()
    again.load(saved.edits!)
    const f = network([])
    expect(again.applyFile(f)).toEqual([])
    expect([f.bhr[4], f.edited[4]]).toEqual([170, 1])
  })
})
