"""Pass 1: one region's reaches and unsampled lines, with region-local network pointers, into the
cache (``cache/<vpu>.parquet``, ``cache/<vpu>.lines.parquet``, ``cache/<vpu>.json``)."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import config as C
from . import geometry, inputs, network, stats

#: the columns a pass-1 table holds beyond the published ones
CACHE_EXTRA = ("huc8", "line_row", "dn_local", "dn_hs", "src_hs", "div_local")


def cache_paths(cache: Path, vpu: str) -> dict:
    return {"rows": cache / f"{vpu}.parquet", "lines": cache / f"{vpu}.lines.parquet", "meta": cache / f"{vpu}.json"}


def cache_key(release: inputs.Release, lines: inputs.Lines, vpu: str) -> dict:
    names = release.asset_names(vpu)
    return {"layout": C.CACHE_LAYOUT, "rule": C.RULE,
            "release": dict((k, release.asset_sha256(v)) for k, v in names.items()),
            "lines": lines.lines_sha256(vpu),
            "extras": inputs.sha256_file(lines.extras_path(vpu))}


def cached(cache: Path, vpu: str, key: dict) -> dict | None:
    p = cache_paths(cache, vpu)
    if not all(x.exists() for x in p.values()):
        return None
    meta = json.loads(p["meta"].read_text(encoding="utf-8"))
    return meta if meta.get("key") == key else None


def build_region(vpu: str, release_dir: str, lines_dir: str, values_dir: str, cache_dir: str,
                 release_doc: dict, lines_doc: dict, force: bool = False, verify: bool = True) -> dict:
    """Pass 1 for one region (run in a worker process). Returns the region's summary; with ``verify``
    it also holds the geometry checks against the grid's stored section points."""
    t0 = time.time()
    release = inputs.Release(Path(release_dir), release_doc)
    lines_m = inputs.Lines(Path(lines_dir), Path(values_dir), lines_doc)
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    key = cache_key(release, lines_m, vpu)
    if not force:
        hit = cached(cache, vpu, key)
        if hit is not None:
            hit["cached"] = True
            return hit
    names = release.asset_names(vpu)
    L = inputs.read_lines(lines_m.lines_path(vpu))
    huc12 = inputs.read_huc12(lines_m.extras_path(vpu), L["nhdplusid"])
    N = inputs.read_numbers(release.asset(names["numbers"]))
    lb = inputs.read_low_bank(release.asset(names["sections"]), N["nhdplusid"], N["k"])
    med_ids, med_k = inputs.read_median_keys(release.asset(names["median"]))
    sec_xy = inputs.read_section_xy(release.folder / names["sections"], N["nhdplusid"], N["k"]) if verify else None
    t_read = time.time() - t0
    rows, lines_tab, summary = region_rows(vpu, L, huc12, N, lb, med_ids, med_k, sec_xy=sec_xy)
    p = cache_paths(cache, vpu)
    pq.write_table(rows, p["rows"], compression="zstd", compression_level=3)
    pq.write_table(lines_tab, p["lines"], compression="zstd", compression_level=3)
    summary.update({"vpu": vpu, "key": key, "seconds": round(time.time() - t0, 1), "read_seconds": round(t_read, 1),
                    "cache_bytes": p["rows"].stat().st_size})
    p["meta"].write_text(json.dumps(summary, indent=1, sort_keys=True), encoding="utf-8")
    summary["cached"] = False
    return summary


