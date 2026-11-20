// The reaches on the map, in three canvases (Leaflet canvas renderers with draws of their own, so panning
// and zoom animation behave as Leaflet's own vectors do):
//
// - the reach canvas strokes every reach in view, one path per style and width class, from the loaded
//   files' typed arrays (each row has a style id, 0: not drawn); a colored reach's path is stroked twice,
//   a white edge under the line, so it stands out from the basemap. It repaints only when the view moves
//   or the styles change;
// - the highlight canvas, just above it, strokes the chosen site and the reach under the pointer, a few
//   paths, so a hover never repaints the reaches (it used to, at 7 to 12 ms a repaint on a fast desktop
//   with 80,000 reaches and several times that on a laptop screen at 125% or under the USACE network's
//   browser isolation);
// - the tick canvas, the Cross-sections layer (the owner, 2026-11-20: off at the start, turned on in the
//   Layers control), marks every section of the drawn reaches across the line, from TICK_ZOOM in. Turning
//   it on or off never repaints the reaches.
//
// No canvas takes pointer events: the app finds the reach under the pointer here (`hit`, a grid of
// cells over the rows' extents), so the watershed outlines under them stay clickable.
import L from 'leaflet'
import { fileOf, refOf, rowOf, type Network, type Ref } from '../screen/model'
import { eachTick } from './along'

export interface LineStyle {
  color: string
  /** width at zoom 14, px (a strong line's is STRONG_WIDER times that from STRONG_ZOOM in) */
  width: number
  dash?: number[]
  alpha?: number
  /** drawn after lower values */
  z: number
  /** a colored reach (a ratio or a site): a white edge under it, and wider from STRONG_ZOOM in */
  strong?: boolean
}

/** Colored reaches stand out from the basemap (the owner, 2026-11-20): from this zoom in, where the lines
 * were thinnest, they are wider and drawn over a white edge. Zoom 11, the whole network in view, keeps its
 * widths and draws no edge: there the edge was half a pixel a side and doubled the time to paint the map
 * (the owner's choice, 2026-11-20)... */
const STRONG_ZOOM = 12
const STRONG_WIDER = 1.2
/** ...the edge adds this share of the line's width (both sides together), at most EDGE_MAX px. */
const EDGE = '#ffffff'
const EDGE_ALPHA = 0.9
const EDGE_SHARE = 0.75
const EDGE_MAX = 2

/** The cell size of the hit grid, Web Mercator units (about 1.2 km at the equator). */
const CELL = 1 / 32768
const HIT_PX = 7
const MIN_HIT_ZOOM = 8
/** Each canvas reaches this far past the map's edges (of its size; Leaflet's default), drawn at once. */
const PADDING = 0.1

/** Canvas pixels per CSS pixel: the screen's own ratio, at most 2. Leaflet's canvas uses a flat 2 on any
 * screen above 100%, which at 125% paints four times the pixels of the map where 1.56 would do. */
export function pixelRatio(): number {
  const r = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  return Math.min(2, Math.max(1, r))
}

/** Leaflet 1.9.4's `Canvas._update` (src/layer/vector/Canvas.js), with the canvas scaled by pixelRatio(). */
function update(this: any): void {
  if (this._map._animatingZoom && this._bounds) return
  ;(L.Renderer as any).prototype._update.call(this)
  const b = this._bounds
  const container = this._container as HTMLCanvasElement
  const size = b.getSize()
  const m = pixelRatio()
  L.DomUtil.setPosition(container, b.min)
  // setting the size also clears the canvas and resets its transform
  container.width = Math.round(m * size.x)
  container.height = Math.round(m * size.y)
  container.style.width = `${size.x}px`
  container.style.height = `${size.y}px`
  if (m !== 1) this._ctx.scale(m, m)
  // the same path coordinates after the canvas moves
  this._ctx.translate(-b.min.x, -b.min.y)
  this.fire('update')
}

