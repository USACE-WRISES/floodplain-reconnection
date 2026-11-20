// The reach popup's cross-sections (the owner, 2026-11-19, after STAF's EASI card): pick a section the
// reach was cut from, see its chart and numbers, and set the bankfull depth and the low-bank height by
// typing them or by dragging the lines. A reach the user edits is screened on the edited sections
// (screen/edits.ts); the map, the counts and the sites follow.
//
// Two places (the owner, 2026-11-20: a cleaner popup, in two tabs): the Cross-section tab (the numbered
// section buttons, the chart, the section's numbers and heights) and a slot in the Details tab (every
// section's ratios, and the shown section's geometry).
//
// A section is drawn when the release stores its profile (one per stream line) or once the user pulls it
// from USGS 3DEP with the button: never on its own (the owner's rule, 2026-10-11). Pulled profiles are
// kept for the page's life.
import type { DataSource } from '../data/source'
import { Q_UNSAMPLED, WHY, type UnitFile } from '../data/units'
import type { Edits, SectionEdit } from '../screen/edits'
import { FT_PER_M, ratio } from '../screen/format'
import { medianProfile } from '../xs/grid'
import { pullable, ratioMedian, reachSections, scored, type ReachSection } from '../xs/reach'
import { defaultHeights, measure, profileFrom, type Measured, type Profile } from '../xs/section'
import { medianCandidate } from '../xs/xsreach'
import { esc } from './html'
import { termButton } from './ratios'
import { type Heights, XsChart } from './xschart'

const SQFT_PER_SQM = FT_PER_M * FT_PER_M
const STATUS_WORDS: Record<string, string> = {
  unbalanced: 'its profile is not balanced around the channel',
  no_dem: 'no elevation data cover it',
  too_few_points: 'too few elevation samples',
}

export interface ExplorerHost {
  readonly staf: DataSource
  readonly edits: Edits
  /** an edit was set or cleared: the screen again (the map, the pane and the popup's facts) */
  changed(): void
}

type Got =
  | { kind: 'loading', what: 'stored' | 'pull' }
  | { kind: 'ready', p: Profile, source: 'stored' | '3dep', verified: boolean }
  | { kind: 'failed', message: string }

