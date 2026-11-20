// The two ratios explained where their names appear (the owner, 2026-11-20). Pointing at "Bank height
// ratio" or "Entrenchment ratio" (in the Screen rows, the legend's title or a reach's popup) shows a
// card with the ratio drawn on a cross-section; Methods and limits draws both. One incised channel is
// drawn for each ratio, in the colors of a reach popup's chart (xschart.ts): blue the bankfull stage,
// green dashes the low bank, brown dots twice the bankfull depth. No em or en dashes, US spelling.
import { esc } from './html'

export type Term = 'bhr' | 'er'
export const TERM_NAME: Record<Term, string> = { bhr: 'Bank height ratio', er: 'Entrenchment ratio' }

const BANKFULL = '#1f6fc0'
const LOW_BANK = '#2f855a'
const FLOOD_PRONE = '#9a6b3f'
const WATER = 'rgba(77,163,255,.45)'
const FLOOD_WATER = 'rgba(77,163,255,.16)'
const GROUND = '#e7dccb'
const GROUND_LINE = '#5b4a3a'

/** The button that shows a ratio's card: its full name, or a short text (BHR) named in full for a screen
 * reader. */
export function termButton(t: Term, text = TERM_NAME[t]): string {
  const name = text === TERM_NAME[t] ? '' : ` aria-label="${esc(TERM_NAME[t])}"`
  return `<button type="button" class="fpr-term" data-term="${t}"${name}>${esc(text)}</button>`
}

// The channel, 300 by 150 units: a high terrace on the left, the bed, a lower bank on the right (the
// low bank), its floodplain, and the valley wall. The bed is at y 120, bankfull at y 80 (d = 40), the low
// bank at y 50 (h = 70: BHR 1.75), twice the bankfull depth at y 40.
const GROUND_EDGE = 'M0 10L95 10L135 120L165 120L200 50L255 50L290 5L300 5'
const BANKFULL_WATER = 'M120.5 80L185 80L165 120L135 120Z'
/** the water at twice the bankfull depth: over the low bank's floodplain, to the valley wall */
const FLOOD_PRONE_WATER = 'M105.9 40L135 120L165 120L200 50L255 50L262.8 40Z'

let figures = 0

/** One ratio drawn on the channel, as an SVG string. */
export function ratioFigure(t: Term): string {
  // arrowheads, one per color, named apart from any other figure on the page
  const id = `fpr-ratio-${++figures}`
  const head = (color: string) => `<marker id="${id}-${color.slice(1)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>`
  const arrow = (x1: number, y1: number, x2: number, y2: number, color: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" marker-start="url(#${id}-${color.slice(1)})" marker-end="url(#${id}-${color.slice(1)})"/>`
  const letter = (x: number, y: number, s: string, anchor = 'middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="12" font-style="italic" fill="#1f2937">${s}</text>`
  const ground = `<path d="${GROUND_EDGE}L300 150L0 150Z" fill="${GROUND}"/>`
  const edge = `<path d="${GROUND_EDGE}" fill="none" stroke="${GROUND_LINE}" stroke-width="1.5"/>`
  const bankfull = `<path d="${BANKFULL_WATER}" fill="${WATER}"/>`
  const stage = `<line x1="120.5" y1="80" x2="185" y2="80" stroke="${BANKFULL}" stroke-width="2"/>`
  let body: string
  let title: string
  if (t === 'bhr') {
    title = 'Bank height ratio: the height of the lower bank above the bed, h, over the bankfull depth, d'
    body = `<defs>${head(BANKFULL)}${head(LOW_BANK)}</defs>${ground}${bankfull}${edge}${stage}
      <line x1="109.5" y1="50" x2="200" y2="50" stroke="${LOW_BANK}" stroke-width="1.5" stroke-dasharray="7 4"/>
      ${arrow(143, 117, 143, 83, BANKFULL)}${arrow(157, 117, 157, 53, LOW_BANK)}
      ${letter(139, 106, 'd', 'end')}${letter(162, 69, 'h', 'start')}`
  } else {
    title = 'Entrenchment ratio: the width of the water at twice the bankfull depth, W, over the bankfull width, w'
    body = `<defs>${head(BANKFULL)}${head(FLOOD_PRONE)}</defs>${ground}<path d="${FLOOD_PRONE_WATER}" fill="${FLOOD_WATER}"/>${bankfull}${edge}${stage}
      <line x1="105.9" y1="40" x2="262.8" y2="40" stroke="${FLOOD_PRONE}" stroke-width="1.5" stroke-dasharray="2 3"/>
      ${arrow(109, 28, 259.8, 28, FLOOD_PRONE)}${arrow(127, 92, 177, 92, BANKFULL)}
      ${letter(184, 20, 'W')}${letter(152, 112, 'w')}`
  }
  return `<svg class="fpr-ratio-fig" viewBox="0 0 300 150" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${body}</svg>`
}

const READ: Record<Term, string> = {
  bhr: 'Near 1.0 the stream spills onto its floodplain at bankfull flow. Higher, it is cut down (incised), and only bigger floods reach the floodplain. The method stops at 2.00.',
  er: 'Low, high flows stay in the channel. High, they spread out across the valley.',
}

/** What both ratios are for (the owner, 2026-11-20). */
export const CONNECTIVITY = 'Both ratios are standard measures of floodplain connectivity: how readily high flows leave the channel and spread over the floodplain.'

/** The card a ratio's name shows. */
export function ratioCard(t: Term): string {
  const bhr = t === 'bhr'
  return `<div class="fpr-card-title">${esc(TERM_NAME[t])} (${bhr ? 'BHR' : 'ER'})</div>
    ${ratioFigure(t)}
    <div class="fpr-card-eq">${bhr ? 'BHR = h ÷ d' : 'ER = W ÷ w'}</div>
    <div class="fpr-card-def">${bhr
      ? '<i>h</i>: height of the lower bank above the bed<br><i>d</i>: bankfull depth'
      : '<i>W</i>: width of the water at twice the bankfull depth<br><i>w</i>: bankfull width'}</div>
    <p>${esc(READ[t])}</p>
    <p class="fpr-card-note">${esc(CONNECTIVITY)} A reach shows the median of its cross-sections.</p>`
}

/** Both ratios side by side, for Methods and limits. */
export function ratiosFigure(): string {
  return `<div class="fpr-ratios">${(['bhr', 'er'] as const).map((t) => `<figure class="fpr-ratio"><figcaption>${esc(TERM_NAME[t])}: ${t === 'bhr' ? 'BHR = h ÷ d' : 'ER = W ÷ w'}</figcaption>${ratioFigure(t)}</figure>`).join('')}</div>
    <p class="fpr-ratios-key">Blue: bankfull. Green dashes: the low bank. Brown dots: twice the bankfull depth.</p>`
}
