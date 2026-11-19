"""The built site: its checksums and schema, section conservation, the pointers, the outlines, the
known answers, parity with STAF on real reaches, and a deterministic rebuild."""
import gzip
import hashlib
import json
import shutil

import numpy as np
import pyarrow.parquet as pq
import pytest

from fprdata import config as C
from fprdata import inputs, outlines, partition, region, report, screen


def _units(index):
    return sorted(k for k in index["files"] if k.startswith("units/"))


def test_manifest_checksums(site, index):
    for logical, (stored, size, sha) in index["files"].items():
        data = (site / stored).read_bytes()
        assert len(data) == size, logical
        assert hashlib.sha256(data).hexdigest() == sha, logical
        assert stored.split("/")[-1].split(".")[1] == sha[:12], logical
    with gzip.open(site / "web-index.json.gz") as fh:
        assert json.load(fh) == index


def test_unit_files_follow_the_contract(site, index):
    for logical in _units(index):
        f = pq.ParquetFile(site / index["files"][logical][0])
        assert f.metadata.num_row_groups == 1
        schema = f.schema_arrow
        assert schema.names == partition.COLUMNS, logical
        for field in partition.SCHEMA:
            assert schema.field(field.name).type == field.type, (logical, field.name)
        assert f.metadata.row_group(0).column(0).compression == "ZSTD"
        assert index["fpr"]["huc8"][logical.split("/")[1][:8]]["rows"] == f.metadata.num_rows


def _all(site, index, cols):
    out = {}
    for logical in _units(index):
        out[logical.split("/")[1][:8]] = pq.read_table(site / index["files"][logical][0], columns=cols)
    return out


def test_sections_conserved_per_region(paths, site, index, release_doc):
    """Every section of every built region is in one reach: the counts by status equal the grid's
    own numbers files (release.json's ``sections`` for the totals)."""
    tabs = _all(site, index, ["vpu", "n", "n_ok", "n_unm", "n_nodem"])
    sums: dict = {}
    for t in tabs.values():
        df = t.to_pandas()
        for vpu, g in df.groupby("vpu"):
            s = sums.setdefault(vpu, [0, 0, 0, 0])
            s[0] += int(g["n"].sum())
            s[1] += int(g["n_ok"].sum())
            s[2] += int(g["n_unm"].sum())
            s[3] += int(g["n_nodem"].sum())
    assert sorted(sums) == sorted(index["fpr"]["regions"])
    for vpu, (n, ok, unm, nodem) in sums.items():
        assert n == release_doc["regions"][vpu]["sections"], vpu
        st = np.bincount(pq.read_table(paths.release / f"xs-{vpu}.parquet", columns=["status"])
                         .column("status").to_numpy(), minlength=5)
        assert ok == st[C.STATUS_OK] + st[C.STATUS_OK_REFERENCE], vpu
        assert unm == st[C.STATUS_UNBALANCED] + st[C.STATUS_TOO_FEW], vpu
        assert nodem == st[C.STATUS_NO_DEM], vpu


def test_pointers_resolve(site, index):
    """Every pointer names a row of a published file, and no row has two mainstem neighbors."""
    tabs = _all(site, index, ["dn_huc8", "dn_row", "main", "div"])
    names = sorted(tabs)
    codes = np.array([int(h) for h in names], dtype=np.int64)
    sizes = np.array([tabs[h].num_rows for h in names], dtype=np.int64)
    offsets = np.cumsum(sizes) - sizes
    main_targets = []
    for i, h in enumerate(names):
        t = tabs[h]
        dh = t.column("dn_huc8").to_numpy().astype(np.int64)
        dr = t.column("dn_row").to_numpy().astype(np.int64)
        m = t.column("main").to_numpy()
        dv = t.column("div").to_numpy()
        has = dr >= 0
        assert ((dh == 0) == ~has).all(), h
        pos = np.searchsorted(codes, dh[has])
        assert (pos < len(codes)).all() and (codes[np.minimum(pos, len(codes) - 1)] == dh[has]).all(), h
        assert (dr[has] < sizes[pos]).all(), h
        assert not (m & ~has).any(), h
        pm = np.searchsorted(codes, dh[m])
        main_targets.append(offsets[pm] + dr[m])
        assert ((dv >= -1) & (dv < sizes[i])).all(), h
    targets = np.concatenate(main_targets)
    assert len(np.unique(targets)) == len(targets)


