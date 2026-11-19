// A cross-section chart with lines to move (the reach popup's explorer): the measured profile (the
// trimmed, thinned samples a section's numbers come from), water to bankfull, and the bankfull, low-bank
// and flood-prone levels in feet above the bed. The user drags the bankfull or low-bank line (or moves it
// with the arrow keys on its grip); the flood-prone line follows bankfull (the bed plus twice the
// bankfull depth, the method's definition). The grid's own levels stay as faint lines once moved. The
// look follows xscard.ts (the site card's stored cross-section).
//
// The chart's height range is fixed while a section is shown, so a dragged line never makes the chart
// jump; heights are snapped to 0.01 ft.
import { FT_PER_M } from '../screen/format'
import { argmin, displayWindow } from '../xs/geomorph'

export interface ChartProfile {
  /** stations (m from the thalweg) and elevations (m) */
  st: number[]
  el: number[]
  thalweg: number
}

/** The bankfull and low-bank heights above the bed, m. */
export interface Heights {
  bf: number
  lb: number
}

export interface ChartOptions {
  /** a line moved (while dragging or keying) */
  onInput: (h: Heights) => void
  /** a move ended: the line let go, or the keys at rest */
  onCommit: (h: Heights) => void
}

const W = 640
const H = 300
const ML = 52
const MR = 16
const MT = 14
const MB = 38
/** the lowest height a line takes, m (0.05 ft) */
export const MIN_HEIGHT = 0.05 / FT_PER_M
/** how near (screen px) a press must be to take a line */
const NEAR_PX = 12
const KEY_REST_MS = 400

const C_BF = '#1f6fc0'
const C_LB = '#2f855a'
const C_FP = '#9a6b3f'

/** STAF's plot window (apps/staf-web/src/tools/easi/xsplot.ts): out from the thalweg to where the ground
 * passes 1.5 times the highest line (at least 15 m each side), 3% padding; heights to the ground's top
 * inside it, at most that ceiling, with room above the highest line to drag. All in m: stations from the
 * thalweg, heights above the bed. */
export function viewOf(p: ChartProfile, ...lines: Heights[]): { x0: number, x1: number, top: number } {
  const hts = p.el.map((e) => e - p.thalweg)
  const topLine = Math.max(...lines.map((h) => Math.max(2 * h.bf, h.lb)), MIN_HEIGHT)
  const ceiling = 1.5 * topLine
  const [lo, hi] = displayWindow(p.st, hts, ceiling, argmin(p.el), 15.0)
  const padx = hi > lo ? 0.03 * (hi - lo) : 1.0
  let hmax = 0
  for (let k = 0; k < p.st.length; k++) if (lo <= p.st[k] && p.st[k] <= hi) hmax = Math.max(hmax, hts[k])
  return { x0: lo - padx, x1: hi + padx, top: Math.max(1.25 * topLine, Math.min(hmax, ceiling)) * 1.06 }
}

/** A height snapped to 0.01 ft (returned in m). */
export function snapFt(m: number): number {
  return Math.round(m * FT_PER_M * 100) / 100 / FT_PER_M
}

/** Heights kept between the lowest a line takes and the top of the range. No cap at twice bankfull:
 * the user's low bank is a reading. */
export function clampHeights(h: Heights, top: number): Heights {
  const c = (v: number) => Math.min(Math.max(v, MIN_HEIGHT), top)
  return { bf: c(h.bf), lb: c(h.lb) }
}

/** The water below bankfull: the ground from where it dips under the level left of the thalweg to where
 * it rises above it on the right, as (station m, height above bed m) points. */
export function waterOutline(p: ChartProfile, bf: number): [number, number][] {
  const n = p.st.length
  if (n < 2) return []
  let ti = 0
  for (let i = 1; i < n; i++) if (p.el[i] < p.el[ti]) ti = i
  const stage = p.thalweg + bf
  const h = (i: number) => p.el[i] - p.thalweg
  const cross = (i: number, j: number): number => p.st[i] + ((stage - p.el[i]) / (p.el[j] - p.el[i])) * (p.st[j] - p.st[i])
  let a = ti
  while (a > 0 && p.el[a - 1] < stage) a--
  let b = ti
  while (b < n - 1 && p.el[b + 1] < stage) b++
  const out: [number, number][] = []
  out.push([a > 0 ? cross(a, a - 1) : p.st[0], bf])
  if (a === 0) out.push([p.st[0], h(0)])
  for (let i = a; i <= b; i++) out.push([p.st[i], h(i)])
  if (b === n - 1) out.push([p.st[n - 1], h(n - 1)])
  out.push([b < n - 1 ? cross(b, b + 1) : p.st[n - 1], bf])
  return out
}