const ReachCanvas = (L.Canvas as any).extend({
  _update: update,
  _draw(this: any) {
    this.options.owner.draw(this._ctx, this._bounds, this._map)
  },
})

const HighlightCanvas = (L.Canvas as any).extend({
  _update: update,
  _draw(this: any) {
    this.options.owner.drawHighlight(this._ctx, this._map)
  },
})

/** The Cross-sections layer draws from this zoom in, where sections 100 ft apart fall about 8 px apart. */
export const TICK_ZOOM = 15
/** A tick reaches this far (px) past the drawn line and its white edge, on each side. */
const TICK_OUT = 4
const TICK_WIDTH = 1.5
const TICK_HALO = 1.25
const TICK_COLOR = '#1f2937'

const TickCanvas = (L.Canvas as any).extend({
  // Leaflet makes a new canvas each time the layer is put on the map
  _initContainer(this: any) {
    ;(L.Canvas as any).prototype._initContainer.call(this)
    this._container.classList.add('fpr-unit-canvas')
  },
  // below TICK_ZOOM the canvas keeps no pixels (one the map's size, at twice the pixels, takes tens of MB)
  _update(this: any) {
    if (this._map.getZoom() >= TICK_ZOOM || this._map._animatingZoom) {
      update.call(this)
      return
    }
    ;(L.Renderer as any).prototype._update.call(this)
    this._container.width = 0
    this._container.height = 0
    this.fire('update')
  },
  _draw(this: any) {
    this.options.owner.drawTicks(this._ctx, this._bounds, this._map)
  },
})

/** Line widths grow with the zoom. */
function zoomFactor(zoom: number): number {
  return zoom >= 15 ? 1.25 : zoom >= 14 ? 1 : zoom >= 12 ? 0.8 : zoom >= 10 ? 0.6 : 0.45
}

/** The width added by a line's width class (stream order 1 and 2, 3 and 4, 5 and up). */
const CLASS_BONUS = [0, 0.6, 1.3]

/** A style's line width at a zoom, px, as the reach canvas strokes it. */
function lineWidth(st: LineStyle, cls: number, zoom: number): number {
  const wider = st.strong && zoom >= STRONG_ZOOM ? STRONG_WIDER : 1
  return Math.max(0.6, (st.width + CLASS_BONUS[cls]) * zoomFactor(zoom) * wider)
}

export class UnitLayer {
  private renderer: any
  private highlighter: any
  private styles: LineStyle[] = [{ color: '#000', width: 0, z: 0 }]
  private ids: Uint16Array[] = []
  private highlight: Ref[] = []
  private hover: Ref | null = null
  private grid = new Map<number, Ref[]>()
  private gridFiles = 0
  private pending = 0
  private pendingHighlight = 0
  private tickCanvas: any
  private pendingTicks = 0
  /** Reach canvas repaints so far (the app's debug handle reads it). */
  redraws = 0
  /** Tick canvas repaints so far, and the ticks the last one drew (the debug handle reads them). */
  tickDraws = 0
  ticksDrawn = 0

  constructor(private readonly map: L.Map, private readonly net: Network, pane: string, highlightPane: string, ticksPane: string) {
    this.renderer = new ReachCanvas({ pane, padding: PADDING, owner: this })
    this.renderer.addTo(map)
    this.renderer._container.classList.add('fpr-unit-canvas')
    this.highlighter = new HighlightCanvas({ pane: highlightPane, padding: PADDING, owner: this })
    this.highlighter.addTo(map)
    this.highlighter._container.classList.add('fpr-unit-canvas')
    // made here, put on the map by the Layers control (off at the start)
    this.tickCanvas = new TickCanvas({ pane: ticksPane, padding: PADDING, owner: this })
  }

  /** The Cross-sections layer, for the Layers control. */
  get ticks(): L.Layer {
    return this.tickCanvas
  }

