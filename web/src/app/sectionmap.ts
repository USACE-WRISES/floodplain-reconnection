// A reach popup's small map (the owner, 2026-11-20): where each of the reach's cross-sections lies, on
// the main map's basemap, numbered like the popup's section buttons. The section shown is drawn across
// its full sampled width; a click on a number shows that section. It starts from the sections placed
// along the reach's line (map/along.ts) and moves them to the grid's exact places once those are read
// (xs/sectionLines.ts).
//
// The popup scrolls, so the wheel scrolls it rather than zooming the map, a finger on a phone scrolls it
// too (a pinch zooms), and the map takes no keyboard stop: the numbered buttons are the keyboard's way.
import L from 'leaflet'
import type { LatLon, SectionMark } from '../map/along'
import { basemapLayer, type Basemap } from '../map/map'

export interface SectionMapOptions {
  basemap: Basemap
  /** the reach's line, upstream to downstream */
  line: LatLon[]
  marks: (SectionMark | null)[]
  /** a section's number was clicked */
  onPick(i: number): void
}

/** A section's number as its button shows it. */
export interface MarkState { on: boolean, edited: boolean, muted: boolean, stored: boolean, title: string }

export class SectionMap {
  /** Maps not yet removed (the debug handle reads it). */
  static live = 0
  private readonly map: L.Map
  private readonly markers: (L.Marker | null)[] = []
  private readonly states = new Map<number, MarkState>()
  private marks: (SectionMark | null)[]
  private readonly widthUnder: L.Polyline
  private readonly widthLine: L.Polyline
  private readonly ro: ResizeObserver
  private fitted = false
  private shown = -1
  private dead = false

  constructor(private readonly box: HTMLElement, private readonly opts: SectionMapOptions) {
    this.marks = opts.marks
    const first = opts.line[Math.floor(opts.line.length / 2)] ?? opts.marks.find((m) => m)?.at ?? [39, -96]
    // no zoom animation: removing the map would not stop the timer that ends one; quarter zoom steps, so
    // a short reach still fills the map and its numbers stand apart
    this.map = L.map(box, {
      center: first, zoom: 16, minZoom: 10, maxZoom: 19, zoomSnap: 0.25, attributionControl: false, keyboard: false,
      scrollWheelZoom: false, boxZoom: false, dragging: !L.Browser.mobile, zoomAnimation: false, fadeAnimation: false,
      markerZoomAnimation: false, trackResize: false,
    })
    SectionMap.live++
    // the tiles' credit, small, in the corner
    L.control.attribution({ position: 'bottomright', prefix: false }).addTo(this.map)
    basemapLayer(opts.basemap).addTo(this.map)
    if (opts.line.length >= 2) {
      L.polyline(opts.line, { color: '#ffffff', weight: 7, opacity: 0.9, interactive: false }).addTo(this.map)
      L.polyline(opts.line, { color: '#1f2937', weight: 3.5, interactive: false }).addTo(this.map)
    }
    this.widthUnder = L.polyline([], { color: '#ffffff', weight: 6, opacity: 0.9, interactive: false }).addTo(this.map)
    this.widthLine = L.polyline([], { color: '#2f4b7c', weight: 3, interactive: false }).addTo(this.map)
    this.drawMarks()
    // the popup lays out after this: the map fits once it has a size, never at 0 by 0
    this.ro = new ResizeObserver(() => this.resized())
    this.ro.observe(box)
  }

  /** The marks again: the grid's exact places once read. */
  setMarks(marks: (SectionMark | null)[]): void {
    if (this.dead) return
    this.marks = marks
    this.drawMarks()
  }

  /** The section shown: its number on top, and its sampled width drawn when known. */
  select(i: number): void {
    if (this.dead) return
    this.shown = i
    const mark = this.marks[i] ?? null
    const ends = mark?.ends ?? []
    this.widthUnder.setLatLngs(ends)
    this.widthLine.setLatLngs(ends)
    this.markers.forEach((m, j) => m?.setZIndexOffset(j === i ? 1000 : 0))
    if (this.fitted && mark && !this.map.getBounds().contains(mark.at)) this.map.panTo(mark.at, { animate: false })
  }

  /** A section's number shown as its button is: shown, edited, unmeasured, stored. */
  flag(j: number, s: MarkState): void {
    if (this.dead) return
    this.states.set(j, s)
    this.applyState(j, s)
  }

  destroy(): void {
    if (this.dead) return
    this.dead = true
    this.ro.disconnect()
    this.map.remove()
    SectionMap.live--
  }

  private resized(): void {
    if (this.dead || !this.box.clientWidth || !this.box.clientHeight) return
    if (this.fitted) {
      this.map.invalidateSize({ animate: false })
      return
    }
    this.map.invalidateSize({ animate: false })
    // the reach, not the section's long line, fills the map
    const pts = this.opts.line.length ? this.opts.line : this.marks.filter((m): m is SectionMark => m !== null).map((m) => m.at)
    if (pts.length) this.map.fitBounds(L.latLngBounds(pts), { padding: [14, 14], maxZoom: 17, animate: false })
    this.fitted = true
    if (this.shown >= 0) this.select(this.shown)
  }

  private drawMarks(): void {
    for (const m of this.markers) m?.remove()
    this.markers.length = 0
    this.marks.forEach((mark, j) => {
      if (!mark) {
        this.markers.push(null)
        return
      }
      // a box of no size at the section's point: only its tick and number take the pointer, so one
      // section's box never covers a neighbor's number
      const icon = L.divIcon({ className: 'fpr-xsm-mark', iconSize: [0, 0], html: markHtml(mark, j) })
      const marker = L.marker(mark.at, { icon, keyboard: false, riseOnHover: true }).addTo(this.map)
      // Leaflet's click, which a drag of the map never sends
      marker.on('click', () => this.opts.onPick(j))
      this.markers.push(marker)
    })
    for (const [j, s] of this.states) this.applyState(j, s)
    if (this.shown >= 0) this.select(this.shown)
  }

  private applyState(j: number, s: MarkState): void {
    const el = this.markers[j]?.getElement()
    if (!el) return
    el.classList.toggle('on', s.on)
    el.classList.toggle('edited', s.edited)
    el.classList.toggle('muted', s.muted)
    el.classList.toggle('stored', s.stored)
    el.title = s.title
  }
}

/** A section's tick, turned across the stream, and its number beyond one end (the end toward the lower
 * right of the screen, so the numbers fall on one side of the stream). */
function markHtml(mark: SectionMark, j: number): string {
  let ax = Math.cos(mark.angle)
  let ay = Math.sin(mark.angle)
  if (ax + ay < 0) {
    ax = -ax
    ay = -ay
  }
  const deg = ((mark.angle * 180) / Math.PI).toFixed(1)
  return `<span class="fpr-xsm-tick" style="transform:translate(-50%,-50%) rotate(${deg}deg)"></span>`
    + `<span class="fpr-xsm-n" style="transform:translate(calc(-50% + ${Math.round(ax * 15)}px),calc(-50% + ${Math.round(ay * 15)}px))">${j + 1}</span>`
}
