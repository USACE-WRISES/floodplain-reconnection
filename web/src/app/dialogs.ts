// The words: About, Help, Methods and limits (dialogs), and the planned steps 2 to 4 (shown in the
// workflow pane). No em or en dashes, US spelling, plain sentences (CONTRIBUTING.md).
import type { FprIndex } from '../data/index'
import { APP_NAME, APP_VERSION, ISSUES_URL, REPO_URL } from '../version'
import { esc } from './html'
import { showModal } from './modal'
import { CONNECTIVITY, ratiosFigure } from './ratios'

export function showAbout(idx: FprIndex | null, dataVersion: string): void {
  const built = idx ? Object.keys(idx.huc8).length : 0
  const regions = idx?.regions.length ?? 0
  showModal('About', `
    <p>The ${esc(APP_NAME)} helps U.S. Army Corps of Engineers teams find, compare and choose floodplain
    reconnection projects. The Engineer Research and Development Center (ERDC) is building it for the Ecosystem
    Management and Restoration Research Program (EMRRP), fiscal years 2027 to 2029.</p>
    <h5>Four steps</h5>
    <ol>
      <li><b>Screen sites.</b> Find candidate reaches and constraints. This beta.</li>
      <li><b>Select measures.</b> Match feasible reconnection measures to each site. Planned.</li>
      <li><b>Predict benefits.</b> Estimate the achievable lift for each site and measure. Planned.</li>
      <li><b>Decide.</b> Compare benefits, costs and feasibility. Planned.</li>
    </ol>
    <h5>Data</h5>
    <p>Reach values come from the national cross-section grid built for the Stream Tiered Assessment Framework
    (STAF): a cross-section every 100 ft on NHDPlus High Resolution streams, measured on USGS 3DEP elevation data.
    This copy covers ${regions.toLocaleString('en-US')} grid regions and ${built.toLocaleString('en-US')} HUC8 watersheds.
    The western regions are still being built. Data version <code>${esc(dataVersion)}</code>.</p>
    <h5>Privacy</h5>
    <p>Your screening stays in this browser. The page downloads data and map tiles, and place searches go to the
    Photon search service. Save writes your screening to a file on your computer.</p>
    <p>Version ${esc(APP_VERSION)}, beta. Results are screening level only. <a href="${REPO_URL}" target="_blank" rel="noopener">Source</a>
    and <a href="${ISSUES_URL}" target="_blank" rel="noopener">feedback</a>.</p>`)
}

export function showHelp(): void {
  showModal('Help', `
    <h5>1. Study area</h5>
    <p>Choose <b>Watersheds</b>, pick a size (HUC12, HUC10 or HUC8), and click the map to add or remove a watershed
    of that size; <b>Upstream</b>, and click a stream to take everything upstream of it; or <b>Reaches</b>, and click the
    reaches you want. In Reaches, hold Shift and drag to add every reach in a box, as many boxes as you like.</p>
    <h5>2. Screen</h5>
    <p>Set the drainage area, bank height ratio and entrenchment ratio a reach needs. Beside each box is the number
    of reaches left after it. Uncheck a row to turn its criterion off; its box keeps the value. The last row joins
    the passing reaches into sites, and the card on top counts the candidate sites your study reaches make. The
    shortest site starts unchecked, so every run of passing reaches is a site: reaches run about 1,000 ft, and over
    half are a little shorter. <b>More settings</b> holds the gaps a site can span, the largest drainage area, the
    quality filters, and <b>Reset to starting values</b>. Point at an <b>i</b>, or at a dotted name such as
    <b>Bank height ratio</b>, for what it means. The starting values are placeholders for the project team to
    set.</p>
    <h5>3. Shortlist</h5>
    <p>A candidate site is a run of reaches that meet the criteria along a stream's main stem. A tributary starts a
    site of its own. Rank the sites, keep or drop each one, add notes, and open a site for its reach by reach values
    and a stored cross-section where one exists.</p>
    <h5>4. Report</h5>
    <p>Download the shortlist as CSV or GeoJSON (for GIS or a finer screen such as FluvialGeomorph), every reach of
    the study area as CSV, or a printable summary. <b>Save</b> writes your study area, criteria, decisions and
    cross-section edits to a file that <b>Open</b> reads back.</p>
    <h5>A reach's cross-sections</h5>
    <p>Click a reach to open it, and pick a section with the numbered buttons or on the small map beside the
    chart, which shows where each section lies and the reach's flood-prone area from each section's width. A
    section the grid stores is drawn at
    once; <b>Pull from 3DEP</b> draws any other. Drag the bankfull or low-bank line, or type the heights, to set your
    own: the reach is then screened on your edited sections, and the map and the sites follow. <b>Details</b> lists
    every section's ratios and the reach's values.</p>
    <h5>On the map</h5>
    <ul>
      <li>Zoom in past the coverage outlines to see reaches anywhere the grid is built.</li>
      <li>Point at a reach for its values. Click it for its cross-sections and details.</li>
      <li>The legend's <b>Color by</b> buttons color the reaches by bank height ratio (BHR), entrenchment ratio
      (ER), or the candidate sites (Sites).</li>
      <li>Dashed reaches carry a caution. Gray reaches have no data (BHR, ER) or were screened out (Sites); point at
      one to see why.</li>
      <li>Turn on <b>Cross-sections</b> in the layers menu to see every section a reach is measured on, from zoom 15
      in.</li>
      <li>Turn on <b>Flood-prone area</b> for a band as wide as each reach's flood-prone width (the median of its
      sections), from zoom 13 in.</li>
    </ul>
    <p><a href="#" data-open-methods>Methods and limits</a></p>`)
}

