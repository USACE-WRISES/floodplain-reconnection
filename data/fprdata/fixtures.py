"""The web app's test fixtures: the published files of two HUC8s (and any file the two walks reach),
and what the screening rules give on them (``expected.json``)."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from . import config as C
from . import report, screen

BASE_HUC8 = ["03130002", "03050208"]


def write_fixtures(paths: C.Paths) -> dict:
    site = paths.site
    index = json.loads((site / "web-manifest.json").read_text(encoding="utf-8"))
    built = set(k.split("/")[1].split(".")[0] for k in index["files"] if k.startswith("units/"))
    missing = [h for h in BASE_HUC8 if h not in built]
    if missing:
        raise SystemExit("not in the built site: " + ", ".join(missing))
    # the walks first, on every file of their regions, to find the files they reach
    walks_def = [("utoy", "0313", report.UTOY_OUTLET_LINE), ("coosawhatchie", "0305", report.COOSAWHATCHIE_OUTLET_LINE)]
    wide = screen.Network(site, [h for h, m in index["fpr"]["huc8"].items()
                                 if set(m["regions"]) & set(v for _, v, _ in walks_def)], index)
    need = set(BASE_HUC8)
    starts = {}
    for name, vpu, line in walks_def:
        lr = report.line_rows(paths.cache, vpu, line)
        starts[name] = lr["last"]
        rows = wide.walk(wide.row_of(*lr["last"]))
        need |= set(f"{int(x):08d}" for x in set(wide.huc8_of_row[rows].tolist()))
    out = paths.out / "fixtures"
    if out.exists():
        shutil.rmtree(out)
    (out / "units").mkdir(parents=True)
    files = {}
    for h in sorted(need):
        src = site / index["files"][f"units/{h}.parquet"][0]
        dst = out / "units" / f"{h}.parquet"
        shutil.copyfile(src, dst)
        files[h] = dst
    net = screen.Network(None, files=files)
    expected = {"data_version": index["data_version"], "files": sorted(files),
                "criteria": C.DEFAULT_CRITERIA, "presets": C.PRESETS,
                "areas": {"utoy": {"huc12": [report.UTOY_HUC12]},
                          "coosawhatchie": {"huc10": report.COOSAWHATCHIE_HUC10}},
                "results": {}, "walks": {}}
    for name, area in (("utoy", screen.area_huc12(net, [report.UTOY_HUC12])),
                       ("coosawhatchie", screen.area_huc10(net, report.COOSAWHATCHIE_HUC10))):
        expected["results"][name] = {}
        for key in C.PRESETS:
            res = screen.screen(net, area, C.preset_criteria(key))
            expected["results"][name][key] = {
                "funnel": res["funnel"],
                "sites": [{"id": s["id"], "length_m": round(s["length_m"], 3), "qual_length_m": round(s["qual_length_m"], 3),
                           "rows": len(s["rows"]), "qualifying": s["qualifying"],
                           "first": "%s/%d" % net.where(s["rows"][0]), "last": "%s/%d" % net.where(s["rows"][-1])}
                          for s in res["sites"]],
            }
    for name, (h, r) in starts.items():
        start = net.row_of(h, r)
        rows = net.walk(start)
        total = 0.0
        for g in sorted(rows.tolist()):
            total += float(net.len_m[g])
        expected["walks"][name] = {"start": {"huc8": h, "row": r, "id": net.reach_id(start)},
                                   "rows": int(len(rows)), "length_m": round(total, 3),
                                   "sections": int(net.a["n"][rows].sum()),
                                   "files": sorted(set(f"{int(x):08d}" for x in net.huc8_of_row[rows].tolist()))}
    (out / "expected.json").write_text(json.dumps(expected, indent=1), encoding="utf-8")
    print(f"fixtures: {len(files)} files ({', '.join(sorted(files))}); "
          + "; ".join(f"{k} walk {v['rows']} rows" for k, v in expected["walks"].items()))
    return expected
