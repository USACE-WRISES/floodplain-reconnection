"""Reach lines: each chain's flowlines laid end to end in EPSG:5070 (the transform the grid placed its
sections with), cut where the reaches meet.

Section k of a line of length L and n sections owns the cell [k L/n, (k+1) L/n]. A reach runs from
its first section's cell start to its last section's cell end, so the reaches of a chain tile it
exactly. Interior vertices are the line's own (whole 1e-5 degree units); a cut vertex is placed by
its distance along the segment measured in EPSG:5070, rounded to 1e-5 degree, and computed once, so
two reaches that meet share it exactly.
"""
from __future__ import annotations

import numpy as np

_TO_5070 = None
_FROM_5070 = None


def to_5070(vx: np.ndarray, vy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """1e-5 degree vertices in EPSG:5070 (as ``tools/xs-grid`` places sections)."""
    global _TO_5070
    if _TO_5070 is None:
        from pyproj import Transformer
        _TO_5070 = Transformer.from_crs(4326, 5070, always_xy=True)
    px, py = _TO_5070.transform(np.asarray(vx, dtype=np.float64) / 1e5, np.asarray(vy, dtype=np.float64) / 1e5)
    return np.asarray(px, dtype=np.float64), np.asarray(py, dtype=np.float64)


def from_5070(px: np.ndarray, py: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """EPSG:5070 points as whole 1e-5 degree units."""
    global _FROM_5070
    if _FROM_5070 is None:
        from pyproj import Transformer
        _FROM_5070 = Transformer.from_crs(5070, 4326, always_xy=True)
    lon, lat = _FROM_5070.transform(np.asarray(px, dtype=np.float64), np.asarray(py, dtype=np.float64))
    return (np.rint(np.asarray(lon, dtype=np.float64) * 1e5).astype(np.int64),
            np.rint(np.asarray(lat, dtype=np.float64) * 1e5).astype(np.int64))


def _ranges(starts: np.ndarray, counts: np.ndarray) -> np.ndarray:
    """The concatenation of range(s, s + c) for each pair."""
    counts = np.asarray(counts, dtype=np.int64)
    total = int(counts.sum())
    if total == 0:
        return np.zeros(0, dtype=np.int64)
    off = np.cumsum(counts) - counts
    return np.repeat(np.asarray(starts, dtype=np.int64) - off, counts) + np.arange(total)


class ChainVertices:
    """The vertices of every chain, line after line (a line's first vertex dropped where it repeats
    the previous line's last), with the distance ``G`` along them: within a chain the sum of its
    segments, and 1 m more from one chain to the next so that ``G`` keeps rising."""

    def __init__(self, cl: np.ndarray, cstart: np.ndarray, voff: np.ndarray, vx: np.ndarray, vy: np.ndarray,
                 px: np.ndarray, py: np.ndarray):
        n_pos = len(cl)
        counts = voff[cl + 1] - voff[cl]
        if n_pos and counts.min() < 2:
            raise ValueError("a gridded line with fewer than two vertices")
        src = _ranges(voff[cl], counts)
        first = np.cumsum(counts) - counts                  # each position's first entry in src
        chain_of_pos = np.repeat(np.arange(len(cstart) - 1), np.diff(cstart))
        is_head = np.zeros(n_pos, dtype=bool)
        is_head[cstart[:-1]] = True
        keep = np.ones(len(src), dtype=bool)
        cand = first[~is_head]
        same = (vx[src[cand]] == vx[src[cand - 1]]) & (vy[src[cand]] == vy[src[cand - 1]])
        keep[cand[same]] = False
        newidx = np.cumsum(keep) - 1
        self.seq = src[keep]                                 # region vertex index of each chain vertex
        self.vstart = newidx[first]                          # each position's first vertex
        self.vend = newidx[first + counts - 1]               # each position's last vertex
        chain_v = np.repeat(chain_of_pos, counts)[keep]
        sx, sy = px[self.seq], py[self.seq]
        step = np.hypot(np.diff(sx), np.diff(sy))
        step = np.where(chain_v[1:] == chain_v[:-1], step, 1.0)
        self.G = np.concatenate([[0.0], np.cumsum(step)])
        self.vx, self.vy = vx, vy
        self.px, self.py = px, py
        self.chain_of_pos = chain_of_pos
        self.chain_first = self.vstart[cstart[:-1]]          # each chain's first vertex
        self.chain_last = self.vend[cstart[1:] - 1]          # and last
        self.gs = self.G[self.vstart]                        # each position's start along the chain
        self.ge = self.G[self.vend]                          # and end

    def boundary(self, pos: np.ndarray, j: np.ndarray, n: np.ndarray) -> np.ndarray:
        """The distance of cell boundary j (0..n) of the line at chain position ``pos``: exactly its
        ends at 0 and n, so a boundary two reaches share is the same number for both."""
        gs, ge = self.gs[pos], self.ge[pos]
        mid = gs + (j * (ge - gs)) / n
        return np.where(j == 0, gs, np.where(j == n, ge, mid))

    def section_at(self, pos: np.ndarray, k: np.ndarray, n: np.ndarray) -> np.ndarray:
        """The distance of section k's point (the middle of its cell)."""
        gs, ge = self.gs[pos], self.ge[pos]
        return gs + ((k + 0.5) * (ge - gs)) / n

    def _segment(self, S: np.ndarray, chain: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        cf, cl = self.chain_first[chain], self.chain_last[chain]
        i = np.clip(np.searchsorted(self.G, S, side="right") - 1, cf, cl - 1)
        seg = self.G[i + 1] - self.G[i]
        t = np.where(seg > 0, (S - self.G[i]) / np.where(seg > 0, seg, 1.0), 0.0)
        return i, np.clip(t, 0.0, 1.0)

    def point_deg(self, S: np.ndarray, chain: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """The point at distance S, in whole 1e-5 degree units: placed on the segment in EPSG:5070 (a
        long straight segment is straight there, not in degrees) and taken back to degrees; a point on
        a vertex is that vertex."""
        i, t = self._segment(S, chain)
        a, b = self.seq[i], self.seq[i + 1]
        x5, y5 = self.px[a] + t * (self.px[b] - self.px[a]), self.py[a] + t * (self.py[b] - self.py[a])
        x, y = from_5070(x5, y5)
        at_a, at_b = t <= 0.0, t >= 1.0
        x = np.where(at_a, self.vx[a], np.where(at_b, self.vx[b], x))
        y = np.where(at_a, self.vy[a], np.where(at_b, self.vy[b], y))
        return x, y

    def point_5070(self, S: np.ndarray, chain: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """The point at distance S in EPSG:5070 (for the checks against the grid's sections)."""
        i, t = self._segment(S, chain)
        a, b = self.seq[i], self.seq[i + 1]
        return (self.px[a] + t * (self.px[b] - self.px[a]), self.py[a] + t * (self.py[b] - self.py[a]))

    def pieces(self, S0: np.ndarray, S1: np.ndarray, chain: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """``(offsets, x, y)``: each reach's line from S0 to S1 in whole 1e-5 degree units."""
        x0, y0 = self.point_deg(S0, chain)
        x1, y1 = self.point_deg(S1, chain)
        cf, cl = self.chain_first[chain], self.chain_last[chain]
        a = np.clip(np.searchsorted(self.G, S0, side="right") - 1, cf, cl - 1)
        b = np.clip(np.searchsorted(self.G, S1, side="left"), cf, cl)
        n_in = np.maximum(0, b - a - 1)
        inner = self.seq[_ranges(a + 1, n_in)]
        return assemble(x0, y0, x1, y1, n_in, self.vx[inner], self.vy[inner])


def assemble(x0, y0, x1, y1, n_in, ix, iy) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Each piece as [start, inner vertices..., end], with inner vertices that repeat the vertex
    before them dropped (a cut that rounds onto a vertex, or a zero-length segment)."""
    m = len(x0)
    cnt = n_in + 2
    off = np.concatenate([[0], np.cumsum(cnt)]).astype(np.int64)
    X = np.empty(int(off[-1]), dtype=np.int64)
    Y = np.empty(int(off[-1]), dtype=np.int64)
    X[off[:-1]], Y[off[:-1]] = x0, y0
    X[off[1:] - 1], Y[off[1:] - 1] = x1, y1
    rep = np.repeat(np.arange(m), n_in)
    within = np.arange(int(n_in.sum())) - np.repeat(np.cumsum(n_in) - n_in, n_in)
    dest = off[:-1][rep] + 1 + within
    X[dest], Y[dest] = ix, iy
    keep = np.ones(len(X), dtype=bool)
    if len(X) > 1:
        dup = np.zeros(len(X), dtype=bool)
        dup[1:] = (X[1:] == X[:-1]) & (Y[1:] == Y[:-1])
        inner_pos = np.ones(len(X), dtype=bool)
        inner_pos[off[:-1]] = False
        inner_pos[off[1:] - 1] = False
        keep = ~(dup & inner_pos)
    piece = np.repeat(np.arange(m), cnt)[keep]
    new_cnt = np.bincount(piece, minlength=m)
    new_off = np.concatenate([[0], np.cumsum(new_cnt)]).astype(np.int64)
    return new_off, X[keep], Y[keep]


def whole_lines(lines: np.ndarray, voff: np.ndarray, vx: np.ndarray, vy: np.ndarray,
                px: np.ndarray, py: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """``(offsets, x, y, length_m)`` of whole lines (the rows the grid does not sample)."""
    counts = voff[lines + 1] - voff[lines]
    idx = _ranges(voff[lines], counts)
    off = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)
    seg = np.hypot(np.diff(px[idx]), np.diff(py[idx])) if len(idx) > 1 else np.zeros(0)
    within_line = np.ones(max(len(idx) - 1, 0), dtype=bool)
    if len(idx) > 1:
        within_line = np.repeat(np.arange(len(lines)), counts)[1:] == np.repeat(np.arange(len(lines)), counts)[:-1]
    seg = np.where(within_line, seg, 0.0)
    csum = np.concatenate([[0.0], np.cumsum(seg)])
    length = csum[off[1:] - 1] - csum[off[:-1]] if len(lines) else np.zeros(0)
    return off, vx[idx], vy[idx], length