def test_outlines_valid(site, index):
    import shapely
    for logical in [k for k in index["files"] if k.startswith("outlines/")]:
        stored, size, sha = index["files"][logical]
        raw = gzip.decompress((site / stored).read_bytes())
        assert len(raw) == index["gzip"][logical]
        doc = json.loads(raw)
        code = "huc8" if logical.endswith("huc8.json") else "huc12"
        assert doc["features"], logical
        geoms = shapely.from_geojson([json.dumps(f["geometry"]) for f in doc["features"]])
        assert shapely.is_valid(geoms).all() and not shapely.is_empty(geoms).any(), logical
        codes = [f["properties"][code] for f in doc["features"]]
        assert codes == sorted(codes) and len(set(codes)) == len(codes)
        # the HUC12 target is 1 MB; a HUC4 still over it at the largest tolerance (Lake Erie's shore,
        # 0424, has many small parts) may go to 1.5 MB
        assert size < (3_000_000 if code == "huc8" else 1_500_000), (logical, size)


def _bfs(lines_path, outlet):
    t = pq.read_table(lines_path, columns=["nhdplusid", "dn_step"])
    ids = t.column("nhdplusid").to_numpy()
    dn = t.column("dn_step").to_numpy()
    src = np.flatnonzero(dn != 0)
    tgt = src + dn[src]
    order = np.argsort(tgt, kind="stable")
    tgt_s, src_s = tgt[order], src[order]
    start = int(np.flatnonzero(ids == outlet)[0])
    seen = {start}
    stack = [start]
    while stack:
        r = stack.pop()
        a, b = np.searchsorted(tgt_s, r, "left"), np.searchsorted(tgt_s, r, "right")
        for u in src_s[a:b].tolist():
            if u not in seen:
                seen.add(u)
                stack.append(u)
    return ids[sorted(seen)]


@pytest.mark.parametrize("name,vpu,outlet,lines,gridded,sections", [
    ("coosawhatchie", "0305", report.COOSAWHATCHIE_OUTLET_LINE, 9604, 6887, 63584),
    ("utoy", "0313", report.UTOY_OUTLET_LINE, 139, 114, 3169),
])
def test_known_answers(paths, site, index, name, vpu, outlet, lines, gridded, sections):
    if vpu not in index["fpr"]["regions"]:
        pytest.skip(f"{vpu} not built")
    lm = inputs.Lines(paths.lines, paths.values)
    basin = _bfs(lm.lines_path(vpu, verify=False), outlet)
    assert len(basin) == lines
    lk = pq.read_table(paths.cache / f"{vpu}.lookup.parquet").to_pandas().set_index("nhdplusid")
    g = lk.loc[lk.index.intersection(basin)]
    g = g[g["nsec"] > 0]
    assert len(g) == gridded and int(g["nsec"].sum()) == sections
    # the screener's walk from the outlet reaches every section of the basin
    huc8s = [h for h, m in index["fpr"]["huc8"].items() if vpu in m["regions"]]
    net = screen.Network(site, huc8s, index)
    last = lk.loc[outlet]
    rows = set(net.walk(net.row_of(f"{int(last['last_huc8']):08d}", int(last["last_row"]))).tolist())
    for _, r in g.iterrows():
        assert net.row_of(f"{int(r['first_huc8']):08d}", int(r["first_row"])) in rows
        assert net.row_of(f"{int(r['last_huc8']):08d}", int(r["last_row"])) in rows
    assert int(net.a["n"][sorted(rows)].sum()) >= sections


