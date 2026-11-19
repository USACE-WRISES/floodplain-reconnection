"""Chains, the cut into reaches and the pointers, on small synthetic networks."""
import math

import numpy as np

from fprdata import network


def test_units_per_chain_is_the_rule():
    for n in range(1, 201):
        assert network.units_per_chain(np.array([n]))[0] == max(1, math.floor(n / 10 + 0.5))


def test_cut_holds_every_section_once_in_order():
    sizes = np.arange(1, 201)
    unit_of, start = network.cut(sizes)
    assert len(unit_of) == sizes.sum()
    assert (np.diff(unit_of) >= 0).all() and (np.diff(unit_of) <= 1).all()
    off = 0
    u = 0
    for n in sizes.tolist():
        k = max(1, math.floor(n / 10 + 0.5))
        for j in range(k):
            lo = off + (j * n) // k
            hi = off + ((j + 1) * n) // k
            assert start[u] == lo
            assert (unit_of[lo:hi] == u).all()
            if n >= 15:
                assert 7 <= hi - lo <= 14
            u += 1
        off += n
    assert u == len(start)


def _net():
    """Rows: 0 -> 1 -> 2 -> 3 (a mainstem), tributary 4 -> 2, a canal 5 -> 3, line 6 in another HUC8
    below 3, a small line 7 joining 3 where the drainage area more than doubles, a minor branch 8
    split from 1 (1's mainstem goes to 2) rejoining at 3."""
    n = 9
    dn = np.full(n, -1)
    up = np.full(n, -1)
    for a, b in [(0, 1), (1, 2), (2, 3), (4, 2), (5, 3), (3, 6), (7, 3), (8, 3)]:
        dn[a] = b
    for b, a in [(1, 0), (2, 1), (3, 2), (6, 3), (8, 1)]:
        up[b] = a
    gridded = np.ones(n, dtype=bool)
    cls = np.array([1, 1, 1, 1, 1, 2, 1, 1, 1], dtype=np.uint8)
    huc8 = np.array([1, 1, 1, 1, 1, 1, 2, 1, 1])
    da = np.array([10.0, 12, 30, 31, 5, 1, 40, 0.5, 1])
    return dn, up, gridded, cls, huc8, da


def test_continuation_rules():
    dn, up, gridded, cls, huc8, da = _net()
    nxt = network.continuation(dn, up, gridded, cls, huc8, da)
    assert nxt[0] == 1                    # mainstem, similar size
    assert nxt[1] == -1                   # 12 < 0.5 * 30: the drainage area more than doubles at 2
    assert nxt[2] == 3
    assert nxt[3] == -1                   # 6 is in another HUC8
    assert nxt[4] == -1                   # 2's mainstem is 1, not the tributary
    assert nxt[5] == -1 and nxt[7] == -1 and nxt[8] == -1


def test_chains_hold_each_gridded_line_once():
    dn, up, gridded, cls, huc8, da = _net()
    nxt = network.continuation(dn, up, gridded, cls, huc8, da)
    lines, starts = network.chains(nxt, gridded)
    assert sorted(lines.tolist()) == list(range(9))
    chains = [lines[a:b].tolist() for a, b in zip(starts[:-1], starts[1:])]
    assert [0, 1] in chains and [2, 3] in chains


def test_downstream_through_dropped_lines():
    # 0 -> 1 (dropped pipeline) -> 2; 2 has no downstream line here but one in another region
    dn = np.array([1, 2, -1])
    up = np.array([-1, 0, 1])
    keep = np.array([True, False, True])
    dn_out = np.array([0, 0, 777])
    hs = np.array([10, 11, 12])
    d, main, hs_out, src = network.downstream_kept(np.array([0, 2]), dn, up, keep, dn_out, hs)
    assert d.tolist() == [2, -1]
    assert main.tolist()[0] is True
    assert hs_out.tolist() == [0, 777] and src.tolist() == [0, 12]


def test_divergence_heads():
    dn, up, gridded, cls, huc8, da = _net()
    keep = np.ones(9, dtype=bool)
    heads, split = network.divergence_heads(up, dn, keep)
    assert heads.tolist() == [8] and split.tolist() == [1]


def test_huc8_falls_back_to_the_reach_code():
    h = network.huc8_of(np.array([31300020103, 0]), np.array([3130002000001, 3050208000001]))
    assert h.tolist() == [3130002, 3050208]
