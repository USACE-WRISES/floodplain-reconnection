"""Pass 2: the processed regions' rows into one file per HUC8, with the network pointers resolved
across regions and files, the watershed outlines, and the index (written last)."""
from __future__ import annotations

import hashlib
import io
import json
import shutil
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from . import config as C
from . import inputs, network, outlines

#: the published columns, in order
COLUMNS = ["id", "k0", "n", "vpu", "len_m", "name", "fclass", "order", "da_sqkm", "slope", "huc12",
           "n_ok", "n_unm", "n_nodem", "n_cap", "n_floor", "n_edge", "n_ext", "n_crest", "res",
           "bhr", "bhr_lo", "bhr_hi", "er", "er_lo", "er_hi", "bfw", "fpw", "bfd", "lbh", "q", "why",
           "prof_id", "prof_k", "dn_huc8", "dn_row", "main", "div", "x", "y"]
SCHEMA = pa.schema([
    ("id", pa.int64()), ("k0", pa.uint16()), ("n", pa.uint8()), ("vpu", pa.string()), ("len_m", pa.float32()),
    ("name", pa.string()), ("fclass", pa.uint8()), ("order", pa.uint8()), ("da_sqkm", pa.float32()),
    ("slope", pa.float32()), ("huc12", pa.int64()),
    ("n_ok", pa.uint8()), ("n_unm", pa.uint8()), ("n_nodem", pa.uint8()), ("n_cap", pa.uint8()),
    ("n_floor", pa.uint8()), ("n_edge", pa.uint8()), ("n_ext", pa.uint8()), ("n_crest", pa.uint8()),
    ("res", pa.uint8()), ("bhr", pa.uint16()), ("bhr_lo", pa.uint16()), ("bhr_hi", pa.uint16()),
    ("er", pa.int32()), ("er_lo", pa.int32()), ("er_hi", pa.int32()),
    ("bfw", pa.uint16()), ("fpw", pa.uint16()), ("bfd", pa.uint16()), ("lbh", pa.uint16()),
    ("q", pa.uint8()), ("why", pa.uint16()), ("prof_id", pa.int64()), ("prof_k", pa.uint16()),
    ("dn_huc8", pa.int32()), ("dn_row", pa.int32()), ("main", pa.bool_()), ("div", pa.int32()),
    ("x", pa.list_(pa.int32())), ("y", pa.list_(pa.int32())),
])
assert SCHEMA.names == COLUMNS


def huc8_str(h: int) -> str:
    return f"{int(h):08d}"


def stored_name(logical: str, data: bytes) -> tuple[str, str]:
    """``(stored path, sha256)``: the logical name with the first 12 hex of the bytes' sha256."""
    sha = hashlib.sha256(data).hexdigest()
    stem, dot, ext = logical.partition(".")
    return f"{stem}.{sha[:12]}.{ext}", sha


def parquet_bytes(t: pa.Table) -> bytes:
    buf = io.BytesIO()
    pq.write_table(t, buf, compression="zstd", compression_level=19, use_dictionary=["vpu", "name"],
                   write_statistics=False, data_page_version="1.0", row_group_size=max(1, t.num_rows))
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# which regions feed each HUC8 (from every lower-48 region, for the "built" or "partial" status)
# --------------------------------------------------------------------------- #
def feeding_regions(lines_m: inputs.Lines, regions: list[str], cache: Path) -> dict:
    key = {"built": lines_m.built, "regions": sorted(regions), "fclass": sorted(C.FCLASS)}
    path = cache / "huc8_regions.json"
    if path.exists():
        doc = json.loads(path.read_text(encoding="utf-8"))
        if doc.get("key") == key:
            return dict((h, set(v)) for h, v in doc["huc8"].items())
    out: dict = {}
    for vpu in sorted(regions):
        lp = lines_m.folder / lines_m.doc["vpus"][vpu]["lines"]["file"]
        ep = lines_m.extras_path(vpu)
        if not ep.exists():
            continue
        t = pq.read_table(lp, columns=["fcode", "reachcode"])
        h12 = pq.read_table(ep, columns=["huc12_50"]).column("huc12_50").fill_null(0).to_numpy()
        fc = t.column("fcode").to_numpy()
        rc = t.column("reachcode").cast(pa.int64()).fill_null(0).to_numpy()
        keep = network.fclass_of(fc) > 0
        for h in np.unique(network.huc8_of(h12, rc)[keep]).tolist():
            out.setdefault(huc8_str(h), set()).add(vpu)
    cache.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"key": key, "huc8": dict((h, sorted(v)) for h, v in sorted(out.items()))}),
                    encoding="utf-8")
    return out