function ticks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo || 1
  const raw = span / n
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

let charts = 0

export class XsChart {
  private svg: SVGSVGElement | null = null
  private p: ChartProfile | null = null
  private h: Heights = { bf: 1, lb: 1 }
  private grid: Heights | null = null
  private editable = false
  private top = 1
  private x0 = 0
  private x1 = 1
  private y0 = 0
  private readonly id = ++charts
  private drag: { which: 'bf' | 'lb', start: Heights } | null = null
  private lastY = 0
  private frame = 0
  private keyTimer = 0
  private parts: Record<string, SVGElement> = {}

  constructor(private readonly host: HTMLElement, private readonly opts: ChartOptions) {}

  /** A section: its profile, the heights now, the grid's own (faint lines where they differ), and
   * whether the lines move. The height range is set here. */
  show(p: ChartProfile, h: Heights, grid: Heights, editable: boolean): void {
    this.p = p
    this.h = { ...h }
    this.grid = { ...grid }
    this.editable = editable
    const v = viewOf(p, grid, h)
    this.top = v.top
    this.x0 = v.x0 * FT_PER_M
    this.x1 = v.x1 * FT_PER_M
    this.y0 = -0.03 * this.top * FT_PER_M
    this.build()
  }

  /** New heights from outside (typed): the lines move; the view reframes only when a line is above it. */
  set(h: Heights): void {
    if (!this.p) return
    this.h = { ...h }
    if (Math.max(2 * h.bf, h.lb) > this.top) {
      const v = viewOf(this.p, this.grid ?? h, h)
      this.top = v.top
      this.x0 = v.x0 * FT_PER_M
      this.x1 = v.x1 * FT_PER_M
      this.y0 = -0.03 * this.top * FT_PER_M
      this.build()
      return
    }
    this.place()
  }

  heights(): Heights {
    return { ...this.h }
  }

  clear(html: string): void {
    this.p = null
    this.svg = null
    this.host.innerHTML = html
  }

  private X(v: number): number {
    return ML + ((v - this.x0) / (this.x1 - this.x0 || 1)) * (W - ML - MR)
  }

  /** svg y of a height in ft */
  private Y(v: number): number {
    const top = this.top * FT_PER_M
    return MT + (1 - (v - this.y0) / (top - this.y0 || 1)) * (H - MT - MB)
  }