export function showMethods(idx: FprIndex | null): void {
  const rule = idx?.rule
  showModal('Methods and limits', `
    <h5>What the two ratios measure</h5>
    <p>${esc(CONNECTIVITY)}</p>
    ${ratiosFigure()}
    <p><b>Bank height ratio (BHR)</b> is the low-bank height divided by the bankfull depth. Near 1.0 the channel
    spills onto its floodplain at bankfull flow. Higher values mean the channel is cut down below its floodplain.
    The method stops at 2.00: where no bank is found below twice the bankfull depth, the ratio reads
    "at least 2.00".</p>
    <p><b>Entrenchment ratio (ER)</b> is the width of the water at the flood-prone stage (twice the bankfull depth)
    divided by the bankfull width. Low values mean high flows stay in the channel. High values mean they spread
    out across the valley.</p>
    <p>Bankfull depth and width come from regional curves (Bieger and others, 2015) at each cross-section's
    drainage area, fitted to the section's ground. The values here are raw values, not condition classes.</p>
    <p><b>The flood-prone area on the map</b> is an estimate. The grid holds each section's flood-prone width, not
    its two edges, so the area is centered on the stream; where the ground is lower on one side, the real area
    leans that way. The <b>Flood-prone area</b> layer draws each reach's median width, joined to the next
    reach's. A reach's popup joins each section's own width, and leaves out a section whose lowest ground lies
    away from this stream, since its width then belongs to another low spot.</p>
    <h5>Reaches</h5>
    <p>A reach is about 1,000 ft of stream: ${rule?.unit_sections ?? 10} cross-sections, cut along the main stem.
    A reach never crosses a junction where the drainage area more than doubles. Its values are the medians of the
    cross-sections measured, as in STAF's screening tool (EASI).</p>
    <h5>Quality</h5>
    <ul>
      <li><b>Not enough data</b> (gray): fewer than 3 cross-sections measured, a ratio outside its physical range,
      or a cap that only reflects a channel too shallow for the elevation data.</li>
      <li><b>Use with caution</b> (dashed): bankfull from a regional curve used outside its range, banks found only
      by the highest ground, 3 or 4 sections measured, a flood-prone width that runs off the sampled line, or a
      3 m or 10 m elevation model.</li>
    </ul>
    <h5>Your cross-section edits</h5>
    <p>On a section's 3DEP profile (stored, or pulled again exactly as the grid sampled it), you can set the bankfull
    depth and the low-bank height. The section is then measured as the grid measures it, at your heights: the
    flood-prone stage is the bed plus twice your bankfull depth, and the bank height ratio is your low-bank height
    over your bankfull depth, with no cap. A reach you edit is screened on your edited sections only (their median
    when several); the grid's flags no longer apply to it, except a ratio outside its physical range ("not enough
    data"), and a flood-prone width that runs off the profile or a 3 m or 10 m elevation model ("use with caution").</p>
    <h5>Sites</h5>
    <p>Reaches that meet every criterion and touch along a main stem make a candidate site. Short gaps can be
    bridged. With a shortest site set, a run shorter than it is not a site, and the map draws it gray. Site values
    are the medians of their reaches' values.</p>
    <h5>Coverage</h5>
    <ul>
      <li>The grid is still being built in the West. Outlines on the map show where reaches exist.</li>
      <li>Wide rivers mapped as artificial paths, lakes and connectors are not sampled. Large leveed rivers will be
      screened from levee and floodplain layers instead.</li>
      <li>In flat coastal plains, much of the bankfull size is extrapolated, and the values need a field check
      before any reach is ruled out.</li>
    </ul>
    <h5>Field check</h5>
    <p>At 1,340 EPA National Rivers and Streams Assessment sites in eastern and central regions, the grid's raw
    values track field measurements: the bank height ratio follows the field incision ratio (Spearman rho 0.30),
    and the low-bank height follows the field incision height (rho 0.64). That is an association, not a
    validation of any one site. The entrenchment ratio has no field check yet. Condition classes stay off until
    they pass a field check set in advance.</p>
    <h5>Planned</h5>
    <p>Additional geomorphic metrics from FluvialGeomorph (ERDC) for a finer screen, once the project team agrees
    which. Starting values for the criteria, set by the team in Task 2.</p>`, { size: 'lg' })
}

