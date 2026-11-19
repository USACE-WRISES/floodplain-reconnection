"""Reach statistics over the scored sections, by EASI's reach rule (``geomorph.reach_stats``): the
median, minimum and maximum of each ratio as Python's ``round(statistics.median(values), 2)``, and
the quality bits of the screener's rule (``fpr-q1``), adapted from the grid's K2b record.

Sections come in reach order: ``unit`` ascending, and within a reach upstream to downstream.
"""
from __future__ import annotations

import numpy as np

from . import config as C


def _groups(unit: np.ndarray, values: np.ndarray, n_units: int):
    """Values sorted by (reach, value, position) with each reach's start and count."""
    order = np.lexsort((np.arange(len(unit)), values, unit))
    cnt = np.bincount(unit, minlength=n_units).astype(np.int64)
    start = np.concatenate([[0], np.cumsum(cnt)[:-1]]).astype(np.int64)
    return order, start, cnt


def ratio_stats(unit: np.ndarray, x100: np.ndarray, n_units: int):
    """``(median, low, high)`` x100 of a ratio stored x100, per reach (-1 where a reach has none):
    the median as Python's ``round(statistics.median([v / 100 ...]), 2)`` gives it."""
    order, start, cnt = _groups(unit, x100, n_units)
    v = x100[order].astype(np.int64)
    med = np.full(n_units, -1, dtype=np.int64)
    lo = np.full(n_units, -1, dtype=np.int64)
    hi = np.full(n_units, -1, dtype=np.int64)
    has = cnt > 0
    lo[has] = v[start[has]]
    hi[has] = v[start[has] + cnt[has] - 1]
    odd = has & (cnt % 2 == 1)
    med[odd] = v[start[odd] + cnt[odd] // 2]
    even = np.flatnonzero(has & (cnt % 2 == 0))
    if len(even):
        a = v[start[even] + cnt[even] // 2 - 1] / 100.0
        b = v[start[even] + cnt[even] // 2] / 100.0
        m = (a + b) / 2
        med[even] = [round(round(x, 2) * 100) for x in m.tolist()]
    return med, lo, hi


def plain_median(unit: np.ndarray, values: np.ndarray, n_units: int) -> np.ndarray:
    """The median per reach (NaN where a reach has none)."""
    order, start, cnt = _groups(unit, values, n_units)
    v = values[order].astype(np.float64)
    out = np.full(n_units, np.nan)
    has = cnt > 0
    odd = has & (cnt % 2 == 1)
    out[odd] = v[start[odd] + cnt[odd] // 2]
    even = has & (cnt % 2 == 0)
    out[even] = (v[start[even] + cnt[even] // 2 - 1] + v[start[even] + cnt[even] // 2]) / 2
    return out


def median_edge_limited(unit: np.ndarray, er_x100: np.ndarray, edge: np.ndarray, n_units: int) -> np.ndarray:
    """``geomorph.median_edge_limited``: a section holding the median entrenchment ratio (the middle
    one, or either middle one on an even count, sorted stably in reach order) is edge-limited."""
    order, start, cnt = _groups(unit, er_x100, n_units)
    e = edge[order]
    out = np.zeros(n_units, dtype=bool)
    has = cnt > 0
    odd = has & (cnt % 2 == 1)
    out[odd] = e[start[odd] + cnt[odd] // 2]
    even = has & (cnt % 2 == 0)
    out[even] = e[start[even] + cnt[even] // 2 - 1] | e[start[even] + cnt[even] // 2]
    return out


def floor_depth_m(res: np.ndarray) -> np.ndarray:
    """The detector's floor depth (m) on each section's elevation model (``cap_unreachable_depth``)."""
    fine = (res > 0) & (res <= C.FINE_DEM_MAX_M)
    return np.where(fine, C.FLOOR_DEPTH_FINE_M, C.FLOOR_DEPTH_COARSE_M)


def unit_stats(unit: np.ndarray, n_units: int, s: dict) -> dict:
    """Every statistic of every reach. ``s`` holds the sections' arrays in reach order: status, flags,
    bank, res, er, bhr, bfd, bfw, fpw (x100 or x10 as stored, -1 when not scored) and lb (m)."""
    status = s["status"]
    scored = np.isin(status, C.SCORED)
    flags = s["flags"]
    capped = scored & ((flags & C.FLAG_CAPPED) > 0)
    # a capped section whose bankfull depth is at or below the detector's floor (K2b)
    floor = capped & (s["bfd"] / 100.0 <= floor_depth_m(s["res"]) + 1e-9)

    def count(mask):
        return np.bincount(unit, weights=mask, minlength=n_units).astype(np.int64)

    out = {
        "n": np.bincount(unit, minlength=n_units).astype(np.int64),
        "n_ok": count(scored),
        "n_unm": count(np.isin(status, C.UNMEASURED)),
        "n_nodem": count(status == C.STATUS_NO_DEM),
        "n_cap": count(capped),
        "n_floor": count(floor),
        "n_edge": count(scored & ((flags & C.FLAG_EDGE) > 0)),
        "n_ext": count(scored & ((flags & C.FLAG_EXTRAPOLATED) > 0)),
        "n_crest": count(scored & (s["bank"] == C.BANK_CREST_SCAN)),
    }
    res = np.zeros(n_units, dtype=np.int64)
    np.maximum.at(res, unit[scored], s["res"][scored])
    out["res"] = res
    u = unit[scored]
    for name in ("bhr", "er"):
        med, lo, hi = ratio_stats(u, s[name][scored], n_units)
        out[name], out[name + "_lo"], out[name + "_hi"] = med, lo, hi
    for name in ("bfw", "fpw", "bfd"):
        m = plain_median(u, s[name][scored].astype(np.float64), n_units)
        out[name] = np.where(np.isnan(m), -1, np.rint(np.nan_to_num(m))).astype(np.int64)
    lbh = plain_median(u, s["lb"][scored] * 100.0, n_units)
    out["lbh"] = np.where(np.isnan(lbh), -1, np.rint(np.nan_to_num(lbh))).astype(np.int64)
    out["edge_med"] = median_edge_limited(u, s["er"][scored], ((flags & C.FLAG_EDGE) > 0)[scored], n_units)
    why, q = quality(out)
    out["why"], out["q"] = why, q
    return out


def quality(st: dict) -> tuple[np.ndarray, np.ndarray]:
    """The why bits and the tier of each reach (``fpr-q1``)."""
    n_ok = st["n_ok"]
    some = n_ok > 0
    why = np.zeros(len(n_ok), dtype=np.int64)
    why |= np.where(n_ok < 3, C.WHY_FEW, 0)
    why |= np.where((st["n_nodem"] == st["n"]) & (st["n"] > 0), C.WHY_NO_DEM, 0)
    why |= np.where(some & (st["bhr"] <= 0), C.WHY_BHR_RANGE, 0)
    why |= np.where(some & (st["er"] < 100), C.WHY_ER_RANGE, 0)
    at_cap = some & (st["n_cap"] > 0) & (st["bhr"] >= C.BHR_CAP_X100)
    why |= np.where(at_cap, C.WHY_AT_CAP, 0)
    needed = n_ok // 2 + 1
    why |= np.where(at_cap & ((st["n_cap"] - st["n_floor"]) < needed), C.WHY_CAP_FLOOR, 0)
    why |= np.where(some & (2 * st["n_ext"] > n_ok), C.WHY_EXTRAPOLATED, 0)
    why |= np.where(some & (st["n_crest"] == n_ok), C.WHY_CREST_SCAN, 0)
    why |= np.where((n_ok == 3) | (n_ok == 4), C.WHY_THIN, 0)
    why |= np.where(some & st["edge_med"], C.WHY_EDGE, 0)
    why |= np.where(some & (st["res"] > 1), C.WHY_COARSE, 0)
    q = np.where((why & C.Q2_BITS) > 0, C.Q_NOT_ENOUGH, np.where((why & C.Q1_BITS) > 0, C.Q_CAUTION, C.Q_NONE))
    return why, q
