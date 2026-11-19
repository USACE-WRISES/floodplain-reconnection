"""The reach layer's commands.

    python run.py build --regions 0305,0313 [--workers 6] [--force]   (or --all)
    python run.py report
    python run.py fixtures
    python run.py check

Paths come from flags (--release, --lines, --values, --wbd, --out, --staf), a paths file
(--paths, or data/paths.local.json), or the environment (FPR_RELEASE and so on). README.md says
what each folder holds.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fprdata import config as C  # noqa: E402
from fprdata import inputs, partition, region  # noqa: E402


def _paths(args) -> C.Paths:
    flags = dict((k, getattr(args, k, None)) for k in C.ENV)
    return C.Paths.load(flags, Path(args.paths) if args.paths else None)


def cmd_build(args) -> int:
    paths = _paths(args)
    paths.need("release", "lines", "values", "wbd", "out")
    t0 = time.time()
    release = inputs.Release(paths.release)
    lines_m = inputs.Lines(paths.lines, paths.values)
    inputs.check_same_bundle(release, lines_m)
    if args.all:
        regions = release.packed
    elif args.regions:
        regions = sorted(set(r.strip() for r in args.regions.split(",") if r.strip()))
    else:
        raise SystemExit("name --regions or --all")
    unknown = [r for r in regions if r not in release.packed]
    if unknown:
        raise SystemExit("not packed in the release: " + ", ".join(unknown))
    paths.cache.mkdir(parents=True, exist_ok=True)
    (paths.cache / "release_snapshot.json").write_text(json.dumps(release.doc, indent=1), encoding="utf-8")
    print(f"release {release.doc['tag']} packed {release.doc['packed']}: {len(release.packed)} regions, "
          f"{len(release.pending)} pending; lines built {lines_m.built}; building {len(regions)} regions")
    summaries = []
    workers = max(1, min(args.workers, len(regions)))
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = dict((ex.submit(region.build_region, vpu, str(paths.release), str(paths.lines), str(paths.values),
                               str(paths.cache), release.doc, lines_m.doc, args.force, not args.no_verify), vpu)
                    for vpu in regions)
        for f in as_completed(futs):
            vpu = futs[f]
            s = f.result()
            summaries.append(s)
            ck = s.get("checks") or {}
            print(f"  {vpu}: {'cached' if s.get('cached') else str(s['seconds']) + ' s'}, {s['units']} reaches, "
                  f"{s['not_sampled']} unsampled lines, {s['sections']} sections"
                  + (f", section offset {ck['section_offset_max_m']:.1e} m, line distance "
                     f"{ck.get('stored_line_distance_max_m', 0):.2f} m" if ck else ""), flush=True)
    bad = [s["vpu"] for s in summaries if s["assigned_sections"] != s["sections"] or s["assigned_scored"] != s["scored"]]
    if bad:
        raise SystemExit("sections not conserved in " + ", ".join(bad))
    for s in summaries:
        ck = s.get("checks") or {}
        errs = [k for k in ("shared_boundary_mismatch", "shared_vertex_mismatch", "chain_start_mismatch",
                            "chain_end_mismatch", "section_outside_reach") if ck.get(k)]
        if errs or ck.get("section_offset_max_m", 0) > 1e-3 or ck.get("stored_line_distance_max_m", 0) > 1.0:
            raise SystemExit(f"{s['vpu']}: geometry checks failed: {json.dumps(ck)}")
    t1 = time.time()
    doc = partition.build_site(paths, regions, release, lines_m, workers=args.workers,
                               log=lambda *a: print(*a, flush=True))
    report = paths.out / "report"
    report.mkdir(parents=True, exist_ok=True)
    total = dict((k, sum(s[k] for s in summaries)) for k in ("units", "not_sampled", "rows", "sections", "scored", "vertices"))
    files = doc["files"]
    unit_bytes = [v[1] for k, v in files.items() if k.startswith("units/")]
    out = {"regions": regions, "data_version": doc["data_version"], "built": doc["built"], "totals": total,
           "huc8_files": len(unit_bytes), "unit_bytes": sum(unit_bytes), "largest_unit_file": max(unit_bytes),
           "pass1_seconds": round(t1 - t0, 1), "pass2_seconds": round(time.time() - t1, 1),
           "summaries": sorted(summaries, key=lambda s: s["vpu"])}
    (report / "build.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"done: {doc['data_version']}, {len(unit_bytes)} HUC8 files, {sum(unit_bytes) / 1e6:.1f} MB "
          f"(largest {max(unit_bytes) / 1e6:.2f} MB), {total['rows']} rows, pass 1 {t1 - t0:.0f} s, "
          f"pass 2 {time.time() - t1:.0f} s")
    return 0


def cmd_report(args) -> int:
    from fprdata import report
    paths = _paths(args)
    paths.need("out")
    report.pilot_report(paths)
    return 0


def cmd_fixtures(args) -> int:
    from fprdata import fixtures
    paths = _paths(args)
    paths.need("out")
    fixtures.write_fixtures(paths)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="The floodplain reconnection screener's reach layer.")
    ap.add_argument("--paths", help="a JSON file naming the paths below")
    for name in C.ENV:
        ap.add_argument(f"--{name}", help=f"folder (or {C.ENV[name]})")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="pass 1 per region into cache/, pass 2 into site/")
    b.add_argument("--regions", help="comma-separated region codes (VPUs)")
    b.add_argument("--all", action="store_true", help="every region packed in the release")
    b.add_argument("--workers", type=int, default=max(1, min(6, (os.cpu_count() or 2) - 2)))
    b.add_argument("--force", action="store_true", help="rebuild regions found in the cache")
    b.add_argument("--no-verify", action="store_true", help="skip the geometry checks against the grid's points")
    b.set_defaults(func=cmd_build)
    r = sub.add_parser("report", help="the pilot preset table (report/pilot_presets.md and .csv)")
    r.set_defaults(func=cmd_report)
    f = sub.add_parser("fixtures", help="the web app's test fixtures (fixtures/)")
    f.set_defaults(func=cmd_fixtures)
    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
