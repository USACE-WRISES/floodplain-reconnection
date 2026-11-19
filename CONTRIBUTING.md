# Contributing

The app is a static web app (TypeScript and Vite, in `web/`) published on GitHub Pages. The reach
layer it reads is built by `data/` (Python) and published to a Hugging Face dataset.

## Commands

With Node 22 or later:

```bash
npm --prefix web ci              # the tools
npm --prefix web run dev         # the app at http://localhost:5200
npm --prefix web test            # every test (Vitest)
npm --prefix web run typecheck   # the app
npm --prefix web run build       # the site, in web/dist
npm --prefix web run preview     # the built site at http://localhost:5201/floodplain-reconnection/
```

`data/README.md` has the builder's commands and tests.

## Rules

1. **Raw values, not condition classes.** The map and the exports show the grid's values and the
   team's criteria. Condition classes stay off until they pass a field check set in advance.
2. **The app and the builder screen the same way.** `web/tests/fixtures.test.ts` holds the app's funnel
   and sites to the counts the builder writes (`data/run.py fixtures`).
3. **Results are never stored.** A saved screening holds the study area, the criteria and the team's
   decisions; everything else is recomputed when it opens.
4. **This app's names in the browser.** Every USACE-WRISES site shares one origin, so caches, storage
   keys and worker messages start with `fpr-` (`web/tests/repo_rules.test.ts` checks).
5. **Written into the page.** Stylesheets are inline and each download opens its own tab, both needed
   under the USACE network's browser isolation.
6. **Copy rules.** No em or en dashes in what people read, US spelling, `n/a` for missing values, plain
   words.
7. **Version lockstep.** The top section of `CHANGELOG.md` = `APP_VERSION` in `web/src/version.ts` =
   `web/package.json` and its lock = `CITATION.cff`. A release has at most 10 bullets of one line each.
8. **The repository reads as its authors' work.** No file or commit message names an AI tool or carries
   a co-author trailer, and no personal data or machine paths are committed.

## Releasing

1. Add a section at the top of `CHANGELOG.md` and move the version with it (rule 7).
2. Run `npm --prefix web run typecheck` and `npm --prefix web test`.
3. Push to `main`. The Pages workflow (`.github/workflows/pages.yml`) tests, builds and deploys.
4. Tag `vX.Y.Z` and publish a GitHub Release with the CHANGELOG section.
