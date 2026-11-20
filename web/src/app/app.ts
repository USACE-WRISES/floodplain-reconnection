// The app: the header's four steps, Step 1's four sub-steps in the workflow pane (Study area,
// Screen, Shortlist, Report), the map's reaches and outlines, and the downloads. State lives here;
// the screening itself is screen/screen.ts and the network screen/model.ts.
import L from 'leaflet'
import { dataVersion, fprIndex, huc8sInBox, type FprIndex } from '../data/index'
import { DataSource } from '../data/source'
import { storedProfile } from '../data/staf'
import { huc12Text, latOf, loadUnits, lonOf, mercX, mercY, Q_CAUTION, Q_NODATA, Q_UNSAMPLED, reachId, WHY, type UnitFile } from '../data/units'
import { BoxSelect } from '../map/boxSelect'
import { makeMap, outlineRenderer, PANES, START, type AppMap } from '../map/map'
import { AT_CAP, binColor, binOf, BINS, MATCH, NO_DATA, RAMPS, rampColor, rampGradient, type RampSpec } from '../map/ramp'
import { UnitLayer, type LineStyle } from '../map/unitLayer'
import { Edits } from '../screen/edits'
import { bhrText, count, flagTexts, ft, mi, QUALITY_LABEL, ratio, slopeText, sqmi } from '../screen/format'
import { chipsOf, toggleUnit, unitOf, type Chip, type PickSize } from '../screen/hucs'
import { fileOf, hucFiles, hucMask, Network, refMask, refOf, rowOf, type Ref } from '../screen/model'
import { addBox, pickedFiles, picksFromBox, resolvePicks, savedPicks, togglePick, type Picks } from '../screen/picks'
import { defaultCriteria, presetOf, rankSites, screen, SORTS, STAGE, type Criteria, type ScreenResult, type Site, type SortKey } from '../screen/screen'
import { APP_VERSION } from '../version'
import { plannedPane, showAbout, showHelp, showMethods } from './dialogs'
import { registerDownload } from './download'
import { printable, readSaved, reachesCsv, shortlistCsv, shortlistGeojson, type Decision, type ReportContext, type SavedScreening } from './exports'
import { byId, esc } from './html'
import { closeModal, showModal } from './modal'
import { notify } from './notify'
import { wireSearch } from './search'
import { profileSvg } from './xscard'
import { ReachExplorer } from './xsexplorer'

type Sub = 'area' | 'screen' | 'shortlist' | 'report'
/** The study area: picked watersheds, everything upstream of a reach, or the reaches picked one by one
 * or a box at a time (the owner, 2026-11-19: Reaches took the place of a single drawn box). */
type Mode = 'huc' | 'walk' | 'reach'
type ColorBy = 'bhr' | 'er' | 'match'

const MODES: { key: Mode, label: string, hint: string }[] = [
  { key: 'huc', label: 'Watersheds', hint: 'Click watersheds on the map to add or remove them.' },
  { key: 'walk', label: 'Upstream', hint: 'Click a stream to screen everything upstream of it.' },
  { key: 'reach', label: 'Reaches', hint: 'Click reaches to add or remove them. Hold Shift and drag to add a box of them.' },
]

/** Watersheds by size (the owner, 2026-11-20: a switch, in place of the add-a-whole-HUC10 and -HUC8
 * buttons): what a click on the map picks, and the one line on it. */
const PICK_SIZES: PickSize[] = [12, 10, 8]
const HUC_HINT: Record<PickSize, string> = {
  12: 'Click watersheds on the map to add or remove them.',
  10: 'Click the map to add or remove a whole HUC10.',
  8: 'Click the map to add or remove a whole HUC8.',
}

const SUBS: { key: Sub, label: string }[] = [
  { key: 'area', label: 'Study area' },
  { key: 'screen', label: 'Screen' },
  { key: 'shortlist', label: 'Shortlist' },
  { key: 'report', label: 'Report' },
]

/** The legend's switch: what the map's colors show. */
const COLORINGS: { key: ColorBy, label: string, title: string }[] = [
  { key: 'bhr', label: 'BHR', title: 'Bank height ratio' },
  { key: 'er', label: 'ER', title: 'Entrenchment ratio' },
  { key: 'match', label: 'Sites', title: 'Candidate sites and the criteria' },
]

/** The criteria under More settings (the Screen step's other three show at all times). */
const MORE_KEYS = ['minSiteFt', 'gapReaches', 'daMaxSqmi', 'includeCaution', 'countCapped', 'skipCanals'] as const

/** Reaches show for the view from this zoom (the files the view meets load by themselves). */
const VIEW_ZOOM = 11
/** A study area's reaches show from this zoom, wider, so the whole area can be seen (reaches are
 * pointed at from here too: unitLayer.ts MIN_HIT_ZOOM). */
const AREA_ZOOM = 8
/** The most HUC8 files a view loads by itself, and a study area may hold. */
const VIEW_FILES = 4
const AREA_FILES = 12
/** HUC12 outlines show from this zoom. */
const PICK_ZOOM = 9

export class App {
  readonly src: DataSource
  readonly staf: DataSource
  idx: FprIndex | null = null
  version = 'unknown'
  readonly net = new Network()
  /** the user's cross-section edits (screen/edits.ts): patched into each file as it loads */
  readonly edits = new Edits()
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
  /** what a click on a watershed picks: the HUC12, or its whole HUC10 or HUC8 (a view setting, not saved) */
  pickSize: PickSize = 12
  walkFrom: { huc8: string, id: string } | null = null
  /** picked reaches (the Reaches study area) */
  picks: Picks = new Map()
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
  /** the Screen step's More settings shown (kept across redraws) */
  moreOpen = false
  dirty = false
  private siteOf = new Map<Ref, number>()
  private loading = new Map<string, Promise<void>>()
  private busy = 0
  private huc12Layers = new Map<string, L.GeoJSON>()
  private huc12Loading = new Map<string, Promise<L.GeoJSON | null>>()
  private huc12Names = new Map<string, string>()
  /** every HUC12 of each HUC4 whose outlines are loaded (the units a click picks, and the chips) */
  private huc12Codes = new Map<string, string[]>()
  /** The watershed under the pointer while picking: its outline drawn stronger, its name in the cue. */
  private hucHover: string | null = null
  private hucHoverLayer: L.Path | null = null
  private coverageLayer: L.GeoJSON | null = null
  /** One canvas for every outline (a canvas takes the pointer for the shapes it draws only) */
  private readonly outlines = outlineRenderer()
  private styleTable: LineStyle[] = []
  private styleIds = new Map<string, number>()
  private hoverFrame = 0
  /** The reach the card shows (undefined: rebuild it at the next move, as after a new screen). */
  private hoverRef: Ref | null | undefined = null
  private hoverSize: [number, number] = [0, 0]
  /** Shift and drag on the map adds a box of reaches (on in the Reaches study area only) */
  private readonly boxSelect: BoxSelect
  /** boxes are added one after another (each waits for its files), so two quick ones never pass the
   * file limit together */
  private boxJob: Promise<void> = Promise.resolve()
  /** counts every clearing of the study area: a box whose files were still loading then is dropped */
  private areaGen = 0
  /** Where the map sits (viewport px) and its offset in the page's shell, measured on resize. */
  private layout = { mapLeft: 0, mapTop: 0, dx: 0, dy: 0, w: 0, h: 0 }
  private recomputeFrame = 0
  /** the watershed outlines' update after a switch of the study-area way, at the next frame */
  private picksFrame = 0
  private inputTimer = 0

