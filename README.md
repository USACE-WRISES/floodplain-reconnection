# Floodplain Reconnection Decision Tool

A web application that helps U.S. Army Corps of Engineers teams find, compare and choose floodplain
reconnection projects. The Engineer Research and Development Center (ERDC) is building it for the
Ecosystem Management and Restoration Research Program (EMRRP), fiscal years 2027 to 2029.

**Open it:** https://usace-wrises.github.io/floodplain-reconnection/ (beta)

## The four steps

| Step | What it does | Status |
|---|---|---|
| 1. Screen sites | Find candidate reaches from the national cross-section grid | Beta |
| 2. Select measures | Match feasible reconnection measures to each site | Planned, alpha September 2027 |
| 3. Predict benefits | Estimate the achievable lift for each site and measure | Planned, beta July 2028 |
| 4. Decide | Compare benefits, costs and feasibility | Planned, public July 2029 |

## Step 1, Screen sites

1. **Study area.** Pick HUC12 watersheds (and whole HUC10s or HUC8s), everything upstream of a point,
   or the reaches you pick (one by one, or with Shift and drag a box at a time).
2. **Screen.** Every stream reach of about 1,000 ft is colored by its bank height ratio or entrenchment
   ratio. The team sets the criteria, and each criterion shows how many reaches it leaves.
3. **Shortlist.** Reaches that meet the criteria and touch along a main stem make candidate sites,
   ranked, kept or dropped, with notes and a stored cross-section where one exists.
4. **Report.** The shortlist as CSV and GeoJSON, every reach as CSV, a printable summary, and a saved
   screening that Open reads back.

Clicking a reach opens its cross-sections: each section's geometry and ratios beside the reach medians,
the profile the grid stores drawn at once and any other pulled from USGS 3DEP on request. The user can
drag the bankfull and low-bank lines (or type the heights) to set their own; a reach the user edits is
screened on the edited sections, and the edits are saved with the screening.

The values are raw values from the grid, not condition classes. Classes stay off until they pass a
field check set in advance. `docs/methods.md` describes the method and its limits.

## How it is built

| Folder | What it holds |
|---|---|
| `web/` | The app: TypeScript, Vite and Leaflet, a static site with no server. Its look follows STAF's web app |
| `data/` | The builder of the reach layer the app reads (Python) |
| `docs/` | The method and its limits |

The reach layer is built from the national cross-section grid (STAF's `staf-xs-current` release) and
NHDPlus High Resolution, and published in a folder of a Hugging Face dataset that browsers can read by
HTTP range. The app reads it there; nothing runs on a server. `data/README.md` describes the layer.

## Run it locally

With Node 22 or later:

```bash
npm --prefix web ci
npm --prefix web run dev        # the app at http://localhost:5200
npm --prefix web test           # every test
npm --prefix web run build      # the site, in web/dist
```

The dev server reads a local copy of the reach layer from the folder named by `FPR_DATA` (the folder
that holds `floodplain-reconnection/`), and STAF's stored cross-sections from `FPR_STAF_DATA`.
`CONTRIBUTING.md` has the house rules and how a release is made.

## Limits

- Screening level only. The grid is still being built in the West; wide rivers, lakes and connectors
  are not sampled.
- The criteria's starting values are placeholders for the project team to set.
