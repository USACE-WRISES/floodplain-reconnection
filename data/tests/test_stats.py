"""Reach statistics and the quality bits, against plain Python and against STAF's own rules."""
import statistics

import numpy as np
import pytest

from fprdata import config as C
from fprdata import stats


def _units(rng, n_units, max_n=14):
    sizes = rng.integers(1, max_n + 1, n_units)
    unit = np.repeat(np.arange(n_units), sizes)
    return unit, sizes


def test_ratio_stats_match_python():
    rng = np.random.default_rng(1)
    unit, sizes = _units(rng, 3000)
    vals = rng.integers(25, 201, len(unit))
    med, lo, hi = stats.ratio_stats(unit, vals, len(sizes))
    off = 0
    for u, n in enumerate(sizes.tolist()):
        v = [x / 100 for x in vals[off:off + n].tolist()]
        assert med[u] == round(round(statistics.median(v), 2) * 100)
        assert lo[u] == round(min(v) * 100) and hi[u] == round(max(v) * 100)
        off += n


def test_median_edge_limited_matches_python():
    rng = np.random.default_rng(2)
    unit, sizes = _units(rng, 2000)
    er = rng.integers(100, 400, len(unit))
    edge = rng.random(len(unit)) < 0.3
    got = stats.median_edge_limited(unit, er, edge, len(sizes))
    off = 0
    for u, n in enumerate(sizes.tolist()):
        cands = sorted(zip(er[off:off + n].tolist(), edge[off:off + n].tolist()), key=lambda c: c[0])
        mid = [cands[n // 2]] if n % 2 else [cands[n // 2 - 1], cands[n // 2]]
        assert got[u] == any(c[1] for c in mid)
        off += n


def _sections(**cols):
    n = len(cols["status"])
    base = dict(status=np.zeros(n, int), flags=np.zeros(n, int), bank=np.zeros(n, int), res=np.ones(n, int),
                er=np.full(n, 300), bhr=np.full(n, 120), bfd=np.full(n, 50), bfw=np.full(n, 80), fpw=np.full(n, 240),
                lb=np.full(n, 0.6))
    base.update(dict((k, np.asarray(v)) for k, v in cols.items()))
    return base


def _one(**cols):
    s = _sections(**cols)
    st = stats.unit_stats(np.zeros(len(s["status"]), dtype=np.int64), 1, s)
    return int(st["why"][0]), int(st["q"][0]), st


def test_quality_bits_each():
    why, q, _ = _one(status=[0] * 10)
    assert (why, q) == (0, C.Q_NONE)
    why, q, _ = _one(status=[0, 0, 1, 1, 1])
    assert why & C.WHY_FEW and q == C.Q_NOT_ENOUGH
    why, q, _ = _one(status=[2] * 6)
    assert why & C.WHY_NO_DEM and why & C.WHY_FEW and q == C.Q_NOT_ENOUGH
    why, q, _ = _one(status=[0] * 3)
    assert why == C.WHY_THIN and q == C.Q_CAUTION
    why, q, _ = _one(status=[0] * 6, flags=[8, 8, 8, 8, 0, 0])
    assert why & C.WHY_EXTRAPOLATED and q == C.Q_CAUTION
    why, q, _ = _one(status=[0] * 6, flags=[8, 8, 8, 0, 0, 0])
    assert not why & C.WHY_EXTRAPOLATED
    why, q, _ = _one(status=[0] * 6, bank=[1] * 6)
    assert why & C.WHY_CREST_SCAN
    why, q, _ = _one(status=[0] * 5, er=[200, 210, 220, 230, 240], flags=[0, 0, 2, 0, 0])
    assert why & C.WHY_EDGE
    why, q, _ = _one(status=[0] * 5, res=[10] * 5)
    assert why & C.WHY_COARSE
    why, q, _ = _one(status=[0] * 5, er=[90, 95, 99, 120, 130])
    assert why & C.WHY_ER_RANGE and q == C.Q_NOT_ENOUGH
    why, q, _ = _one(status=[0] * 5, bhr=[0, 0, 0, 50, 60])
    assert why & C.WHY_BHR_RANGE and q == C.Q_NOT_ENOUGH


def test_cap_bits():
    # median at the cap with deep capped sections: "at least 2.00", no flag
    why, q, _ = _one(status=[0] * 5, bhr=[200] * 5, flags=[1] * 5, bfd=[50] * 5)
    assert why & C.WHY_AT_CAP and not why & C.WHY_CAP_FLOOR and q == C.Q_NONE
    # the same at the detector's floor (bankfull depth 0.05 m on 1 m lidar)
    why, q, st = _one(status=[0] * 5, bhr=[200] * 5, flags=[1] * 5, bfd=[5] * 5)
    assert why & C.WHY_CAP_FLOOR and q == C.Q_NOT_ENOUGH and st["n_floor"][0] == 5
    # 0.06 m is above the lidar floor but under the coarse one
    why, q, _ = _one(status=[0] * 5, bhr=[200] * 5, flags=[1] * 5, bfd=[6] * 5)
    assert not why & C.WHY_CAP_FLOOR
    why, q, _ = _one(status=[0] * 5, bhr=[200] * 5, flags=[1] * 5, bfd=[14] * 5, res=[10] * 5)
    assert why & C.WHY_CAP_FLOOR


def test_parity_with_staf(geomorph):
    """The medians, the cap and its floor, and the edge-limited median, as STAF's own rules give them."""
    rng = np.random.default_rng(3)
    for trial in range(1500):
        n = int(rng.integers(1, 15))
        res = int(rng.choice([1, 1, 1, 3, 10]))
        capped = rng.random(n) < 0.5
        bhr = np.where(capped, 200, rng.integers(25, 200, n))
        er = rng.integers(100, 600, n)
        edge = rng.random(n) < 0.3
        bfd = rng.integers(2, 40, n)
        s = _sections(status=[0] * n, bhr=bhr, er=er, flags=capped * 1 + edge * 2, bfd=bfd, res=[res] * n)
        st = stats.unit_stats(np.zeros(n, dtype=np.int64), 1, s)
        cands = [{"entrenchment_ratio": float(e) / 100, "bank_height_ratio": float(b) / 100,
                  "low_bank_capped": bool(c), "edge_limited": bool(g), "bankfull_depth_m": float(d) / 100}
                 for e, b, c, g, d in zip(er.tolist(), bhr.tolist(), capped.tolist(), edge.tolist(), bfd.tolist())]
        rs = geomorph.reach_stats(cands)
        assert st["bhr"][0] == round(rs["bank_height_ratio"]["median"] * 100)
        assert st["er"][0] == round(rs["entrenchment_ratio"]["median"] * 100)
        assert st["bhr_lo"][0] == round(rs["bank_height_ratio"]["min"] * 100)
        assert st["er_hi"][0] == round(rs["entrenchment_ratio"]["max"] * 100)
        assert bool(st["why"][0] & C.WHY_AT_CAP) == rs["bank_height_ratio"]["median_capped"]
        assert bool(st["edge_med"][0]) == geomorph.median_edge_limited(cands)
        qual = geomorph.cross_section_quality({
            "reach": rs, "bank_height_ratio": rs["bank_height_ratio"]["median"],
            "entrenchment_ratio": rs["entrenchment_ratio"]["median"], "candidate_scalars": cands,
            "dem_resolution_m": float(res)})
        assert int(st["n_floor"][0]) == qual["capUnreachableSections"]
        assert bool(st["why"][0] & C.WHY_CAP_FLOOR) == qual["capIsFloor"], (trial, cands)