  /** The style table (index 0 is "not drawn") and each loaded file's row style ids. The same styles as
   * before (a switch of the study-area way that leaves the map as it was) paint nothing: a repaint of
   * the whole network at zoom 11 takes a good part of a second. */
  setStyles(styles: LineStyle[], ids: Uint16Array[]): void {
    const same = styles === this.styles && ids.length === this.ids.length && ids.every((a, i) => sameIds(a, this.ids[i]))
    this.styles = styles
    this.ids = ids
    if (same) return
    this.redraw()
    this.redrawHighlight()
    this.redrawTicks()
  }

  /** The chosen site's rows (none: no site). */
  setHighlight(refs: Ref[]): void {
    this.highlight = refs
    this.redrawHighlight()
  }

  /** The reach under the pointer (null: none), drawn at once (a few paths; the app calls this from its
   * frame callback, so the outline shows in the same frame as the card). */
  setHover(ref: Ref | null): void {
    if (ref === this.hover) return
    this.hover = ref
    if (!this.pendingHighlight && this.highlighter._map) this.highlighter._redraw()
  }

  /** The reaches, at the next frame. */
  redraw(): void {
    if (this.pending) return
    this.pending = requestAnimationFrame(() => {
      this.pending = 0
      if (this.renderer._map) this.renderer._redraw()
    })
  }

  /** The chosen site and the hovered reach, at the next frame. */
  private redrawHighlight(): void {
    if (this.pendingHighlight) return
    this.pendingHighlight = requestAnimationFrame(() => {
      this.pendingHighlight = 0
      if (this.highlighter._map) this.highlighter._redraw()
    })
  }

  /** The cross-sections, at the next frame (nothing while the layer is off). */
  private redrawTicks(): void {
    if (this.pendingTicks || !this.tickCanvas._map) return
    this.pendingTicks = requestAnimationFrame(() => {
      this.pendingTicks = 0
      if (this.tickCanvas._map) this.tickCanvas._redraw()
    })
  }

  /** Line width class of a row: stream order 1 and 2, 3 and 4, 5 and up. */
  private static widthClass(order: number): number {
    return order >= 5 ? 2 : order >= 3 ? 1 : 0
  }

  /** A row's line on a context or a path, in layer points (scale and origin: the map's at this zoom). A
   * vertex less than a pixel from the last one drawn is skipped (the last vertex never is): at zoom 11 a
   * reach is a few pixels long, and its sub-pixel segments cost paint time for nothing. */
  private path(ctx: CanvasPath, ref: Ref, scale: number, ox: number, oy: number): void {
    const f = this.net.files[fileOf(ref)]
    if (!f) return
    const r = rowOf(ref)
    const a = f.off[r]
    const e = f.off[r + 1]
    if (e - a < 2) return
    let px = f.mx[a] * scale - ox
    let py = f.my[a] * scale - oy
    ctx.moveTo(px, py)
    for (let v = a + 1; v < e - 1; v++) {
      const x = f.mx[v] * scale - ox
      const y = f.my[v] * scale - oy
      if ((x - px) * (x - px) + (y - py) * (y - py) < 1) continue
      ctx.lineTo(x, y)
      px = x
      py = y
    }
    ctx.lineTo(f.mx[e - 1] * scale - ox, f.my[e - 1] * scale - oy)
  }

