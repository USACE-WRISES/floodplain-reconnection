// The app: the header's four steps, Step 1's four sub-steps in the workflow pane (Study area,
// Screen, Shortlist, Report), the map's reaches and outlines, and the downloads. State lives here;
// the screening itself is screen/screen.ts and the network screen/model.ts.
import L from 'leaflet'
import { dataVersion, fprIndex, huc8sInBox, type FprIndex } from '../data/index'
import { DataSource } from '../data/source'
import { storedProfile } from '../data/staf'
import { huc12Text, latOf, loadUnits, lonOf, mercX, mercY, Q_CAUTION, Q_NODATA, Q_UNSAMPLED, reachId, WHY, type UnitFile } from '../data/units'
import { makeMap, outlineRenderer, PANES, START, type AppMap } from '../map/map'
import { AT_CAP, binColor, binOf, BINS, MATCH, NO_DATA, RAMPS, rampColor, rampGradient, UNSAMPLED, type RampSpec } from '../map/ramp'
import { UnitLayer, type LineStyle } from '../map/unitLayer'
import { bhrText, count, flagTexts, ft, mi, QUALITY_LABEL, ratio, slopeText, sqmi } from '../screen/format'
import { boxMask, hucFiles, hucMask, Network, refMask, refOf, rowOf, type Ref } from '../screen/model'
import { defaultCriteria, presetOf, PRESETS, rankSites, screen, SORTS, STAGE, type Criteria, type ScreenResult, type Site, type SortKey } from '../screen/screen'
import { APP_VERSION } from '../version'
import { plannedPane, showAbout, showHelp, showMethods } from './dialogs'
import { registerDownload } from './download'
import { printable, readSaved, reachesCsv, shortlistCsv, shortlistGeojson, type Decision, type ReportContext, type SavedScreening } from './exports'
import { byId, esc } from './html'
import { closeModal, showModal } from './modal'
import { notify } from './notify'
import { wireSearch } from './search'
import { profileSvg } from './xscard'

type Sub = 'area' | 'screen' | 'shortlist' | 'report'
type Mode = 'huc' | 'walk' | 'box'
type ColorBy = 'bhr' | 'er' | 'match'

const SUBS: { key: Sub, label: string }[] = [
  { key: 'area', label: 'Study area' },
  { key: 'screen', label: 'Screen' },
  { key: 'shortlist', label: 'Shortlist' },
  { key: 'report', label: 'Report' },
]

/** Reaches show for the view from this zoom (the files the view meets load by themselves). */
const VIEW_ZOOM = 11
/** The most HUC8 files a view loads by itself, and a study area may hold. */
const VIEW_FILES = 4
const AREA_FILES = 12
/** HUC12 outlines show from this zoom. */
const PICK_ZOOM = 9

interface Example { id: string, label: string, kind: 'huc' | 'walk', prefixes?: string[], walkId?: number, huc8?: string, view: [number, number, number] }

const EXAMPLES: Example[] = [
  { id: 'utoy', label: 'Utoy Creek, GA', kind: 'huc', prefixes: ['031300020103'], view: [33.73, -84.49, 12] },
  { id: 'coosa', label: 'Coosawhatchie River, SC', kind: 'huc', prefixes: ['0305020801', '0305020802', '0305020803', '0305020804'], view: [32.85, -81.15, 10] },
  { id: 'norway', label: 'Norway Creek, IA', kind: 'walk', walkId: 23000300012339, huc8: '10230001', view: [41.93, -95.85, 12] },
]

export class App {
  readonly src: DataSource
  readonly staf: DataSource
  idx: FprIndex | null = null
  version = 'unknown'
  readonly net = new Network()
  readonly m: AppMap
  readonly map: L.Map
  readonly units: UnitLayer
  readonly pane = byId('fpr-pane')
  readonly hover = byId('fpr-hover')
  readonly readout = byId('fpr-readout')
  readonly cue = byId('fpr-cue')

  step = 1
  sub: Sub = 'area'
  mode: Mode = 'huc'
  /** picked HUC12s */
  codes = new Set<string>()
  lastPick: string | null = null
  walkFrom: { huc8: string, id: string } | null = null
  box: [number, number, number, number] | null = null
  private corner: L.LatLng | null = null
  private boxLayer: L.Rectangle | null = null
  private pin: L.CircleMarker | null = null
  masks: Uint8Array[] = []
  criteria: Criteria = defaultCriteria()
  colorBy: ColorBy = 'bhr'
  result: ScreenResult | null = null
  ranked: Site[] = []
  sort: SortKey = 'length'
  decisions = new Map<string, Decision>()
  selected: string | null = null
  showAll = false
  dirty = false
  private siteOf = new Map<Ref, number>()
  private loading = new Map<string, Promise<void>>()
  private busy = 0
  private huc12Layers = new Map<string, L.GeoJSON>()
  private huc12Loading = new Map<string, Promise<L.GeoJSON | null>>()
  private huc12Names = new Map<string, string>()
  private coverageLayer: L.GeoJSON | null = null
  private coverageTips = new Map<L.Layer, string>()
  /** One canvas for every outline (a canvas takes the pointer for the shapes it draws only) */
  private readonly outlines = outlineRenderer()
  private styleTable: LineStyle[] = []
  private styleIds = new Map<string, number>()
  private hoverFrame = 0
  private recomputeFrame = 0
  private inputTimer = 0

  constructor(params: URLSearchParams, dataBase: string, stafBase: string) {
    const cache = params.get('cache') !== '0'
    this.src = new DataSource(dataBase, { cache, cacheName: 'fpr-data-1' })
    this.staf = new DataSource(stafBase, { cache, cacheName: 'fpr-staf-1' })
    this.src.onBusy = (ms) => notify(`The data host is busy. Trying again in ${Math.round(ms / 1000)} s.`, { type: 'warning', id: 'busy', seconds: 6 })
    this.m = makeMap(byId('fpr-map'))
    this.map = this.m.map
    this.units = new UnitLayer(this.map, this.net, PANES.units)
    this.buildStyles()
  }

  // ---------------------------------------------------------------- start

  async start(): Promise<void> {
    this.wireHeader()
    this.wireMap()
    this.wirePane()
    this.registerDownloads()
    this.renderPane()
    this.renderLegend()
    try {
      const manifest = await this.src.ready()
      this.idx = fprIndex(manifest)
      this.version = dataVersion(manifest)
    } catch (err) {
      this.renderPane()
      notify(`The reach data could not be reached: ${err instanceof Error ? err.message : String(err)}`, { type: 'error', seconds: 15 })
      return
    }
    this.renderPane()
    await this.loadCoverage()
    this.updateCue()
    void this.staf.ready().catch(() => { /* stored cross-sections are optional */ })
  }

  private async loadCoverage(): Promise<void> {
    if (!this.src.has('outlines/huc8.json')) return
    try {
      const data = JSON.parse(new TextDecoder().decode(await this.src.bytesOf('outlines/huc8.json')))
      const opts: L.GeoJSONOptions & L.PathOptions = {
        renderer: this.outlines,
        pane: PANES.outlines,
        style: (feat) => this.coverageStyle(String(feat?.properties?.huc8 ?? '')),
        onEachFeature: (feat, layer) => {
          const code = String(feat.properties?.huc8 ?? '')
          const info = this.idx?.huc8[code]
          const status = info ? (info.status === 'built' ? 'reaches built' : 'reaches partly built') : 'not built yet'
          this.coverageTips.set(layer, `${esc(feat.properties?.name ?? '')} (HUC8 ${esc(code)}): ${status}`)
          if (this.map.getZoom() < PICK_ZOOM) layer.bindTooltip(this.coverageTips.get(layer)!, { sticky: true, className: 'fpr-tip' })
          layer.on('click', () => {
            if (this.map.getZoom() < PICK_ZOOM) this.map.fitBounds((layer as L.Polygon).getBounds(), { maxZoom: 11 })
          })
        },
      }
      this.coverageLayer = L.geoJSON(data, opts)
      this.m.coverage.addLayer(this.coverageLayer)
    } catch {
      // coverage outlines are a convenience
    }
  }

  private coverageStyle(code: string): L.PathOptions {
    const info = this.idx?.huc8[code]
    const low = this.map.getZoom() < PICK_ZOOM
    if (!info) return { color: '#8a94a6', weight: low ? 0.6 : 0.4, opacity: 0.5, fill: low, fillOpacity: 0.0, dashArray: '3 3' }
    const built = info.status === 'built'
    return {
      color: built ? '#2f4b7c' : '#b7791f', weight: low ? 1 : 0.8, opacity: low ? 0.8 : 0.5,
      fill: true, fillColor: built ? '#2f4b7c' : '#e9c46a', fillOpacity: low ? (built ? 0.14 : 0.18) : 0,
    }
  }

  // ---------------------------------------------------------------- data

  /** Loads the HUC8 files not loaded yet (each once). */
  async ensureFiles(huc8s: string[]): Promise<void> {
    const wanted = huc8s.filter((h) => this.idx?.huc8[h] && this.src.has(`units/${h}.parquet`))
    const jobs = wanted.map((h) => {
      if (this.net.has(h)) return Promise.resolve()
      let job = this.loading.get(h)
      if (!job) {
        this.busy++
        this.renderBusy()
        job = loadUnits(this.src, h).then((f: UnitFile) => {
          this.net.add(f)
          this.scheduleRecompute()
        }).catch((err) => {
          notify(`HUC8 ${h} could not be read: ${err instanceof Error ? err.message : String(err)}`, { type: 'error', seconds: 10 })
        }).finally(() => {
          this.loading.delete(h)
          this.busy--
          this.renderBusy()
        })
        this.loading.set(h, job)
      }
      return job
    })
    await Promise.all(jobs)
  }