def finish_huc8(parts_folder: str, site: str, name: str, done_dir: str = ""):
    """One HUC8's file from its regions' parts (in region order): written under its stored name.
    Returns ``(huc8, logical, [stored, bytes, sha256], meta)`` (run in a worker process). With
    ``done_dir``, a HUC8 whose parts are byte for byte those of an earlier build, and whose file is
    still there, is taken from that build's record instead of compressed again."""
    folder = Path(parts_folder)
    paths = sorted(folder.glob("*.parquet"))
    h = hashlib.sha256()
    for p in paths:
        h.update(p.name.encode("utf-8"))
        h.update(p.read_bytes())
    parts_key = h.hexdigest()
    record = Path(done_dir) / f"{name}.json" if done_dir else None
    if record is not None and record.exists():
        rec = json.loads(record.read_text(encoding="utf-8"))
        if rec.get("parts") == parts_key and (Path(site) / rec["entry"][0]).exists():
            return name, rec["logical"], rec["entry"], rec["meta"]
    parts = [pq.read_table(p) for p in paths]
    t = pa.concat_tables(parts).select(COLUMNS).cast(SCHEMA)
    data = parquet_bytes(t)
    logical = f"units/{name}.parquet"
    stored, sha = stored_name(logical, data)
    out = Path(site) / stored
    if not out.exists():
        out.write_bytes(data)
    xs = t.column("x").combine_chunks().values.to_numpy()
    ys = t.column("y").combine_chunks().values.to_numpy()
    nn = t.column("n").to_numpy()
    ln = t.column("len_m").to_numpy().astype(np.float64)
    meta = {"bbox": [round(float(xs.min()) / 1e5, 5), round(float(ys.min()) / 1e5, 5),
                     round(float(xs.max()) / 1e5, 5), round(float(ys.max()) / 1e5, 5)],
            "rows": t.num_rows, "units": int((nn > 0).sum()),
            "km": round(float(ln[nn > 0].sum()) / 1000.0, 3),
            "regions": sorted(set(t.column("vpu").to_pylist())), "bytes": len(data)}
    if record is not None:
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text(json.dumps({"parts": parts_key, "logical": logical, "entry": [stored, len(data), sha],
                                      "meta": meta}), encoding="utf-8")
    return name, logical, [stored, len(data), sha], meta


