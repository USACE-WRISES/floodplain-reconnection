"""The screening rules, as the web app applies them to the published files: the funnel, candidate
sites along the mainstem paths, and the upstream walk. The report and the fixtures use these, and
the app's tests compare against what they give."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import numpy as np
import pyarrow.parquet as pq

from . import config as C

LOAD = ["id", "k0", "n", "vpu", "len_m", "name", "fclass", "q", "why", "bhr", "er", "da_sqkm", "huc12",
        "dn_huc8", "dn_row", "main", "div"]


class Network:
    """The rows of some HUC8 files, end to end, with the pointers between loaded files resolved."""

    def __init__(self, site: Path, huc8s: Optional[list] = None, index: Optional[dict] = None, files: Optional[dict] = None):
        """``files`` maps a HUC8 to a file path directly (the fixtures); else ``site``'s index names them."""
        self.site = Path(site) if site else None
        if files is None:
            index = index or json.loads((self.site / "web-manifest.json").read_text(encoding="utf-8"))
            self.index = index
            avail = sorted(k.split("/")[1].split(".")[0] for k in index["files"] if k.startswith("units/"))
            huc8s = sorted(set(huc8s) & set(avail)) if huc8s is not None else avail
            files = dict((h, self.site / index["files"][f"units/{h}.parquet"][0]) for h in huc8s)
        self.huc8s = sorted(files)
        cols: dict = dict((c, []) for c in LOAD)
        self.offset: dict = {}
        total = 0
        for h in self.huc8s:
            t = pq.read_table(files[h], columns=LOAD)
            self.offset[h] = total
            total += t.num_rows
            for c in LOAD:
                if c in ("vpu", "name"):
                    cols[c].append(np.asarray(t.column(c).to_pylist(), dtype=object))
                elif c in ("bhr", "er"):
                    cols[c].append(t.column(c).cast("int64").fill_null(-1).to_numpy())
                else:
                    cols[c].append(t.column(c).to_numpy(zero_copy_only=False))
        self.n = total
        a = dict((c, np.concatenate(v) if v else np.zeros(0)) for c, v in cols.items())
        self.a = a
        self.huc8_of_row = np.concatenate([np.full(len(cols["id"][i]), int(h), dtype=np.int64)
                                           for i, h in enumerate(self.huc8s)]) if self.huc8s else np.zeros(0, np.int64)
        own = self.huc8_of_row
        dn = np.full(total, -1, dtype=np.int64)
        for h in self.huc8s:
            sel = (a["dn_row"] >= 0) & (a["dn_huc8"] == int(h))
            dn[sel] = self.offset[h] + a["dn_row"][sel]
        self.dn = dn
        div = np.full(total, -1, dtype=np.int64)
        has = a["div"] >= 0
        base = np.array([self.offset[f"{int(x):08d}"] for x in own[has]], dtype=np.int64) if has.any() else np.zeros(0, np.int64)
        div[has] = base + a["div"][has]
        self.div = div
        self.main = a["main"].astype(bool) & (dn >= 0)
        self.len_m = a["len_m"].astype(np.float64)
        self.sqmi = a["da_sqkm"].astype(np.float64) / C.SQKM_PER_SQMI

    def row_of(self, huc8: str, row: int) -> int:
        return self.offset[huc8] + int(row)

    def where(self, g: int) -> tuple[str, int]:
        h = f"{int(self.huc8_of_row[g]):08d}"
        return h, int(g - self.offset[h])

    def reach_id(self, g: int) -> str:
        return f"{int(self.a['id'][g])}-{int(self.a['k0'][g])}"

    # ---- the funnel
    def funnel(self, area: np.ndarray, crit: dict) -> tuple[dict, np.ndarray]:
        a = self.a
        steps = {}
        cur = area & (a["q"] <= C.Q_NOT_ENOUGH)
        steps["reaches"] = int(cur.sum())
        if crit.get("skipCanals"):
            cur = cur & (a["fclass"] != C.FCLASS_CANAL)
        steps["canals"] = int(cur.sum())
        ok_q = (a["q"] == C.Q_NONE) | ((a["q"] == C.Q_CAUTION) if crit.get("includeCaution") else False)
        cur = cur & ok_q
        steps["measured"] = int(cur.sum())
        if crit.get("daMinSqmi") is not None:
            cur = cur & (self.sqmi >= crit["daMinSqmi"])
        if crit.get("daMaxSqmi") is not None:
            cur = cur & (self.sqmi <= crit["daMaxSqmi"])
        steps["da"] = int(cur.sum())
        if crit.get("bhrMin") is not None:
            cur = cur & (a["bhr"] >= round(crit["bhrMin"] * 100))
        if not crit.get("countCapped", True):
            cur = cur & ((a["why"] & C.WHY_AT_CAP) == 0)
        steps["bhr"] = int(cur.sum())
        if crit.get("erMin") is not None:
            cur = cur & (a["er"] >= round(crit["erMin"] * 100))
        steps["er"] = int(cur.sum())
        steps["qualifying"] = int(cur.sum())
        return steps, cur

    # ---- the mainstem paths and the sites along them
    def paths(self) -> list:
        """Every mainstem path, upstream to downstream (each row on exactly one)."""
        has_up = np.zeros(self.n, dtype=bool)
        m = self.main
        has_up[self.dn[m]] = True
        heads = np.flatnonzero(~has_up)
        dn, main = self.dn.tolist(), m.tolist()
        seen = bytearray(self.n)
        out = []
        for h in heads.tolist():
            path = [h]
            seen[h] = 1
            c = h
            while main[c] and not seen[dn[c]]:
                c = dn[c]
                seen[c] = 1
                path.append(c)
            out.append(path)
        return out

    def sites(self, area: np.ndarray, qual: np.ndarray, crit: dict) -> list:
        gaps_max = int(crit.get("gapReaches") or 0)
        min_ft = float(crit.get("minSiteFt") or 0)
        q = self.a["q"]
        eligible = area & (q <= C.Q_NOT_ENOUGH)
        lens = self.len_m.tolist()
        out = []

        def close(run):
            if run:
                rows = run
                length = 0.0                       # summed in order, as the app sums
                qual_len = 0.0
                n_qual = 0
                for r in rows:
                    length += lens[r]
                    if qual[r]:
                        qual_len += lens[r]
                        n_qual += 1
                if length / C.M_PER_FT >= min_ft:
                    out.append({"rows": rows, "length_m": length, "qual_length_m": qual_len,
                                "qualifying": n_qual, "id": self.reach_id(rows[-1])})

        for path in self.paths():
            run: list = []
            gaps: list = []
            for r in path:
                if eligible[r]:
                    if qual[r]:
                        if run:
                            run.extend(gaps)
                        run.append(r)
                        gaps = []
                    elif run:
                        gaps.append(r)
                        if len(gaps) > gaps_max:
                            close(run)
                            run, gaps = [], []
                else:
                    close(run)
                    run, gaps = [], []
            close(run)
        out.sort(key=lambda s: (-s["length_m"], s["id"]))
        return out

    # ---- the upstream walk
    def walk(self, start: int) -> np.ndarray:
        """Every row upstream of ``start`` (included): rows pointing to a row, any main, and the
        line a minor divergent branch splits from."""
        src = np.flatnonzero(self.dn >= 0)
        tgt = self.dn[src]
        order = np.argsort(tgt, kind="stable")
        tgt_s, src_s = tgt[order], src[order]
        starts = np.searchsorted(tgt_s, np.arange(self.n), side="left")
        ends = np.searchsorted(tgt_s, np.arange(self.n), side="right")
        seen = np.zeros(self.n, dtype=bool)
        seen[start] = True
        stack = [start]
        div = self.div
        while stack:
            r = stack.pop()
            ups = src_s[starts[r]:ends[r]].tolist()
            if div[r] >= 0:
                ups.append(int(div[r]))
            for u in ups:
                if not seen[u]:
                    seen[u] = True
                    stack.append(u)
        return np.flatnonzero(seen)


def area_huc12(net: Network, huc12s: list) -> np.ndarray:
    return np.isin(net.a["huc12"], np.asarray([int(h) for h in huc12s], dtype=np.int64))


def area_huc10(net: Network, huc10s: list) -> np.ndarray:
    return np.isin(net.a["huc12"] // 100, np.asarray([int(h) for h in huc10s], dtype=np.int64))


def area_rows(net: Network, rows: np.ndarray) -> np.ndarray:
    m = np.zeros(net.n, dtype=bool)
    m[rows] = True
    return m


def screen(net: Network, area: np.ndarray, crit: dict) -> dict:
    steps, qual = net.funnel(area, crit)
    sites = net.sites(area, qual, crit)
    steps["sites"] = len(sites)
    return {"funnel": steps, "sites": sites, "qualifying": qual}