  /** The files the view meets, nearest the center first (at most VIEW_FILES), from VIEW_ZOOM. */
  private autoLoad(): void {
    if (!this.idx || this.map.getZoom() < VIEW_ZOOM) return
    const b = this.map.getBounds()
    const c = b.getCenter()
    const near = huc8sInBox(this.idx, b.getWest(), b.getSouth(), b.getEast(), b.getNorth())
      .map((h) => {
        const [w, s, e, n] = this.idx!.huc8[h].bbox
        return { h, d: Math.hypot((w + e) / 2 - c.lng, (s + n) / 2 - c.lat) }
      })
      .sort((a, z) => a.d - z.d)
      .slice(0, VIEW_FILES)
      .map((x) => x.h)
    void this.ensureFiles(near)
  }

  private scheduleRecompute(): void {
    if (this.recomputeFrame) return
    this.recomputeFrame = requestAnimationFrame(() => {
      this.recomputeFrame = 0
      this.recompute()
    })
  }

  hasArea(): boolean {
    return (this.mode === 'huc' && this.codes.size > 0) || (this.mode === 'walk' && this.walkFrom !== null) || (this.mode === 'box' && this.box !== null)
  }

  /** Study-area masks, the screen, the sites, then the map and the pane. */
  recompute(): void {
    this.masks = this.computeMasks()
    const any = this.masks.some((m) => m.some((v) => v === 1))
    this.result = any ? screen(this.net, this.masks, this.criteria) : null
    this.ranked = this.result ? rankSites(this.result.sites, this.sort) : []
    this.siteOf.clear()
    this.ranked.forEach((s, i) => s.refs.forEach((ref) => this.siteOf.set(ref, i)))
    if (this.selected && !this.ranked.some((s) => s.id === this.selected)) this.selected = null
    this.restyle()
    this.refreshPane()
  }

  private computeMasks(): Uint8Array[] {
    if (!this.hasArea()) return this.net.files.map((f) => new Uint8Array(f.rows))
    if (this.mode === 'huc') return hucMask(this.net, [...this.codes])
    if (this.mode === 'box' && this.box) {
      const [w, s, e, n] = this.box
      return boxMask(this.net, mercX(w), mercY(n), mercX(e), mercY(s))
    }
    if (this.mode === 'walk' && this.walkFrom) {
      const start = this.findReach(this.walkFrom.id)
      if (start === null) return this.net.files.map((f) => new Uint8Array(f.rows))
      return refMask(this.net, this.net.walk(start))
    }
    return this.net.files.map((f) => new Uint8Array(f.rows))
  }

  private findReach(id: string): Ref | null {
    const [a, b] = id.split('-').map(Number)
    const ref = this.net.find(a, b)
    return ref >= 0 ? ref : null
  }

  // ---------------------------------------------------------------- styles

  private buildStyles(): void {
    const t: LineStyle[] = [{ color: '#000', width: 0, z: 0 }]
    const ids = new Map<string, number>()
    const add = (key: string, s: LineStyle) => {
      ids.set(key, t.length)
      t.push(s)
    }
    add('out', { color: '#7d8ba1', width: 1.1, alpha: 0.4, z: 1 })
    add('uns', { color: UNSAMPLED, width: 1.2, z: 2 })
    add('nod', { color: NO_DATA, width: 1.4, z: 3 })
    for (let b = 0; b < BINS; b++) {
      add(`s${b}`, { color: binColor(b), width: 2.6, z: 6 })
      add(`d${b}`, { color: binColor(b), width: 2.4, dash: [5, 4], z: 5 })
    }
    add('cap', { color: AT_CAP, width: 2.6, z: 6 })
    add('capd', { color: AT_CAP, width: 2.4, dash: [5, 4], z: 5 })
    add('m-site', { color: MATCH.site, width: 3.4, z: 9 })
    add('m-gap', { color: MATCH.site, width: 2.6, dash: [3, 4], z: 8 })
    add('m-short', { color: MATCH.short, width: 2.6, z: 7 })
    add('m-fail', { color: MATCH.fail, width: 1.8, z: 4 })
    add('m-unm', { color: MATCH.unmeasured, width: 1.4, z: 3 })
    this.styleTable = t
    this.styleIds = ids
  }

  private restyle(): void {
    const id = (k: string) => this.styleIds.get(k)!
    const area = this.result !== null
    const by: ColorBy = this.colorBy === 'match' && !area ? 'bhr' : this.colorBy
    const spec = RAMPS[by === 'er' ? 'er' : 'bhr']
    const ids = this.net.files.map((f, fi) => {
      const out = new Uint16Array(f.rows)
      const mask = this.masks[fi]
      const stage = this.result?.stage[fi]
      for (let r = 0; r < f.rows; r++) {
        if (area && !mask?.[r]) {
          out[r] = id('out')
          continue
        }
        const q = f.q[r]
        if (q === Q_UNSAMPLED) {
          out[r] = id('uns')
          continue
        }
        if (by === 'match' && stage) {
          const st = stage[r]
          const site = this.siteOf.get(refOf(fi, r))
          if (site !== undefined) out[r] = st === STAGE.pass ? id('m-site') : id('m-gap')
          else if (st === STAGE.pass) out[r] = id('m-short')
          else if (st === STAGE.unmeasured) out[r] = id('m-unm')
          else out[r] = id('m-fail')
          continue
        }
        if (q === Q_NODATA) {
          out[r] = id('nod')
          continue
        }
        const dash = q === Q_CAUTION
        if (by === 'bhr' && (f.why[r] & WHY.atCap)) {
          out[r] = id(dash ? 'capd' : 'cap')
          continue
        }
        const v = (by === 'er' ? f.er[r] : f.bhr[r]) / 100
        if (!Number.isFinite(v)) {
          out[r] = id('nod')
          continue
        }
        out[r] = id(`${dash ? 'd' : 's'}${binOf(spec, v)}`)
      }
      return out
    })
    this.units.setStyles(this.styleTable, ids)
    const site = this.ranked.find((s) => s.id === this.selected)
    this.units.setHighlight(site ? site.refs : [])
    this.renderLegend()
  }

  private renderLegend(): void {
    const area = this.result !== null
    const by: ColorBy = this.colorBy === 'match' && !area ? 'bhr' : this.colorBy
    const sw = (color: string, label: string, kind = '') => `<div class="fpr-legend-row"><span class="fpr-legend-sw ${kind}" style="--sw:${color}"></span><span>${esc(label)}</span></div>`
    let html: string
    if (by === 'match') {
      html = `<div class="fpr-legend-title">Criteria</div>
        ${sw(MATCH.site, 'In a candidate site')}
        ${sw(MATCH.site, 'Gap joined into a site', 'dash')}
        ${sw(MATCH.short, 'Meets the criteria, site too short')}
        ${sw(MATCH.fail, 'Fails a criterion')}
        ${sw(MATCH.unmeasured, 'Not measured')}
        ${sw(UNSAMPLED, 'Not sampled')}`
    } else {
      const spec: RampSpec = RAMPS[by]
      html = `<div class="fpr-legend-title">${esc(spec.title)}</div>
        <div class="fpr-legend-ramp" style="background:${rampGradient(spec)}"></div>
        <div class="fpr-legend-ends"><span>${esc(spec.loLabel)}</span><span>${esc(spec.hiLabel)}</span></div>
        ${by === 'bhr' ? sw(AT_CAP, 'At least 2.00 (method cap)') : ''}
        <div class="fpr-legend-sep"></div>
        ${sw(rampColor(0.5), 'Use with caution', 'dash')}
        ${sw(NO_DATA, 'Not enough data')}
        ${sw(UNSAMPLED, 'Not sampled')}`
    }
    if (area) html += `<div class="fpr-legend-sep"></div>${sw('#7d8ba1', 'Outside the study area')}`
    if (!this.net.files.length) html += `<div class="fpr-legend-sep"></div><div class="fpr-legend-row" style="color:#646f80">Zoom in to see reaches.</div>`
    this.m.legend.innerHTML = html
  }

  // ---------------------------------------------------------------- the map's events

