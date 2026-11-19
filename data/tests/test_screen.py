"""The screening rules on a tiny synthetic network, and the fixtures' expected results."""
import json

import numpy as np
import pytest

from fprdata import config as C
from fprdata import screen


class _Net(screen.Network):
    """A network built from plain arrays (one HUC8)."""

    def __init__(self, rows):
        n = len(rows)
        self.n = n
        self.huc8s = ["00000001"]
        self.offset = {"00000001": 0}
        self.huc8_of_row = np.full(n, 1)
        a = dict((k, np.array([r.get(k, d) for r in rows])) for k, d in [
            ("id", 1), ("k0", 0), ("n", 10), ("len_m", 300.0), ("fclass", 1), ("q", 0), ("why", 0), ("bhr", 160),
            ("er", 250), ("da_sqkm", 10.0), ("huc12", 1), ("main", True), ("div", -1), ("vpu", "0000")])
        a["k0"] = np.arange(n)
        self.a = a
        self.dn = np.array([r.get("dn", -1) for r in rows])
        self.div = a["div"]
        self.main = a["main"].astype(bool) & (self.dn >= 0)
        self.len_m = a["len_m"].astype(float)
        self.sqmi = a["da_sqkm"] / C.SQKM_PER_SQMI


def _chain(n, **over):
    rows = [{"dn": i + 1} for i in range(n)]
    rows[-1]["dn"] = -1
    for i, d in over.items():
        rows[int(i[1:])].update(d)
    return rows


def test_funnel_steps():
    net = _Net(_chain(6, r1={"q": 1}, r2={"q": 2}, r3={"fclass": 2}, r4={"bhr": 140}, r5={"er": 200}))
    area = np.ones(6, dtype=bool)
    steps, qual = net.funnel(area, C.DEFAULT_CRITERIA)
    assert steps == {"reaches": 6, "canals": 5, "measured": 4, "da": 4, "bhr": 3, "er": 2, "qualifying": 2}
    assert qual.tolist() == [True, True, False, False, False, False]


def test_sites_join_one_gap_and_never_end_on_one():
    rows = _chain(7, r2={"bhr": 100}, r4={"bhr": 100}, r5={"bhr": 100})
    net = _Net(rows)
    area = np.ones(7, dtype=bool)
    crit = dict(C.DEFAULT_CRITERIA, minSiteFt=0)
    sites = screen.screen(net, area, crit)["sites"]
    runs = sorted([s["rows"] for s in sites])
    assert runs == [[0, 1, 2, 3], [6]]
    crit0 = dict(crit, gapReaches=0)
    assert sorted(s["rows"] for s in screen.screen(net, area, crit0)["sites"]) == [[0, 1], [3], [6]]


def test_unsampled_rows_and_the_area_end_a_site():
    net = _Net(_chain(5, r2={"q": 3}))
    area = np.array([True, True, True, True, False])
    crit = dict(C.DEFAULT_CRITERIA, minSiteFt=0)
    assert sorted(s["rows"] for s in screen.screen(net, area, crit)["sites"]) == [[0, 1], [3]]


def test_minimum_length_in_feet():
    net = _Net(_chain(3))
    area = np.ones(3, dtype=bool)
    crit = dict(C.DEFAULT_CRITERIA, minSiteFt=900 / C.M_PER_FT)
    assert len(screen.screen(net, area, crit)["sites"]) == 1
    crit = dict(C.DEFAULT_CRITERIA, minSiteFt=901 / C.M_PER_FT)
    assert len(screen.screen(net, area, crit)["sites"]) == 0


def test_tributaries_start_their_own_sites():
    # 0 -> 2 (main), 1 -> 2 (tributary), 2 -> 3
    rows = [{"dn": 2}, {"dn": 2, "main": False}, {"dn": 3}, {"dn": -1}]
    net = _Net(rows)
    crit = dict(C.DEFAULT_CRITERIA, minSiteFt=0)
    runs = sorted(s["rows"] for s in screen.screen(net, np.ones(4, dtype=bool), crit)["sites"])
    assert runs == [[0, 2, 3], [1]]


def test_walk_follows_every_pointer_and_divergences():
    rows = [{"dn": 2}, {"dn": 2, "main": False}, {"dn": 3}, {"dn": -1}, {"dn": 3, "div": 0}]
    net = _Net(rows)
    assert net.walk(3).tolist() == [0, 1, 2, 3, 4]
    assert net.walk(4).tolist() == [0, 4]


def test_fixtures_expected(paths):
    exp_path = paths.out / "fixtures" / "expected.json" if paths.out else None
    if exp_path is None or not exp_path.exists():
        pytest.skip("no fixtures written")
    exp = json.loads(exp_path.read_text(encoding="utf-8"))
    files = dict((h, paths.out / "fixtures" / "units" / f"{h}.parquet") for h in exp["files"])
    net = screen.Network(None, files=files)
    for name, area in (("utoy", screen.area_huc12(net, exp["areas"]["utoy"]["huc12"])),
                       ("coosawhatchie", screen.area_huc10(net, exp["areas"]["coosawhatchie"]["huc10"]))):
        for key in C.PRESETS:
            res = screen.screen(net, area, C.preset_criteria(key))
            assert res["funnel"] == exp["results"][name][key]["funnel"]
            assert [s["id"] for s in res["sites"]] == [s["id"] for s in exp["results"][name][key]["sites"]]
