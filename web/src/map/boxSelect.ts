// Shift and drag on the map draws a box (the Reaches study area: the owner, 2026-11-19). A plain drag
// still pans the map, and a Shift click with no drag stays a click. Leaflet's own Shift-drag zoom
// (boxZoom) is off while the tool is on. Escape drops a box being drawn. Phones tap reaches instead.
import L from 'leaflet'

/** How far the pointer moves before a press becomes a box (CSS px). */
const START_PX = 4

export class BoxSelect {
  private on = false
  /** where the press began: on screen (to tell a drag from a click) and on the map (a box corner that
   * stays put if the map zooms under it) */
  private from: L.Point | null = null
  private corner: L.LatLng | null = null
  private pointer = -1
  private rect: L.Rectangle | null = null
  /** the pointer of a box dropped with Escape: its release is no click either */
  private dropped = -1
  /** a box being drawn (the hover card stays hidden meanwhile) */
  drawing = false

  constructor(
    private readonly map: L.Map,
    private readonly pane: string,
    private readonly done: (bounds: L.LatLngBounds) => void,
    private readonly changed: () => void,
  ) {
    const el = map.getContainer()
    // capture: before Leaflet sees the press (a press whose default is prevented sends no mousedown,
    // so Leaflet's drag never starts)
    el.addEventListener('pointerdown', (e) => this.down(e), true)
    el.addEventListener('pointermove', (e) => this.move(e))
    el.addEventListener('pointerup', (e) => this.up(e))
    el.addEventListener('pointercancel', () => this.stop())
    el.addEventListener('lostpointercapture', (e) => {
      if (this.from && e.pointerId === this.pointer) this.stop()
    })
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.from) return
      this.dropped = this.pointer
      this.stop()
    })
  }

  /** On only where a box adds reaches. */
  enable(on: boolean): void {
    if (on === this.on) return
    this.on = on
    if (on) this.map.boxZoom.disable()
    else {
      this.stop()
      this.map.boxZoom.enable()
    }
  }

  private down(e: PointerEvent): void {
    if (!this.on || !e.shiftKey || e.button !== 0 || e.pointerType === 'touch') return
    if (e.target instanceof Element && e.target.closest('.leaflet-control')) return
    e.preventDefault()
    this.from = this.map.mouseEventToContainerPoint(e as unknown as MouseEvent)
    this.corner = this.map.containerPointToLatLng(this.from)
    this.pointer = e.pointerId
    // the moves past the map's edge still come here (a pointer the browser no longer tracks cannot be
    // captured: the box still works inside the map)
    try {
      this.map.getContainer().setPointerCapture(e.pointerId)
    } catch { /* not capturable */ }
    this.map.dragging.disable()
  }

  private move(e: PointerEvent): void {
    if (!this.from || e.pointerId !== this.pointer) return
    const to = this.map.mouseEventToContainerPoint(e as unknown as MouseEvent)
    if (!this.drawing) {
      if (to.distanceTo(this.from) < START_PX) return
      this.drawing = true
      this.map.getContainer().classList.add('fpr-crosshair')
      this.rect = L.rectangle(this.bounds(to), { pane: this.pane, color: '#c2410c', weight: 1.5, dashArray: '5 4', fillColor: '#c2410c', fillOpacity: 0.08, interactive: false }).addTo(this.map)
      this.changed()
    }
    this.rect?.setBounds(this.bounds(to))
  }

  private up(e: PointerEvent): void {
    if (e.pointerId === this.dropped) {
      this.dropped = -1
      this.skipClick()
      return
    }
    if (!this.from || e.pointerId !== this.pointer) return
    const bounds = this.drawing ? this.bounds(this.map.mouseEventToContainerPoint(e as unknown as MouseEvent)) : null
    this.stop()
    if (!bounds) return
    this.skipClick()
    this.done(bounds)
  }

  /** The click the browser sends on release is no click on the map: it is stopped before anything on
   * the page sees it (the reaches, the outlines), in the same turn; past it, a click is a click again. */
  private skipClick(): void {
    const stop = (e: Event) => {
      e.stopPropagation()
      e.preventDefault()
    }
    window.addEventListener('click', stop, true)
    setTimeout(() => window.removeEventListener('click', stop, true), 0)
  }

  private bounds(to: L.Point): L.LatLngBounds {
    return L.latLngBounds(this.corner!, this.map.containerPointToLatLng(to))
  }

  /** Ends a press, drawn or not, without a box. */
  private stop(): void {
    if (!this.from) return
    const el = this.map.getContainer()
    const pointer = this.pointer
    this.from = null
    this.corner = null
    this.pointer = -1
    try {
      if (el.hasPointerCapture(pointer)) el.releasePointerCapture(pointer)
    } catch { /* not captured */ }
    this.rect?.remove()
    this.rect = null
    el.classList.remove('fpr-crosshair')
    this.map.dragging.enable()
    if (this.drawing) {
      this.drawing = false
      this.changed()
    }
  }
}