  private build(): void {
    const p = this.p!
    const ft = FT_PER_M
    const clip = `fpr-xsx-clip-${this.id}`
    const pts = p.st.map((s, i) => [s * ft, (p.el[i] - p.thalweg) * ft] as const)
    const ground = pts.map((q, i) => `${i ? 'L' : 'M'}${this.X(q[0]).toFixed(1)},${this.Y(q[1]).toFixed(1)}`).join('')
    const floor = this.Y(this.y0)
    const fill = `${ground}L${this.X(this.x1).toFixed(1)},${floor.toFixed(1)}L${this.X(this.x0).toFixed(1)},${floor.toFixed(1)}Z`
    const axis: string[] = []
    for (const t of ticks(this.x0, this.x1, 6)) {
      axis.push(`<line x1="${this.X(t).toFixed(1)}" x2="${this.X(t).toFixed(1)}" y1="${H - MB}" y2="${H - MB + 4}" stroke="#8a94a6"/>`)
      axis.push(`<text x="${this.X(t).toFixed(1)}" y="${H - MB + 16}" text-anchor="middle" font-size="10.5" fill="#646f80">${Math.round(t)}</text>`)
    }
    for (const t of ticks(0, this.top * ft, 5)) {
      axis.push(`<line x1="${ML - 4}" x2="${ML}" y1="${this.Y(t).toFixed(1)}" y2="${this.Y(t).toFixed(1)}" stroke="#8a94a6"/>`)
      axis.push(`<text x="${ML - 7}" y="${(this.Y(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#646f80">${Number(t.toFixed(1))}</text>`)
    }
    const grip = (which: 'bf' | 'lb', label: string, color: string) => this.editable
      ? `<g class="fpr-xsx-grip" data-line="${which}" tabindex="0" role="slider" aria-label="${label}" aria-valuemin="0.05">
          <rect x="${ML + 4}" width="26" height="14" rx="4" fill="#fff" stroke="${color}" stroke-width="1.6"/>
          <path d="M${ML + 12} 0h10M${ML + 12} 0h10" stroke="${color}" stroke-width="1.4"/></g>`
      : ''
    this.host.innerHTML = `<svg class="fpr-xs fpr-xsx-svg${this.editable ? ' editable' : ''}" viewBox="0 0 ${W} ${H}" role="group"
        aria-label="Cross-section: height above the bed by station">
      <defs><clipPath id="${clip}"><rect x="${ML}" y="${MT}" width="${W - ML - MR}" height="${H - MT - MB}"/></clipPath></defs>
      <rect x="${ML}" y="${MT}" width="${W - ML - MR}" height="${H - MT - MB}" fill="#fff"/>
      <g clip-path="url(#${clip})">
        <path data-part="water" fill="rgba(77,163,255,0.45)" stroke="none"/>
        <path d="${fill}" fill="#efe9e1" stroke="none"/>
        <path d="${ground}" fill="none" stroke="#5b4a3a" stroke-width="1.6"/>
        <line data-part="gbf" stroke="${C_BF}" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>
        <line data-part="glb" stroke="${C_LB}" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>
        <line data-part="fp" stroke="${C_FP}" stroke-width="1.4" stroke-dasharray="2 3"/>
        <line data-part="lb" stroke="${C_LB}" stroke-width="1.6" stroke-dasharray="7 4"/>
        <line data-part="bf" stroke="${C_BF}" stroke-width="1.8"/>
        ${this.editable ? `<line data-part="hlb" class="fpr-xsx-hit" stroke="transparent" stroke-width="14"/>
        <line data-part="hbf" class="fpr-xsx-hit" stroke="transparent" stroke-width="14"/>` : ''}
      </g>
      ${grip('lb', 'Low-bank height above the bed', C_LB)}
      ${grip('bf', 'Bankfull depth', C_BF)}
      <text data-part="tfp" text-anchor="end" font-size="11" fill="${C_FP}" paint-order="stroke" stroke="#fff" stroke-width="3"></text>
      <text data-part="tlb" text-anchor="end" font-size="11" fill="${C_LB}" paint-order="stroke" stroke="#fff" stroke-width="3"></text>
      <text data-part="tbf" text-anchor="end" font-size="11" fill="${C_BF}" paint-order="stroke" stroke="#fff" stroke-width="3"></text>
      ${axis.join('')}
      <rect x="${ML}" y="${MT}" width="${W - ML - MR}" height="${H - MT - MB}" fill="none" stroke="#d5deea"/>
      <text x="${(ML + W - MR) / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#33415c">Station (ft)</text>
      <text transform="translate(13 ${(MT + H - MB) / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="#33415c">Height above bed (ft)</text>
    </svg>`
    this.svg = this.host.querySelector('svg')
    this.parts = {}
    this.svg!.querySelectorAll<SVGElement>('[data-part]').forEach((e) => {
      this.parts[e.dataset.part!] = e
    })
    this.svg!.querySelectorAll<SVGGElement>('.fpr-xsx-grip').forEach((g) => {
      this.parts[`grip-${g.dataset.line}`] = g
    })
    if (this.editable) this.wire()
    this.place()
  }