export interface PlannedStep { n: number, title: string, when: string, body: string }

export const PLANNED: Record<number, PlannedStep> = {
  2: {
    n: 2, title: 'Select measures', when: 'Planned for the alpha, September 2027',
    body: `<p>A decision tree that helps Districts pick reconnection measures that fit the site and region.</p>
      <ul>
        <li><b>Physical context.</b> Room to work, slope, incision, constraints. The Step 1 values answer these
        questions for each candidate site.</li>
        <li><b>Valley history.</b> Past channel form, legacy sediment.</li>
        <li><b>Target stream functions.</b> What the project should restore.</li>
      </ul>
      <p>Measures: floodplain benching, two-stage channel, natural channel design, Stage 0, valley restoration,
      beaver dam analogs and leaky dams. Each answer carries its reasons, sources and regional evidence.</p>
      <p>A team that already has a site starts here.</p>`,
  },
  3: {
    n: 3, title: 'Predict benefits', when: 'Planned for the beta, July 2028',
    body: `<p>The achievable lift for each site and measure, in four goods and services:</p>
      <ul>
        <li>Flood peak reduction</li>
        <li>Sediment capture</li>
        <li>Water resource improvement</li>
        <li>Aquatic and floodplain habitat</li>
      </ul>
      <p>Each is scored from the STAF stream functions that support it, at three levels: a screening level from
      precomputed indicators and quick calculations in the browser, a rapid level from a SFARI field visit, and a
      detailed level from results of models a District already runs, such as HEC-RAS. Calibrated to published
      and District case studies.</p>`,
  },
  4: {
    n: 4, title: 'Decide', when: 'Planned for the public release, July 2029',
    body: `<p>Compare options on benefit units (lift times extent, in acres reconnected or stream miles),
      screening cost ranges and feasibility.</p>
      <p>The result is a decision package (sites, measures, benefit units, feasibility) for alternatives design,
      cost estimating and a cost-effectiveness analysis in CEICA.</p>`,
  },
}

export function plannedPane(step: number): string {
  const p = PLANNED[step]
  return `<div class="fpr-pane-head">Step ${p.n}. ${esc(p.title)} <small>Planned</small></div>
    <div class="fpr-pane-body fpr-planned">
      <span class="fpr-when">${esc(p.when)}</span>
      ${p.body}
      <div class="fpr-actions"><button type="button" class="btn btn-primary btn-sm" data-act="step1">Back to Step 1. Screen sites</button></div>
    </div>`
}
