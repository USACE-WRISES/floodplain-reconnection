// What the Report step downloads: the shortlist as CSV and GeoJSON (the hand-off to a finer screen,
// such as FluvialGeomorph, and to GIS), every reach of the study area as CSV, a printable summary,
// and the saved screening (inputs and decisions; results are recomputed on Open).
import { latOf, lonOf, Q_UNSAMPLED, WHY, huc12Text, reachId } from '../data/units'
import { refOf, rowOf, type Network } from '../screen/model'
import { flagTexts, FT_PER_M, MI_PER_M, QUALITY_LABEL, SQMI_PER_SQKM } from '../screen/format'
import { STAGE, type Criteria, type ScreenResult, type Site } from '../screen/screen'
import { APP_NAME, APP_VERSION } from '../version'
import { esc } from './html'

export interface Decision { keep: boolean, note: string }

export interface ReportContext {
  areaText: string
  dataVersion: string
  criteria: Criteria
  criteriaText: string[]
  result: ScreenResult
  ranked: Site[]
  decisions: Map<string, Decision>
  net: Network
  masks: Uint8Array[]
  made: Date
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function csv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

const n2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '')
const n1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '')
const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toString() : '')

function siteEnds(net: Network, s: Site): { up: [number, number], dn: [number, number] } {
  const f0 = net.file(s.refs[0])
  const r0 = rowOf(s.refs[0])
  const f1 = net.file(s.refs[s.refs.length - 1])
  const r1 = rowOf(s.refs[s.refs.length - 1])
  const a = f0.off[r0]
  const b = f1.off[r1 + 1] - 1
  return { up: [lonOf(f0.mx[a]), latOf(f0.my[a])], dn: [lonOf(f1.mx[b]), latOf(f1.my[b])] }
}

const SITE_HEADER = ['rank', 'site_id', 'keep', 'note', 'stream', 'huc12', 'length_ft', 'qualifying_length_ft', 'reaches',
  'gap_reaches', 'bhr_median', 'bhr_min', 'bhr_max', 'reaches_bhr_at_least_2', 'er_median', 'er_min', 'er_max',
  'low_bank_height_ft', 'bankfull_width_ft', 'floodprone_width_ft', 'drainage_area_sqmi', 'slope_percent',
  'reaches_use_with_caution', 'upstream_lon', 'upstream_lat', 'downstream_lon', 'downstream_lat', 'data_version']

function siteRow(ctx: ReportContext, s: Site, rank: number): unknown[] {
  const d = ctx.decisions.get(s.id)
  const ends = siteEnds(ctx.net, s)
  const gaps = s.pass.filter((p) => !p).length
  return [rank, s.id, d?.keep === false ? 'no' : 'yes', d?.note ?? '', s.name, s.huc12, n0(s.lengthM * FT_PER_M),
    n0(s.passLengthM * FT_PER_M), s.refs.length, gaps, n2(s.bhr), n2(s.bhrLo), n2(s.bhrHi), s.bhrAtCap, n2(s.er), n2(s.erLo),
    n2(s.erHi), n1(s.lbhM * FT_PER_M), n1(s.bfwM * FT_PER_M), n1(s.fpwM * FT_PER_M), n2(s.daSqkm * SQMI_PER_SQKM),
    Number.isFinite(s.slope) ? (s.slope * 100).toFixed(3) : '', s.caution, ...ends.up, ...ends.dn, ctx.dataVersion]
}

export function shortlistCsv(ctx: ReportContext): string {
  return csv(SITE_HEADER, ctx.ranked.map((s, i) => siteRow(ctx, s, i + 1)))
}