def region_rows(vpu: str, L: dict, huc12: np.ndarray, N: dict, lb: np.ndarray,
                med_ids: np.ndarray, med_k: np.ndarray, sec_xy=None, sample: int = 20000,
                seed: int = 17) -> tuple[pa.Table, pa.Table, dict]:
    """The region's rows (reaches, then unsampled lines, sorted by first line and k0) and its lines.
    With ``sec_xy`` (the sections' stored points, EPSG:5070) the summary also holds the geometry
    checks: every section's point against its reach, and ``sample`` of them against the stored,
    rounded reach line."""
    n_lines = len(L["nhdplusid"])
    lid = L["nhdplusid"]
    # ---- the grid's sections of each line
    nid = N["nhdplusid"]
    if len(nid):
        if not (N["part"] == 0).all():
            raise ValueError(f"{vpu}: a section on a line part other than 0")
        heads = np.flatnonzero(np.r_[True, nid[1:] != nid[:-1]])
        uid = nid[heads]
        ucount = np.diff(np.r_[heads, len(nid)])
        if not (N["n_sec"][heads] == ucount).all() or not (np.diff(uid) > 0).all():
            raise ValueError(f"{vpu}: the numbers file is not one run of sections per line, sorted")
        pos = np.searchsorted(uid, lid)
        pos_c = np.minimum(pos, len(uid) - 1)
        has = uid[pos_c] == lid
        if int(has.sum()) != len(uid):
            raise ValueError(f"{vpu}: {len(uid) - int(has.sum())} gridded lines are not in the lines file")
        sec_start = np.where(has, heads[pos_c], -1)
        nsec = np.where(has, ucount[pos_c], 0)
    else:
        sec_start = np.full(n_lines, -1, dtype=np.int64)
        nsec = np.zeros(n_lines, dtype=np.int64)
    fclass = network.fclass_of(L["fcode"])
    keep = fclass > 0
    gridded = keep & (nsec > 0)
    if int((nsec[~keep] > 0).sum()):
        raise ValueError(f"{vpu}: sections on lines of a dropped feature type")
    huc8 = network.huc8_of(huc12, L["reachcode"])
    dn = network.targets(L["dn_step"])
    up = network.targets(L["up_step"])
    da = L["totdasqkm"]

    # ---- chains and their cut into reaches
    nxt = network.continuation(dn, up, gridded, fclass, huc8, da)
    cl, cstart = network.chains(nxt, gridded)
    nsec_cl = nsec[cl]
    chain_n = np.add.reduceat(nsec_cl, cstart[:-1]) if len(cl) else np.zeros(0, dtype=np.int64)
    unit_of_cs, unit_start = network.cut(chain_n)
    n_units = len(unit_start)
    total_cs = int(nsec_cl.sum())
    unit_end = np.r_[unit_start[1:], total_cs][:n_units] - 1
    cs_pos = np.repeat(np.arange(len(cl)), nsec_cl)
    pos_sec_off = np.cumsum(nsec_cl) - nsec_cl              # each chain position's first chain section
    cs_k = np.arange(total_cs) - pos_sec_off[cs_pos]
    cs_rel = sec_start[cl][cs_pos] + cs_k                   # the release row of each chain section
    if total_cs != len(nid) or (len(cs_rel) and len(np.unique(cs_rel)) != total_cs):
        raise ValueError(f"{vpu}: sections were not assigned once each")

    # ---- statistics
    sec = dict((k, N[k][cs_rel]) for k in ("status", "flags", "bank", "res", "er", "bhr", "bfd", "bfw", "fpw"))
    sec["lb"] = lb[cs_rel]
    st = stats.unit_stats(unit_of_cs, n_units, sec)

    # ---- geometry: chains of vertices, cut at the reaches' boundaries
    px, py = geometry.to_5070(L["vx"], L["vy"])
    cv = geometry.ChainVertices(cl, cstart, L["voff"], L["vx"], L["vy"], px, py)
    p_first, k_first = cs_pos[unit_start], cs_k[unit_start]
    p_last, k_last = cs_pos[unit_end], cs_k[unit_end]
    S0 = cv.boundary(p_first, k_first, nsec_cl[p_first])
    S1 = cv.boundary(p_last, k_last + 1, nsec_cl[p_last])
    chain_of_unit = cv.chain_of_pos[p_first]
    u_off, u_x, u_y = cv.pieces(S0, S1, chain_of_unit)
    u_len = S1 - S0
    checks = geometry_checks(cv, S0, S1, chain_of_unit, u_off, u_x, u_y, cs_pos, cs_k, nsec_cl, unit_of_cs,
                             cs_rel, sec_xy, sample, seed) if sec_xy is not None else None

    # ---- reach attributes
    line_first, line_last = cl[p_first], cl[p_last]
    p_mid = cs_pos[unit_start + st["n"] // 2]
    line_mid = cl[p_mid]
    names = list(L["gnis_name"])
    u_name = [names[i] for i in line_mid.tolist()]
    for u in np.flatnonzero(p_last > p_first).tolist():     # the downstream-most named line instead
        if not u_name[u]:
            for p in range(int(p_last[u]), int(p_first[u]) - 1, -1):
                if names[cl[p]]:
                    u_name[u] = names[cl[p]]
                    break

    # stored profiles inside each reach (prefer the line with the most sections in the reach)
    prof_id = np.full(n_units, -1, dtype=np.int64)
    prof_k = np.full(n_units, -1, dtype=np.int64)
    if len(med_ids) and len(cl):
        order_lid = np.argsort(lid, kind="stable")
        mpos = np.searchsorted(lid[order_lid], med_ids)
        mrow = order_lid[np.minimum(mpos, n_lines - 1)]
        ok = (lid[mrow] == med_ids) & gridded[mrow]
        pos_of_line = np.full(n_lines, -1, dtype=np.int64)
        pos_of_line[cl] = np.arange(len(cl))
        mp = pos_of_line[mrow[ok]]
        mk = med_k[ok]
        valid = (mp >= 0) & (mk < nsec[mrow[ok]])
        mp, mk, mline = mp[valid], mk[valid], mrow[ok][valid]
        mu = unit_of_cs[pos_sec_off[mp] + mk]
        line_lo = pos_sec_off[mp]
        line_hi = line_lo + nsec[mline] - 1
        overlap = np.minimum(line_hi, unit_end[mu]) - np.maximum(line_lo, unit_start[mu]) + 1
        best = np.lexsort((mp, -overlap, mu))               # per reach: most sections, then upstream-most
        first_of = np.r_[True, mu[best][1:] != mu[best][:-1]]
        chosen = best[first_of]
        prof_id[mu[chosen]] = lid[mline[chosen]]
        prof_k[mu[chosen]] = mk[chosen]

    # ---- unsampled lines
    ns = np.flatnonzero(keep & ~gridded)
    n_ns = len(ns)
    ns_off, ns_x, ns_y, ns_len = geometry.whole_lines(ns, L["voff"], L["vx"], L["vy"], px, py)

    # ---- rows before sorting: reaches 0..n_units-1, then unsampled lines
    n_rows = n_units + n_ns
    first_row = np.full(n_lines, -1, dtype=np.int64)
    last_row = np.full(n_lines, -1, dtype=np.int64)
    first_row[cl] = unit_of_cs[pos_sec_off]
    last_row[cl] = unit_of_cs[pos_sec_off + nsec_cl - 1]
    first_row[ns] = n_units + np.arange(n_ns)
    last_row[ns] = first_row[ns]

    row_first_line = np.r_[line_first, ns]
    row_last_line = np.r_[line_last, ns]
    dn_local = np.full(n_rows, -1, dtype=np.int64)
    main = np.zeros(n_rows, dtype=bool)
    dn_hs = np.zeros(n_rows, dtype=np.int64)
    src_hs = np.zeros(n_rows, dtype=np.int64)
    inner = np.zeros(n_rows, dtype=bool)                    # reach followed by the next one of its chain
    if n_units > 1:
        same_chain = chain_of_unit[1:] == chain_of_unit[:-1]
        inner[:n_units - 1] = same_chain
        dn_local[:n_units - 1][same_chain] = np.flatnonzero(same_chain) + 1
        main[:n_units - 1][same_chain] = True
    ends = np.flatnonzero(~inner)
    d, m, hs_out, s_hs = network.downstream_kept(row_last_line[ends], dn, up, keep, L["dn_out"], L["hydroseq"])
    found = d >= 0
    dn_local[ends[found]] = first_row[d[found]]
    main[ends] = np.where(found | (hs_out != 0), m, False)
    dn_hs[ends] = hs_out
    src_hs[ends] = s_hs
    div_local = np.full(n_rows, -1, dtype=np.int64)
    heads_x, split_a = network.divergence_heads(up, dn, keep)
    div_local[first_row[heads_x]] = last_row[split_a]

    # ---- assemble the columns, then sort by (first line's row, k0)
    k0 = np.r_[k_first, np.zeros(n_ns, dtype=np.int64)]
    line_row = row_first_line
    order = np.lexsort((k0, line_row))
    rank = np.empty(n_rows, dtype=np.int64)
    rank[order] = np.arange(n_rows)

    def remap(ptr):
        return np.where(ptr >= 0, rank[np.maximum(ptr, 0)], -1)

    def stat(name, n_fill=-1):
        return np.r_[st[name], np.full(n_ns, n_fill, dtype=np.int64)]

    slope_line = np.r_[line_mid, ns]
    slope = L["slope"][slope_line]
    slope_ok = np.isfinite(slope) & (slope > 0)
    order_v = np.maximum(L["streamorde"][slope_line], 0)
    da_row = da[row_last_line]
    da_row = np.where(np.isfinite(da_row) & (da_row > 0), da_row, 0.0)
    q = np.r_[st["q"], np.full(n_ns, C.Q_NOT_SAMPLED, dtype=np.int64)]
    why = np.r_[st["why"], np.zeros(n_ns, dtype=np.int64)]
    off = np.r_[u_off[:-1], ns_off[:-1] + u_off[-1], [u_off[-1] + ns_off[-1]]]
    vx = np.r_[u_x, ns_x]
    vy = np.r_[u_y, ns_y]
    counts = np.diff(off)
    new_counts = counts[order]
    new_off = np.concatenate([[0], np.cumsum(new_counts)])
    vidx = geometry._ranges(off[:-1][order], new_counts)

    def u8(a):
        return pa.array(np.asarray(a)[order].astype(np.uint8), type=pa.uint8())

    def nullable(a, typ, scale_ok=None):
        a = np.asarray(a)[order]
        mask = a < 0 if scale_ok is None else ~scale_ok[order]
        return pa.array(np.where(mask, 0, a).astype(typ.to_pandas_dtype()), type=typ, mask=mask)

    has_stats = np.r_[st["n_ok"] > 0, np.zeros(n_ns, dtype=bool)]
    all_names = u_name + [names[i] for i in ns.tolist()]
    cols = {
        "id": pa.array(lid[row_first_line][order], type=pa.int64()),
        "k0": pa.array(k0[order].astype(np.uint16), type=pa.uint16()),
        "n": u8(np.r_[st["n"], np.zeros(n_ns, dtype=np.int64)]),
        "vpu": pa.array([vpu] * n_rows, type=pa.string()),
        "len_m": pa.array(np.r_[u_len, ns_len][order].astype(np.float32), type=pa.float32()),
        "name": pa.array([all_names[i] for i in order.tolist()], type=pa.string()),
        "fclass": u8(fclass[row_first_line]),
        "order": u8(order_v),
        "da_sqkm": pa.array(da_row[order].astype(np.float32), type=pa.float32()),
        "slope": pa.array(np.where(slope_ok, slope, 0)[order].astype(np.float32), type=pa.float32(),
                          mask=~slope_ok[order]),
        "huc12": pa.array(huc12[slope_line][order], type=pa.int64()),
    }
    for name in ("n_ok", "n_unm", "n_nodem", "n_cap", "n_floor", "n_edge", "n_ext", "n_crest", "res"):
        cols[name] = u8(stat(name, 0))
    for name in ("bhr", "bhr_lo", "bhr_hi"):
        cols[name] = nullable(stat(name), pa.uint16(), has_stats)
    for name in ("er", "er_lo", "er_hi"):
        cols[name] = nullable(stat(name), pa.int32(), has_stats)
    for name in ("bfw", "fpw", "bfd", "lbh"):
        cols[name] = nullable(np.clip(stat(name), -1, 65535), pa.uint16(), has_stats)
    cols["q"] = u8(q)
    cols["why"] = pa.array(why[order].astype(np.uint16), type=pa.uint16())
    pid = np.r_[prof_id, np.full(n_ns, -1, dtype=np.int64)]
    pk = np.r_[prof_k, np.full(n_ns, -1, dtype=np.int64)]
    cols["prof_id"] = nullable(pid, pa.int64())
    cols["prof_k"] = nullable(pk, pa.uint16())
    cols["main"] = pa.array(main[order], type=pa.bool_())
    lst = pa.ListArray.from_arrays
    cols["x"] = lst(pa.array(new_off.astype(np.int32)), pa.array(vx[vidx].astype(np.int32), type=pa.int32()))
    cols["y"] = lst(pa.array(new_off.astype(np.int32)), pa.array(vy[vidx].astype(np.int32), type=pa.int32()))
    cols["huc8"] = pa.array(huc8[row_first_line][order].astype(np.int32), type=pa.int32())
    cols["line_row"] = pa.array(line_row[order].astype(np.int32), type=pa.int32())
    cols["dn_local"] = pa.array(remap(dn_local)[order].astype(np.int32), type=pa.int32())
    cols["dn_hs"] = pa.array(dn_hs[order], type=pa.int64())
    cols["src_hs"] = pa.array(src_hs[order], type=pa.int64())
    cols["div_local"] = pa.array(remap(div_local)[order].astype(np.int32), type=pa.int32())
    table = pa.table(cols)

    lines_tab = pa.table({
        "nhdplusid": pa.array(lid, type=pa.int64()),
        "hydroseq": pa.array(L["hydroseq"], type=pa.int64()),
        "up_out": pa.array(L["up_out"], type=pa.int64()),
        "first_row": pa.array(remap(first_row).astype(np.int32), type=pa.int32()),
        "last_row": pa.array(remap(last_row).astype(np.int32), type=pa.int32()),
        "nsec": pa.array(nsec.astype(np.int32), type=pa.int32()),
    })
    scored = np.isin(N["status"], C.SCORED)
    summary = {
        "lines": n_lines, "kept": int(keep.sum()), "gridded_lines": int(gridded.sum()),
        "chains": int(len(cstart) - 1), "units": n_units, "not_sampled": n_ns, "rows": n_rows,
        "sections": int(len(nid)), "scored": int(scored.sum()),
        "assigned_sections": int(st["n"].sum()), "assigned_scored": int(st["n_ok"].sum()),
        "vertices": int(len(vidx)), "divergence_heads": int(len(heads_x)),
        "cross_region_links": int((dn_hs != 0).sum()),
        "q": dict((str(i), int((q == i).sum())) for i in range(4)),
    }
    if checks is not None:
        summary["checks"] = checks
    return table, lines_tab, summary


def geometry_checks(cv, S0, S1, chain_of_unit, u_off, u_x, u_y, cs_pos, cs_k, nsec_cl, unit_of_cs, cs_rel,
                    sec_xy, sample, seed) -> dict:
    """The reaches tile their chains, and every section of the grid lies inside its reach: its point,
    placed by the grid's rule on the chain, against the grid's stored point, and a sample of stored
    points against the stored (rounded) reach lines."""
    import shapely
    out: dict = {}
    if len(S0) == 0:                                        # nothing gridded (a Great Lakes unit)
        return {"shared_boundary_mismatch": 0, "shared_vertex_mismatch": 0, "chain_start_mismatch": 0,
                "chain_end_mismatch": 0, "section_outside_reach": 0, "section_offset_max_m": 0.0,
                "sections_checked": 0, "stored_line_distance_max_m": 0.0, "stored_line_sample": 0}
    same = chain_of_unit[1:] == chain_of_unit[:-1]
    out["shared_boundary_mismatch"] = int((S1[:-1][same] != S0[1:][same]).sum())
    last = u_off[1:] - 1
    first = u_off[:-1]
    differ = (u_x[last][:-1] != u_x[first][1:]) | (u_y[last][:-1] != u_y[first][1:])
    out["shared_vertex_mismatch"] = int(differ[same].sum())
    head = np.r_[True, ~same]
    tail = np.r_[~same, True]
    out["chain_start_mismatch"] = int((S0[head] != cv.G[cv.chain_first[chain_of_unit[head]]]).sum())
    out["chain_end_mismatch"] = int((S1[tail] != cv.G[cv.chain_last[chain_of_unit[tail]]]).sum())
    S = cv.section_at(cs_pos, cs_k, nsec_cl[cs_pos])
    out["section_outside_reach"] = int(((S < S0[unit_of_cs]) | (S > S1[unit_of_cs])).sum())
    qx, qy = cv.point_5070(S, cv.chain_of_pos[cs_pos])
    sx, sy = sec_xy[0][cs_rel], sec_xy[1][cs_rel]
    off = np.hypot(qx - sx, qy - sy)
    out["section_offset_max_m"] = float(off.max()) if len(off) else 0.0
    out["sections_checked"] = int(len(off))
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(cs_rel), size=min(sample, len(cs_rel)), replace=False) if len(cs_rel) else np.zeros(0, int)
    units = unit_of_cs[pick]
    lines = []
    for u in units.tolist():
        a, b = int(u_off[u]), int(u_off[u + 1])
        px, py = geometry.to_5070(u_x[a:b], u_y[a:b])
        lines.append(shapely.linestrings(np.column_stack([px, py])) if b - a >= 2 else shapely.points(px[0], py[0]))
    if lines:
        dist = shapely.distance(np.array(lines, dtype=object), shapely.points(sx[pick], sy[pick]))
        out["stored_line_distance_max_m"] = float(np.max(dist))
        out["stored_line_sample"] = int(len(pick))
    return out


def table_digest(t: pa.Table) -> str:
    """A digest of a table's content (for the determinism checks)."""
    import io
    buf = io.BytesIO()
    pq.write_table(t, buf, compression="zstd", compression_level=3)
    return hashlib.sha256(buf.getvalue()).hexdigest()
