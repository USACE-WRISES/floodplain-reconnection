"""The pilot preset table: how each preset narrows the pilot study areas, for the team's review
before any preset is published as a default."""
from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from . import config as C
from . import screen

PILOTS = ["0305", "0313", "1023", "0710", "0108"]
UTOY_HUC12 = "031300020103"
COOSAWHATCHIE_HUC10 = ["0305020801", "0305020802", "0305020803", "0305020804"]
NORWAY_CREEK_LINE = 23000300012339
UTOY_OUTLET_LINE = 15001100035499
COOSAWHATCHIE_OUTLET_LINE = 15001500060413


def line_rows(cache: Path, vpu: str, nhdplusid: int) -> dict | None:
    """Where a line's first and last rows are in the published files."""
    t = pq.read_table(cache / f"{vpu}.lookup.parquet")
    ids = t.column("nhdplusid").to_numpy()
    hit = np.flatnonzero(ids == nhdplusid)
    if not len(hit):
        return None
    i = int(hit[0])
    return {"first": (f"{int(t.column('first_huc8')[i].as_py()):08d}", int(t.column("first_row")[i].as_py())),
            "last": (f"{int(t.column('last_huc8')[i].as_py()):08d}", int(t.column("last_row")[i].as_py())),
            "nsec": int(t.column("nsec")[i].as_py())}


def pilot_areas(paths: C.Paths, net: screen.Network, regions: list) -> list:
    areas = []
    if "0313" in regions:
        areas.append(("Utoy Creek, HUC12 031300020103", screen.area_huc12(net, [UTOY_HUC12]), None))
    if "0305" in regions:
        areas.append(("Coosawhatchie River, HUC10 0305020801 to 0305020804",
                      screen.area_huc10(net, COOSAWHATCHIE_HUC10), None))
    if "1023" in regions:
        lr = line_rows(paths.cache, "1023", NORWAY_CREEK_LINE)
        if lr and lr["last"][0] in net.offset:
            start = net.row_of(*lr["last"])
            areas.append(("Norway Creek, upstream of line 23000300012339",
                          screen.area_rows(net, net.walk(start)), {"huc8": lr["last"][0], "row": lr["last"][1],
                                                                   "id": net.reach_id(start)}))
    for vpu in regions:
        areas.append((f"Region {vpu}, whole", net.a["vpu"] == vpu, None))
    return areas


def pilot_report(paths: C.Paths) -> list:
    site = paths.site
    index = json.loads((site / "web-manifest.json").read_text(encoding="utf-8"))
    regions = [p for p in PILOTS if p in index["fpr"]["regions"]]
    huc8s = [h for h, m in index["fpr"]["huc8"].items() if set(m["regions"]) & set(regions)]
    net = screen.Network(site, huc8s, index)
    rows = []
    starts = {}
    for name, area, start in pilot_areas(paths, net, regions):
        if start:
            starts[name] = start
        q = net.a["q"]
        reaches = area & (q <= C.Q_NOT_ENOUGH)
        shown = area & (q <= C.Q_CAUTION)
        n_reach = int(reaches.sum())
        at_cap = int((shown & ((net.a["why"] & C.WHY_AT_CAP) > 0)).sum())
        for key in C.PRESETS:
            crit = C.preset_criteria(key)
            res = screen.screen(net, area, crit)
            lens = np.array([s["length_m"] / C.M_PER_FT for s in res["sites"]])
            f = res["funnel"]
            rows.append({
                "area": name, "preset": key, "label": C.PRESETS[key]["label"],
                "rows": int(area.sum()), "not_sampled": int((area & (q == C.Q_NOT_SAMPLED)).sum()),
                "reaches": f["reaches"], "after_canals": f["canals"], "measured": f["measured"],
                "after_drainage_area": f["da"], "after_bhr": f["bhr"], "qualifying": f["qualifying"],
                "sites": len(res["sites"]),
                "site_ft_median": round(float(np.median(lens)), 0) if len(lens) else 0,
                "site_ft_max": round(float(lens.max()), 0) if len(lens) else 0,
                "at_cap_share": round(at_cap / max(1, int(shown.sum())), 3),
                "q0_share": round(int((reaches & (q == 0)).sum()) / max(1, n_reach), 3),
                "q1_share": round(int((reaches & (q == 1)).sum()) / max(1, n_reach), 3),
                "q2_share": round(int((reaches & (q == 2)).sum()) / max(1, n_reach), 3),
            })
    out = paths.out / "report"
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "pilot_presets.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    lines = [f"# Pilot presets ({index['data_version']})", "",
             "Each preset keeps drainage area 2 sq mi or more, leaves out canals and ditches, includes reaches marked "
             "use with caution, counts reaches at the 2.00 cap, joins sites across one reach, and keeps sites "
             "1,000 ft or longer. Shares: at cap is of reaches with values shown; tiers are of all sampled reaches.", "",
             "| Area | Preset | Reaches | Measured | DA | BHR | Qualifying | Sites | Median ft | Max ft | At cap | No flags | Caution | Not enough |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['area']} | {r['preset']} | {r['reaches']:,} | {r['measured']:,} | {r['after_drainage_area']:,} | "
                     f"{r['after_bhr']:,} | {r['qualifying']:,} | {r['sites']:,} | {r['site_ft_median']:,.0f} | "
                     f"{r['site_ft_max']:,.0f} | {r['at_cap_share']:.0%} | {r['q0_share']:.0%} | {r['q1_share']:.0%} | "
                     f"{r['q2_share']:.0%} |")
    lines += ["", "Presets: " + "; ".join(f"{k} = {v['label']}" for k, v in C.PRESETS.items()) + ".", ""]
    for name, st in starts.items():
        lines.append(f"Walk start for {name}: HUC8 {st['huc8']} row {st['row']} (reach {st['id']}).")
    (out / "pilot_presets.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return rows