export function shortlistGeojson(ctx: ReportContext): string {
  const features = ctx.ranked.map((s, i) => {
    const props = Object.fromEntries(SITE_HEADER.map((k, j) => [k, siteRow(ctx, s, i + 1)[j]]))
    const lines = s.refs.map((ref) => {
      const f = ctx.net.file(ref)
      const r = rowOf(ref)
      const coords: [number, number][] = []
      for (let v = f.off[r]; v < f.off[r + 1]; v++) coords.push([lonOf(f.mx[v]), latOf(f.my[v])])
      return coords
    })
    return { type: 'Feature', properties: { ...props, criteria: ctx.criteriaText.join('; ') }, geometry: { type: 'MultiLineString', coordinates: lines } }
  })
  return JSON.stringify({ type: 'FeatureCollection', name: 'floodplain_reconnection_shortlist', features }) + '\n'
}

const STAGE_TEXT: Record<number, string> = {
  [STAGE.unsampled]: 'not sampled',
  [STAGE.canal]: 'canal or ditch',
  [STAGE.unmeasured]: 'not measured',
  [STAGE.da]: 'drainage area outside the range',
  [STAGE.bhr]: 'bank height ratio below the minimum',
  [STAGE.er]: 'entrenchment ratio below the minimum',
  [STAGE.pass]: 'meets every criterion',
}

export function reachesCsv(ctx: ReportContext): string {
  const inSite = new Map<number, string>()
  for (const s of ctx.ranked) for (const ref of s.refs) inSite.set(ref, s.id)
  const header = ['reach_id', 'site_id', 'screen_result', 'stream', 'huc12', 'length_ft', 'quality', 'bhr_median',
    'bhr_at_least_2', 'bhr_min', 'bhr_max', 'er_median', 'er_min', 'er_max', 'low_bank_height_ft', 'bankfull_depth_ft',
    'bankfull_width_ft', 'floodprone_width_ft', 'drainage_area_sqmi', 'slope_percent', 'sections', 'sections_measured',
    'dem_m', 'flags', 'region', 'data_version']
  const rows: unknown[][] = []
  ctx.net.files.forEach((f, fi) => {
    const m = ctx.masks[fi]
    for (let r = 0; r < f.rows; r++) {
      if (!m?.[r]) continue
      const ref = refOf(fi, r)
      const st = ctx.result.stage[fi][r]
      const hide = f.q[r] >= 2
      rows.push([reachId(f, r), inSite.get(ref) ?? '', STAGE_TEXT[st] ?? '', f.name[r], huc12Text(f, r),
        n0(f.lenM[r] * FT_PER_M), QUALITY_LABEL[f.q[r]], hide ? '' : n2(f.bhr[r] / 100), f.why[r] & WHY.atCap ? 'yes' : 'no',
        hide ? '' : n2(f.bhrLo[r] / 100), hide ? '' : n2(f.bhrHi[r] / 100), hide ? '' : n2(f.er[r] / 100),
        hide ? '' : n2(f.erLo[r] / 100), hide ? '' : n2(f.erHi[r] / 100), hide ? '' : n1((f.lbh[r] / 100) * FT_PER_M),
        hide ? '' : n1((f.bfd[r] / 100) * FT_PER_M), hide ? '' : n1((f.bfw[r] / 10) * FT_PER_M),
        hide ? '' : n1((f.fpw[r] / 10) * FT_PER_M), n2(f.da[r] * SQMI_PER_SQKM),
        Number.isFinite(f.slope[r]) ? (f.slope[r] * 100).toFixed(3) : '', f.n[r], f.nOk[r], f.res[r] || '',
        f.q[r] === Q_UNSAMPLED ? '' : flagTexts(f, r).join(' '), f.vpu[r], ctx.dataVersion])
    }
  })
  return csv(header, rows)
}

