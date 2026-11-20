# The web app

The Floodplain Reconnection Decision Tool as a static web app, served by GitHub Pages at
`https://usace-wrises.github.io/floodplain-reconnection/`. It runs in the browser: it reads the reach
layer from a Hugging Face dataset by HTTP range and draws it over USGS basemaps. Nothing runs on a
server.

## Commands

```bash
npm --prefix web ci                 # the tools (Node 22 or later)
npm --prefix web run dev            # the page at http://localhost:5200/
npm --prefix web run build          # the site, into web/dist
npm --prefix web run preview        # the built site at http://localhost:5201/floodplain-reconnection/
npm --prefix web test               # Vitest: every test in tests/
npm --prefix web run typecheck      # the app
```

In development, `/data` serves a local copy of the reach layer (`FPR_DATA`: the folder that holds
`floodplain-reconnection/`) and `/staf-data` a local copy of STAF's browser layout (`FPR_STAF_DATA`),
both with range reads. A page can be pointed at other copies with `?data=<url>` and `?staf=<url>`;
`?cache=0` reads past the browser's copy of the data, and `?debug=1` puts the app on `window.fprApp`.

## Layout

| Path | What it holds |
|---|---|
| `index.html`, `site.ts` | The page: `site.ts` (a Vite plugin) writes the stylesheets into its head |
| `page/` | Files served as they are: `fpr.css` (the look, after STAF's web app), Bootstrap's stylesheet as Shiny for Python bundles it, Leaflet's stylesheet, the fonts, the download worker, `licenses.txt` |
| `src/data/` | The data layer: `source.ts`, `cache.ts`, `signed.ts`, `range.ts`, `parquet.ts`, `zstd.ts` (adapted from STAF's web app), `units.ts` (a HUC8's reaches as typed arrays), `index.ts` (the layer's index), `staf.ts` (a stored cross-section from STAF's layout) |
| `src/screen/` | The network (`model.ts`: rows across files, links, the upstream walk, study areas), the screen (`screen.ts`: criteria, funnel, sites), the Screen step's rows (`rows.ts`: on, off and the values they keep) and the words (`format.ts`) |
| `src/map/` | The map (`map.ts`), the reach canvas with its hit grid (`unitLayer.ts`), the color ramps (`ramp.ts`) |
| `src/app/` | The app (`app.ts`: steps, panes, map events), the two ratios' cards and diagrams (`ratios.ts`), dialogs, exports, search, downloads, toasts |
| `tests/` | Vitest: the screen on a synthetic network, the exports, the repository's rules, and the builder's fixtures |

## Under the USACE network's browser isolation

Two things STAF's web app learned are kept here: stylesheets are written into the page (a linked
stylesheet did not apply), and each download opens its own tab through a small service worker scoped
to `download/` (the isolation shows a file in place of the tab it came to). Every USACE-WRISES site
shares one origin, so this app's caches, storage keys and worker messages start with `fpr-`.
