# The reach layer

The screener's data: the national cross-section grid (a section every 100 ft on NHDPlus HR
streams, from USGS 3DEP elevation) summarized as reaches of about 1,000 ft, with their stream lines
and network pointers, in one small Parquet file per HUC8 that the web app reads whole.

## What it is built from

| Input | What it holds |
|---|---|
| The grid release (`release.json`, `xs-<vpu>.parquet`, `xs-<vpu>-sections.parquet`, `xs-<vpu>-median.parquet`) | Every section's numbers, its low-bank height and its point, and one stored profile per line. Each file is checked against the `release.json` read at the start of a build |
| The slim NHDPlus HR lines (`lines2_<vpu>.parquet`, `manifest.json`) | The flowlines, their attributes and network steps; the grid was placed on these same lines (the build checks the dates agree) |
| The per-line values (`extras2_<vpu>.parquet`) | The HUC12 at each line's middle |
| The WBD (`WBD_National_GDB.gdb`, `huc12_5070.parquet`) | HUC8 names and outlines, HUC12 outlines |

## The rule

1. **Rows.** Stream, river, canal and ditch lines the grid sampled become reaches. Artificial paths
   and connectors (and any stream line without sections) stay as one row each, not sampled, so the
   network stays connected. Pipelines and coastline are left out.
2. **Chains.** A line continues into the line below it when that line's upstream mainstem is this
   line, both were sampled, both are streams (or both canals), both are in one HUC8, and this line
   drains at least half of the next one (`DA_BREAK = 0.5`).
3. **Reaches.** A chain of N sections is cut into max(1, floor(N/10 + 1/2)) reaches; reach j holds
   sections floor(jN/u) to floor((j+1)N/u) - 1. Chains of 15 sections or more give reaches of 7 to
   14 sections.
4. **Lines.** Section k of a line of length L with n sections owns [kL/n, (k+1)L/n] along it,
   measured in EPSG:5070 as the grid placed its sections. A reach runs from its first section's
   start to its last section's end, so the reaches of a chain tile it exactly and share their cut
   vertices.
5. **Numbers.** Over the reach's scored sections: the median, minimum and maximum bank height
   ratio and entrenchment ratio as EASI's reach rule gives them (`round(statistics.median(...), 2)`),
   and the medians of bankfull width, flood-prone width, bankfull depth and low-bank height.
6. **Quality** (`fpr-q1`), from the grid's K2b record:

   | Bit | Meaning | Tier |
   |---|---|---|
   | 1 | fewer than 3 scored sections | not enough data |
   | 2 | median bank height ratio at or below 0 | not enough data |
   | 4 | median entrenchment ratio below 1 | not enough data |
   | 8 | median bank height ratio at the 2.00 cap only through sections at the bank detector's floor | not enough data |
   | 1024 | no section has elevation data | not enough data |
   | 16 | bankfull extrapolated on most scored sections | use with caution |
   | 32 | every scored section found its bank by the crest scan | use with caution |
   | 64 | only 3 or 4 scored sections | use with caution |
   | 128 | the median entrenchment ratio's section is edge-limited | use with caution |
   | 256 | the coarsest scored elevation model is 3 m or 10 m | use with caution |
   | 512 | median bank height ratio reads "at least 2.00" | information only |

7. **Pointers.** Each row points to the row below it (`dn_huc8`, `dn_row`), says whether it is that
   row's mainstem neighbor (`main`), and a row heading a minor divergent branch points to the line it
   splits from (`div`). Links across regions are resolved through the lines' hydrologic sequence
   numbers.

## The published folder

`site/floodplain-reconnection/`, uploaded as it is:

| File | What it holds |
|---|---|
| `units/<huc8>.<sha12>.parquet` | One HUC8's rows (one row group, zstd), the columns in `fprdata/partition.py` (`COLUMNS`, `SCHEMA`) |
| `outlines/huc8.<sha12>.json.gz` | The lower 48's HUC8 outlines (GeoJSON, gzipped) |
| `outlines/huc12_<huc4>.<sha12>.json.gz` | Each built HUC4's HUC12 outlines |
| `web-index.json.gz`, `web-manifest.json` | The index: every file's stored name, size and sha256, the data version, and each HUC8's name, bounds, counts, status, regions and neighbors. Written last |

Stored names carry the first 12 hex digits of the file's sha256, so a browser cache keyed by name
never goes stale. Two builds of the same inputs give the same files.

## Commands

Paths come from flags, a paths file, or the environment:

```
python run.py --release <grid release> --lines <lines folder> --values <values folder> --wbd <WBD folder> --out <output folder> build --regions 0305,0313
```

or write `data/paths.local.json` (kept out of the repository):

```json
{"release": "...", "lines": "...", "values": "...", "wbd": "...", "out": "...", "staf": "<a STAF checkout, for the parity tests>"}
```

| Command | What it does |
|---|---|
| `python run.py build --regions <vpus>` or `--all` | Pass 1 per region into `<out>/cache/` (skipped when the region's inputs and the rule are unchanged; `--force` rebuilds), with the geometry checks against the grid's points; pass 2 into `<out>/site/` |
| `python run.py report` | `<out>/report/pilot_presets.md` and `.csv`: how each preset narrows the pilot study areas |
| `python run.py fixtures` | `<out>/fixtures/`: two HUC8 files and `expected.json`, the screening results the web app's tests compare with |
| `python -m pytest` | The tests. Those that need the data or a STAF checkout skip without them |
| `python fprdata/publish.py --site <out>/site` | Checks every stored file against `web-manifest.json` (a dry run). With `--yes` it uploads exactly the files the manifest names to the `floodplain-reconnection/` folder of the Hugging Face dataset, then `web-index.json.gz` and `web-manifest.json` last; `--verify` compares the hub with the manifest. It needs `huggingface_hub` and a login with write access (`hf auth login`), and touches nothing else in the dataset |

## Screening rules

`fprdata/screen.py` applies the same rules as the web app: the funnel (sampled reaches, canals,
quality, drainage area, bank height ratio, entrenchment ratio), candidate sites along the mainstem
paths (joining across up to `gapReaches` reaches that fall short, never across an unsampled line or
the edge of the study area, and kept when 1,000 ft or longer by default), and the upstream walk.
