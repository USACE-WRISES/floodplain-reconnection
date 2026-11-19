"""Reach lines tile their chains exactly; checked on a synthetic chain and on the built regions."""
import json

import numpy as np
import pytest

from fprdata import geometry


def _chain():
    # two lines meeting near (-84.49, 33.70), in whole 1e-5 degree units, in one chain
    x0, y0 = -8449000, 3370000
    vx = np.array([0, 400, 1000, 1000, 1600, 2000], dtype=np.int64) + x0
    vy = np.array([0, 0, 0, 0, 300, 300], dtype=np.int64) + y0
    voff = np.array([0, 3, 6])
    return vx, vy, voff


def test_pieces_tile_a_chain():
    vx, vy, voff = _chain()
    px, py = geometry.to_5070(vx, vy)
    cv = geometry.ChainVertices(np.array([0, 1]), np.array([0, 2]), voff, vx, vy, px, py)
    assert cv.seq.tolist() == [0, 1, 2, 4, 5]                 # the shared vertex once
    nsec = np.array([3, 4])
    pos = np.array([0, 0, 0, 1, 1, 1, 1])
    k = np.array([0, 1, 2, 0, 1, 2, 3])
    # reaches of sections [0..1], [2..4], [5..6]
    first, last = np.array([0, 2, 5]), np.array([1, 4, 6])
    S0 = cv.boundary(pos[first], k[first], nsec[pos[first]])
    S1 = cv.boundary(pos[last], k[last] + 1, nsec[pos[last]])
    assert (S1[:-1] == S0[1:]).all()
    assert S0[0] == cv.G[0] and S1[-1] == cv.G[-1]
    off, x, y = cv.pieces(S0, S1, np.zeros(3, dtype=np.int64))
    ends = [(x[off[i + 1] - 1], y[off[i + 1] - 1]) for i in range(3)]
    starts = [(x[off[i]], y[off[i]]) for i in range(3)]
    assert ends[:-1] == starts[1:]
    assert (x[0], y[0]) == (vx[0], vy[0]) and (x[-1], y[-1]) == (vx[-1], vy[-1])
    allx = np.concatenate([x[off[i]:off[i + 1]] for i in range(3)])
    assert set((vx[[0, 1, 2, 4, 5]]).tolist()) <= set(allx.tolist())
    # each cut lies on the line, within the rounding of whole 1e-5 degree units
    cx, cy = geometry.to_5070(np.array([s[0] for s in starts[1:]]), np.array([s[1] for s in starts[1:]]))
    qx, qy = cv.point_5070(S0[1:], np.zeros(2, dtype=np.int64))
    assert np.hypot(cx - qx, cy - qy).max() < 1.0


def test_whole_lines_length():
    vx, vy, voff = _chain()
    vx, vy = vx - vx[0], vy - vy[0]                           # plane coordinates for the lengths
    off, x, y, length = geometry.whole_lines(np.array([0, 1]), voff, vx, vy, vx.astype(float), vy.astype(float))
    assert off.tolist() == [0, 3, 6]
    assert length[0] == pytest.approx(1000.0)
    assert length[1] == pytest.approx(np.hypot(600, 300) + 400)


def test_built_regions_pass_the_geometry_checks(paths, index):
    """Every section of every built region lies in its reach (its point placed by the grid's rule
    within a millimeter of the grid's stored point), the reaches of each chain share their cut
    vertices exactly, and a sample of stored points lie within 1 m of the stored reach lines."""
    for vpu in index["fpr"]["regions"]:
        meta = json.loads((paths.cache / f"{vpu}.json").read_text(encoding="utf-8"))
        ck = meta.get("checks")
        assert ck, f"{vpu} was built without the checks"
        for name in ("shared_boundary_mismatch", "shared_vertex_mismatch", "chain_start_mismatch",
                     "chain_end_mismatch", "section_outside_reach"):
            assert ck[name] == 0, (vpu, name)
        assert ck["sections_checked"] == meta["sections"]
        assert ck["section_offset_max_m"] < 1e-3, vpu
        assert ck["stored_line_distance_max_m"] < 1.0, vpu