  /** Puts the lines, the water and the labels at the heights now. */
  private place(): void {
    if (!this.svg || !this.p) return
    const ft = FT_PER_M
    const line = (key: string, hM: number | null) => {
      const e = this.parts[key]
      if (!e) return
      if (hM === null) {
        e.setAttribute('visibility', 'hidden')
        return
      }
      const y = this.Y(hM * ft).toFixed(1)
      e.setAttribute('visibility', 'visible')
      for (const [k, v] of [['x1', String(ML)], ['x2', String(W - MR)], ['y1', y], ['y2', y]]) e.setAttribute(k, v)
    }
    const { bf, lb } = this.h
    const g = this.grid
    line('bf', bf)
    line('lb', lb)
    line('fp', 2 * bf)
    line('hbf', bf)
    line('hlb', lb)
    line('gbf', g && Math.abs(g.bf - bf) * ft >= 0.005 ? g.bf : null)
    line('glb', g && Math.abs(g.lb - lb) * ft >= 0.005 ? g.lb : null)
    const water = waterOutline(this.p, bf)
    this.parts.water?.setAttribute('d', water.length
      ? water.map((q, i) => `${i ? 'L' : 'M'}${this.X(q[0] * ft).toFixed(1)},${this.Y(q[1] * ft).toFixed(1)}`).join('') + 'Z' : '')
    // labels, highest first, each at least 13 px under the one above (levels often sit close)
    const labels = [
      { key: 'tbf', h: bf, text: `bankfull ${(bf * ft).toFixed(2)} ft` },
      { key: 'tlb', h: lb, text: `low bank ${(lb * ft).toFixed(2)} ft` },
      { key: 'tfp', h: 2 * bf, text: `flood-prone ${(2 * bf * ft).toFixed(2)} ft` },
    ].map((l) => ({ ...l, y: Math.max(MT + 11, this.Y(Math.min(l.h, this.top) * ft) - 4) })).sort((a, b) => a.y - b.y)
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13)
    for (const l of labels) {
      const t = this.parts[l.key]
      if (!t) continue
      t.setAttribute('x', String(W - MR - 4))
      t.setAttribute('y', l.y.toFixed(1))
      t.textContent = l.text
    }
    for (const [which, hM] of [['bf', bf], ['lb', lb]] as const) {
      const g2 = this.parts[`grip-${which}`]
      if (!g2) continue
      const y = this.Y(Math.min(hM, this.top) * ft)
      g2.querySelector('rect')?.setAttribute('y', (y - 7).toFixed(1))
      g2.querySelector('path')?.setAttribute('d', `M${ML + 11} ${(y - 2).toFixed(1)}h12M${ML + 11} ${(y + 2).toFixed(1)}h12`)
      g2.setAttribute('aria-valuenow', (hM * ft).toFixed(2))
      g2.setAttribute('aria-valuemax', (this.top * ft).toFixed(2))
      g2.setAttribute('aria-valuetext', `${(hM * ft).toFixed(2)} feet`)
    }
  }

  /** The height (m above the bed) at a pointer's page y. */
  private heightAt(clientY: number): number {
    const ctm = this.svg!.getScreenCTM()
    if (!ctm) return 0
    const y = (clientY - ctm.f) / ctm.d
    const top = this.top * FT_PER_M
    const v = this.y0 + (1 - (y - MT) / (H - MT - MB)) * (top - this.y0)
    return v / FT_PER_M
  }

  private apply(which: 'bf' | 'lb', m: number): void {
    const next = clampHeights({ ...this.h, [which]: snapFt(m) }, this.top)
    if (next.bf === this.h.bf && next.lb === this.h.lb) return
    this.h = next
    this.place()
    this.opts.onInput({ ...this.h })
  }

  private wire(): void {
    const svg = this.svg!
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.p) return
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const y = (e.clientY - ctm.f) / ctm.d
      const dBf = Math.abs(this.Y(this.h.bf * FT_PER_M) - y) * ctm.d
      const dLb = Math.abs(this.Y(this.h.lb * FT_PER_M) - y) * ctm.d
      const which = dBf <= dLb ? 'bf' : 'lb'
      if (Math.min(dBf, dLb) > NEAR_PX) return
      this.drag = { which, start: { ...this.h } }
      this.lastY = e.clientY
      svg.setPointerCapture(e.pointerId)
      svg.classList.add('dragging')
      e.preventDefault()
    })
    svg.addEventListener('pointermove', (e) => {
      if (!this.drag) return
      this.lastY = e.clientY
      if (this.frame) return
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        if (this.drag) this.apply(this.drag.which, this.heightAt(this.lastY))
      })
    })
    const end = (commit: boolean) => {
      const d = this.drag
      if (!d) return
      this.drag = null
      svg.classList.remove('dragging')
      if (this.frame) {
        cancelAnimationFrame(this.frame)
        this.frame = 0
        if (commit) this.apply(d.which, this.heightAt(this.lastY))
      }
      if (commit) {
        this.opts.onCommit({ ...this.h })
      } else {
        this.h = d.start
        this.place()
        this.opts.onInput({ ...this.h })
      }
    }
    svg.addEventListener('pointerup', () => end(true))
    svg.addEventListener('pointercancel', () => end(false))
    svg.addEventListener('lostpointercapture', () => end(false))
    svg.querySelectorAll<SVGGElement>('.fpr-xsx-grip').forEach((g) => {
      const which = g.dataset.line as 'bf' | 'lb'
      g.addEventListener('keydown', (e) => {
        const ft = e.shiftKey ? 0.01 : 0.1
        const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? ft : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -ft
          : e.key === 'PageUp' ? 1 : e.key === 'PageDown' ? -1 : 0
        if (!step) return
        e.preventDefault()
        this.apply(which, this.h[which] + step / FT_PER_M)
        clearTimeout(this.keyTimer)
        this.keyTimer = window.setTimeout(() => this.restKeys(), KEY_REST_MS)
      })
      g.addEventListener('blur', () => {
        if (this.keyTimer) this.restKeys()
      })
    })
  }

  private restKeys(): void {
    clearTimeout(this.keyTimer)
    this.keyTimer = 0
    this.opts.onCommit({ ...this.h })
  }
}
