"""Chains of flowlines, their cut into reaches, and the network pointers (numpy only, so the rules
can be tested on small synthetic networks).

Lines are rows of a region's lines file. ``dn`` and ``up`` are the absolute row of the downstream
line and of the upstream mainstem line in the same region (-1 none), from the file's row offsets.
"""
from __future__ import annotations

import numpy as np

from .config import DA_BREAK, FCLASS, UNIT_SECTIONS


def fclass_of(fcode: np.ndarray) -> np.ndarray:
    """The layer's class of each line (0: dropped)."""
    ft = np.asarray(fcode, dtype=np.int64) // 100
    out = np.zeros(len(ft), dtype=np.uint8)
    for code, cls in FCLASS.items():
        out[ft == code] = cls
    return out


def huc8_of(huc12: np.ndarray, reachcode: np.ndarray) -> np.ndarray:
    """Each line's HUC8: from the HUC12 at its middle, else from its reach code."""
    h = np.asarray(huc12, dtype=np.int64)
    rc = np.asarray(reachcode, dtype=np.int64)
    return np.where(h > 0, h // 10 ** 4, rc // 10 ** 6).astype(np.int64)


def targets(step: np.ndarray) -> np.ndarray:
    """Row offsets (0 = none) as absolute rows (-1 = none)."""
    step = np.asarray(step, dtype=np.int64)
    return np.where(step != 0, np.arange(len(step)) + step, -1)


def continuation(dn: np.ndarray, up: np.ndarray, gridded: np.ndarray, cls: np.ndarray, huc8: np.ndarray,
                 da: np.ndarray, da_break: float = DA_BREAK) -> np.ndarray:
    """``nxt[u]``: the line u continues into in one chain (-1 none). Gridded line u continues into its
    downstream line d when d's upstream mainstem is u, d is gridded, both are of one class and one
    HUC8, and u drains at least ``da_break`` of d."""
    n = len(dn)
    u = np.arange(n)
    ok = gridded & (dn >= 0)
    d = np.where(ok, dn, 0)
    with np.errstate(invalid="ignore"):
        ok &= gridded[d] & (up[d] == u) & (cls[d] == cls) & (huc8[d] == huc8) & (da >= da_break * da[d])
    return np.where(ok, dn, -1)


def chains(nxt: np.ndarray, gridded: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """``(lines, starts)``: every gridded line once, chain by chain, upstream to downstream; ``starts``
    holds each chain's first position (and the total at the end). A chain starts at a gridded line
    no other line continues into; a cycle (never expected) is cut at its first line by row."""
    n = len(nxt)
    has = nxt >= 0
    prev = np.full(n, -1, dtype=np.int64)
    prev[nxt[has]] = np.flatnonzero(has)
    nxt_l = nxt.tolist()
    seen = bytearray(n)
    order: list[int] = []
    starts: list[int] = []

    def follow(head: int) -> None:
        starts.append(len(order))
        c = head
        while c >= 0 and not seen[c]:
            seen[c] = 1
            order.append(c)
            c = nxt_l[c]

    for head in np.flatnonzero(gridded & (prev < 0)).tolist():
        follow(head)
    for head in np.flatnonzero(gridded).tolist():   # lines on a cycle, if any
        if not seen[head]:
            follow(head)
    starts.append(len(order))
    return np.asarray(order, dtype=np.int64), np.asarray(starts, dtype=np.int64)


def units_per_chain(n_sections: np.ndarray, unit_sections: int = UNIT_SECTIONS) -> np.ndarray:
    """A chain of N sections makes max(1, floor(N / unit_sections + 1/2)) reaches."""
    n = np.asarray(n_sections, dtype=np.int64)
    return np.maximum(1, (2 * n + unit_sections) // (2 * unit_sections))


def cut(chain_sections: np.ndarray, unit_sections: int = UNIT_SECTIONS) -> tuple[np.ndarray, np.ndarray]:
    """``(unit_of_section, unit_start)``: chains of ``chain_sections`` sections laid end to end; reach j
    of a chain of N sections in u reaches holds its sections [floor(jN/u), floor((j+1)N/u))."""
    n = np.asarray(chain_sections, dtype=np.int64)
    u = units_per_chain(n, unit_sections)
    sec_off = np.cumsum(n) - n                              # right for no chains too (an empty region)
    chain_of_unit = np.repeat(np.arange(len(n)), u)
    unit_off = np.cumsum(u) - u
    j = np.arange(int(u.sum())) - np.repeat(unit_off, u)
    unit_start = sec_off[chain_of_unit] + (j * n[chain_of_unit]) // u[chain_of_unit]
    g = np.arange(int(n.sum()))
    unit_of_section = np.searchsorted(unit_start, g, side="right") - 1
    return unit_of_section, unit_start


def downstream_kept(start: np.ndarray, dn: np.ndarray, up: np.ndarray, keep: np.ndarray,
                    dn_out: np.ndarray, hydroseq: np.ndarray, max_hops: int = 256):
    """From each line in ``start``, the first kept line downstream in the region, through dropped
    lines (pipelines, coastline). Returns ``(d, main, hs_out, src_hs)``: the line (-1 none), whether
    every hop was onto the target's upstream mainstem, and for a target in another region its
    hydroseq and the hydroseq of the line whose downstream it is (0 none)."""
    cur = np.asarray(start, dtype=np.int64).copy()
    m = len(cur)
    d = np.full(m, -1, dtype=np.int64)
    main = np.ones(m, dtype=bool)
    hs_out = np.zeros(m, dtype=np.int64)
    src_hs = np.zeros(m, dtype=np.int64)
    active = np.ones(m, dtype=bool)
    for _ in range(max_hops):
        if not active.any():
            break
        nxt = np.where(active, dn[cur], -1)
        ends = active & (nxt < 0)
        hs_out[ends] = dn_out[cur[ends]]
        src_hs[ends] = np.where(dn_out[cur[ends]] != 0, hydroseq[cur[ends]], 0)
        active &= ~ends
        safe = np.where(active, nxt, 0)
        main &= ~active | (up[safe] == cur)
        found = active & keep[safe]
        d[found] = safe[found]
        active &= ~found
        cur = np.where(active, safe, cur)
    return d, main, hs_out, src_hs


def divergence_heads(up: np.ndarray, dn: np.ndarray, keep: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """``(heads, splitters)``: kept lines that head a minor divergent branch (their upstream mainstem
    line A flows on into another line) and that line A (kept lines only)."""
    x = np.flatnonzero(keep & (up >= 0))
    a = up[x]
    minor = keep[a] & (dn[a] != x)
    return x[minor], a[minor]