  private wireMap(): void {
    let low = this.map.getZoom() < PICK_ZOOM
    this.map.on('moveend', () => {
      this.autoLoad()
      this.updatePicks()
      this.updateCue()
      const nowLow = this.map.getZoom() < PICK_ZOOM
      if (this.coverageLayer && nowLow !== low) {
        this.coverageLayer.setStyle((feat) => this.coverageStyle(String(feat?.properties?.huc8 ?? '')))
        // the watershed names show at the national view only (zoomed in, the reaches carry the pointer)
        this.coverageLayer.eachLayer((l) => {
          if (nowLow) l.bindTooltip(this.coverageTips.get(l) ?? '', { sticky: true, className: 'fpr-tip' })
          else l.unbindTooltip()
        })
      }
      low = nowLow
    })
    this.map.on('mousemove', (e: L.LeafletMouseEvent) => {
      this.readout.textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)} · zoom ${this.map.getZoom()}`
      if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame)
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = 0
        this.onHover(e)
      })
    })
    this.map.on('mouseout', () => {
      this.hover.hidden = true
      this.units.setHover(null)
    })
    this.map.on('click', (e: L.LeafletMouseEvent) => this.onClick(e))
  }

  private onHover(e: L.LeafletMouseEvent): void {
    const picking = this.step === 1 && this.sub === 'area' && this.mode === 'box'
    const ref = picking ? null : this.units.hit(e.latlng)
    this.units.setHover(ref)
    const container = this.map.getContainer()
    container.classList.toggle('fpr-pick', ref !== null)
    container.classList.toggle('fpr-crosshair', picking)
    if (ref === null) {
      this.hover.hidden = true
      return
    }
    const f = this.net.file(ref)
    const r = rowOf(ref)
    const site = this.siteOf.get(ref)
    const q = f.q[r]
    const values = q >= Q_NODATA ? `<div>${esc(QUALITY_LABEL[q])}</div>` : `
      <div>Bank height ratio <b>${esc(bhrText(f, r))}</b></div>
      <div>Entrenchment ratio <b>${ratio(f.er[r] / 100)}</b></div>
      <div>Low-bank height <b>${ft(f.lbh[r] / 100, 1)} ft</b></div>
      ${q === Q_CAUTION ? '<div class="f">Use with caution</div>' : ''}`
    this.hover.innerHTML = `<div class="t">${esc(f.name[r] || 'Unnamed stream')}</div>
      ${values}
      <div>Drains <b>${sqmi(f.da[r])} sq mi</b>, ${ft(f.lenM[r])} ft long</div>
      ${site !== undefined ? `<div>Candidate site <b>#${site + 1}</b></div>` : ''}`
    const p = this.map.mouseEventToContainerPoint(e.originalEvent)
    const shell = byId('fpr-shell').getBoundingClientRect()
    const mapBox = container.getBoundingClientRect()
    const x = p.x + mapBox.left - shell.left
    const y = p.y + mapBox.top - shell.top
    this.hover.hidden = false
    const w = this.hover.offsetWidth
    const h = this.hover.offsetHeight
    this.hover.style.left = `${Math.min(x + 16, shell.width - w - 8)}px`
    this.hover.style.top = `${Math.max(56, Math.min(y + 16, shell.height - h - 8))}px`
  }

  private onClick(e: L.LeafletMouseEvent): void {
    if (this.step !== 1) return
    if (this.sub === 'area' && this.mode === 'box') {
      this.boxClick(e.latlng)
      return
    }
    const ref = this.units.hit(e.latlng)
    if (this.sub === 'area' && this.mode === 'walk') {
      if (ref === null) {
        this.nudgeCue()
        return
      }
      void this.setWalk(ref)
      return
    }
    if (this.sub === 'area' && this.mode === 'huc') return   // the HUC12 outlines take the click
    if (ref !== null) this.showReach(ref)
  }

  private boxClick(at: L.LatLng): void {
    if (!this.corner) {
      this.corner = at
      this.boxLayer?.remove()
      this.boxLayer = L.rectangle(L.latLngBounds(at, at), { pane: PANES.marks, color: '#c2410c', weight: 2, fill: false }).addTo(this.map)
      this.updateCue()
      return
    }
    const b = L.latLngBounds(this.corner, at)
    this.corner = null
    this.boxLayer?.setBounds(b)
    const box: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    const files = this.idx ? huc8sInBox(this.idx, ...box) : []
    if (files.length > AREA_FILES) {
      notify(`That box meets ${files.length} HUC8 watersheds. Draw a smaller box (up to ${AREA_FILES}).`, { type: 'warning', seconds: 8 })
      this.boxLayer?.remove()
      this.boxLayer = null
      this.updateCue()
      return
    }
    this.box = box
    this.touch()
    this.updateCue()
    void this.ensureFiles(files).then(() => this.recompute())
    this.recompute()
  }

  private async setWalk(ref: Ref): Promise<void> {
    const f = this.net.file(ref)
    const r = rowOf(ref)
    if (!this.idx) return
    const from = { huc8: f.huc8, id: reachId(f, r) }
    if (!(await this.expandWalk(from.id))) {
      notify(`This point drains more than ${AREA_FILES} HUC8 watersheds. Pick watersheds instead, or click farther upstream.`, { type: 'warning', seconds: 10 })
      return
    }
    this.walkFrom = from
    this.setPin(this.findReach(from.id))
    this.touch()
    this.recompute()
  }

  /** Loads what a walk upstream from reach `id` needs. The HUC8 links in the index are whole-file
   * links (a HUC8 on a main stem links to every HUC8 the river comes from), so only the files the walk
   * actually reaches bring in their upstream neighbors, each loaded once to find the rows that flow
   * into the reached ones. False when the walk reaches more than AREA_FILES files. */
  private async expandWalk(id: string): Promise<boolean> {
    if (!this.idx) return false
    const probed = new Set<string>()
    for (let round = 0; round < 50; round++) {
      const start = this.findReach(id)
      if (start === null) return true
      const reached = new Set<string>()
      for (const ref of this.net.walk(start)) reached.add(this.net.file(ref).huc8)
      if (reached.size > AREA_FILES) return false
      const need: string[] = []
      for (const h of reached) {
        if (probed.has(h)) continue
        probed.add(h)
        for (const up of this.idx.huc8[h]?.up ?? []) if (!this.net.has(up) && !need.includes(up)) need.push(up)
      }
      if (!need.length) return true
      await this.ensureFiles(need)
    }
    return false
  }

  private setPin(ref: Ref | null): void {
    this.pin?.remove()
    this.pin = null
    if (ref === null) return
    const f = this.net.file(ref)
    const r = rowOf(ref)
    const v = f.off[r + 1] - 1
    this.pin = L.circleMarker([latOf(f.my[v]), lonOf(f.mx[v])], { pane: PANES.marks, radius: 7, color: '#fff', weight: 2.5, fillColor: '#c2410c', fillOpacity: 1 })
      .bindTooltip('Everything upstream of here', { className: 'fpr-tip' }).addTo(this.map)
  }

  // ---------------------------------------------------------------- HUC12 picking

  private visibleHuc4s(): string[] {
    if (!this.idx) return []
    const b = this.map.getBounds()
    const have = new Set(this.idx.huc4)
    return [...new Set(huc8sInBox(this.idx, b.getWest(), b.getSouth(), b.getEast(), b.getNorth()).map((h) => h.slice(0, 4)))]
      .filter((h) => have.has(h)).slice(0, 6)
  }

  private pickingOn(): boolean {
    return this.step === 1 && this.sub === 'area' && this.mode === 'huc' && this.map.getZoom() >= PICK_ZOOM
  }

  private updatePicks(): void {
    if (!this.pickingOn()) {
      this.m.picks.clearLayers()
      return
    }
    const want = new Set(this.visibleHuc4s())
    for (const [h, layer] of this.huc12Layers) {
      if (want.has(h)) this.m.picks.addLayer(layer)
      else this.m.picks.removeLayer(layer)
    }
    for (const h of want) if (!this.huc12Layers.has(h)) void this.huc12Outline(h).then(() => this.updatePicks())
  }

  private huc12Outline(huc4: string): Promise<L.GeoJSON | null> {
    const have = this.huc12Layers.get(huc4)
    if (have) return Promise.resolve(have)
    let job = this.huc12Loading.get(huc4)
    if (!job) {
      const logical = `outlines/huc12_${huc4}.json`
      job = (this.src.has(logical) ? this.src.bytesOf(logical) : Promise.reject(new Error('no outline')))
        .then((buf) => {
          const data = JSON.parse(new TextDecoder().decode(buf))
          const opts: L.GeoJSONOptions & L.PathOptions = {
            renderer: this.outlines,
            pane: PANES.outlines,
                style: (feat) => this.huc12Style(String(feat?.properties?.huc12 ?? '')),
            onEachFeature: (feat, l) => {
              const code = String(feat.properties?.huc12 ?? '')
              this.huc12Names.set(code, String(feat.properties?.name ?? ''))
              l.bindTooltip(`${esc(feat.properties?.name ?? '')}<br><small>HUC12 ${esc(code)}</small>`, { sticky: true, className: 'fpr-tip' })
              l.on('click', () => this.togglePick(code))
            },
          }
          const layer = L.geoJSON(data, opts)
          this.huc12Layers.set(huc4, layer)
          return layer
        })
        .catch(() => null)
        .finally(() => this.huc12Loading.delete(huc4))
      this.huc12Loading.set(huc4, job)
    }
    return job
  }

  private huc12Style(code: string): L.PathOptions {
    const on = this.codes.has(code)
    return on
      ? { color: '#c2410c', weight: 2, opacity: 0.95, fill: true, fillColor: '#c2410c', fillOpacity: 0.12 }
      : { color: '#2f4b7c', weight: 0.9, opacity: 0.55, fill: true, fillColor: '#2f4b7c', fillOpacity: 0.02 }
  }

  private restylePicks(): void {
    for (const layer of this.huc12Layers.values()) layer.setStyle((feat) => this.huc12Style(String(feat?.properties?.huc12 ?? '')))
  }

  private togglePick(code: string): void {
    if (!this.pickingOn()) return
    if (this.codes.has(code)) this.codes.delete(code)
    else this.codes.add(code)
    this.lastPick = this.codes.has(code) ? code : this.lastPick === code ? null : this.lastPick
    this.afterPicks()
  }

  private afterPicks(): void {
    this.touch()
    this.restylePicks()
    this.recompute()
    void this.ensureFiles(hucFiles([...this.codes]))
  }

  /** Every HUC12 code under `prefix` (8 or 10 digits), from the outlines. */
  private async expand(prefix: string): Promise<string[]> {
    const layer = await this.huc12Outline(prefix.slice(0, 4))
    if (!layer) return []
    const out: string[] = []
    layer.eachLayer((l) => {
      const code = String((l as L.Polygon & { feature?: GeoJSON.Feature }).feature?.properties?.huc12 ?? '')
      if (code.startsWith(prefix)) out.push(code)
    })
    return out.sort()
  }

  private async addWhole(len: 8 | 10): Promise<void> {
    if (!this.lastPick) return
    for (const c of await this.expand(this.lastPick.slice(0, len))) this.codes.add(c)
    this.afterPicks()
  }

  // ---------------------------------------------------------------- examples

  private async example(id: string): Promise<void> {
    const ex = EXAMPLES.find((e) => e.id === id)
    if (!ex || !this.idx) return
    this.clearArea()
    this.map.setView([ex.view[0], ex.view[1]], ex.view[2])
    if (ex.kind === 'huc') {
      this.mode = 'huc'
      for (const p of ex.prefixes ?? []) for (const c of p.length === 12 ? [p] : await this.expand(p)) this.codes.add(c)
      this.lastPick = [...this.codes][0] ?? null
      this.renderPane()
      this.afterPicks()
      await this.ensureFiles(hucFiles([...this.codes]))
      this.recompute()
      this.fitArea()
    } else {
      this.mode = 'walk'
      this.renderPane()
      await this.ensureFiles([ex.huc8!])
      const ref = this.net.find(ex.walkId!, undefined, true)
      if (ref < 0) {
        notify('That example is not in this copy of the data.', { type: 'warning' })
        return
      }
      await this.setWalk(ref)
      this.fitArea()
    }
  }

  /** The map framed on the study area. */
  fitArea(): void {
    // Web Mercator units: y grows southward, so the north edge is the smallest y
    let west = Infinity
    let east = -Infinity
    let north = Infinity
    let south = -Infinity
    this.net.files.forEach((f, fi) => {
      const m = this.masks[fi]
      if (!m) return
      for (let r = 0; r < f.rows; r++) {
        if (!m[r]) continue
        const b = r * 4
        west = Math.min(west, f.box[b])
        north = Math.min(north, f.box[b + 1])
        east = Math.max(east, f.box[b + 2])
        south = Math.max(south, f.box[b + 3])
      }
    })
    if (!Number.isFinite(west)) return
    this.map.fitBounds(L.latLngBounds([latOf(south), lonOf(west)], [latOf(north), lonOf(east)]),
      { paddingTopLeft: [400, 30], paddingBottomRight: [30, 30] })
  }

  private clearArea(): void {
    this.codes.clear()
    this.lastPick = null
    this.walkFrom = null
    this.box = null
    this.corner = null
    this.boxLayer?.remove()
    this.boxLayer = null
    this.setPin(null)
    this.selected = null
    this.restylePicks()
  }

  // ---------------------------------------------------------------- the pane

  private wirePane(): void {
    this.pane.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      if (t.closest('.fpr-site-keep')) return            // the Keep box: its change event does the work
      const act = t.closest<HTMLElement>('[data-act]')
      if (!act) return
      const a = act.dataset.act!
      if (a === 'sub') this.goSub(act.dataset.sub as Sub)
      else if (a === 'mode') this.setMode(act.dataset.mode as Mode)
      else if (a === 'example') void this.example(act.dataset.id!)
      else if (a === 'whole10') void this.addWhole(10)
      else if (a === 'whole8') void this.addWhole(8)
      else if (a === 'clear') {
        this.clearArea()
        this.touch()
        this.recompute()
        this.renderPane()
      } else if (a === 'unpick') {
        this.codes.delete(act.dataset.code!)
        this.afterPicks()
      } else if (a === 'fit') this.fitArea()
      else if (a === 'color') {
        this.colorBy = act.dataset.by as ColorBy
        this.restyle()
        this.renderPane()
      } else if (a === 'methods') showMethods(this.idx)
      else if (a === 'site') this.selectSite(act.dataset.id!, true)
      else if (a === 'site-details') {
        e.stopPropagation()
        this.showSite(act.dataset.id!)
      } else if (a === 'table') this.showTable()
      else if (a === 'more') {
        this.showAll = true
        this.refreshPane()
      } else if (a === 'step1') this.goStep(1)
    })
    this.pane.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement
      if (t.dataset.crit !== undefined) this.readCriteria()
      else if (t.id === 'fpr-preset') this.applyPreset(t.value)
      else if (t.id === 'fpr-sort') {
        this.sort = t.value as SortKey
        this.ranked = this.result ? rankSites(this.result.sites, this.sort) : []
        this.siteOf.clear()
        this.ranked.forEach((s, i) => s.refs.forEach((ref) => this.siteOf.set(ref, i)))
        this.refreshPane()
      } else if (t.dataset.keep !== undefined) {
        const id = t.dataset.keep!
        const d = this.decisions.get(id) ?? { keep: true, note: '' }
        d.keep = (t as HTMLInputElement).checked
        this.decisions.set(id, d)
        this.touch()
        this.refreshPane()
      }
    })
    this.pane.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement
      if ((e.key === 'Enter' || e.key === ' ') && t.classList.contains('fpr-site')) {
        e.preventDefault()
        this.selectSite(t.dataset.id!, true)
      }
    })
    this.pane.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement
      if (t.dataset.crit === undefined || t.type !== 'number') return
      clearTimeout(this.inputTimer)
      this.inputTimer = window.setTimeout(() => this.readCriteria(), 350)
    })
  }

  private goStep(n: number): void {
    this.step = n
    document.querySelectorAll<HTMLElement>('.fpr-step-btn').forEach((b) => {
      const on = Number(b.dataset.step) === n
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', String(on))
    })
    this.updatePicks()
    this.updateCue()
    this.renderPane()
  }

  goSub(sub: Sub): void {
    if (sub !== 'area' && !this.result) {
      notify('Choose a study area first.', { seconds: 4 })
      return
    }
    this.sub = sub
    if (sub === 'area') this.corner = null
    if (sub === 'shortlist' && this.colorBy !== 'match') {
      this.colorBy = 'match'
      this.restyle()
    }
    this.updatePicks()
    this.updateCue()
    this.renderPane()
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode) return
    this.clearArea()
    this.mode = mode
    this.touch()
    this.recompute()
    this.updatePicks()
    this.updateCue()
    this.renderPane()
  }

  private stepsStrip(): string {
    const at = SUBS.findIndex((s) => s.key === this.sub)
    return `<div class="fpr-steps" role="tablist">${SUBS.map((s, i) => {
      const cls = s.key === this.sub ? 'active' : this.result && i < at ? 'done' : ''
      const off = s.key !== 'area' && !this.result
      return `<button type="button" class="fpr-sub ${cls}" data-act="sub" data-sub="${s.key}"${off ? ' disabled' : ''}>${esc(s.label)}</button>`
    }).join('')}</div>`
  }

  renderPane(): void {
    if (this.step !== 1) {
      this.pane.innerHTML = plannedPane(this.step)
      return
    }
    const body = this.sub === 'area' ? this.areaPane() : this.sub === 'screen' ? this.screenPane() : this.sub === 'shortlist' ? this.shortlistPane() : this.reportPane()
    this.pane.innerHTML = `<div class="fpr-pane-head">Step 1. Screen sites <small>Beta</small></div>
      <div class="fpr-pane-body">${this.stepsStrip()}<div id="fpr-busy-slot"></div>${body}</div>`
    this.renderBusy()
    if (this.sub === 'area') {
      const input = this.pane.querySelector<HTMLInputElement>('#fpr-search')
      const menu = this.pane.querySelector<HTMLElement>('#fpr-search-menu')
      if (input && menu) wireSearch(input, menu, (p) => this.map.setView([p.lat, p.lon], Math.max(p.zoom, this.mode === 'huc' ? 11 : 12)))
    }
    this.refreshPane()
  }

  /** The parts of the pane that change without a full redraw (inputs keep their focus). */
  refreshPane(): void {
    if (this.step !== 1) return
    const strip = this.pane.querySelector('.fpr-steps')
    if (strip) strip.outerHTML = this.stepsStrip()
    if (this.sub === 'area') {
      const picks = this.pane.querySelector('#fpr-area-picks')
      if (picks) picks.innerHTML = this.picksHtml()
      const sum = this.pane.querySelector('#fpr-area-summary')
      if (sum) sum.innerHTML = this.areaSummary()
      const next = this.pane.querySelector<HTMLButtonElement>('#fpr-next-screen')
      if (next) next.disabled = !this.result
      this.pane.querySelectorAll<HTMLButtonElement>('[data-act="whole10"], [data-act="whole8"]').forEach((b) => { b.disabled = !this.lastPick })
    } else if (this.sub === 'screen') {
      const set = (id: string, html: string) => {
        const e = this.pane.querySelector(`#${id}`)
        if (e) e.innerHTML = html
      }
      set('fpr-hist-bhr', this.histogram('bhr'))
      set('fpr-hist-er', this.histogram('er'))
      set('fpr-funnel', this.funnelHtml())
      const preset = this.pane.querySelector<HTMLSelectElement>('#fpr-preset')
      if (preset) preset.value = presetOf(this.criteria)?.id ?? 'custom'
      const next = this.pane.querySelector('#fpr-next-short')
      if (next) next.textContent = `Next: shortlist (${count(this.ranked.length)})`
    } else if (this.sub === 'shortlist') {
      const list = this.pane.querySelector('#fpr-site-list')
      if (list) list.innerHTML = this.sitesHtml()
      const head = this.pane.querySelector('#fpr-short-head')
      if (head) head.innerHTML = this.shortHead()
    }
  }

  private renderBusy(): void {
    const slot = this.pane.querySelector('#fpr-busy-slot')
    if (!slot) return
    slot.innerHTML = this.busy > 0
      ? `<div class="fpr-busy"><span class="fpr-spinner"></span>Loading ${this.busy} watershed file${this.busy === 1 ? '' : 's'}</div>`
      : ''
  }

  // the Study area sub-step

  private areaPane(): string {
    const ready = this.idx !== null
    const modes: { key: Mode, label: string }[] = [
      { key: 'huc', label: 'Watersheds' }, { key: 'walk', label: 'Upstream of a point' }, { key: 'box', label: 'Draw a box' },
    ]
    const how = this.mode === 'huc'
      ? '<p>Zoom in and click HUC12 watersheds to add or remove them. Add the whole HUC10 or HUC8 of the last one you picked.</p>'
      : this.mode === 'walk'
        ? '<p>Zoom in until streams show, then click one. Everything upstream of it becomes the study area.</p>'
        : '<p>Click two opposite corners on the map. Every reach in the box becomes the study area.</p>'
    return `
      <div class="fpr-instr"><p>Choose where to screen. Reaches show on the map wherever the grid is built.</p></div>
      <div class="fpr-search"><input id="fpr-search" class="form-control form-control-sm" type="search" placeholder="Find a place, or enter lat, lon" autocomplete="off" aria-label="Find a place"><div id="fpr-search-menu" class="fpr-ac-menu" hidden role="listbox"></div></div>
      <div class="fpr-seg" role="tablist">${modes.map((m) => `<button type="button" data-act="mode" data-mode="${m.key}" class="${m.key === this.mode ? 'on' : ''}">${esc(m.label)}</button>`).join('')}</div>
      <div class="fpr-note" style="margin:0 0 8px">${how}</div>
      ${this.mode === 'huc' ? `<div id="fpr-area-picks"></div>
        <div class="fpr-actions" style="margin-top:6px">
          <button type="button" class="btn btn-outline-primary btn-sm" data-act="whole10">Add whole HUC10</button>
          <button type="button" class="btn btn-outline-primary btn-sm" data-act="whole8">Add whole HUC8</button>
        </div>` : ''}
      <div class="fpr-group">Examples</div>
      <div class="fpr-chips">${EXAMPLES.map((e) => `<button type="button" class="fpr-chip" data-act="example" data-id="${e.id}"${ready ? '' : ' disabled'}>${esc(e.label)}</button>`).join('')}</div>
      <div id="fpr-area-summary"></div>
      <div class="fpr-actions">
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="clear">Clear</button>
        <button type="button" class="btn btn-primary btn-sm" id="fpr-next-screen" data-act="sub" data-sub="screen">Next: screen</button>
      </div>`
  }

  private picksHtml(): string {
    if (!this.codes.size) return '<div class="fpr-note">No watersheds picked yet.</div>'
    const codes = [...this.codes].sort()
    const shown = codes.slice(0, 12)
    return `<div class="fpr-chips">${shown.map((c) => `<button type="button" class="fpr-chip on" data-act="unpick" data-code="${c}" title="Remove HUC12 ${c}">${esc(this.huc12Names.get(c) || c)} &times;</button>`).join('')}</div>
      ${codes.length > shown.length ? `<div class="fpr-note">and ${codes.length - shown.length} more HUC12 watersheds</div>` : ''}`
  }

  private areaStats(): { reaches: number, m: number, unsampled: number, caution: number, nodata: number } {
    let reaches = 0
    let m = 0
    let unsampled = 0
    let caution = 0
    let nodata = 0
    this.net.files.forEach((f, fi) => {
      const mask = this.masks[fi]
      if (!mask) return
      for (let r = 0; r < f.rows; r++) {
        if (!mask[r]) continue
        if (f.q[r] === Q_UNSAMPLED) {
          unsampled++
          continue
        }
        reaches++
        m += f.lenM[r]
        if (f.q[r] === Q_CAUTION) caution++
        if (f.q[r] === Q_NODATA) nodata++
      }
    })
    return { reaches, m, unsampled, caution, nodata }
  }

  private areaText(): string {
    if (this.mode === 'huc' && this.codes.size) {
      const codes = [...this.codes].sort()
      const names = codes.slice(0, 4).map((c) => `${this.huc12Names.get(c) || 'HUC12'} (${c})`)
      return `${codes.length} HUC12 watershed${codes.length === 1 ? '' : 's'}: ${names.join(', ')}${codes.length > 4 ? `, and ${codes.length - 4} more` : ''}`
    }
    if (this.mode === 'walk' && this.walkFrom) {
      const ref = this.findReach(this.walkFrom.id)
      const name = ref !== null ? this.net.file(ref).name[rowOf(ref)] : ''
      return `Everything upstream of ${name || 'an unnamed stream'}, reach ${this.walkFrom.id} (HUC8 ${this.walkFrom.huc8})`
    }
    if (this.mode === 'box' && this.box) {
      const [w, s, e, n] = this.box
      return `A box from ${s.toFixed(4)}, ${w.toFixed(4)} to ${n.toFixed(4)}, ${e.toFixed(4)}`
    }
    return 'No study area'
  }

  private areaSummary(): string {
    if (!this.hasArea()) return ''
    const st = this.areaStats()
    const partial = this.areaHuc8s().filter((h) => this.idx?.huc8[h]?.status === 'partial')
    const missing = this.mode === 'huc' ? hucFiles([...this.codes]).filter((h) => !this.idx?.huc8[h]) : []
    return `<div class="fpr-card" style="margin-top:12px">
      <h5>Study area</h5>
      <div class="fpr-row"><span>Reaches</span><b>${count(st.reaches)}</b></div>
      <div class="fpr-row"><span>Stream length</span><b>${mi(st.m)} mi</b></div>
      <div class="fpr-row"><span>Use with caution</span><b>${count(st.caution)}</b></div>
      <div class="fpr-row"><span>Not enough data</span><b>${count(st.nodata)}</b></div>
      <div class="fpr-row"><span>Lines not sampled</span><b>${count(st.unsampled)}</b></div>
      ${partial.length ? '<div class="fpr-note warn">Part of this area is in grid regions not built yet.</div>' : ''}
      ${missing.length ? `<div class="fpr-note warn">No reaches are built yet for HUC8 ${missing.map(esc).join(', ')}.</div>` : ''}
      <div class="fpr-actions" style="margin-top:6px"><button type="button" class="btn btn-link btn-sm p-0" data-act="fit">Zoom to the study area</button></div>
    </div>`
  }

  private areaHuc8s(): string[] {
    const out = new Set<string>()
    this.net.files.forEach((f, fi) => {
      if (this.masks[fi]?.some((v) => v === 1)) out.add(f.huc8)
    })
    return [...out]
  }

  // the Screen sub-step

  private screenPane(): string {
    const c = this.criteria
    const num = (key: keyof Criteria, v: number | null, step: string, min = '0') =>
      `<input type="number" class="form-control" data-crit="${key}" value="${v === null ? '' : v}" step="${step}" min="${min}" aria-label="${key}">`
    const box = (key: keyof Criteria, on: boolean) => `<input type="checkbox" class="form-check-input" data-crit="${key}" id="crit-${key}"${on ? ' checked' : ''}>`
    const colors: { key: ColorBy, label: string }[] = [{ key: 'bhr', label: 'Bank height ratio' }, { key: 'er', label: 'Entrenchment ratio' }, { key: 'match', label: 'Criteria' }]
    return `
      <div class="fpr-group">Color the map by</div>
      <div class="fpr-seg">${colors.map((k) => `<button type="button" data-act="color" data-by="${k.key}" class="${k.key === this.colorBy ? 'on' : ''}">${esc(k.label)}</button>`).join('')}</div>
      <div class="fpr-group">Criteria <small>starting values for the team to set</small></div>
      <select id="fpr-preset" class="form-select form-select-sm fpr-preset" aria-label="Starting values">
        ${PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}<option value="custom">Custom</option></select>
      <div class="fpr-crit"><div class="fpr-crit-line">${box('includeCaution', c.includeCaution)}<label for="crit-includeCaution">Include reaches marked "use with caution"</label></div></div>
      <div class="fpr-crit"><div class="fpr-crit-line">${box('skipCanals', c.skipCanals)}<label for="crit-skipCanals">Leave out canals and ditches</label></div></div>
      <div class="fpr-crit"><div class="fpr-crit-line"><label>Drainage area at least</label>${num('daMinSqmi', c.daMinSqmi, '0.5')}<span class="fpr-unit">sq mi</span></div>
        <div class="fpr-crit-line" style="margin-top:4px"><label>and at most</label>${num('daMaxSqmi', c.daMaxSqmi, '10')}<span class="fpr-unit">sq mi</span></div></div>
      <div class="fpr-crit"><div class="fpr-crit-line"><label>Bank height ratio at least</label>${num('bhrMin', c.bhrMin, '0.05')}<span class="fpr-unit"></span></div>
        <div class="fpr-crit-sub">${box('countCapped', c.countCapped)}<label for="crit-countCapped">Count reaches that read "at least 2.00"</label></div>
        <div id="fpr-hist-bhr"></div></div>
      <div class="fpr-crit"><div class="fpr-crit-line"><label>Entrenchment ratio at least</label>${num('erMin', c.erMin, '0.1', '1')}<span class="fpr-unit"></span></div>
        <div id="fpr-hist-er"></div></div>
      <div class="fpr-crit"><div class="fpr-crit-line"><label>Shortest site</label>${num('minSiteFt', c.minSiteFt, '100')}<span class="fpr-unit">ft</span></div></div>
      <div class="fpr-crit"><div class="fpr-crit-line"><label>Join a site across gaps of up to</label>${num('gapReaches', c.gapReaches, '1')}<span class="fpr-unit">reaches</span></div></div>
      <div class="fpr-crit fpr-planned-crit">Additional metrics from FluvialGeomorph (planned)</div>
      <div class="fpr-note">Leave a box empty to drop that criterion. <a href="#" data-act="methods">Methods and limits</a></div>
      <div class="fpr-group">How the criteria narrow the reaches</div>
      <div id="fpr-funnel"></div>
      <div class="fpr-actions">
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="sub" data-sub="area">Back</button>
        <button type="button" class="btn btn-primary btn-sm" id="fpr-next-short" data-act="sub" data-sub="shortlist">Next: shortlist</button>
      </div>`
  }

  private readCriteria(): void {
    const c: Criteria = { ...this.criteria }
    this.pane.querySelectorAll<HTMLInputElement>('[data-crit]').forEach((i) => {
      const key = i.dataset.crit as keyof Criteria
      if (i.type === 'checkbox') (c as any)[key] = i.checked
      else {
        const v = i.value.trim() === '' ? null : Number(i.value)
        const ok = v === null || Number.isFinite(v)
        if (!ok) return
        if (key === 'minSiteFt') c.minSiteFt = v === null ? 0 : Math.max(0, v)
        else if (key === 'gapReaches') c.gapReaches = v === null ? 0 : Math.max(0, Math.round(v))
        else (c as any)[key] = v
      }
    })
    this.criteria = c
    this.touch()
    this.recompute()
  }

  private applyPreset(id: string): void {
    const p = PRESETS.find((x) => x.id === id)
    if (!p) return
    this.criteria = { ...p.criteria }
    this.touch()
    this.renderPane()
    this.recompute()
  }

  private histogram(which: 'bhr' | 'er'): string {
    if (!this.result) return ''
    const spec = RAMPS[which]
    const lo = which === 'bhr' ? 0.8 : 1
    const hi = which === 'bhr' ? 2 : 3
    const step = 0.1
    const nb = Math.round((hi - lo) / step)
    const bins = new Array(nb + 1).fill(0)        // the last: at or past hi (BHR: the cap)
    this.net.files.forEach((f, fi) => {
      const st = this.result!.stage[fi]
      for (let r = 0; r < f.rows; r++) {
        if (st[r] < STAGE.da) continue
        const v = (which === 'bhr' ? f.bhr[r] : f.er[r]) / 100
        if (!Number.isFinite(v)) continue
        if (which === 'bhr' && (f.why[r] & WHY.atCap)) bins[nb]++
        else if (v >= hi) bins[nb]++
        else bins[Math.max(0, Math.min(nb - 1, Math.floor((v - lo) / step + 1e-9)))]++
      }
    })
    const max = Math.max(1, ...bins)
    const W = 320
    const H = 58
    const bw = (W - 4) / (nb + 1)
    const thr = which === 'bhr' ? this.criteria.bhrMin : this.criteria.erMin
    const bars = bins.map((n, i) => {
      const v0 = lo + i * step
      const h = (n / max) * (H - 14)
      const color = i === nb && which === 'bhr' ? AT_CAP : binColor(binOf(spec, v0 + step / 2))
      const below = thr !== null && i < nb && v0 + step / 2 < thr
      return `<rect x="${(2 + i * bw).toFixed(1)}" y="${(H - 12 - h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="${below ? 0.3 : 0.95}"><title>${i === nb ? (which === 'bhr' ? 'at least 2.00' : `${hi.toFixed(1)} or more`) : `${v0.toFixed(1)} to ${(v0 + step).toFixed(1)}`}: ${n}</title></rect>`
    }).join('')
    const tx = thr === null ? null : 2 + Math.max(0, Math.min(nb, (thr - lo) / step)) * bw
    const line = tx === null ? '' : `<line x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="2" y2="${H - 12}" stroke="#111827" stroke-width="1.5" stroke-dasharray="3 2"/>`
    const labels = `<text x="2" y="${H - 1}" font-size="10" fill="#646f80">${lo.toFixed(1)}</text>
      <text x="${W - 2}" y="${H - 1}" font-size="10" fill="#646f80" text-anchor="end">${which === 'bhr' ? 'at least 2.00' : `${hi.toFixed(1)}+`}</text>`
    return `<svg class="fpr-hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title)} of the measured reaches">${bars}${line}${labels}</svg>`
  }

  private funnelHtml(): string {
    if (!this.result) return '<div class="fpr-note">Choose a study area first.</div>'
    const first = Math.max(1, this.result.funnel[0]?.reaches ?? 1)
    const rows = this.result.funnel.map((s) => `<div class="fpr-funnel-row" title="${mi(s.lengthM)} mi">
        <span class="fpr-funnel-label">${esc(s.label)}</span>
        <span class="fpr-funnel-track"><span class="fpr-funnel-fill" style="display:block;width:${((s.reaches / first) * 100).toFixed(1)}%"></span></span>
        <span class="fpr-funnel-val">${count(s.reaches)}</span></div>`).join('')
    const total = this.ranked.reduce((a, s) => a + s.lengthM, 0)
    return `${rows}<div class="fpr-funnel-row last" title="${mi(total)} mi">
        <span class="fpr-funnel-label"><b>Candidate sites</b>, ${count(this.criteria.minSiteFt)} ft or longer</span>
        <span class="fpr-funnel-track"><span class="fpr-funnel-fill" style="display:block;width:${Math.min(100, (this.ranked.length / first) * 100 * 10).toFixed(1)}%"></span></span>
        <span class="fpr-funnel-val">${count(this.ranked.length)}</span></div>
      <div class="fpr-note">${mi(total)} mi of stream in candidate sites.${this.result.shortRuns ? ` ${count(this.result.shortRuns)} more reaches meet the criteria in runs shorter than the shortest site.` : ''}</div>`
  }

  // the Shortlist sub-step

  private shortlistPane(): string {
    return `
      <div class="fpr-instr" id="fpr-short-head"></div>
      <div class="fpr-sort"><label for="fpr-sort">Rank by</label><select id="fpr-sort" class="form-select form-select-sm">
        ${SORTS.map((s) => `<option value="${s.key}"${s.key === this.sort ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
        <button type="button" class="btn btn-link btn-sm p-0 ms-auto" data-act="table">Open the table</button></div>
      <div id="fpr-site-list"></div>
      <div class="fpr-actions">
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="sub" data-sub="screen">Back</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="sub" data-sub="report">Next: report</button>
      </div>`
  }

  private shortHead(): string {
    const kept = this.ranked.filter((s) => this.decisions.get(s.id)?.keep !== false).length
    const total = this.ranked.reduce((a, s) => a + s.lengthM, 0)
    if (!this.ranked.length) return '<p>No sites meet the criteria. Loosen a criterion in the Screen step.</p>'
    const n = this.ranked.length
    return `<p><b>${count(n)}</b> candidate site${n === 1 ? '' : 's'}, ${mi(total)} mi in all. ${count(kept)} kept.</p><p>Click a site to see it on the map.</p>`
  }

  private siteMeta(s: Site): string {
    const bhr = `BHR ${ratio(s.bhr)}${s.bhrAtCap && s.bhr >= 2 - 1e-9 ? ' (at least)' : ''}`
    return `${ft(s.lengthM)} ft · ${bhr} · ER ${ratio(s.er)} · low bank ${ft(s.lbhM, 1)} ft · drains ${sqmi(s.daSqkm)} sq mi${s.caution ? ` · <span class="fpr-flag">${s.caution} with cautions</span>` : ''}`
  }

  private sitesHtml(): string {
    const list = this.showAll ? this.ranked : this.ranked.slice(0, 40)
    const cards = list.map((s, i) => {
      const d = this.decisions.get(s.id)
      const kept = d?.keep !== false
      return `<div class="fpr-site${s.id === this.selected ? ' on' : ''}${kept ? '' : ' dropped'}" data-act="site" data-id="${s.id}" tabindex="0" role="button" aria-label="Site ${i + 1}, ${esc(s.name || 'Unnamed stream')}">
        <span class="fpr-site-rank">${i + 1}</span>
        <span class="fpr-site-name">${esc(s.name || 'Unnamed stream')}</span>
        <label class="fpr-site-keep"><input type="checkbox" data-keep="${s.id}"${kept ? ' checked' : ''}> Keep</label>
        <span class="fpr-site-meta">${this.siteMeta(s)}${d?.note ? `<br>Note: ${esc(d.note)}` : ''} · <a href="#" data-act="site-details" data-id="${s.id}">Details</a></span>
      </div>`
    }).join('')
    const more = !this.showAll && this.ranked.length > list.length
      ? `<button type="button" class="btn btn-outline-primary btn-sm fpr-more" data-act="more">Show all ${count(this.ranked.length)}</button>` : ''
    return `<div class="fpr-sites">${cards}</div>${more}`
  }

  selectSite(id: string, zoom: boolean): void {
    this.selected = id
    const site = this.ranked.find((s) => s.id === id)
    this.units.setHighlight(site ? site.refs : [])
    this.refreshPane()
    if (site && zoom) {
      let w = Infinity
      let e = -Infinity
      let n = Infinity
      let s2 = -Infinity
      for (const ref of site.refs) {
        const f = this.net.file(ref)
        const b = rowOf(ref) * 4
        w = Math.min(w, f.box[b])
        n = Math.min(n, f.box[b + 1])
        e = Math.max(e, f.box[b + 2])
        s2 = Math.max(s2, f.box[b + 3])
      }
      this.map.fitBounds(L.latLngBounds([latOf(s2), lonOf(w)], [latOf(n), lonOf(e)]),
        { paddingTopLeft: [400, 60], paddingBottomRight: [60, 60], maxZoom: 16 })
    }
  }

  // the Report sub-step

  private criteriaText(): string[] {
    const c = this.criteria
    const out = [
      c.includeCaution ? 'Reaches marked "use with caution" included' : 'Reaches marked "use with caution" left out',
      c.skipCanals ? 'Canals and ditches left out' : 'Canals and ditches included',
    ]
    if (c.daMinSqmi !== null || c.daMaxSqmi !== null) {
      out.push(c.daMinSqmi !== null && c.daMaxSqmi !== null ? `Drainage area ${c.daMinSqmi} to ${c.daMaxSqmi} sq mi`
        : c.daMinSqmi !== null ? `Drainage area ${c.daMinSqmi} sq mi or more` : `Drainage area ${c.daMaxSqmi} sq mi or less`)
    }
    if (c.bhrMin !== null) out.push(`Bank height ratio ${c.bhrMin.toFixed(2)} or more${c.countCapped ? ', counting reaches that read "at least 2.00"' : ', not counting reaches that read "at least 2.00"'}`)
    if (c.erMin !== null) out.push(`Entrenchment ratio ${c.erMin.toFixed(2)} or more`)
    out.push(`Sites ${count(c.minSiteFt)} ft or longer, joined across gaps of up to ${c.gapReaches} reach${c.gapReaches === 1 ? '' : 'es'}`)
    const preset = presetOf(c)
    if (preset) out.push(`Starting values: ${preset.label}`)
    return out
  }

  private reportPane(): string {
    const kept = this.ranked.filter((s) => this.decisions.get(s.id)?.keep !== false).length
    const dl = (id: string, label: string, note: string) => `<a href="#" id="${id}" class="fpr-download-link fpr-dl"><span>${esc(label)}</span><small>${esc(note)}</small></a>`
    return `
      <div class="fpr-card">
        <h5>Screening summary</h5>
        <div class="fpr-note" style="margin:0 0 6px">${esc(this.areaText())}</div>
        <div class="fpr-row"><span>Candidate sites</span><b>${count(this.ranked.length)}</b></div>
        <div class="fpr-row"><span>Kept</span><b>${count(kept)}</b></div>
        <div class="fpr-row"><span>Data version</span><b>${esc(this.version)}</b></div>
        <ul class="fpr-note" style="padding-left:16px;margin:6px 0 0">${this.criteriaText().map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>
      <div class="fpr-group">Downloads</div>
      <div class="fpr-downloads">
        ${dl('fpr-dl-short-csv', 'Shortlist', 'CSV')}
        ${dl('fpr-dl-short-geojson', 'Shortlist', 'GeoJSON, for GIS or FluvialGeomorph')}
        ${dl('fpr-dl-reaches-csv', 'Every reach of the study area', 'CSV')}
        ${dl('fpr-dl-print', 'Printable summary', 'web page')}
        ${dl('fpr-dl-save', 'Save this screening', 'reopens with Open')}
      </div>
      <div class="fpr-group">Next</div>
      <div class="fpr-note" style="margin:0">A finer screen with FluvialGeomorph can confirm conditions at the kept sites. Step 2 will match
      reconnection measures to each site.</div>
      <div class="fpr-actions">
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="sub" data-sub="shortlist">Back</button>
      </div>`
  }

  private reportContext(): ReportContext | null {
    if (!this.result) return null
    return {
      areaText: this.areaText(), dataVersion: this.version, criteria: this.criteria, criteriaText: this.criteriaText(),
      result: this.result, ranked: this.ranked, decisions: this.decisions, net: this.net, masks: this.masks, made: new Date(),
    }
  }

  private fileStem(): string {
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    let what = 'screening'
    if (this.mode === 'huc' && this.codes.size) what = this.codes.size === 1 ? [...this.codes][0] : `${this.codes.size}-huc12s`
    else if (this.mode === 'walk' && this.walkFrom) what = `upstream-${this.walkFrom.id}`
    return `floodplain-${what}-${day}`
  }

  private registerDownloads(): void {
    const need = (): ReportContext => {
      const ctx = this.reportContext()
      if (!ctx) throw new Error('choose a study area first')
      return ctx
    }
    registerDownload('fpr-dl-short-csv', { filename: () => `${this.fileStem()}-shortlist.csv`, mime: 'text/csv', build: () => shortlistCsv(need()) })
    registerDownload('fpr-dl-short-geojson', { filename: () => `${this.fileStem()}-shortlist.geojson`, mime: 'application/geo+json', build: () => shortlistGeojson(need()) })
    registerDownload('fpr-dl-reaches-csv', { filename: () => `${this.fileStem()}-reaches.csv`, mime: 'text/csv', build: () => reachesCsv(need()) })
    registerDownload('fpr-dl-print', { filename: () => `${this.fileStem()}-summary.html`, mime: 'text/html', inline: true, build: () => printable(need()) })
    const save = { filename: () => `${this.fileStem()}.fpr.json`, mime: 'application/json', build: () => {
      this.dirty = false
      return JSON.stringify(this.saved(), null, 2) + '\n'
    } }
    registerDownload('fpr-dl-save', save)
    registerDownload('fpr-nav-save', save)
  }

  // ---------------------------------------------------------------- details

  showReach(ref: Ref): void {
    const f = this.net.file(ref)
    const r = rowOf(ref)
    const site = this.siteOf.get(ref)
    const q = f.q[r]
    const hide = q >= Q_NODATA
    const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`
    const flags = flagTexts(f, r)
    const body = showModal(f.name[r] || 'Unnamed stream', `
      <p class="fpr-note" style="margin-top:0">Reach ${esc(reachId(f, r))} · HUC12 ${esc(huc12Text(f, r) || 'n/a')} · region ${esc(f.vpu[r])}</p>
      ${site !== undefined ? `<p>Part of candidate site <b>#${site + 1}</b>. <a href="#" data-site="${esc(this.ranked[site].id)}">Open the site</a></p>` : ''}
      <table class="fpr-tbl"><tbody>
        ${row('Quality', esc(QUALITY_LABEL[q]))}
        ${hide ? '' : row('Bank height ratio', `${esc(bhrText(f, r))} <span class="fpr-note">(${ratio(f.bhrLo[r] / 100)} to ${ratio(f.bhrHi[r] / 100)})</span>`)}
        ${hide ? '' : row('Entrenchment ratio', `${ratio(f.er[r] / 100)} <span class="fpr-note">(${ratio(f.erLo[r] / 100)} to ${ratio(f.erHi[r] / 100)})</span>`)}
        ${hide ? '' : row('Low-bank height', `${ft(f.lbh[r] / 100, 1)} ft`)}
        ${hide ? '' : row('Bankfull depth and width', `${ft(f.bfd[r] / 100, 1)} ft, ${ft(f.bfw[r] / 10)} ft`)}
        ${hide ? '' : row('Flood-prone width', `${ft(f.fpw[r] / 10)} ft`)}
        ${row('Drainage area', `${sqmi(f.da[r])} sq mi`)}
        ${row('Slope', esc(slopeText(f.slope[r])))}
        ${row('Length', `${ft(f.lenM[r])} ft`)}
        ${q === Q_UNSAMPLED ? '' : row('Cross-sections', `${f.nOk[r]} of ${f.n[r]} measured${f.res[r] ? `, ${f.res[r]} m elevation model` : ''}`)}
      </tbody></table>
      ${flags.length ? `<h5>Notes</h5><ul>${flags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div id="fpr-xs-slot"></div>`)
    body.querySelector<HTMLElement>('[data-site]')?.addEventListener('click', (e) => {
      e.preventDefault()
      const id = (e.currentTarget as HTMLElement).dataset.site!
      closeModal()
      this.showSite(id)
    })
    void this.fillProfile(body.querySelector('#fpr-xs-slot'), f, r)
  }

  private async fillProfile(slot: Element | null, f: UnitFile, r: number): Promise<void> {
    if (!slot) return
    const id = f.profId[r]
    if (!Number.isFinite(id)) {
      slot.innerHTML = f.q[r] === Q_UNSAMPLED ? '' : '<p class="fpr-note">No stored cross-section for this reach. The national grid stores one per stream line.</p>'
      return
    }
    slot.innerHTML = '<div class="fpr-busy"><span class="fpr-spinner"></span>Reading the stored cross-section</div>'
    try {
      const p = await storedProfile(this.staf, f.vpu[r], id)
      const svg = p ? profileSvg(p) : ''
      slot.innerHTML = svg
        ? `<h5>Stored cross-section</h5>${svg}<div class="fpr-xs-cap">The line's median cross-section from the national grid (section ${p!.k + 1}, ${p!.res} m elevation model). Heights above the bed.</div>`
        : '<p class="fpr-note">The stored cross-section is not in this copy of the data yet.</p>'
    } catch {
      slot.innerHTML = '<p class="fpr-note">The stored cross-section could not be read.</p>'
    }
  }

  showSite(id: string): void {
    const i = this.ranked.findIndex((s) => s.id === id)
    if (i < 0) return
    const s = this.ranked[i]
    this.selectSite(id, true)
    const d = this.decisions.get(id) ?? { keep: true, note: '' }
    const rows = s.refs.map((ref, j) => {
      const f = this.net.file(ref)
      const r = rowOf(ref)
      const hide = f.q[r] >= Q_NODATA
      return `<tr${s.pass[j] ? '' : ' class="sel"'}><td>${j + 1}</td><td>${esc(reachId(f, r))}</td><td class="num">${ft(f.lenM[r])}</td>
        <td class="num">${hide ? 'n/a' : esc(bhrText(f, r))}</td><td class="num">${hide ? 'n/a' : ratio(f.er[r] / 100)}</td>
        <td class="num">${hide ? 'n/a' : ft(f.lbh[r] / 100, 1)}</td><td class="num">${hide ? 'n/a' : ft(f.bfw[r] / 10)}</td>
        <td class="num">${hide ? 'n/a' : ft(f.fpw[r] / 10)}</td><td>${s.pass[j] ? (f.q[r] === Q_CAUTION ? '<span class="fpr-flag">caution</span>' : '') : 'gap'}</td></tr>`
    }).join('')
    const withProfile = s.refs.find((ref) => Number.isFinite(this.net.file(ref).profId[rowOf(ref)]))
    const body = showModal(`Site ${i + 1}. ${s.name || 'Unnamed stream'}`, `
      <p class="fpr-note" style="margin-top:0">Site ${esc(s.id)} · HUC12 ${esc(s.huc12 || 'n/a')} · ${s.refs.length} reaches</p>
      <table class="fpr-tbl" style="margin-bottom:10px"><tbody>
        <tr><th>Length</th><td>${ft(s.lengthM)} ft (${ft(s.passLengthM)} ft meet every criterion)</td></tr>
        <tr><th>Bank height ratio</th><td>${ratio(s.bhr)} median of reaches (${ratio(s.bhrLo)} to ${ratio(s.bhrHi)})${s.bhrAtCap ? `, ${s.bhrAtCap} read "at least 2.00"` : ''}</td></tr>
        <tr><th>Entrenchment ratio</th><td>${ratio(s.er)} (${ratio(s.erLo)} to ${ratio(s.erHi)})</td></tr>
        <tr><th>Low-bank height</th><td>${ft(s.lbhM, 1)} ft</td></tr>
        <tr><th>Bankfull and flood-prone width</th><td>${ft(s.bfwM)} ft and ${ft(s.fpwM)} ft</td></tr>
        <tr><th>Drainage area</th><td>${sqmi(s.daSqkm)} sq mi at the downstream end</td></tr>
        <tr><th>Slope</th><td>${esc(slopeText(s.slope))}</td></tr>
      </tbody></table>
      <div class="d-flex gap-3 align-items-center mb-2">
        <label class="d-flex gap-2 align-items-center mb-0"><input type="checkbox" class="form-check-input mt-0" id="fpr-site-keep"${d.keep ? ' checked' : ''}> Keep this site</label>
      </div>
      <label for="fpr-site-note" class="form-label mb-1">Note</label>
      <textarea id="fpr-site-note" class="form-control form-control-sm mb-3" rows="2" placeholder="Access, land use, constraints">${esc(d.note)}</textarea>
      <h5>Reaches, upstream to downstream</h5>
      <div class="fpr-tbl-wrap"><table class="fpr-tbl"><thead><tr><th>#</th><th>Reach</th><th class="num">Length (ft)</th><th class="num">BHR</th><th class="num">ER</th>
        <th class="num">Low bank (ft)</th><th class="num">Bankfull width (ft)</th><th class="num">Flood-prone width (ft)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div id="fpr-xs-slot"></div>`, { size: 'xl' })
    const keep = body.querySelector<HTMLInputElement>('#fpr-site-keep')!
    const note = body.querySelector<HTMLTextAreaElement>('#fpr-site-note')!
    const store = () => {
      this.decisions.set(id, { keep: keep.checked, note: note.value.trim() })
      this.touch()
      this.refreshPane()
    }
    keep.addEventListener('change', store)
    note.addEventListener('input', store)
    if (withProfile !== undefined) void this.fillProfile(body.querySelector('#fpr-xs-slot'), this.net.file(withProfile), rowOf(withProfile))
  }

  private showTable(): void {
    const head = ['#', 'Stream', 'Length (ft)', 'BHR', 'ER', 'Low bank (ft)', 'Drains (sq mi)', 'Cautions', 'Keep']
    const rows = this.ranked.map((s, i) => {
      const kept = this.decisions.get(s.id)?.keep !== false
      return `<tr data-id="${s.id}" style="cursor:pointer"><td class="num">${i + 1}</td><td>${esc(s.name || 'Unnamed stream')}<div class="fpr-note" style="margin:0">${esc(s.id)}</div></td>
        <td class="num">${ft(s.lengthM)}</td><td class="num">${ratio(s.bhr)}</td><td class="num">${ratio(s.er)}</td><td class="num">${ft(s.lbhM, 1)}</td>
        <td class="num">${sqmi(s.daSqkm)}</td><td class="num">${s.caution}</td><td>${kept ? 'yes' : 'no'}</td></tr>`
    }).join('')
    const body = showModal(`Candidate sites (${count(this.ranked.length)})`, `
      <p class="fpr-note" style="margin-top:0">Ranked by ${esc(SORTS.find((s) => s.key === this.sort)?.label.toLowerCase() ?? '')}. Click a row to open the site.</p>
      <div class="fpr-tbl-wrap"><table class="fpr-tbl"><thead><tr>${head.map((h, i) => `<th${i && i !== 1 && i !== 8 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`, { size: 'xl' })
    body.querySelectorAll<HTMLElement>('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => {
      closeModal()
      this.showSite(tr.dataset.id!)
    }))
  }

  // ---------------------------------------------------------------- header, save and open

  private wireHeader(): void {
    document.querySelectorAll<HTMLElement>('.fpr-step-btn').forEach((b) => b.addEventListener('click', () => this.goStep(Number(b.dataset.step))))
    const menuBtn = byId('fpr-menu-btn')
    const header = byId('fpr-header')
    menuBtn.addEventListener('click', () => {
      const open = header.classList.toggle('menu-open')
      menuBtn.setAttribute('aria-expanded', String(open))
    })
    byId('fpr-nav-new').addEventListener('click', (e) => {
      e.preventDefault()
      if (this.dirty && !confirm('Start a new screening? Changes not saved are lost.')) return
      this.reset()
    })
    const file = byId<HTMLInputElement>('fpr-open-file')
    byId('fpr-nav-open').addEventListener('click', (e) => {
      e.preventDefault()
      if (this.dirty && !confirm('Open a saved screening? Changes not saved are lost.')) return
      file.value = ''
      file.click()
    })
    file.addEventListener('change', async () => {
      const f = file.files?.[0]
      if (!f) return
      try {
        await this.open(readSaved(await f.text()))
      } catch (err) {
        notify(`That file could not be opened: ${err instanceof Error ? err.message : String(err)}`, { type: 'error', seconds: 10 })
      }
    })
    byId('fpr-nav-about').addEventListener('click', (e) => {
      e.preventDefault()
      showAbout(this.idx, this.version)
    })
    byId('fpr-nav-help').addEventListener('click', (e) => {
      e.preventDefault()
      showHelp()
    })
    document.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      if (t.closest('[data-open-methods]')) {
        e.preventDefault()
        showMethods(this.idx)
      }
      if (t.closest('a[href="#"]')) e.preventDefault()
    })
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty) e.preventDefault()
    })
  }

  private touch(): void {
    this.dirty = true
  }

  private reset(): void {
    this.clearArea()
    this.mode = 'huc'
    this.criteria = defaultCriteria()
    this.colorBy = 'bhr'
    this.sort = 'length'
    this.decisions.clear()
    this.showAll = false
    this.sub = 'area'
    this.dirty = false
    this.goStep(1)
    this.recompute()
    this.map.setView([START.lat, START.lon], START.zoom)
  }

  saved(): SavedScreening {
    const decisions: Record<string, Decision> = {}
    for (const [k, v] of this.decisions) if (!v.keep || v.note) decisions[k] = v
    return {
      format: 'fpr-screening', version: 1, app_version: APP_VERSION, data_version: this.version, saved_at: new Date().toISOString(),
      area: { mode: this.mode, codes: [...this.codes].sort(), walk: this.walkFrom, box: this.box },
      criteria: this.criteria, color_by: this.colorBy, sort: this.sort, sub: this.sub, decisions,
    }
  }

  async open(s: SavedScreening): Promise<void> {
    this.reset()
    this.mode = s.area.mode
    this.criteria = { ...defaultCriteria(), ...s.criteria }
    this.colorBy = (['bhr', 'er', 'match'].includes(s.color_by) ? s.color_by : 'bhr') as ColorBy
    this.sort = (SORTS.some((x) => x.key === s.sort) ? s.sort : 'length') as SortKey
    for (const [k, v] of Object.entries(s.decisions ?? {})) this.decisions.set(k, { keep: v.keep !== false, note: String(v.note ?? '') })
    this.renderPane()
    if (this.mode === 'huc') {
      for (const c of s.area.codes ?? []) this.codes.add(c)
      this.lastPick = [...this.codes][0] ?? null
      this.restylePicks()
      await this.ensureFiles(hucFiles([...this.codes]))
    } else if (this.mode === 'walk' && s.area.walk && this.idx) {
      this.walkFrom = s.area.walk
      await this.ensureFiles([s.area.walk.huc8])
      await this.expandWalk(s.area.walk.id)
      this.setPin(this.findReach(s.area.walk.id))
    } else if (this.mode === 'box' && s.area.box && this.idx) {
      this.box = s.area.box
      const [w, so, e, n] = s.area.box
      this.boxLayer = L.rectangle([[so, w], [n, e]], { pane: PANES.marks, color: '#c2410c', weight: 2, fill: false }).addTo(this.map)
      await this.ensureFiles(huc8sInBox(this.idx, w, so, e, n).slice(0, AREA_FILES))
    }
    this.recompute()
    this.fitArea()
    const sub = (['area', 'screen', 'shortlist', 'report'].includes(s.sub) ? s.sub : 'screen') as Sub
    this.goSub(this.result ? sub : 'area')
    this.dirty = false
    if (s.data_version !== this.version) {
      notify(`This screening was saved with data version ${s.data_version}. The data are now ${this.version}, so the numbers may differ.`, { type: 'warning', seconds: 12 })
    } else notify('Screening opened.', { seconds: 4 })
  }

  // ---------------------------------------------------------------- the cue over the map

  private updateCue(): void {
    let text = ''
    const z = this.map.getZoom()
    if (this.step === 1 && this.sub === 'area') {
      if (this.mode === 'huc' && z < PICK_ZOOM) text = 'Zoom in to pick watersheds.'
      else if (this.mode === 'walk' && z < VIEW_ZOOM) text = 'Zoom in until streams show, then click one.'
      else if (this.mode === 'walk' && !this.walkFrom) text = 'Click a stream. Everything upstream becomes the study area.'
      else if (this.mode === 'box') text = this.corner ? 'Click the opposite corner.' : this.box ? '' : 'Click the first corner of the box.'
    } else if (!this.result && z < VIEW_ZOOM && this.idx) text = 'Zoom in to see reaches.'
    this.cue.innerHTML = text ? `<div class="fpr-cue">${esc(text)}</div>` : ''
  }

  private nudgeCue(): void {
    const c = this.cue.querySelector('.fpr-cue')
    if (!c) return
    c.classList.remove('is-nudged')
    void (c as HTMLElement).offsetWidth
    c.classList.add('is-nudged')
  }
}