# --------------------------------------------------------------------------- #
# pass 2
# --------------------------------------------------------------------------- #
def build_site(paths: C.Paths, regions: list[str], release: inputs.Release, lines_m: inputs.Lines,
               log=print, workers: int = 6) -> dict:
    t0 = time.time()
    cache, site = paths.cache, paths.site
    regions = sorted(regions)
    if not regions:
        raise ValueError("no regions to publish")

    # ---- phase 1: where each row goes, and every pointer resolved
    small, ltab = {}, {}
    for vpu in regions:
        t = pq.read_table(cache / f"{vpu}.parquet",
                          columns=["huc8", "dn_local", "dn_hs", "src_hs", "main", "div_local"])
        small[vpu] = dict((c, t.column(c).to_numpy()) for c in t.column_names)
        lt = pq.read_table(cache / f"{vpu}.lines.parquet")
        ltab[vpu] = dict((c, lt.column(c).to_numpy()) for c in lt.column_names)
        hs = ltab[vpu]["hydroseq"]
        ltab[vpu]["hs_order"] = np.argsort(hs, kind="stable")
        ltab[vpu]["hs_sorted"] = hs[ltab[vpu]["hs_order"]]
    counts: dict = {}                                       # (huc8, vpu) -> rows
    for vpu in regions:
        h, c = np.unique(small[vpu]["huc8"], return_counts=True)
        for hh, cc in zip(h.tolist(), c.tolist()):
            counts[(hh, vpu)] = cc
    offset: dict = {}
    running: dict = {}
    for (hh, vpu) in sorted(counts, key=lambda k: (k[0], k[1])):
        offset[(hh, vpu)] = running.get(hh, 0)
        running[hh] = running.get(hh, 0) + counts[(hh, vpu)]
    file_row = {}
    for vpu in regions:
        h = small[vpu]["huc8"]
        order = np.argsort(h, kind="stable")
        sh = h[order]
        starts = np.flatnonzero(np.r_[True, sh[1:] != sh[:-1]])
        grp = np.repeat(starts, np.diff(np.r_[starts, len(sh)]))
        rank = np.empty(len(h), dtype=np.int64)
        rank[order] = np.arange(len(h)) - grp
        base = np.array([offset[(int(x), vpu)] for x in sh[starts].tolist()], dtype=np.int64)
        base_of = np.empty(len(h), dtype=np.int64)
        base_of[order] = np.repeat(base, np.diff(np.r_[starts, len(sh)]))
        file_row[vpu] = base_of + rank
    ranges = sorted((lines_m.hydroseq_range(v) + (v,)) for v in regions)

    def region_of(hs: int):
        for lo, hi, v in ranges:
            if lo <= hs <= hi:
                return v
        return None

    resolved, links = {}, {}
    cross_found = cross_missing = 0
    for vpu in regions:
        s = small[vpu]
        h = s["huc8"].astype(np.int64)
        n = len(h)
        dn_huc8 = np.zeros(n, dtype=np.int64)
        dn_row = np.full(n, -1, dtype=np.int64)
        main = s["main"].astype(bool).copy()
        loc = s["dn_local"] >= 0
        dn_huc8[loc] = h[s["dn_local"][loc]]
        dn_row[loc] = file_row[vpu][s["dn_local"][loc]]
        for r in np.flatnonzero(s["dn_hs"] != 0).tolist():
            hs = int(s["dn_hs"][r])
            tv = region_of(hs)
            target = -1
            if tv is not None:
                lt = ltab[tv]
                pos = np.searchsorted(lt["hs_sorted"], hs)
                if pos < len(lt["hs_order"]):
                    line = lt["hs_order"][pos]
                    if lt["hydroseq"][line] == hs:
                        target = int(lt["first_row"][line])
                        if target >= 0:
                            main[r] = main[r] and int(lt["up_out"][line]) == int(s["src_hs"][r])
            if target >= 0:
                dn_huc8[r] = int(small[tv]["huc8"][target])
                dn_row[r] = int(file_row[tv][target])
                cross_found += 1
            else:
                main[r] = False
                cross_missing += 1
        main &= dn_row >= 0
        div = np.full(n, -1, dtype=np.int64)
        dv = s["div_local"] >= 0
        same = np.zeros(n, dtype=bool)
        same[dv] = h[s["div_local"][dv]] == h[dv]
        div[same] = file_row[vpu][s["div_local"][same]]
        resolved[vpu] = {"dn_huc8": dn_huc8, "dn_row": dn_row, "main": main, "div": div}
        crossing = (dn_row >= 0) & (dn_huc8 != h)
        for a, b in set(zip(h[crossing].tolist(), dn_huc8[crossing].tolist())):
            links.setdefault(a, {"up": set(), "dn": set()})["dn"].add(b)
            links.setdefault(b, {"up": set(), "dn": set()})["up"].add(a)
    t1 = time.time()
    log(f"pass 2: pointers resolved ({cross_found} across regions, {cross_missing} to regions not built) "
        f"in {t1 - t0:.1f} s")

    # ---- phase 2: each region's rows split by HUC8 into parts, then each HUC8's file from its parts
    site.mkdir(parents=True, exist_ok=True)
    (site / "units").mkdir(exist_ok=True)
    parts_dir = cache / "parts"
    if parts_dir.exists():
        shutil.rmtree(parts_dir)
    parts_dir.mkdir(parents=True)
    files: dict = {}
    meta: dict = {}
    lookup: dict = {}

    for vpu in regions:
        t = pq.read_table(cache / f"{vpu}.parquet")
        r = resolved[vpu]
        t = t.drop_columns(["main"])
        t = t.append_column("dn_huc8", pa.array(r["dn_huc8"].astype(np.int32), type=pa.int32()))
        t = t.append_column("dn_row", pa.array(r["dn_row"].astype(np.int32), type=pa.int32()))
        t = t.append_column("main", pa.array(r["main"], type=pa.bool_()))
        t = t.append_column("div", pa.array(r["div"].astype(np.int32), type=pa.int32()))
        h = small[vpu]["huc8"]
        order = np.argsort(h, kind="stable")
        sh = h[order]
        starts = np.flatnonzero(np.r_[True, sh[1:] != sh[:-1]])
        ends = np.r_[starts[1:], len(sh)]
        for a, b in zip(starts.tolist(), ends.tolist()):
            hh = int(sh[a])
            part = t.take(pa.array(order[a:b])).select(COLUMNS).cast(SCHEMA)
            folder = parts_dir / huc8_str(hh)
            folder.mkdir(exist_ok=True)
            pq.write_table(part, folder / f"{vpu}.parquet", compression="zstd", compression_level=1)
        lt = ltab[vpu]
        fr, lr = lt["first_row"], lt["last_row"]
        has = fr >= 0
        lookup[vpu] = pa.table({
            "nhdplusid": pa.array(lt["nhdplusid"][has]),
            "first_huc8": pa.array(h[fr[has]].astype(np.int32)), "first_row": pa.array(file_row[vpu][fr[has]].astype(np.int32)),
            "last_huc8": pa.array(h[lr[has]].astype(np.int32)), "last_row": pa.array(file_row[vpu][lr[has]].astype(np.int32)),
            "nsec": pa.array(lt["nsec"][has]),
        })
    for vpu, lk in lookup.items():
        pq.write_table(lk, cache / f"{vpu}.lookup.parquet", compression="zstd", compression_level=3)
    names8 = sorted(p.name for p in parts_dir.iterdir())
    with ProcessPoolExecutor(max_workers=max(1, min(workers, len(names8)))) as ex:
        for name, logical, entry, m in ex.map(finish_huc8, [str(parts_dir / n) for n in names8],
                                              [str(site)] * len(names8), names8,
                                              [str(cache / "finished")] * len(names8), chunksize=4):
            files[logical] = entry
            meta[name] = m
    shutil.rmtree(parts_dir)
    t2 = time.time()
    log(f"pass 2: {len(meta)} HUC8 files written in {t2 - t1:.1f} s")

    # ---- the HUC8 entries
    lower48 = release.lower48
    feeding = feeding_regions(lines_m, lower48, cache)
    names = outlines.huc8_names(paths.wbd)
    huc8_doc = {}
    done = set(regions)
    for name in sorted(meta):
        m = meta[name]
        feed = feeding.get(name, set(m["regions"]))
        hh = int(name)
        lk = links.get(hh, {"up": set(), "dn": set()})
        huc8_doc[name] = {"name": names.get(name, ""), "bbox": m["bbox"], "rows": m["rows"], "units": m["units"],
                          "km": m["km"], "status": "built" if feed <= done else "partial",
                          "regions": m["regions"], "up": sorted(huc8_str(x) for x in lk["up"]),
                          "dn": sorted(huc8_str(x) for x in lk["dn"])}

    # ---- outlines
    gzip_sizes: dict = {}
    okey = {"wbd": str(paths.wbd.name), "huc8_tol": outlines.HUC8_TOLERANCE_M, "huc12_tol": outlines.HUC12_TOLERANCE_M,
            "grid": outlines.GRID_DEG, "layout": 1}
    ocache = cache / "outlines"
    (site / "outlines").mkdir(exist_ok=True)

    def put_outline(logical: str, raw: bytes) -> None:
        gz = outlines.gzipped(raw)
        stored, sha = stored_name(logical, gz)
        stored = stored + ".gz" if not stored.endswith(".gz") else stored
        out = site / stored
        if not out.exists():
            out.write_bytes(gz)
        files[logical] = [stored, len(gz), sha]
        gzip_sizes[logical] = len(raw)

    put_outline("outlines/huc8.json", outlines.cached_outline(ocache, "huc8", okey, lambda: outlines.huc8_outline(paths.wbd)))
    huc4s = sorted(set(n[:4] for n in huc8_doc))
    table12 = outlines.LazyHuc12(paths.wbd)
    for h4 in huc4s:
        # the base tolerance, doubled until the file is under the size target
        raw = b""
        for step, tol in enumerate(outlines.HUC12_TOLERANCES_M):
            key = dict(okey, huc12_tol=tol)
            name = f"huc12_{h4}" if step == 0 else f"huc12_{h4}_t{int(tol)}"
            raw = outlines.cached_outline(ocache, name, key,
                                          lambda h4=h4, tol=tol: outlines.huc12_outline_from(table12.get(h4), h4, tol))
            if len(outlines.gzipped(raw)) <= outlines.HUC12_TARGET_BYTES:
                break
        put_outline(f"outlines/huc12_{h4}.json", raw)
    t3 = time.time()
    log(f"pass 2: outlines ({1 + len(huc4s)} files) in {t3 - t2:.1f} s")

    # ---- the index, last
    files = dict(sorted(files.items()))
    packed = release.doc["packed"]
    version_src = {"files": sorted(v[2] for v in files.values()), "packed": packed, "da_break": C.DA_BREAK,
                   "unit_sections": C.UNIT_SECTIONS, "quality": C.QUALITY}
    data_version = "fpr1-" + hashlib.sha256(json.dumps(version_src, sort_keys=True, separators=(",", ":"))
                                            .encode("utf-8")).hexdigest()[:10]
    doc = {
        "format": C.INDEX_FORMAT,
        "built": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "data_version": data_version,
        "files": files,
        "gzip": dict(sorted(gzip_sizes.items())),
        "fpr": {
            "rule": dict(C.RULE),
            "grid": {"tag": release.doc.get("tag"), "packed": packed, "regions": len(release.packed),
                     "pending": release.pending},
            "lines": {"built": lines_m.built},
            "regions": regions,
            "huc8": huc8_doc,
            "huc4": huc4s,
        },
    }
    (site / "web-manifest.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    (site / "web-index.json.gz").write_bytes(outlines.gzipped(json.dumps(doc, separators=(",", ":"),
                                                                          ensure_ascii=False).encode("utf-8")))
    keep = set(v[0] for v in files.values())
    removed = 0
    for sub in ("units", "outlines"):
        for p in (site / sub).iterdir():
            if f"{sub}/{p.name}" not in keep:
                p.unlink()
                removed += 1
    log(f"pass 2: index written ({len(files)} files, {data_version}); {removed} stale files removed; "
        f"{time.time() - t0:.1f} s in all")
    return doc