  constructor(params: URLSearchParams, dataBase: string, stafBase: string) {
    const cache = params.get('cache') !== '0'
    this.src = new DataSource(dataBase, { cache, cacheName: 'fpr-data-1' })
    this.staf = new DataSource(stafBase, { cache, cacheName: 'fpr-staf-1' })
    this.src.onBusy = (ms) => notify(`The data host is busy. Trying again in ${Math.round(ms / 1000)} s.`, { type: 'warning', id: 'busy', seconds: 6 })
    this.m = makeMap(byId('fpr-map'))
    this.map = this.m.map
    this.units = new UnitLayer(this.map, this.net, PANES.units, PANES.highlight)
    // a box belongs to the study area it was drawn on: a Clear or an Open since drops it
    this.boxSelect = new BoxSelect(this.map, PANES.marks, (b) => {
      const gen = this.areaGen
      this.boxJob = this.boxJob.then(() => this.pickBox(b, gen))
    }, () => {
      if (this.boxSelect.drawing) this.hideHover()
      this.updateCue()
    })
    this.buildStyles()
  }

  // ---------------------------------------------------------------- start

  async start(): Promise<void> {
    this.wireHeader()
    this.wireMap()
    this.wireLegend()
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
        // no name on hover (the owner, 2026-11-19: a watershed's name, mostly a river's, read as a
        // river's card while no river was drawn yet); the legend and the cue say where reaches are built
        // and to zoom in, and a click on a watershed zooms to it
        onEachFeature: (_feat, layer) => {
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

  /** The coverage's look by zoom: a soft tint where reaches are built at the national view (no lines,
   * so the map stays clean), outlines from zoom 7, and outlines only once reaches show. */
  private coverageBand(): number {
    const z = this.map.getZoom()
    return z < 7 ? 0 : z < PICK_ZOOM ? 1 : 2
  }

  private coverageStyle(code: string): L.PathOptions {
    const info = this.idx?.huc8[code]
    const band = this.coverageBand()
    // fill stays on (at no opacity where nothing shows) so a click inside a watershed still zooms to it
    if (!info) {
      return band === 0 ? { stroke: false, fill: true, fillOpacity: 0 }
        : { color: '#8a94a6', weight: band === 1 ? 0.5 : 0.4, opacity: 0.5, dashArray: '3 3', fill: true, fillOpacity: 0 }
    }
    const built = info.status === 'built'
    const color = built ? '#2f4b7c' : '#b7791f'
    const fillColor = built ? '#2f4b7c' : '#e9c46a'
    if (band === 0) return { stroke: false, fill: true, fillColor, fillOpacity: built ? 0.16 : 0.28 }
    if (band === 1) return { stroke: true, color, weight: 0.8, opacity: 0.6, fill: true, fillColor, fillOpacity: built ? 0.1 : 0.18 }
    return { stroke: true, color, weight: 0.8, opacity: 0.5, fill: true, fillColor, fillOpacity: 0 }
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
          const gone = this.edits.applyFile(f)
          if (gone.length) {
            notify(`Cross-section edits on ${gone.length} reach${gone.length === 1 ? '' : 'es'} of HUC8 ${h} were dropped: the data no longer hold ${gone.length === 1 ? 'that reach' : 'those reaches'} as saved.`,
              { type: 'warning', seconds: 12 })
          }
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
    return (this.mode === 'huc' && this.codes.size > 0) || (this.mode === 'walk' && this.walkFrom !== null) || (this.mode === 'reach' && this.picks.size > 0)
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
    if (this.mode === 'reach') return refMask(this.net, this.picks.values())
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
    add('nod', { color: NO_DATA, width: 1.4, z: 3 })
    // the colored reaches are strong (a white edge, wider zoomed in: unitLayer.ts); the grays recede
    for (let b = 0; b < BINS; b++) {
      add(`s${b}`, { color: binColor(b), width: 2.6, z: 6, strong: true })
      add(`d${b}`, { color: binColor(b), width: 2.4, dash: [5, 4], z: 5, strong: true })
    }
    add('cap', { color: AT_CAP, width: 2.6, z: 6, strong: true })
    add('capd', { color: AT_CAP, width: 2.4, dash: [5, 4], z: 5, strong: true })
    add('m-site', { color: MATCH.site, width: 3.4, z: 9, strong: true })
    add('m-other', { color: MATCH.other, width: 1.8, z: 4 })
    this.styleTable = t
    this.styleIds = ids
  }

  /** Which reaches the map draws at its zoom: 2 all (from VIEW_ZOOM, where they load), 1 the study
   * area's only (from AREA_ZOOM), 0 none. */
  private reachBand(): number {
    const z = this.map.getZoom()
    return z >= VIEW_ZOOM ? 2 : z >= AREA_ZOOM ? 1 : 0
  }

  private restyle(): void {
    const id = (k: string) => this.styleIds.get(k)!
    const area = this.result !== null
    const by: ColorBy = this.colorBy === 'match' && !area ? 'bhr' : this.colorBy
    const spec = RAMPS[by === 'er' ? 'er' : 'bhr']
    // a reach shows only where it can be seen (the owner, 2026-11-19: lines kept on a map zoomed back
    // out read as a blot); one with no style is neither drawn nor pointed at
    const band = this.reachBand()
    const ids = this.net.files.map((f, fi) => {
      const out = new Uint16Array(f.rows)
      const mask = this.masks[fi]
      for (let r = 0; r < f.rows; r++) {
        if (band < (area && mask?.[r] ? 1 : 2)) continue
        if (area && !mask?.[r]) {
          out[r] = id('out')
          continue
        }
        if (by === 'match') {
          // two kinds only (the owner, 2026-11-20): in a candidate site, a gap it bridges included (its
          // card says it is one), or not; a reach that meets the criteria in a run shorter than the
          // shortest site is not in a site (its card says so too)
          out[r] = this.siteOf.has(refOf(fi, r)) ? id('m-site') : id('m-other')
          continue
        }
        const q = f.q[r]
        // too little data or not sampled: one gray (the owner, 2026-11-20)
        if (q === Q_NODATA || q === Q_UNSAMPLED) {
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
    // the card's text (its site number) is rebuilt at the next move
    if (this.hoverRef !== null) this.hoverRef = undefined
  }

  private renderLegend(): void {
    const area = this.result !== null
    const by: ColorBy = this.colorBy === 'match' && !area ? 'bhr' : this.colorBy
    // the switch is made once and then only marked, so a keyboard user's focus stays on it
    let key = this.m.legend.querySelector<HTMLElement>('.fpr-legend-key')
    if (!key) {
      // "Color by" says what the buttons do (the owner, 2026-11-20)
      this.m.legend.innerHTML = `<div class="fpr-legend-by" id="fpr-legend-by">Color by</div>
        <div class="fpr-legend-switch" role="group" aria-labelledby="fpr-legend-by">${COLORINGS.map((c) =>
        `<button type="button" data-by="${c.key}" title="${esc(c.title)}">${esc(c.label)}</button>`).join('')}</div>
        <div class="fpr-legend-key"></div>`
      key = this.m.legend.querySelector<HTMLElement>('.fpr-legend-key')!
    }
    this.m.legend.querySelectorAll<HTMLButtonElement>('.fpr-legend-switch button').forEach((b) => {
      const on = b.dataset.by === by
      b.classList.toggle('on', on)
      b.setAttribute('aria-pressed', String(on))
      b.disabled = b.dataset.by === 'match' && !area
      b.title = b.disabled ? 'Candidate sites: choose a study area first' : COLORINGS.find((c) => c.key === b.dataset.by)!.title
    })
    const sw = (color: string, label: string, kind = '') => `<div class="fpr-legend-row"><span class="fpr-legend-sw ${kind}" style="--sw:${color}"></span><span>${esc(label)}</span></div>`
    let html: string
    if (by === 'match') {
      html = `<div class="fpr-legend-title">Candidate sites</div>
        ${sw(MATCH.site, 'Candidate site')}
        ${sw(MATCH.other, 'Not a site')}`
    } else {
      const spec: RampSpec = RAMPS[by]
      html = `<div class="fpr-legend-title">${esc(spec.title)}</div>
        <div class="fpr-legend-ramp" style="background:${rampGradient(spec)}"></div>
        <div class="fpr-legend-ends"><span>${esc(spec.loLabel)}</span><span>${esc(spec.hiLabel)}</span></div>
        ${by === 'bhr' ? sw(AT_CAP, 'At least 2.00 (method cap)') : ''}
        <div class="fpr-legend-sep"></div>
        ${sw(rampColor(0.5), 'Use with caution', 'dash')}
        ${sw(NO_DATA, 'No data')}`
    }
    if (area) html += `<div class="fpr-legend-sep"></div>${sw('#7d8ba1', 'Outside the study area')}`
    // where no reach is drawn at this zoom, the coverage shading is what the map shows
    if (!this.net.files.length || this.reachBand() < (area ? 1 : 2)) {
      const tint = (fill: string, label: string) => `<div class="fpr-legend-row"><span class="fpr-legend-sw box" style="--sw:${fill};background:${fill}40"></span><span>${esc(label)}</span></div>`
      html += `<div class="fpr-legend-sep"></div>${tint('#2f4b7c', 'Reaches built')}${tint('#e9c46a', 'Partly built')}
        <div class="fpr-legend-row" style="color:#646f80">Zoom in to see reaches.</div>`
    }
    key.innerHTML = html
  }

  // ---------------------------------------------------------------- the map's events

  private wireMap(): void {
    let band = this.coverageBand()
    let reaches = this.reachBand()
    this.map.on('moveend', () => {
      this.autoLoad()
      this.updatePicks()
      this.updateCue()
      const now = this.coverageBand()
      if (this.coverageLayer && now !== band) this.coverageLayer.setStyle((feat) => this.coverageStyle(String(feat?.properties?.huc8 ?? '')))
      band = now
      // past a zoom where reaches show or hide, the map draws them again
      const shown = this.reachBand()
      if (shown !== reaches) this.restyle()
      reaches = shown
    })
    // The pointer, straight from the map's element (Leaflet hands moves over a canvas on at most every
    // 32 ms): the latest move is handled once a frame, with positions from a cached layout, so a move
    // reads no layout and a hover repaints only the highlight canvas.
    const box = this.map.getContainer()
    const measure = () => {
      const shell = byId('fpr-shell').getBoundingClientRect()
      const map = box.getBoundingClientRect()
      this.layout = { mapLeft: map.left, mapTop: map.top, dx: map.left - shell.left, dy: map.top - shell.top, w: shell.width, h: shell.height }
    }
    measure()
    window.addEventListener('resize', measure)
    this.map.on('resize', measure)
    let last: { x: number, y: number, over: EventTarget | null } | null = null
    const frame = () => {
      if (this.hoverFrame) return
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = 0
        if (!last) return
        // over the legend, the Layers control or the zoom buttons: no reach card under them
        if (last.over instanceof Element && last.over.closest('.leaflet-control')) this.hideHover()
        else this.onPointer(last.x - this.layout.mapLeft, last.y - this.layout.mapTop)
      })
    }
    box.addEventListener('pointermove', (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY, over: ev.target }
      frame()
    }, { passive: true })
    box.addEventListener('pointerleave', () => {
      last = null
      this.hideHover()
    })
    // after a pan or a zoom, a pointer that stood still may be over another reach
    this.map.on('moveend', frame)
    this.map.on('click', (e: L.LeafletMouseEvent) => this.onClick(e))
  }

  /** The pointer at a point of the map's element (CSS px), once a frame. */
  private onPointer(x: number, y: number): void {
    const map = this.map as L.Map & { _animatingZoom?: boolean }
    // (Leaflet's drag handler has moving(); its typings leave it out)
    // (a box being drawn shows no card either)
    if ((map.dragging as L.Handler & { moving(): boolean }).moving() || map._animatingZoom || this.boxSelect.drawing) {
      this.hideHover()
      return
    }
    const latlng = map.containerPointToLatLng([x, y])
    this.readout.textContent = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)} · zoom ${map.getZoom()}`
    const container = map.getContainer()
    const ref = this.units.hit(latlng)
    if (ref !== this.hoverRef) {
      // a new reach (or none): the highlight, the cursor and the card's text, then its size, once
      this.hoverRef = ref
      this.units.setHover(ref)
      container.classList.toggle('fpr-pick', ref !== null)
      if (ref === null) {
        this.hover.hidden = true
        return
      }
      this.hover.innerHTML = this.hoverHtml(ref)
      this.hover.hidden = false
      this.hoverSize = [this.hover.offsetWidth, this.hover.offsetHeight]
    }
    if (ref === null) return
    const { dx, dy, w, h } = this.layout
    const left = Math.max(8, Math.min(x + dx + 16, w - this.hoverSize[0] - 8))
    const top = Math.max(56, Math.min(y + dy + 16, h - this.hoverSize[1] - 8))
    this.hover.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
  }

  private hideHover(): void {
    if (this.hoverRef === null && this.hover.hidden) return
    this.hoverRef = null
    this.hover.hidden = true
    this.units.setHover(null)
    this.map.getContainer().classList.remove('fpr-pick')
  }

  /** The card's text for a reach. */
  private hoverHtml(ref: Ref): string {
    const f = this.net.file(ref)
    const r = rowOf(ref)
    const site = this.siteOf.get(ref)
    const q = f.q[r]
    const values = q >= Q_NODATA ? `<div>${esc(QUALITY_LABEL[q])}</div>` : `
      <div>Bank height ratio <b>${esc(bhrText(f, r))}</b></div>
      <div>Entrenchment ratio <b>${ratio(f.er[r] / 100)}</b></div>
      <div>Low-bank height <b>${ft(f.lbh[r] / 100, 1)} ft</b></div>
      ${q === Q_CAUTION ? '<div class="f">Use with caution</div>' : ''}`
    return `<div class="t">${esc(f.name[r] || 'Unnamed stream')}</div>
      ${values}
      <div>Drains <b>${sqmi(f.da[r])} sq mi</b>, ${ft(f.lenM[r])} ft long</div>
      ${f.edited[r] ? `<div class="f">Screened on your edits of ${f.edited[r]} cross-section${f.edited[r] === 1 ? '' : 's'}</div>` : ''}
      ${site !== undefined ? `<div>Candidate site <b>#${site + 1}</b>${this.isGap(ref) ? ', as a gap' : ''}</div>` : this.inShortRun(ref) ? `<div>${esc(this.shortRunText())}</div>` : ''}`
  }

  /** A reach in a candidate site that misses a criterion: a gap the site bridges. The map draws it as
   * part of its site, so its card and popup say what it is. */
  private isGap(ref: Ref): boolean {
    return this.siteOf.get(ref) !== undefined && this.result?.stage[fileOf(ref)]?.[rowOf(ref)] !== STAGE.pass
  }

  /** A reach that meets every criterion but in a run shorter than the shortest site (not in a site,
   * so the map does not color it). */
  private inShortRun(ref: Ref): boolean {
    return this.siteOf.get(ref) === undefined && this.result?.stage[fileOf(ref)]?.[rowOf(ref)] === STAGE.pass
  }

  private shortRunText(): string {
    return `Meets the criteria, in a run shorter than ${count(this.criteria.minSiteFt)} ft`
  }

  private onClick(e: L.LeafletMouseEvent): void {
    if (this.step !== 1) return
    const ref = this.units.hit(e.latlng)
    if (this.sub === 'area' && this.mode === 'walk') {
      if (ref === null) {
        this.nudgeCue()
        return
      }
      void this.setWalk(ref)
      return
    }
    if (this.sub === 'area' && this.mode === 'reach') {
      if (ref === null) this.nudgeCue()
      else this.pickReach(ref)
      return
    }
    if (this.sub === 'area' && this.mode === 'huc') return   // the HUC12 outlines take the click
    if (ref !== null) this.showReach(ref)
  }

  /** A click in the Reaches study area: the reach joins the picks, or leaves them. */
  private pickReach(ref: Ref): void {
    const f = this.net.file(ref)
    const files = pickedFiles(this.net, this.picks)
    if (!this.picks.has(reachId(f, rowOf(ref))) && !files.includes(f.huc8) && files.length >= AREA_FILES) {
      notify(`A study area holds reaches from up to ${AREA_FILES} HUC8 watersheds.`, { type: 'warning', seconds: 6 })
      return
    }
    if (togglePick(this.net, this.picks, ref) === 'not sampled') {
      notify('That line was not sampled, so it has no values to screen.', { seconds: 4 })
      return
    }
    this.touch()
    this.recompute()
  }

  /** A box drawn with Shift held: every reach whose line runs through it joins the picks, once the
   * files the box meets have loaded (the picks span AREA_FILES files at most, as any study area). */
  private async pickBox(b: L.LatLngBounds, gen: number): Promise<void> {
    if (!this.idx || this.mode !== 'reach' || gen !== this.areaGen) return
    const [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    const files = huc8sInBox(this.idx, w, s, e, n)
    if (new Set([...pickedFiles(this.net, this.picks), ...files]).size > AREA_FILES) {
      notify(`A study area holds reaches from up to ${AREA_FILES} HUC8 watersheds. Draw a smaller box.`, { type: 'warning', seconds: 8 })
      return
    }
    await this.ensureFiles(files)
    // not if the user has moved on, cleared the area, or opened another screening while the files loaded
    if (gen !== this.areaGen || this.step !== 1 || this.sub !== 'area' || this.mode !== 'reach') return
    if (!addBox(this.net, this.picks, mercX(w), mercY(n), mercX(e), mercY(s))) {
      notify('No new reaches with values in that box.', { seconds: 4 })
      return
    }
    this.touch()
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
    // Shift and drag adds reaches only in the Reaches study area (elsewhere it zooms to a box, as Leaflet's)
    this.boxSelect.enable(this.step === 1 && this.sub === 'area' && this.mode === 'reach')
    if (!this.pickingOn()) {
      this.m.picks.clearLayers()
      this.setHucHover(null, null)
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
          const codes: string[] = []
          const opts: L.GeoJSONOptions & L.PathOptions = {
            renderer: this.outlines,
            pane: PANES.outlines,
                style: (feat) => this.huc12Style(String(feat?.properties?.huc12 ?? '')),
            onEachFeature: (feat, l) => {
              const code = String(feat.properties?.huc12 ?? '')
              codes.push(code)
              this.huc12Names.set(code, String(feat.properties?.name ?? ''))
              // the name goes in the cue, not by the pointer: zoomed in, the pointer is always inside one
              // watershed, and a label there sat beside the reach card wherever the pointer went
              l.on('mouseover', () => this.setHucHover(code, l as L.Path))
              l.on('mouseout', () => {
                if (this.hucHover === code) this.setHucHover(null, null)
              })
              l.on('click', () => this.togglePick(code))
            },
          }
          const layer = L.geoJSON(data, opts)
          this.huc12Layers.set(huc4, layer)
          this.huc12Codes.set(huc4, codes)
          // the chips group a whole HUC10 or HUC8 once its outlines are here (a screening just opened)
          if (this.codes.size) this.refreshPane()
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
    const hover = this.inHoverUnit(code)
    // a whole HUC10 or HUC8 under the pointer is tinted; its inner borders stay as they are
    const unit = hover && this.pickSize !== 12
    return on
      ? { color: '#c2410c', weight: hover && !unit ? 3.5 : 2, opacity: 0.95, fill: true, fillColor: '#c2410c', fillOpacity: hover ? (unit ? 0.26 : 0.2) : 0.12 }
      : { color: '#2f4b7c', weight: hover ? (unit ? 1.2 : 2.5) : 0.9, opacity: hover ? 0.95 : 0.55, fill: true, fillColor: '#2f4b7c', fillOpacity: hover ? (unit ? 0.14 : 0.08) : 0.02 }
  }

  /** Whether watershed `code` is in the unit under the pointer (at the HUC12 size, the one under it). */
  private inHoverUnit(code: string): boolean {
    const h = this.hucHover
    if (h === null) return false
    return this.pickSize === 12 ? code === h : code.startsWith(h.slice(0, this.pickSize))
  }

  private setHucHover(code: string | null, layer: L.Path | null): void {
    if (code === this.hucHover) return
    const before = this.hucHoverLayer
    const beforeCode = this.hucHover
    this.hucHover = code
    this.hucHoverLayer = layer
    if (this.pickSize === 12) {
      if (before && beforeCode !== null) before.setStyle(this.huc12Style(beforeCode))
      if (layer && code !== null) {
        layer.setStyle(this.huc12Style(code))
        layer.bringToFront()
      }
    } else {
      // a whole HUC10 or HUC8: its watersheds are restyled when the pointer moves to another unit
      const was = beforeCode?.slice(0, this.pickSize) ?? null
      const now = code?.slice(0, this.pickSize) ?? null
      if (was !== now) {
        if (was !== null) this.restyleUnit(was)
        if (now !== null) this.restyleUnit(now)
      }
    }
    this.updateCue()
  }

  /** Restyles the HUC12s under a HUC10 or HUC8 code. */
  private restyleUnit(code: string): void {
    this.huc12Layers.get(code.slice(0, 4))?.eachLayer((l) => {
      const c = String((l as L.Polygon & { feature?: GeoJSON.Feature }).feature?.properties?.huc12 ?? '')
      if (c.startsWith(code)) (l as L.Path).setStyle(this.huc12Style(c))
    })
  }

  private restylePicks(): void {
    for (const layer of this.huc12Layers.values()) layer.setStyle((feat) => this.huc12Style(String(feat?.properties?.huc12 ?? '')))
  }

  /** A click on a watershed: the unit of the pick size under it (the HUC12, or its whole HUC10 or HUC8)
   * joins the study area, or leaves it when all of it is in already. */
  private togglePick(code: string): void {
    if (!this.pickingOn()) return
    toggleUnit(this.codes, this.unitCodes(code))
    this.afterPicks()
  }

  /** The HUC12s a click on watershed `code` picks at the pick size now. */
  private unitCodes(code: string): string[] {
    return unitOf(code, this.pickSize, this.huc12Codes.get(code.slice(0, 4)) ?? [])
  }

  /** Every HUC12 under a HUC8 or HUC10 code (null while its outlines are not loaded). */
  private hucsUnder(code: string): string[] | null {
    const all = this.huc12Codes.get(code.slice(0, 4))
    return all ? all.filter((c) => c.startsWith(code)) : null
  }

  /** The pick-size switch: the map's hover and cue follow, and the switch keeps the keyboard's focus. */
  private setPickSize(size: PickSize): void {
    if (size === this.pickSize) return
    this.pickSize = size
    this.restylePicks()
    this.updateCue()
    this.pane.querySelectorAll<HTMLButtonElement>('[data-act="size"]').forEach((b) => {
      const on = Number(b.dataset.size) === size
      b.classList.toggle('on', on)
      b.setAttribute('aria-pressed', String(on))
    })
    const hint = this.pane.querySelector('.fpr-mode-hint')
    if (hint) hint.textContent = HUC_HINT[size]
  }

  private afterPicks(): void {
    this.touch()
    this.restylePicks()
    this.recompute()
    // the cue says what a click on the watershed under the pointer does now
    this.updateCue()
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
    const bounds = L.latLngBounds([latOf(south), lonOf(west)], [latOf(north), lonOf(east)])
    // never wider than the study area's reaches show: an area too big to fit opens on its middle
    if (this.map.getBoundsZoom(bounds, false, L.point(430, 60)) < AREA_ZOOM) this.map.setView(bounds.getCenter(), AREA_ZOOM)
    else this.map.fitBounds(bounds, { paddingTopLeft: [400, 30], paddingBottomRight: [30, 30] })
  }

  private clearArea(): void {
    this.codes.clear()
    this.walkFrom = null
    this.picks.clear()
    this.areaGen++
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
      else if (a === 'size') this.setPickSize(Number(act.dataset.size) as PickSize)
      else if (a === 'clear') {
        this.clearArea()
        this.touch()
        this.recompute()
        this.renderPane()
      } else if (a === 'unpick') {
        // a chip's x: its HUC12, or every HUC12 of its whole HUC10 or HUC8
        for (const c of (act.dataset.codes ?? '').split(' ')) this.codes.delete(c)
        this.afterPicks()
      } else if (a === 'fit') this.fitArea()
      else if (a === 'reset-criteria') this.resetCriteria()
      else if (a === 'methods') showMethods(this.idx)
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
    // More settings stays as the user left it across redraws ('toggle' does not bubble)
    this.pane.addEventListener('toggle', (e) => {
      const t = e.target as HTMLElement
      if (t.id === 'fpr-more') this.moreOpen = (t as HTMLDetailsElement).open
    }, true)
  }

  /** The legend's switch: what the map's colors show. */
  private wireLegend(): void {
    this.m.legend.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-by]')
      if (!b || b.disabled || b.dataset.by === this.colorBy) return
      this.colorBy = b.dataset.by as ColorBy
      this.restyle()
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
    if (sub === 'shortlist' && this.colorBy !== 'match') {
      this.colorBy = 'match'
      this.restyle()
    }
    this.updatePicks()
    this.updateCue()
    this.renderPane()
  }

  /** Each way keeps its own area while the user switches between them, so a stray click never loses
   * hand-picked reaches; the study area is the chosen way's, and Clear empties them all. */
  private setMode(mode: Mode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.setPin(mode === 'walk' && this.walkFrom ? this.findReach(this.walkFrom.id) : null)
    this.touch()
    this.recompute()
    this.updateCue()
    this.renderPane()
    // the pane answers the click at once (the owner, 2026-11-20: a switch took about 2 s); the watershed
    // outlines, hundreds of polygons to project, come in or go out on the next frame, once however
    // quickly the ways are switched
    if (!this.picksFrame) {
      this.picksFrame = requestAnimationFrame(() => {
        this.picksFrame = 0
        this.updatePicks()
        this.updateCue()
      })
    }
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
    } else if (this.sub === 'screen') {
      // the boxes are never redrawn here: a box being typed in keeps its focus
      const set = (id: string, html: string) => {
        const e = this.pane.querySelector(`#${id}`)
        if (e) e.innerHTML = html
      }
      set('fpr-result', this.resultHtml())
      for (const row of this.leftCounts()) {
        const n = this.pane.querySelector<HTMLElement>(`#fpr-left-${row.key}`)
        if (n) {
          n.innerHTML = row.reaches === null ? '' : `${count(row.reaches)}<span class="visually-hidden"> reaches left</span>`
          n.title = row.reaches === null ? '' : `${count(row.reaches)} reach${row.reaches === 1 ? '' : 'es'}, ${mi(row.lengthM)} mi`
        }
        this.pane.querySelector(`#fpr-row-${row.key}`)?.classList.toggle('off', row.off)
      }
      set('fpr-hist-bhr', this.histogram('bhr'))
      set('fpr-hist-er', this.histogram('er'))
      const changed = this.moreChanged()
      set('fpr-more-n', changed ? `${changed} changed` : '')
      set('fpr-gap-unit', this.criteria.gapReaches === 1 ? 'reach' : 'reaches')
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

  /** Where to screen: the three choices, one line on how each works (the map's cue says when to zoom
   * in), what is picked, and the study area in one line. */
  private areaPane(): string {
    const hint = this.mode === 'huc' ? HUC_HINT[this.pickSize] : MODES.find((m) => m.key === this.mode)?.hint ?? ''
    return `
      <div class="fpr-search"><input id="fpr-search" class="form-control form-control-sm" type="search" placeholder="Find a place or lat, lon" autocomplete="off" aria-label="Find a place"><div id="fpr-search-menu" class="fpr-ac-menu" hidden role="listbox"></div></div>
      <div class="fpr-seg" role="tablist">${MODES.map((m) => `<button type="button" data-act="mode" data-mode="${m.key}" class="${m.key === this.mode ? 'on' : ''}">${esc(m.label)}</button>`).join('')}</div>
      ${this.mode === 'huc' ? `<div class="fpr-pick-size" role="group" aria-label="Pick watersheds by size">
        <span class="fpr-pick-size-l" aria-hidden="true">Pick</span>
        <div class="fpr-seg">${PICK_SIZES.map((s) => `<button type="button" data-act="size" data-size="${s}" class="${s === this.pickSize ? 'on' : ''}" aria-pressed="${s === this.pickSize}">HUC${s}</button>`).join('')}</div>
      </div>` : ''}
      <div class="fpr-note fpr-mode-hint">${esc(hint)}</div>
      ${this.mode === 'huc' ? '<div id="fpr-area-picks"></div>' : ''}
      <div id="fpr-area-summary"></div>
      <div class="fpr-actions fpr-sticky">
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="clear">Clear</button>
        <button type="button" class="btn btn-primary btn-sm" id="fpr-next-screen" data-act="sub" data-sub="screen">Next: screen</button>
      </div>`
  }

  /** The watersheds picked: one chip per whole HUC8 or HUC10, then one per HUC12 (nothing until one is
   * picked). A chip's x takes all of it out. */
  private picksHtml(): string {
    if (!this.codes.size) return ''
    const chips = chipsOf(this.codes, (c) => this.hucsUnder(c))
    const shown = chips.slice(0, 12)
    const more = chips.slice(12).reduce((n, c) => n + c.codes.length, 0)
    return `<div class="fpr-chips">${shown.map((c) => this.chipHtml(c)).join('')}</div>
      ${more ? `<div class="fpr-note">and ${count(more)} more HUC12 watershed${more === 1 ? '' : 's'}</div>` : ''}`
  }

  private chipHtml(c: Chip): string {
    const n = c.codes.length
    const label = c.size === 12 ? this.huc12Names.get(c.code) || c.code
      : c.size === 8 ? `${this.idx?.huc8[c.code]?.name || `HUC8 ${c.code}`} (${n})` : `HUC10 ${c.code} (${n})`
    const title = c.size === 12 ? `Remove HUC12 ${c.code}` : `Remove HUC${c.size} ${c.code}, ${n} HUC12 watersheds`
    return `<button type="button" class="fpr-chip on" data-act="unpick" data-codes="${c.codes.join(' ')}" title="${esc(title)}">${esc(label)} &times;</button>`
  }

  /** The study area's reaches with values to screen (lines not sampled left out) and their length. */
  private areaStats(): { reaches: number, m: number } {
    let reaches = 0
    let m = 0
    this.net.files.forEach((f, fi) => {
      const mask = this.masks[fi]
      if (!mask) return
      for (let r = 0; r < f.rows; r++) {
        if (!mask[r] || f.q[r] === Q_UNSAMPLED) continue
        reaches++
        m += f.lenM[r]
      }
    })
    return { reaches, m }
  }

  private areaText(): string {
    if (this.mode === 'huc' && this.codes.size) {
      // a whole HUC8 or HUC10 by its name or code, as the chips show it
      const n = this.codes.size
      const chips = chipsOf(this.codes, (c) => this.hucsUnder(c))
      const names = chips.slice(0, 4).map((c) => {
        if (c.size === 12) return `${this.huc12Names.get(c.code) || 'HUC12'} (${c.code})`
        const name = c.size === 8 ? this.idx?.huc8[c.code]?.name : ''
        return name ? `HUC8 ${name} (${c.code})` : `HUC${c.size} ${c.code}`
      })
      const rest = chips.length - names.length
      return `${count(n)} HUC12 watershed${n === 1 ? '' : 's'}: ${names.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`
    }
    if (this.mode === 'walk' && this.walkFrom) {
      const ref = this.findReach(this.walkFrom.id)
      const name = ref !== null ? this.net.file(ref).name[rowOf(ref)] : ''
      return `Everything upstream of ${name || 'an unnamed stream'}, reach ${this.walkFrom.id} (HUC8 ${this.walkFrom.huc8})`
    }
    if (this.mode === 'reach' && this.picks.size) {
      const n = this.picks.size
      const names = [...new Set([...this.picks.values()].map((ref) => this.net.file(ref).name[rowOf(ref)]).filter(Boolean))].sort()
      const more = names.length - 3
      const on = names.length ? ` on ${names.slice(0, 3).join(', ')}${more > 0 ? `, and ${more} more stream${more === 1 ? '' : 's'}` : ''}` : ''
      return `${count(n)} picked reach${n === 1 ? '' : 'es'}${on}`
    }
    return 'No study area'
  }

  /** The study area in one line, and what of it is not built yet. */
  private areaSummary(): string {
    if (!this.hasArea()) return ''
    const st = this.areaStats()
    const partial = this.areaHuc8s().filter((h) => this.idx?.huc8[h]?.status === 'partial')
    const missing = this.mode === 'huc' ? hucFiles([...this.codes]).filter((h) => !this.idx?.huc8[h]) : []
    return `<div class="fpr-area-line">
        <span><b>${count(st.reaches)}</b> reach${st.reaches === 1 ? '' : 'es'}, ${mi(st.m)} mi</span>
        <button type="button" class="btn btn-link btn-sm p-0" data-act="fit">Zoom to area</button>
      </div>
      ${partial.length ? '<div class="fpr-note warn">Part of this area is in grid regions not built yet.</div>' : ''}
      ${missing.length ? `<div class="fpr-note warn">No reaches are built yet for HUC8 ${missing.map(esc).join(', ')}.</div>` : ''}`
  }

  private areaHuc8s(): string[] {
    const out = new Set<string>()
    this.net.files.forEach((f, fi) => {
      if (this.masks[fi]?.some((v) => v === 1)) out.add(f.huc8)
    })
    return [...out]
  }

  // the Screen sub-step

  /** The result on top, the three criteria most teams set with the reaches each leaves, and the rest
   * under More settings. The numbers are filled in by refreshPane, so typing never redraws a box. */
  private screenPane(): string {
    const c = this.criteria
    const num = (key: keyof Criteria, v: number | null, step: string, min: string, placeholder: string, describedBy = '') =>
      `<input type="number" class="form-control" id="crit-${key}" data-crit="${key}" value="${v === null ? '' : v}" step="${step}" min="${min}" placeholder="${placeholder}"${describedBy ? ` aria-describedby="${describedBy}"` : ''}>`
    const box = (key: keyof Criteria, on: boolean) => `<input type="checkbox" class="form-check-input" data-crit="${key}" id="crit-${key}"${on ? ' checked' : ''}>`
    // an empty box turns its criterion off; the count beside it is what is left after it
    const row = (key: keyof Criteria, label: string, v: number | null, step: string, min: string, unit: string, left: 'da' | 'bhr' | 'er') =>
      `<div class="fpr-crit" id="fpr-row-${left}"><div class="fpr-crit-row">
        <label for="crit-${key}">${label}</label>${num(key, v, step, min, 'off', `fpr-left-${left}`)}<span class="fpr-unit">${unit}</span><b class="fpr-left" id="fpr-left-${left}"></b></div>
        ${left === 'da' ? '' : `<div id="fpr-hist-${left}"></div>`}</div>`
    const line = (inner: string) => `<div class="fpr-crit"><div class="fpr-crit-line">${inner}</div></div>`
    return `
      <div class="fpr-result" id="fpr-result" aria-live="polite"></div>
      <div class="fpr-group">Keep reaches with <small>reaches left</small></div>
      ${row('daMinSqmi', 'Drainage area at least', c.daMinSqmi, '0.5', '0', 'sq mi', 'da')}
      ${row('bhrMin', 'Bank height ratio at least', c.bhrMin, '0.05', '0', '', 'bhr')}
      ${row('erMin', 'Entrenchment ratio at least', c.erMin, '0.1', '1', '', 'er')}
      <details class="fpr-more" id="fpr-more"${this.moreOpen ? ' open' : ''}>
        <summary>More settings <span class="fpr-more-n" id="fpr-more-n"></span></summary>
        ${line(`<label for="crit-minSiteFt">Shortest site</label>${num('minSiteFt', c.minSiteFt, '100', '0', '0')}<span class="fpr-unit">ft</span>`)}
        ${line(`<label for="crit-gapReaches">Allow gaps of up to</label>${num('gapReaches', c.gapReaches, '1', '0', '0')}<span class="fpr-unit" id="fpr-gap-unit">reach</span>`)}
        ${line(`<label for="crit-daMaxSqmi">Drainage area at most</label>${num('daMaxSqmi', c.daMaxSqmi, '10', '0', 'none')}<span class="fpr-unit">sq mi</span>`)}
        ${line(`${box('includeCaution', c.includeCaution)}<label for="crit-includeCaution">Include reaches marked "use with caution"</label>`)}
        ${line(`${box('countCapped', c.countCapped)}<label for="crit-countCapped">Count reaches whose BHR reads "at least 2.00"</label>`)}
        ${line(`${box('skipCanals', c.skipCanals)}<label for="crit-skipCanals">Leave out canals and ditches</label>`)}
        <div class="fpr-more-links">
          <button type="button" class="btn btn-link btn-sm p-0" data-act="reset-criteria">Reset to starting values</button>
          <button type="button" class="btn btn-link btn-sm p-0" data-act="methods">Methods and limits</button>
        </div>
      </details>
      <div class="fpr-actions fpr-sticky">
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

  private resetCriteria(): void {
    this.criteria = defaultCriteria()
    this.touch()
    this.renderPane()
    this.recompute()
  }

  /** How many of the settings under More settings differ from the starting values. */
  private moreChanged(): number {
    const d = defaultCriteria()
    return MORE_KEYS.filter((k) => this.criteria[k] !== d[k]).length
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
    const H = 40
    const bw = (W - 4) / (nb + 1)
    const thr = which === 'bhr' ? this.criteria.bhrMin : this.criteria.erMin
    // a bar left out shows faint: below the minimum, or BHR's "at least 2.00" when those are not counted
    const capOut = which === 'bhr' && thr !== null && !this.criteria.countCapped
    const bars = bins.map((n, i) => {
      const v0 = lo + i * step
      const h = (n / max) * (H - 14)
      const color = i === nb && which === 'bhr' ? AT_CAP : binColor(binOf(spec, v0 + step / 2))
      const below = thr !== null && ((i < nb && v0 + step / 2 < thr) || (i === nb && capOut))
      return `<rect x="${(2 + i * bw).toFixed(1)}" y="${(H - 12 - h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="${below ? 0.3 : 0.95}"><title>${i === nb ? (which === 'bhr' ? 'at least 2.00' : `${hi.toFixed(1)} or more`) : `${v0.toFixed(1)} to ${(v0 + step).toFixed(1)}`}: ${n}</title></rect>`
    }).join('')
    const tx = thr === null ? null : 2 + Math.max(0, Math.min(nb, (thr - lo) / step)) * bw
    const line = tx === null ? '' : `<line x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="2" y2="${H - 12}" stroke="#111827" stroke-width="1.5" stroke-dasharray="3 2"/>`
    const labels = `<text x="2" y="${H - 1}" font-size="10" fill="#646f80">${lo.toFixed(1)}</text>
      <text x="${W - 2}" y="${H - 1}" font-size="10" fill="#646f80" text-anchor="end">${which === 'bhr' ? 'at least 2.00' : `${hi.toFixed(1)}+`}</text>`
    return `<svg class="fpr-hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title)} of the measured reaches">${bars}${line}${labels}</svg>`
  }

  /** The Screen step's result: the candidate sites, or why there are none. */
  private resultHtml(): string {
    if (!this.result) return '<div class="fpr-result-sub">Choose a study area first.</div>'
    const n = this.ranked.length
    if (!n) {
      const pass = this.result.pass
      const why = pass
        ? `${count(pass)} ${pass === 1 ? 'reach passes' : 'reaches pass'}, but none in a run of ${count(this.criteria.minSiteFt)} ft. Lower the shortest site under More settings.`
        : 'No reach meets every criterion. Lower a minimum or empty a box.'
      return `<div class="fpr-result-head"><span class="fpr-result-n">No candidate sites</span></div>
        <div class="fpr-result-sub">${esc(why)}</div>`
    }
    const measured = this.result.funnel.find((s) => s.key === 'measured')?.reaches ?? 0
    const total = this.ranked.reduce((a, s) => a + s.lengthM, 0)
    return `<div class="fpr-result-head"><span class="fpr-result-n">${count(n)} candidate site${n === 1 ? '' : 's'}</span><span class="fpr-result-mi">${mi(total)} mi</span></div>
      <div class="fpr-result-sub">from ${count(measured)} measured reach${measured === 1 ? '' : 'es'}</div>`
  }

  /** The reaches left after each criterion row, from the funnel (a criterion that is off narrows
   * nothing, so its row carries the count above it). */
  private leftCounts(): { key: 'da' | 'bhr' | 'er', reaches: number | null, lengthM: number, off: boolean }[] {
    const funnel = this.result?.funnel ?? []
    let before = funnel.find((s) => s.key === 'measured')
    return (['da', 'bhr', 'er'] as const).map((key) => {
      const s = funnel.find((x) => x.key === key)
      if (s) before = s
      return { key, reaches: before ? before.reaches : null, lengthM: before ? before.lengthM : 0, off: !s }
    })
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
    const edited = this.edits.size
    if (edited) out.push(`Cross-sections edited on ${count(edited)} reach${edited === 1 ? '' : 'es'}: each is screened on its edited sections`)
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
      result: this.result, ranked: this.ranked, decisions: this.decisions, net: this.net, masks: this.masks, edits: this.edits, made: new Date(),
    }
  }

  private fileStem(): string {
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    let what = 'screening'
    if (this.mode === 'huc' && this.codes.size) what = this.codes.size === 1 ? [...this.codes][0] : `${this.codes.size}-huc12s`
    else if (this.mode === 'walk' && this.walkFrom) what = `upstream-${this.walkFrom.id}`
    else if (this.mode === 'reach' && this.picks.size) what = `${this.picks.size}-reaches`
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

  /** The reach popup (the owner, 2026-11-20: cleaner, in two tabs): a summary, then the Cross-section
   * tab (xsexplorer.ts) and the Details tab (every section, the shown section's geometry, the reach's
   * facts). A line the grid did not sample has no cross-sections: its summary and facts, with no tabs. */
  showReach(ref: Ref): void {
    const f = this.net.file(ref)
    const r = rowOf(ref)
    let explorer: ReachExplorer | null = null
    const xs = f.q[r] !== Q_UNSAMPLED && f.n[r] > 0
    const body = showModal(f.name[r] || 'Unnamed stream', `
      <div class="fpr-reach-sum" data-reach-sum></div>
      ${xs ? `<div class="fpr-seg fpr-reach-tabs" role="tablist" aria-label="Reach">
        <button type="button" role="tab" data-reach-tab="xs" class="on" aria-selected="true">Cross-section</button>
        <button type="button" role="tab" data-reach-tab="details" aria-selected="false" tabindex="-1">Details</button>
      </div>
      <div role="tabpanel" data-reach-panel="xs"></div>` : ''}
      <div role="tabpanel" data-reach-panel="details"${xs ? ' hidden' : ''}>
        <div data-reach-sections></div>
        <div data-reach-facts></div>
      </div>`, { size: 'xl', onClose: () => explorer?.close() })
    const sum = body.querySelector<HTMLElement>('[data-reach-sum]')!
    const facts = body.querySelector<HTMLElement>('[data-reach-facts]')!
    const fill = () => {
      sum.innerHTML = this.reachSummary(f, r, ref)
      facts.innerHTML = this.reachFacts(f, r)
    }
    fill()
    const tab = (which: string) => {
      body.querySelectorAll<HTMLElement>('[data-reach-tab]').forEach((b) => {
        const on = b.dataset.reachTab === which
        b.classList.toggle('on', on)
        b.setAttribute('aria-selected', String(on))
        b.tabIndex = on ? 0 : -1
      })
      body.querySelectorAll<HTMLElement>('[data-reach-panel]').forEach((p) => {
        p.hidden = p.dataset.reachPanel !== which
      })
    }
    body.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const site = t.closest<HTMLElement>('[data-site]')
      if (site) {
        e.preventDefault()
        closeModal()
        this.showSite(site.dataset.site!)
        return
      }
      const b = t.closest<HTMLElement>('[data-reach-tab]')
      if (b) {
        tab(b.dataset.reachTab!)
        return
      }
      // a station in the Details tab's table: that section, in the Cross-section tab
      const go = t.closest<HTMLElement>('[data-reach-sections] [data-xsx-go]')
      if (go && explorer) {
        explorer.show(Number(go.dataset.xsxGo))
        tab('xs')
        return
      }
      if (t.closest('[data-reach-clear]')) {
        e.preventDefault()
        explorer?.clearReach()
      }
    })
    // the two tabs are one stop for the Tab key: the arrow keys switch them
    body.querySelector<HTMLElement>('.fpr-reach-tabs')?.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const next = body.querySelector<HTMLElement>('[data-reach-tab]:not(.on)')
      if (!next) return
      e.preventDefault()
      tab(next.dataset.reachTab!)
      next.focus()
    })
    if (!xs) return
    explorer = new ReachExplorer({
      staf: this.staf,
      edits: this.edits,
      changed: () => {
        this.touch()
        this.recompute()
        fill()
      },
    }, f, r, body.querySelector<HTMLElement>('[data-reach-panel="xs"]')!, body.querySelector<HTMLElement>('[data-reach-sections]')!)
    void explorer.start()
  }

  /** The reach popup's summary: the values it is screened on, its site, and the user's edits. */
  private reachSummary(f: UnitFile, r: number, ref: Ref): string {
    const q = f.q[r]
    const site = this.siteOf.get(ref)
    const vals = q >= Q_NODATA ? `<span>${esc(QUALITY_LABEL[q])}</span>`
      : `<span><abbr title="Bank height ratio">BHR</abbr> <b>${esc(bhrText(f, r))}</b></span>
        <span><abbr title="Entrenchment ratio">ER</abbr> <b>${ratio(f.er[r] / 100)}</b></span>
        ${q === Q_CAUTION ? '<span class="f">Use with caution</span>' : ''}`
    return `<div class="fpr-reach-vals">${vals}<span>Drains <b>${sqmi(f.da[r])} sq mi</b></span><span><b>${ft(f.lenM[r])} ft</b> long</span></div>
      ${site !== undefined ? `<p>In candidate site <b>#${site + 1}</b>${this.isGap(ref) ? ', as a gap' : ''}. <a href="#" data-site="${esc(this.ranked[site].id)}">Open the site</a></p>`
        : this.inShortRun(ref) ? `<p>${esc(this.shortRunText())}, so it is not a candidate site.</p>` : ''}
      ${f.edited[r] ? `<p>Screened on your edits (${f.edited[r]} of ${f.n[r]} sections). <a href="#" data-reach-clear>Clear my edits</a></p>` : ''}`
  }

  /** The reach popup's facts: the values it is screened on (the user's where edited) and the notes. */
  private reachFacts(f: UnitFile, r: number): string {
    const q = f.q[r]
    const hide = q >= Q_NODATA
    const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`
    const g = this.edits.grid(f, r)
    const mine = f.edited[r] > 0
    const notes = mine
      ? [`Screened on your edits of ${f.edited[r]} of ${f.n[r]} cross-sections (the grid's median: bank height ratio ${g.why & WHY.atCap ? 'at least ' : ''}${ratio(g.bhr / 100)}, entrenchment ratio ${ratio(g.er / 100)}).`,
        ...flagTexts(f, r, g.why, g.q).map((t) => `The grid's: ${t}`)]
      : flagTexts(f, r)
    return `<h5 class="fpr-xsx-h">${mine ? 'Screened on (your edits)' : 'Screened on'}</h5>
      <table class="fpr-tbl"><tbody>
        ${row('Quality', esc(QUALITY_LABEL[q]))}
        ${hide ? '' : row('Bank height ratio', `${esc(bhrText(f, r))} <span class="fpr-note">(${ratio(f.bhrLo[r] / 100)} to ${ratio(f.bhrHi[r] / 100)})</span>`)}
        ${hide ? '' : row('Entrenchment ratio', `${ratio(f.er[r] / 100)} <span class="fpr-note">(${ratio(f.erLo[r] / 100)} to ${ratio(f.erHi[r] / 100)})</span>`)}
        ${hide ? '' : row('Low-bank height', `${ft(f.lbh[r] / 100, 1)} ft`)}
        ${hide ? '' : row('Bankfull depth and width', `${ft(f.bfd[r] / 100, 1)} ft, ${ft(f.bfw[r] / 10)} ft`)}
        ${hide ? '' : row('Flood-prone width', `${ft(f.fpw[r] / 10)} ft`)}
        ${row('Slope', esc(slopeText(f.slope[r])))}
        ${q === Q_UNSAMPLED ? '' : row('Cross-sections', `${f.nOk[r]} of ${f.n[r]} measured by the grid${f.res[r] ? `, ${f.res[r]} m elevation model` : ''}`)}
      </tbody></table>
      ${notes.length ? `<h5 class="fpr-xsx-h">Notes</h5><ul class="fpr-reach-notes">${notes.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <p class="fpr-note">Reach ${esc(reachId(f, r))} · HUC12 ${esc(huc12Text(f, r) || 'n/a')} · region ${esc(f.vpu[r])}</p>`
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
        <td class="num">${hide ? 'n/a' : ft(f.fpw[r] / 10)}</td><td>${[s.pass[j] ? (f.q[r] === Q_CAUTION ? '<span class="fpr-flag">caution</span>' : '') : 'gap',
          f.edited[r] ? '<span class="fpr-flag">edited</span>' : ''].filter(Boolean).join(', ')}</td></tr>`
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
    this.edits.clearAll(this.net.files)
    this.showAll = false
    this.moreOpen = false
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
      format: 'fpr-screening', version: 2, app_version: APP_VERSION, data_version: this.version, saved_at: new Date().toISOString(),
      // the area of the way chosen (each way keeps its own while the user switches between them)
      area: {
        mode: this.mode, codes: this.mode === 'huc' ? [...this.codes].sort() : [], walk: this.mode === 'walk' ? this.walkFrom : null, box: null,
        ...(this.mode === 'reach' ? { reaches: savedPicks(this.net, this.picks) } : {}),
      },
      criteria: this.criteria, color_by: this.colorBy, sort: this.sort, sub: this.sub, decisions, edits: this.edits.toJSON(),
    }
  }

  async open(s: SavedScreening): Promise<void> {
    this.reset()
    // a box saved by version 0.2 opens as the reaches it holds
    const saved = s.area.mode
    this.mode = saved === 'box' ? 'reach' : MODES.some((m) => m.key === saved) ? saved : 'huc'
    this.criteria = { ...defaultCriteria(), ...s.criteria }
    // a screening whose hidden settings differ from the starting values opens with them in view
    this.moreOpen = this.moreChanged() > 0
    this.colorBy = (['bhr', 'er', 'match'].includes(s.color_by) ? s.color_by : 'bhr') as ColorBy
    this.sort = (SORTS.some((x) => x.key === s.sort) ? s.sort : 'length') as SortKey
    for (const [k, v] of Object.entries(s.decisions ?? {})) this.decisions.set(k, { keep: v.keep !== false, note: String(v.note ?? '') })
    // the cross-section edits, with their numbers (no pull needed): into the files already loaded now,
    // and into the others as they load
    this.edits.load(s.edits ?? {})
    let gone = 0
    for (const f of this.net.files) gone += this.edits.applyFile(f).length
    if (gone) notify(`Cross-section edits on ${gone} reach${gone === 1 ? '' : 'es'} were dropped: the data no longer hold ${gone === 1 ? 'that reach' : 'those reaches'} as saved.`, { type: 'warning', seconds: 12 })
    this.renderPane()
    if (this.mode === 'huc') {
      for (const c of s.area.codes ?? []) this.codes.add(c)
      this.restylePicks()
      await this.ensureFiles(hucFiles([...this.codes]))
    } else if (this.mode === 'walk' && s.area.walk && this.idx) {
      this.walkFrom = s.area.walk
      await this.ensureFiles([s.area.walk.huc8])
      await this.expandWalk(s.area.walk.id)
      this.setPin(this.findReach(s.area.walk.id))
    } else if (saved === 'box' && s.area.box && this.idx) {
      const [w, so, e, n] = s.area.box
      await this.ensureFiles(huc8sInBox(this.idx, w, so, e, n).slice(0, AREA_FILES))
      this.picks = picksFromBox(this.net, s.area.box)
    } else if (this.mode === 'reach' && this.idx) {
      const list = s.area.reaches ?? []
      await this.ensureFiles([...new Set(list.map((x) => x.huc8))].slice(0, AREA_FILES))
      // a file that did not load says so itself; of the rest, the reaches the data no longer hold
      const { picks, missing } = resolvePicks(this.net, list.filter((x) => this.net.has(x.huc8)))
      this.picks = picks
      if (missing) notify(`${missing} picked reach${missing === 1 ? ' was' : 'es were'} dropped: the data no longer hold ${missing === 1 ? 'it' : 'them'}.`, { type: 'warning', seconds: 10 })
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
      else if (this.mode === 'huc' && this.hucHover !== null) text = this.hucCue(this.hucHover)
      else if (this.mode === 'walk' && z < VIEW_ZOOM) text = 'Zoom in until streams show, then click one.'
      else if (this.mode === 'walk' && !this.walkFrom) text = 'Click a stream. Everything upstream becomes the study area.'
      else if (this.mode === 'reach' && this.boxSelect.drawing) text = 'Let go to add the reaches in the box.'
      else if (this.mode === 'reach' && z < VIEW_ZOOM) text = 'Zoom in until streams show, then click reaches.'
    } else if (!this.result && z < VIEW_ZOOM && this.idx) text = 'Zoom in to see reaches.'
    else if (this.result && z < AREA_ZOOM) text = 'Zoom in to see the study area.'
    this.cue.innerHTML = text ? `<div class="fpr-cue">${esc(text)}</div>` : ''
  }

  /** The cue over a watershed: the unit a click takes at the pick size now, and what the click does. */
  private hucCue(code: string): string {
    const unit = this.unitCodes(code)
    const click = unit.every((c) => this.codes.has(c)) ? 'Click to remove it from the study area.' : 'Click to add it to the study area.'
    if (this.pickSize === 12) {
      const name = this.huc12Names.get(code)
      return `${name ? `${name}, ` : ''}HUC12 ${code}. ${click}`
    }
    const p = code.slice(0, this.pickSize)
    const name = this.pickSize === 8 ? this.idx?.huc8[p]?.name : ''
    return `${name ? `${name}, ` : ''}HUC${this.pickSize} ${p}, ${count(unit.length)} watershed${unit.length === 1 ? '' : 's'}. ${click}`
  }

  private nudgeCue(): void {
    const c = this.cue.querySelector('.fpr-cue')
    if (!c) return
    c.classList.remove('is-nudged')
    void (c as HTMLElement).offsetWidth
    c.classList.add('is-nudged')
  }
}