/** The printable summary: a page of its own (shown in its tab, printed or saved from the browser). */
export function printable(ctx: ReportContext): string {
  const kept = ctx.ranked.filter((s) => ctx.decisions.get(s.id)?.keep !== false)
  const funnel = ctx.result.funnel.map((f) => `<tr><td>${esc(f.label)}</td><td class="n">${f.reaches.toLocaleString('en-US')}</td><td class="n">${(f.lengthM * MI_PER_M).toFixed(1)}</td></tr>`).join('')
  const sites = ctx.ranked.map((s, i) => {
    const d = ctx.decisions.get(s.id)
    return `<tr${d?.keep === false ? ' class="drop"' : ''}><td class="n">${i + 1}</td><td>${esc(s.name || 'Unnamed stream')}<div class="id">${esc(s.id)}</div></td>
      <td class="n">${Math.round(s.lengthM * FT_PER_M).toLocaleString('en-US')}</td><td class="n">${n2(s.bhr)}${s.bhrAtCap ? '*' : ''}</td>
      <td class="n">${n2(s.er)}</td><td class="n">${n1(s.lbhM * FT_PER_M)}</td><td class="n">${n2(s.daSqkm * SQMI_PER_SQKM)}</td>
      <td>${d?.keep === false ? 'Dropped' : 'Kept'}</td><td>${esc(d?.note ?? '')}</td></tr>`
  }).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Screening summary</title>
<style>
body { font: 13px/1.45 "Segoe UI", system-ui, sans-serif; color: #2a3344; margin: 28px auto; max-width: 960px; padding: 0 20px; }
h1 { font-size: 20px; color: #1f3f6e; margin: 0 0 2px; } h2 { font-size: 15px; color: #1f3f6e; margin: 20px 0 6px; }
.sub { color: #646f80; margin: 0 0 14px; } table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #e5e8ee; padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #f6f8fb; } td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
tr.drop td { color: #8a94a6; } .id { font-size: 11px; color: #8a94a6; } ul { padding-left: 18px; }
.note { font-size: 12px; color: #646f80; } @media print { body { margin: 0; } }
</style></head><body>
<h1>Floodplain reconnection screening summary</h1>
<p class="sub">${esc(APP_NAME)} ${esc(APP_VERSION)} (beta), made ${esc(ctx.made.toLocaleString('en-US'))}. Screening level only: raw values from the national cross-section grid, not condition classes.</p>
<h2>Study area</h2><p>${esc(ctx.areaText)}</p>
<h2>Criteria</h2><ul>${ctx.criteriaText.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<h2>How the criteria narrow the reaches</h2>
<table><thead><tr><th>Step</th><th class="n">Reaches</th><th class="n">Miles</th></tr></thead><tbody>${funnel}
<tr><td><b>Candidate sites</b></td><td class="n"><b>${ctx.result.sites.length}</b></td><td class="n">${(ctx.result.sites.reduce((a, s) => a + s.lengthM, 0) * MI_PER_M).toFixed(1)}</td></tr></tbody></table>
<h2>Shortlist (${kept.length} kept of ${ctx.ranked.length})</h2>
<table><thead><tr><th class="n">#</th><th>Stream</th><th class="n">Length (ft)</th><th class="n">BHR</th><th class="n">ER</th><th class="n">Low bank (ft)</th><th class="n">Drains (sq mi)</th><th>Decision</th><th>Note</th></tr></thead>
<tbody>${sites || '<tr><td colspan="9">No sites meet the criteria.</td></tr>'}</tbody></table>
<p class="note">BHR and ER are site medians of reach medians. * a reach reads "at least 2.00". Data version ${esc(ctx.dataVersion)}.</p>
</body></html>`
}

export interface SavedScreening {
  format: 'fpr-screening'
  version: 1
  app_version: string
  data_version: string
  saved_at: string
  area: { mode: 'huc' | 'walk' | 'box', codes: string[], walk: { huc8: string, id: string } | null, box: [number, number, number, number] | null }
  criteria: Criteria
  color_by: string
  sort: string
  sub: string
  decisions: Record<string, Decision>
}

export function readSaved(text: string): SavedScreening {
  const v = JSON.parse(text)
  if (v?.format !== 'fpr-screening' || v?.version !== 1) throw new Error('This is not a screening saved by this tool.')
  if (!v.area || !v.criteria) throw new Error('The file is missing its study area or criteria.')
  return v as SavedScreening
}
