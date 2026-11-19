// The reaches on the map: one canvas, drawn from the loaded files' typed arrays (a Leaflet canvas
// renderer with its own draw, so panning and zoom animation behave as Leaflet's own vectors do).
// Each row has a style id (0: not drawn); rows are stroked in one path per style and width class.
// The canvas takes no pointer events: the map's own mousemove and click find the nearest reach here
// (a grid of cells over the rows' extents), so the watershed outlines under it stay clickable.
import L from 'leaflet'
import { fileOf, refOf, rowOf, type Network, type Ref } from '../screen/model'

export interface LineStyle {
  color: string
  /** width at zoom 14, px */
  width: number
  dash?: number[]
  alpha?: number
  /** drawn after lower values */
  z: number
}

/** The cell size of the hit grid, Web Mercator units (about 1.2 km at the equator). */
const CELL = 1 / 32768
const HIT_PX = 7
const MIN_HIT_ZOOM = 8

const Renderer = (L.Canvas as any).extend({
  _draw(this: any) {
    this.options.owner.draw(this._ctx, this._bounds, this._map)
  },
})

export class UnitLayer {
  private renderer: any
  private styles: LineStyle[] = [{ color: '#000', width: 0, z: 0 }]
  private ids: Uint16Array[] = []
  private highlight: Ref[] = []
  private hover: Ref | null = null
  private grid = new Map<number, Ref[]>()
  private gridFiles = 0
  private pending = 0

  constructor(private readonly map: L.Map, private readonly net: Network, pane: string) {
    this.renderer = new Renderer({ pane, padding: 0.35, owner: this })
    this.renderer.addTo(map)
    this.renderer._container.classList.add('fpr-unit-canvas')
  }

  /** The style table (index 0 is "not drawn") and each loaded file's row style ids. */
  setStyles(styles: LineStyle[], ids: Uint16Array[]): void {
    this.styles = styles
    this.ids = ids
    this.redraw()
  }

  setHighlight(refs: Ref[]): void {
    this.highlight = refs
    this.redraw()
  }

  setHover(ref: Ref | null): void {
    if (ref === this.hover) return
    this.hover = ref
    this.redraw()
  }

  redraw(): void {
    if (this.pending) return
    this.pending = requestAnimationFrame(() => {
      this.pending = 0
      if (this.renderer._map) this.renderer._redraw()
    })
  }

  /** Line width class of a row: stream order 1 and 2, 3 and 4, 5 and up. */
  private static widthClass(order: number): number {
    return order >= 5 ? 2 : order >= 3 ? 1 : 0
  }

  draw(ctx: CanvasRenderingContext2D, bounds: L.Bounds, map: L.Map): void {
    const zoom = map.getZoom()
    const scale = 256 * Math.pow(2, zoom)
    const origin = map.getPixelOrigin()
    const ox = origin.x
    const oy = origin.y
    const x0 = (bounds.min!.x + ox) / scale
    const y0 = (bounds.min!.y + oy) / scale
    const x1 = (bounds.max!.x + ox) / scale
    const y1 = (bounds.max!.y + oy) / scale
    const zf = zoom >= 15 ? 1.25 : zoom >= 14 ? 1 : zoom >= 12 ? 0.8 : zoom >= 10 ? 0.6 : 0.45
    const classBonus = [0, 0.6, 1.3]
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
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const path = (ref: Ref) => {
      const f = this.net.files[fileOf(ref)]
      const r = rowOf(ref)
      const a = f.off[r]
      const e = f.off[r + 1]
      if (e - a < 2) return
      ctx.moveTo(f.mx[a] * scale - ox, f.my[a] * scale - oy)
      for (let v = a + 1; v < e; v++) ctx.lineTo(f.mx[v] * scale - ox, f.my[v] * scale - oy)
    }
    for (const key of keys) {
      const st = this.styles[key >> 2]
      ctx.beginPath()
      for (const ref of groups.get(key)!) path(ref)
      ctx.globalAlpha = st.alpha ?? 1
      ctx.strokeStyle = st.color
      ctx.lineWidth = Math.max(0.6, (st.width + classBonus[key & 3]) * zf)
      ctx.setLineDash(st.dash ?? [])
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.setLineDash([])
    // the chosen site, then the reach under the pointer
    if (this.highlight.length) {
      ctx.beginPath()
      for (const ref of this.highlight) path(ref)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = Math.max(5, 9 * zf)
      ctx.stroke()
      ctx.strokeStyle = '#7c2d12'
      ctx.lineWidth = Math.max(2.5, 4.5 * zf)
      ctx.stroke()
    }
    if (this.hover !== null && fileOf(this.hover) < this.net.files.length) {
      ctx.beginPath()
      path(this.hover)
      ctx.strokeStyle = '#111827'
      ctx.globalAlpha = 0.55
      ctx.lineWidth = Math.max(4, 7 * zf)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
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