def test_parity_with_staf_on_built_reaches(paths, site, index, geomorph):
    """Reaches inside one line: their published numbers against STAF's reach rule on the grid's own
    sections."""
    rng = np.random.default_rng(5)
    checked = 0
    for vpu in index["fpr"]["regions"][:3]:
        num = pq.read_table(paths.release / f"xs-{vpu}.parquet").to_pandas()
        num = num.set_index(["nhdplusid", "k"]).sort_index()
        huc8 = next(h for h, m in index["fpr"]["huc8"].items() if m["regions"] == [vpu])
        t = pq.read_table(site / index["files"][f"units/{huc8}.parquet"][0]).to_pandas()
        t = t[t["n"] > 0]
        nsec = num.groupby(level=0)["n_sec"].first()
        t = t[t["k0"] + t["n"] <= t["id"].map(nsec)]
        for _, u in t.sample(n=min(300, len(t)), random_state=int(rng.integers(1 << 30))).iterrows():
            sec = num.loc[(u["id"], slice(int(u["k0"]), int(u["k0"]) + int(u["n"]) - 1)), :]
            assert len(sec) == u["n"]
            ok = sec[sec["status"].isin(C.SCORED)]
            assert len(ok) == u["n_ok"]
            if not len(ok):
                assert np.isnan(u["bhr"])
                continue
            cands = [{"entrenchment_ratio": float(r.er) / 100, "bank_height_ratio": float(r.bhr) / 100,
                      "low_bank_capped": bool(int(r.flags) & 1), "edge_limited": bool(int(r.flags) & 2)}
                     for r in ok.itertuples()]
            rs = geomorph.reach_stats(cands)
            assert u["bhr"] == round(rs["bank_height_ratio"]["median"] * 100)
            assert u["er"] == round(rs["entrenchment_ratio"]["median"] * 100)
            assert u["bhr_hi"] == round(rs["bank_height_ratio"]["max"] * 100)
            assert u["er_lo"] == round(rs["entrenchment_ratio"]["min"] * 100)
            assert bool(int(u["why"]) & C.WHY_AT_CAP) == rs["bank_height_ratio"]["median_capped"]
            assert bool(int(u["why"]) & C.WHY_EDGE) == geomorph.median_edge_limited(cands)
            checked += 1
    assert checked > 100


def test_rebuild_is_identical(paths, index, tmp_path):
    """Pass 1 and pass 2 of one region, twice, into two folders: the same bytes."""
    vpu = "0313" if "0313" in index["fpr"]["regions"] else index["fpr"]["regions"][0]
    release = inputs.Release(paths.release, json.loads((paths.cache / "release_snapshot.json").read_text("utf-8")))
    lines_m = inputs.Lines(paths.lines, paths.values)
    digests = []
    for name in ("a", "b"):
        out = tmp_path / name
        (out / "cache" / "outlines").mkdir(parents=True)
        for p in (paths.cache / "outlines").iterdir():
            shutil.copyfile(p, out / "cache" / "outlines" / p.name)
        shutil.copyfile(paths.cache / "huc8_regions.json", out / "cache" / "huc8_regions.json")
        region.build_region(vpu, str(paths.release), str(paths.lines), str(paths.values), str(out / "cache"),
                            release.doc, lines_m.doc, force=True, verify=False)
        p = C.Paths(release=paths.release, lines=paths.lines, values=paths.values, wbd=paths.wbd, out=out)
        doc = partition.build_site(p, [vpu], release, lines_m, log=lambda *a: None)
        digests.append((doc["data_version"], dict((k, v[2]) for k, v in doc["files"].items()),
                        hashlib.sha256((out / "cache" / f"{vpu}.parquet").read_bytes()).hexdigest()))
    assert digests[0] == digests[1]