  draw(ctx: CanvasRenderingContext2D, bounds: L.Bounds, map: L.Map): void {
    this.redraws++
    const zoom = map.getZoom()
    const scale = 256 * Math.pow(2, zoom)
    const origin = map.getPixelOrigin()
    const ox = origin.x
    const oy = origin.y
    const x0 = (bounds.min!.x + ox) / scale
    const y0 = (bounds.min!.y + oy) / scale
    const x1 = (bounds.max!.x + ox) / scale
    const y1 = (bounds.max!.y + oy) / scale
    // group rows by (style, width class)
    const groups = new Map<number, number[]>()
    this.net.files.forEach((f, fi) => {
      const ids = this.ids[fi]
      if (!ids) return
      for (let r = 0; r < f.rows; r++) {
        const s = ids[r]
        if (!s) continue
        const b = r * 4
        if (f.box[b] > x1 || f.box[b + 2] < x0 || f.box[b + 1] > y1 || f.box[b + 3] < y0) continue
        const key = s * 4 + UnitLayer.widthClass(f.order[r])
        const list = groups.get(key)
        if (list) list.push(refOf(fi, r))
        else groups.set(key, [refOf(fi, r)])
      }
    })
    const keys = [...groups.keys()].sort((a, b) => this.styles[a >> 2].z - this.styles[b >> 2].z || a - b)
    // each group's path is built once (a strong group's is stroked twice)
    const paths = keys.map((key) => {
      const p = new Path2D()
      for (const ref of groups.get(key)!) this.path(p, ref, scale, ox, oy)
      return p
    })
    const widths = keys.map((key) => lineWidth(this.styles[key >> 2], key & 3, zoom))
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // the white edges first (from STRONG_ZOOM in), every one of them, so no edge cuts across a line where
    // two reaches meet
    if (zoom >= STRONG_ZOOM) {
      ctx.strokeStyle = EDGE
      ctx.globalAlpha = EDGE_ALPHA
      ctx.setLineDash([])
      keys.forEach((key, i) => {
        if (!this.styles[key >> 2].strong) return
        ctx.lineWidth = widths[i] + Math.min(EDGE_MAX, widths[i] * EDGE_SHARE)
        ctx.stroke(paths[i])
      })
    }
    keys.forEach((key, i) => {
      const st = this.styles[key >> 2]
      ctx.globalAlpha = st.alpha ?? 1
      ctx.strokeStyle = st.color
      ctx.lineWidth = widths[i]
      ctx.setLineDash(st.dash ?? [])
      ctx.stroke(paths[i])
    })
    ctx.globalAlpha = 1
    ctx.setLineDash([])
  }

  drawHighlight(ctx: CanvasRenderingContext2D, map: L.Map): void {
    const zoom = map.getZoom()
    const scale = 256 * Math.pow(2, zoom)
    const origin = map.getPixelOrigin()
    const zf = zoomFactor(zoom)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (this.highlight.length) {
      ctx.beginPath()
      for (const ref of this.highlight) this.path(ctx, ref, scale, origin.x, origin.y)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = Math.max(5, 9 * zf)
      ctx.stroke()
      ctx.strokeStyle = '#7c2d12'
      ctx.lineWidth = Math.max(2.5, 4.5 * zf)
      ctx.stroke()
    }
    if (this.hover !== null && fileOf(this.hover) < this.net.files.length) {
      ctx.beginPath()
      this.path(ctx, this.hover, scale, origin.x, origin.y)
      ctx.strokeStyle = '#111827'
      ctx.globalAlpha = 0.55
      ctx.lineWidth = Math.max(4, 7 * zf)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  /** The Cross-sections layer: a tick across the line at every section of the drawn reaches in view
   * (along.ts places them), reaching TICK_OUT past the line and its edge, dark over a white halo. */
  drawTicks(ctx: CanvasRenderingContext2D, bounds: L.Bounds, map: L.Map): void {
    const zoom = map.getZoom()
    if (zoom < TICK_ZOOM) return
    this.tickDraws++
    const scale = 256 * Math.pow(2, zoom)
    const origin = map.getPixelOrigin()
    // a tick just past the edge still shows its end
    const pad = 16
    const x0 = (bounds.min!.x - pad + origin.x) / scale
    const y0 = (bounds.min!.y - pad + origin.y) / scale
    const x1 = (bounds.max!.x + pad + origin.x) / scale
    const y1 = (bounds.max!.y + pad + origin.y) / scale
    // half a tick's length, by style and width class
    const half = new Map<number, number>()
    const path = new Path2D()
    this.ticksDrawn = eachTick(this.net.files, this.ids, x0, y0, x1, y1, (x, y, ax, ay, fi, r) => {
      const key = this.ids[fi][r] * 4 + UnitLayer.widthClass(this.net.files[fi].order[r])
      let h = half.get(key)
      if (h === undefined) {
        const st = this.styles[key >> 2]
        const w = lineWidth(st, key & 3, zoom)
        const edge = st.strong && zoom >= STRONG_ZOOM ? Math.min(EDGE_MAX, w * EDGE_SHARE) : 0
        h = (w + edge) / 2 + TICK_OUT
        half.set(key, h)
      }
      const px = x * scale - origin.x
      const py = y * scale - origin.y
      path.moveTo(px - ax * h, py - ay * h)
      path.lineTo(px + ax * h, py + ay * h)
    })
    ctx.setLineDash([])
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#ffffff'
    ctx.globalAlpha = 0.9
    ctx.lineWidth = TICK_WIDTH + 2 * TICK_HALO
    ctx.stroke(path)
    ctx.globalAlpha = 1
    ctx.lineCap = 'butt'
    ctx.strokeStyle = TICK_COLOR
    ctx.lineWidth = TICK_WIDTH
    ctx.stroke(path)
  }

  private buildGrid(): void {
    this.grid.clear()
    this.net.files.forEach((f, fi) => {
      for (let r = 0; r < f.rows; r++) {
        const b = r * 4
        if (!(f.box[b] <= f.box[b + 2])) continue
        const cx0 = Math.floor(f.box[b] / CELL)
        const cy0 = Math.floor(f.box[b + 1] / CELL)
        const cx1 = Math.floor(f.box[b + 2] / CELL)
        const cy1 = Math.floor(f.box[b + 3] / CELL)
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cy = cy0; cy <= cy1; cy++) {
            const k = cx * 32768 + cy
            const list = this.grid.get(k)
            if (list) list.push(refOf(fi, r))
            else this.grid.set(k, [refOf(fi, r)])
          }
        }
      }
    })
    this.gridFiles = this.net.files.length
  }

