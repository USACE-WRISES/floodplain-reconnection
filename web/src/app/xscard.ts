// A stored cross-section drawn as an SVG: the ground, and the bankfull, low-bank and flood-prone
// stages the grid scored it with, in feet above the bed. The view keeps the valley bottom around
// the channel (where the ground stays within a few bankfull depths of the bed).
import type { StoredProfile } from '../data/staf'
import { esc } from './html'

const FT = 3.28083989501312

function ticks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo || 1
  const raw = span / n
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

/** The SVG of a profile; '' when it has no bed or no samples. */
export function profileSvg(p: StoredProfile): string {
  const n = p.z.length
  if (!n || p.thalweg === null || p.bfM === null) return ''
  const bed = p.thalweg
  const bf = p.bfM
  const ti = p.thalwegI ?? Math.floor(n / 2)
  // the window: out from the bed while the ground stays below 4 bankfull depths (at least 30 m each side)
  const lim = bed + Math.max(4 * bf, 1.5)
  let a = ti
  let b = ti
  while (a > 0 && (Number.isNaN(p.z[a - 1]) || p.z[a - 1] <= lim)) a--
  while (b < n - 1 && (Number.isNaN(p.z[b + 1]) || p.z[b + 1] <= lim)) b++
  const pad = Math.max(30, 0.25 * (p.s[b] - p.s[a]))
  const s0 = Math.max(p.s[0], p.s[a] - pad)
  const s1 = Math.min(p.s[n - 1], p.s[b] + pad)
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) {
    if (p.s[i] < s0 || p.s[i] > s1 || Number.isNaN(p.z[i])) continue
    pts.push([p.s[i] * FT, (p.z[i] - bed) * FT])
  }
  if (pts.length < 2) return ''
  const stages = [
    { h: bf, label: 'bankfull', color: '#2b6cb0', dash: '' },
    ...(p.lbM !== null ? [{ h: p.lbM, label: 'low bank', color: '#2f855a', dash: '6 4' }] : []),
    { h: 2 * bf, label: 'flood-prone', color: '#6b7280', dash: '3 3' },
  ]
  const xs = pts.map((q) => q[0])
  const ys = pts.map((q) => q[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(0, ...ys)
  const y1 = Math.max(...ys, ...stages.map((st) => st.h * FT)) * 1.05 + 0.5
  const W = 640
  const H = 270
  const L = 52
  const R = 14
  const T = 14
  const B = 36
  const X = (v: number) => L + ((v - x0) / (x1 - x0 || 1)) * (W - L - R)
  const Y = (v: number) => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B)
  const ground = pts.map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join('')
  const fill = `${ground}L${X(x1).toFixed(1)},${Y(y0).toFixed(1)}L${X(x0).toFixed(1)},${Y(y0).toFixed(1)}Z`
  // water to bankfull, clipped by the ground (drawn under it)
  const bfY = Y(bf * FT)
  const parts: string[] = []
  parts.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="#fff"/>`)
  parts.push(`<rect x="${L}" y="${bfY.toFixed(1)}" width="${W - L - R}" height="${(Y(y0) - bfY).toFixed(1)}" fill="#bfdbfe" opacity="0.7"/>`)
  parts.push(`<path d="${fill}" fill="#e7dccb" stroke="none"/>`)
  parts.push(`<path d="${ground}" fill="none" stroke="#5b4a3a" stroke-width="1.6"/>`)
  for (const st of stages) {
    const y = Y(st.h * FT)
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${st.color}" stroke-width="1.4"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`)
  }
  // the labels, highest stage first, each at least 13 px below the one above it (stages often sit close)
  const labels = stages.map((st) => ({ st, y: Y(st.h * FT) - 4 })).sort((a, b) => a.y - b.y)
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13)
  for (const { st, y } of labels) {
    parts.push(`<text x="${W - R - 4}" y="${y.toFixed(1)}" text-anchor="end" font-size="11" fill="${st.color}" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(st.label)} ${(st.h * FT).toFixed(1)} ft</text>`)
  }
  for (const t of ticks(x0, x1, 6)) {
    parts.push(`<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${H - B}" y2="${H - B + 4}" stroke="#8a94a6"/>`)
    parts.push(`<text x="${X(t).toFixed(1)}" y="${H - B + 16}" text-anchor="middle" font-size="10.5" fill="#646f80">${Math.round(t)}</text>`)
  }
  for (const t of ticks(y0, y1, 5)) {
    parts.push(`<line x1="${L - 4}" x2="${L}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="#8a94a6"/>`)
    parts.push(`<text x="${L - 7}" y="${(Y(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#646f80">${Number(t.toFixed(1))}</text>`)
  }
  parts.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="none" stroke="#d5deea"/>`)
  parts.push(`<text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#33415c">Station (ft)</text>`)
  parts.push(`<text transform="translate(13 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="#33415c">Height above bed (ft)</text>`)
  return `<svg class="fpr-xs" viewBox="0 0 ${W} ${H}" role="img" aria-label="Stored cross-section">${parts.join('')}</svg>`
}