/** Profiles pulled in this page's life, by section. */
const pulledProfiles = new Map<string, { p: Profile, verified: boolean }>()
const keyOf = (s: ReachSection): string => `${s.vpu}:${s.id}:${s.k}`
const row = (k: string, v: string): string => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`
const r2 = (x100: number | null): string => (x100 === null || !Number.isFinite(x100) ? 'n/a' : ratio(x100 / 100))
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const busy = (text: string): string => `<div class="fpr-busy"><span class="fpr-spinner"></span>${esc(text)}</div>`
/** A section's two ratios in words ("at least" where the method caps BHR or the profile runs out). */
const ratios = (m: { er: number | null, bhr: number | null, edge?: boolean, capped?: boolean }): string =>
  `BHR ${m.capped ? 'at least ' : ''}${r2(m.bhr)}, ER ${m.edge ? 'at least ' : ''}${r2(m.er)}`
const near = (a: number, b: number): boolean => Math.abs(a - b) * FT_PER_M < 0.005

/** A section's grid numbers as Measured (bfArea from its profile when drawn). */
function gridMeasured(s: ReachSection, bfArea: number | null): Measured {
  const n = s.num
  const x = (v: number | null, k: number) => (v === null ? null : Math.round(v * k))
  return { er: x(n.er, 100), bhr: x(n.bhr, 100), bfd: x(n.bfd, 100), bfw: x(n.bfw, 10), fpw: x(n.fpw, 10),
    lbh: s.det?.lbM !== null && s.det?.lbM !== undefined ? s.det.lbM * 100 : null, bfArea, edge: Boolean(n.flags & 2), capped: Boolean(n.flags & 1) }
}

export class ReachExplorer {
  private sections: ReachSection[] = []
  private i = 0
  private def = 0
  private readonly got = new Map<string, Got>()
  /** the shown section's heights (m above the bed) while it has a profile */
  private h: Heights | null = null
  /** typed or dragged, not yet committed */
  private pending = false
  private viewOnly = false
  private chart: XsChart | null = null
  private closed = false

  constructor(private readonly host: ExplorerHost, private readonly f: UnitFile, private readonly r: number,
    private readonly root: HTMLElement, private readonly details: HTMLElement) {}

  async start(): Promise<void> {
    const { f, r } = this
    if (f.q[r] === Q_UNSAMPLED || !f.n[r]) return
    this.root.innerHTML = busy("Reading the reach's cross-sections")
    let got
    try {
      got = await reachSections(this.host.staf, f.vpu[r], f.id[r], f.k0[r], f.n[r])
    } catch (err) {
      if (!this.closed) this.root.innerHTML = `<p class="fpr-note">The cross-sections could not be read: ${esc(message(err))}</p>`
      return
    }
    if (this.closed) return
    if (!got.ok) {
      this.root.innerHTML = `<p class="fpr-note">${esc(got.reason === 'region'
        ? `Cross-sections for grid region ${f.vpu[r]} are not on the data host yet, so this reach's cross-sections can't be shown or edited here.`
        : "This reach's cross-sections could not all be found in the data host's copy of the grid.")}</p>`
      return
    }
    this.sections = got.sections
    // the data host's copy must be the grid the reach was built from: its medians must come back
    const g = this.host.edits.grid(f, r)
    const ok = this.sections.filter(scored)
    this.viewOnly = ok.length !== f.nOk[r] || (ok.length > 0 && (ratioMedian(ok.map((s) => Math.round(s.num.bhr! * 100))) !== g.bhr
      || ratioMedian(ok.map((s) => Math.round(s.num.er! * 100))) !== g.er))
    this.def = medianCandidate(this.sections.map((s) => ({ position_frac: s.at, entrenchment_ratio: scored(s) ? s.num.er : null,
      bank_height_ratio: scored(s) ? s.num.bhr : null })))
    const stored = this.sections.findIndex((s) => s.stored && scored(s))
    this.layout()
    this.go(stored >= 0 ? stored : this.def)
  }

  /** The popup closes: a typed height not yet committed is kept. */
  close(): void {
    if (this.pending) this.commit()
    this.closed = true
  }

  private q<T extends Element>(sel: string): T {
    return this.root.querySelector<T>(sel)!
  }

  /** In the Details tab's slot. */
  private qd<T extends Element>(sel: string): T {
    return this.details.querySelector<T>(sel)!
  }

  private layout(): void {
    const n = this.sections.length
    this.root.innerHTML = `
      <div class="fpr-xsx-pick" role="group" aria-label="Cross-sections" data-xsx-pick>
        <span class="fpr-xsx-pick-l" aria-hidden="true">Section</span>
        ${this.sections.map((_, j) => `<button type="button" data-xsx-go="${j}">${j + 1}</button>`).join('')}
      </div>
      <div class="fpr-xsx-where" data-xsx-label></div>
      <div class="fpr-xsx-main">
        <div>
          <div class="fpr-xsx-chart" data-xsx-chart></div>
          <div class="fpr-xs-cap" data-xsx-cap></div>
        </div>
        <div class="fpr-xsx-side">
          <div class="fpr-xsx-side-h">This section</div>
          <div class="fpr-xsx-nums" data-xsx-nums></div>
          <div class="fpr-xsx-edit">
            <label>Bankfull depth<span class="fpr-xsx-in"><input type="number" class="form-control form-control-sm" data-xsx-in="bf" step="0.01" min="0.05" inputmode="decimal" aria-label="Bankfull depth, feet"> ft</span></label>
            <label>Low-bank height<span class="fpr-xsx-in"><input type="number" class="form-control form-control-sm" data-xsx-in="lb" step="0.01" min="0.05" inputmode="decimal" aria-label="Low-bank height above the bed, feet"> ft</span></label>
          </div>
          <button type="button" class="btn btn-outline-secondary btn-sm" data-xsx="reset">Reset section</button>
          <p class="fpr-note fpr-xsx-state" data-xsx-state></p>
        </div>
      </div>`
    this.details.innerHTML = `
      <h5 class="fpr-xsx-h">Every section</h5>
      <div class="fpr-tbl-wrap"><table class="fpr-tbl fpr-xsx-sections" data-xsx-table></table></div>
      <p class="fpr-note">Click a station to see it. A dot marks the profile the grid stores. &ge;2.00: no bank below twice the bankfull
        depth. &dagger;: the flood-prone width runs off the profile, so the entrenchment ratio is at least the value shown.</p>
      <h5 class="fpr-xsx-h" data-xsx-geom-h></h5>
      <table class="fpr-tbl fpr-xsx-geom"><tbody data-xsx-geom></tbody></table>`
    this.chart = new XsChart(this.q<HTMLElement>('[data-xsx-chart]'), {
      onInput: (h) => {
        this.h = h
        this.pending = true
        this.renderInfo()
      },
      onCommit: (h) => {
        this.h = h
        this.commit()
      },
    })
    this.root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-xsx], [data-xsx-go]')
      if (!t || !this.root.contains(t)) return
      if (t.dataset.xsxGo !== undefined) {
        this.go(Number(t.dataset.xsxGo))
        return
      }
      const a = t.dataset.xsx
      if (a === 'reset') this.reset()
      else if (a === 'pull') void this.pull()
    })
    // the section buttons are one stop for the Tab key: the arrow keys (Home, End) step through them
    this.q<HTMLElement>('[data-xsx-pick]').addEventListener('keydown', (e) => {
      const to = e.key === 'ArrowLeft' ? (this.i - 1 + n) % n : e.key === 'ArrowRight' ? (this.i + 1) % n
        : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
      if (to < 0) return
      e.preventDefault()
      this.go(to)
      this.q<HTMLElement>(`[data-xsx-go="${to}"]`).focus()
    })
    for (const which of ['bf', 'lb'] as const) {
      const input = this.q<HTMLInputElement>(`[data-xsx-in="${which}"]`)
      input.addEventListener('input', () => this.typed(which, input.value))
      input.addEventListener('change', () => {
        if (this.pending) this.commit()
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && this.pending) this.commit()
      })
    }
  }

  private editOf(s: ReachSection): SectionEdit | undefined {
    return this.host.edits.of(this.f, this.r)?.sections.find((e) => e.line === String(s.id) && e.k === s.k)
  }

  private stationFt(s: ReachSection): number {
    return Math.round((s.at * this.f.lenM[this.r] * FT_PER_M) / 10) * 10
  }

  /** Shows section i (the Details tab's stations table picks one this way). */
  show(i: number): void {
    if (this.chart && i >= 0 && i < this.sections.length) this.go(i)
  }

  private go(i: number): void {
    if (this.pending) this.commit()
    this.i = i
    this.h = null
    const s = this.sections[i]
    const key = keyOf(s)
    if (!this.got.has(key)) {
      const kept = pulledProfiles.get(key)
      if (kept) this.got.set(key, { kind: 'ready', p: kept.p, source: '3dep', verified: kept.verified })
      else if (s.stored && s.det) void this.loadStored(s)
    }
    this.render()
  }

  private async loadStored(s: ReachSection): Promise<void> {
    const key = keyOf(s)
    this.got.set(key, { kind: 'loading', what: 'stored' })
    try {
      const m = await medianProfile(this.host.staf, s.vpu, s.id)
      const p = m && m.k === s.k && s.det ? profileFrom(m.z, s.det, s.num.res) : null
      this.got.set(key, p ? { kind: 'ready', p, source: 'stored', verified: true } : { kind: 'failed', message: 'the stored profile could not be measured' })
    } catch (err) {
      this.got.set(key, { kind: 'failed', message: message(err) })
    }
    if (!this.closed && keyOf(this.sections[this.i]) === key) this.render()
  }

  private async pull(): Promise<void> {
    const s = this.sections[this.i]
    const key = keyOf(s)
    if (!s.det || !pullable(s)) return
    this.got.set(key, { kind: 'loading', what: 'pull' })
    this.render()
    try {
      const { pullSection } = await import('../xs/pull')
      const got = await pullSection(this.host.staf, s)
      const p = profileFrom(got.z, s.det, s.num.res)
      if (!p) throw new Error('the pulled profile could not be measured')
      pulledProfiles.set(key, { p, verified: got.verified })
      this.got.set(key, { kind: 'ready', p, source: '3dep', verified: got.verified })
    } catch (err) {
      this.got.set(key, { kind: 'failed', message: message(err) })
    }
    if (!this.closed && keyOf(this.sections[this.i]) === key) {
      this.h = null
      this.render()
    }
  }

  /** The section and its profile (when drawn) now. */
  private now(): { s: ReachSection, g: Got | undefined, e: SectionEdit | undefined } {
    const s = this.sections[this.i]
    return { s, g: this.got.get(keyOf(s)), e: this.editOf(s) }
  }

  /** The shown section's numbers: at the heights now (the grid's own at its heights), else the saved
   * edit's or the grid's. */
  private current(): { m: Measured | null, mine: boolean } {
    const { s, g, e } = this.now()
    if (g?.kind === 'ready' && this.h) {
      const [gbf, glb] = defaultHeights(g.p)
      const atGrid = near(this.h.bf, gbf) && near(this.h.lb, glb)
      return { m: atGrid ? gridMeasured(s, g.p.grid.bfArea) : measure(g.p, this.h.bf, this.h.lb), mine: !atGrid }
    }
    if (e) return { m: { er: e.er, bhr: e.bhr, bfd: e.bfd, bfw: e.bfw, fpw: e.fpw, lbh: e.lbh, bfArea: null, edge: e.edge, capped: false }, mine: true }
    return { m: scored(s) ? gridMeasured(s, null) : null, mine: false }
  }

  /** Everything for the shown section, the chart included. */
  private render(): void {
    if (this.closed || !this.chart) return
    const { s, g, e } = this.now()
    if (g?.kind === 'ready') {
      const [gbf, glb] = defaultHeights(g.p)
      if (!this.h) this.h = e ? { bf: e.bfM, lb: e.lbM } : { bf: gbf, lb: glb }
      this.chart.show(g.p, this.h, { bf: gbf, lb: glb }, !this.viewOnly)
    } else {
      this.chart.clear(this.emptyHtml(s, g))
    }
    this.renderInfo()
  }

  private emptyHtml(s: ReachSection, g: Got | undefined): string {
    if (!scored(s)) return `<div class="fpr-xsx-empty">The grid could not measure this section: ${esc(STATUS_WORDS[s.num.status] ?? s.num.status)}.</div>`
    if (g?.kind === 'loading') return `<div class="fpr-xsx-empty">${busy(g.what === 'stored' ? 'Reading the stored profile' : 'Pulling the section from USGS 3DEP')}</div>`
    const pull = pullable(s)
    if (g?.kind === 'failed') {
      return `<div class="fpr-xsx-empty"><p>The profile could not be read: ${esc(g.message)}.</p>
        ${pull ? '<button type="button" class="btn btn-outline-primary btn-sm" data-xsx="pull">Try again</button>' : ''}</div>`
    }
    if (!pull) return '<div class="fpr-xsx-empty">The grid recorded no elevation tiles for this section, so it cannot be pulled.</div>'
    return `<div class="fpr-xsx-empty"><p>The grid stores one profile per stream line, and not this section's. Pull it from USGS 3DEP
      to draw it and set your own heights. It takes a few seconds.</p>
      <button type="button" class="btn btn-primary btn-sm" data-xsx="pull">Pull from 3DEP</button></div>`
  }

  /** The buttons, the lines, the numbers, the inputs and the Details tab's tables (not the chart): cheap
   * enough for every move. */
  private renderInfo(): void {
    if (this.closed) return
    const { s, g, e } = this.now()
    const cur = this.current()
    const m = cur.m
    const det = s.det
    const ready = g?.kind === 'ready'
    const mine = Boolean(e) || cur.mine
    const station = (x: ReachSection) => `${this.stationFt(x).toLocaleString('en-US')} ft`
    // the section buttons: the one shown, the edited ones, the stored profile, the unmeasured
    this.root.querySelectorAll<HTMLButtonElement>('[data-xsx-pick] [data-xsx-go]').forEach((b) => {
      const j = Number(b.dataset.xsxGo)
      const sj = this.sections[j]
      const ej = this.editOf(sj)
      const on = j === this.i
      const yours = Boolean(ej) || (on && cur.mine)
      const v = on && cur.mine && cur.m ? cur.m : ej ?? (scored(sj) ? gridMeasured(sj, null) : null)
      b.classList.toggle('on', on)
      b.classList.toggle('edited', yours)
      b.classList.toggle('stored', sj.stored)
      b.classList.toggle('muted', !v)
      b.setAttribute('aria-pressed', String(on))
      b.tabIndex = on ? 0 : -1
      const label = `Section ${j + 1}, ${station(sj)}: ${v ? ratios(v) : 'not measured'}${yours ? ', your heights' : ''}${sj.stored ? ', stored profile' : ''}`
      b.title = label
      b.setAttribute('aria-label', label)
    })
    const tags = [this.i === this.def ? 'nearest the reach medians' : '', s.stored ? 'stored profile' : '', mine ? 'your heights' : '']
    this.q<HTMLElement>('[data-xsx-label]').textContent = [`${station(s)} from the upstream end`, ...tags.filter(Boolean)].join(' · ')
    const ftOf = (v: number | null, k: number) => (v === null ? 'n/a' : `${((v / k) * FT_PER_M).toFixed(1)} ft`)
    const sqft = (m2: number | null | undefined) => (m2 === null || m2 === undefined ? 'n/a' : `${(m2 * SQFT_PER_SQM).toFixed(1)} sq ft`)
    const num = (k: string, v: string) => `<span>${k}</span><b>${v}</b>`
    this.q<HTMLElement>('[data-xsx-nums]').innerHTML = m ? [
      num(termButton('bhr', 'BHR'), `${m.capped ? 'at least ' : ''}${r2(m.bhr)}`),
      num(termButton('er', 'ER'), `${m.edge ? 'at least ' : ''}${r2(m.er)}`),
      num('Bankfull', `${ftOf(m.bfd, 100)} deep, ${ftOf(m.bfw, 10)} wide`),
      num('Flood-prone', `${ftOf(m.fpw, 10)} wide`),
    ].join('') : '<span>Not measured</span>'
    // the Details tab: the shown section's geometry
    this.qd<HTMLElement>('[data-xsx-geom-h]').textContent = `Section ${this.i + 1}, ${station(s)}${mine ? ', your heights' : ''}`
    this.qd<HTMLElement>('[data-xsx-geom]').innerHTML = [
      row('Bieger region', esc(det?.division ?? 'n/a')),
      row('Bieger cross-section area', sqft(det?.rcArea)),
      row('Bankfull depth', ftOf(m?.bfd ?? null, 100)),
      row('Bankfull width', ftOf(m?.bfw ?? null, 10)),
      row('Bankfull cross-section area', sqft(m?.bfArea)),
      row('Flood-prone width', `${ftOf(m?.fpw ?? null, 10)}${m?.edge ? ' &dagger;' : ''}`),
      row('Low-bank height', ftOf(m?.lbh ?? null, 100)),
    ].join('')
    // the inputs: the heights now (the one being typed in is left alone)
    const heights: Heights | null = ready && this.h ? this.h : e ? { bf: e.bfM, lb: e.lbM }
      : det && det.bfM !== null && det.lbM !== null ? { bf: det.bfM, lb: det.lbM } : null
    for (const which of ['bf', 'lb'] as const) {
      const input = this.q<HTMLInputElement>(`[data-xsx-in="${which}"]`)
      input.disabled = !ready || this.viewOnly
      if (document.activeElement !== input) input.value = heights ? (heights[which] * FT_PER_M).toFixed(2) : ''
    }
    this.q<HTMLButtonElement>('[data-xsx="reset"]').disabled = this.viewOnly || !(e || (ready && cur.mine))
    const res = s.num.res ? `${s.num.res} m` : ''
    this.q<HTMLElement>('[data-xsx-cap]').textContent = g?.kind !== 'ready' ? ''
      : g.source === 'stored' ? `The grid's stored profile, USGS 3DEP ${res}. Heights above the bed.`
        : g.verified ? `Pulled from USGS 3DEP ${res}. Heights above the bed.`
          : `Pulled from USGS 3DEP ${res}. It may differ slightly from the grid's own samples.`
    this.q<HTMLElement>('[data-xsx-state]').textContent = this.viewOnly
      ? "View only: the data host's copy of these cross-sections differs from the one this reach was built from, so they can't be edited."
      : ready ? (cur.mine ? 'Your heights. This reach is screened on your edited sections.' : "The grid's heights. Drag a line or type a height to set your own.")
        : e ? 'Your saved heights. Pull the section to see or change them.' : ''
    this.renderTable()
  }

  private renderTable(): void {
    const { f, r } = this
    const gv = this.host.edits.grid(f, r)
    const atCap = (gv.why & WHY.atCap) !== 0
    const edited = f.edited[r] > 0
    const live = this.current()
    const cells = (key: 'er' | 'bhr') => this.sections.map((s, j) => {
      const e = this.editOf(s)
      const on = j === this.i ? ' on' : ''
      if (j === this.i && live.mine && live.m) return `<td class="num live${on}">${r2(live.m[key])}</td>`
      if (e) return `<td class="num edited${on}">${r2(e[key])}</td>`
      if (!scored(s)) return `<td class="num muted${on}">&middot;</td>`
      const v = s.num[key]!
      const mark = key === 'bhr' && s.num.flags & 1 ? '&ge;' : ''
      const dag = key === 'er' && s.num.flags & 2 ? '&dagger;' : ''
      return `<td class="num${on}">${mark}${r2(Math.round(v * 100))}${dag}</td>`
    }).join('')
    this.qd<HTMLElement>('[data-xsx-table]').innerHTML = `<thead><tr><th>Station</th>${this.sections.map((s, j) =>
      `<th class="num${j === this.i ? ' on' : ''}" data-xsx-go="${j}" title="Show this cross-section">${this.stationFt(s).toLocaleString('en-US')} ft${s.stored ? ' <span class="fpr-xsx-dot" aria-label="stored profile">&bull;</span>' : ''}</th>`).join('')}
      <th class="num">Reach median</th>${edited ? '<th class="num">Screened on</th>' : ''}</tr></thead>
      <tbody>
        <tr><th>Entrenchment ratio</th>${cells('er')}<td class="num">${r2(gv.er)}</td>${edited ? `<td class="num edited">${r2(f.er[r])}</td>` : ''}</tr>
        <tr><th>Bank height ratio</th>${cells('bhr')}<td class="num">${atCap ? '&ge;' : ''}${r2(gv.bhr)}</td>${edited ? `<td class="num edited">${r2(f.bhr[r])}</td>` : ''}</tr>
      </tbody>`
  }

  private typed(which: 'bf' | 'lb', value: string): void {
    const v = Number(value)
    if (!this.h || !Number.isFinite(v) || v <= 0) return
    this.h = { ...this.h, [which]: Math.max(v, 0.05) / FT_PER_M }
    this.pending = true
    this.chart?.set(this.h)
    this.renderInfo()
  }

  /** The heights now become the section's edit (or, back at the grid's heights, its edit goes). */
  private commit(): void {
    this.pending = false
    if (this.viewOnly || this.closed) return
    const { s, g, e } = this.now()
    if (g?.kind !== 'ready' || !this.h) return
    const [gbf, glb] = defaultHeights(g.p)
    const bf = near(this.h.bf, gbf) ? gbf : this.h.bf
    const lb = near(this.h.lb, glb) ? glb : this.h.lb
    this.h = { bf, lb }
    if (bf === gbf && lb === glb) {
      if (!e) {
        this.renderInfo()
        return
      }
      this.host.edits.clearSection(this.f, this.r, String(s.id), s.k)
    } else {
      if (e && e.bfM === bf && e.lbM === lb) {
        this.renderInfo()
        return
      }
      const m = measure(g.p, bf, lb)
      this.host.edits.setSection(this.f, this.r, s.vpu, { line: String(s.id), k: s.k, i: this.i, bfM: bf, lbM: lb, er: m.er, bhr: m.bhr,
        bfd: m.bfd, bfw: m.bfw, fpw: m.fpw, lbh: m.lbh, edge: m.edge, res: s.num.res, profile: g.source })
    }
    this.chart?.set(this.h)
    this.host.changed()
    this.renderInfo()
  }

  private reset(): void {
    const { s, g, e } = this.now()
    this.pending = false
    if (g?.kind === 'ready') {
      const [bf, lb] = defaultHeights(g.p)
      this.h = { bf, lb }
      this.chart?.set(this.h)
    }
    if (e) {
      this.host.edits.clearSection(this.f, this.r, String(s.id), s.k)
      this.host.changed()
    }
    this.renderInfo()
  }

  /** Clears the user's edits on the whole reach (the popup's summary has the link). */
  clearReach(): void {
    if (!this.host.edits.of(this.f, this.r)) return
    if (!window.confirm("Clear your cross-section edits on this reach? It goes back to the grid's values.")) return
    this.pending = false
    this.host.edits.clearReach(this.f, this.r)
    this.h = null
    this.host.changed()
    this.render()
  }
}