  /** The drawn reach nearest a map point, within a few pixels; null when none. */
  hit(latlng: L.LatLng): Ref | null {
    const zoom = this.map.getZoom()
    if (zoom < MIN_HIT_ZOOM) return null
    if (this.gridFiles !== this.net.files.length) this.buildGrid()
    const scale = 256 * Math.pow(2, zoom)
    const p = this.map.project(latlng, zoom)
    const px = p.x / scale
    const py = p.y / scale
    const tol = HIT_PX / scale
    let best: Ref | null = null
    let bestD = HIT_PX
    const seen = new Set<Ref>()
    for (let cx = Math.floor((px - tol) / CELL); cx <= Math.floor((px + tol) / CELL); cx++) {
      for (let cy = Math.floor((py - tol) / CELL); cy <= Math.floor((py + tol) / CELL); cy++) {
        for (const ref of this.grid.get(cx * 32768 + cy) ?? []) {
          if (seen.has(ref)) continue
          seen.add(ref)
          const fi = fileOf(ref)
          const r = rowOf(ref)
          if (!this.ids[fi]?.[r]) continue
          const f = this.net.files[fi]
          const b = r * 4
          if (f.box[b] > px + tol || f.box[b + 2] < px - tol || f.box[b + 1] > py + tol || f.box[b + 3] < py - tol) continue
          for (let v = f.off[r]; v < f.off[r + 1] - 1; v++) {
            const d = segDist(px, py, f.mx[v], f.my[v], f.mx[v + 1], f.my[v + 1]) * scale
            if (d < bestD) {
              bestD = d
              best = ref
            }
          }
        }
      }
    }
    return best
  }
}

/** Whether two files' style ids are the same (a file not there before is not). */
function sameIds(a: Uint16Array, b: Uint16Array | undefined): boolean {
  if (!b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  const x = ax + t * dx - px
  const y = ay + t * dy - py
  return Math.sqrt(x * x + y * y)
}
