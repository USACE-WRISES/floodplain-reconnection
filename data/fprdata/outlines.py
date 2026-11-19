"""Watershed outlines from the WBD: the lower 48's HUC8s in one file (from the national geodatabase)
and the HUC12s of each HUC4 in their own (from the WBD's HUC12 polygons in EPSG:5070, the table the
lines' HUC12 codes were taken from). Each set is simplified as one coverage with
``shapely.coverage_simplify`` in EPSG:5070 (shared edges stay shared), then snapped to 1e-5 degree
and written as GeoJSON."""
from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np

#: simplification tolerances (m, EPSG:5070): a HUC4's HUC12 file takes the first that keeps it under
#: the size target
HUC8_TOLERANCE_M = 1000.0
HUC12_TOLERANCE_M = 50.0
HUC12_TOLERANCES_M = (50.0, 100.0, 200.0, 400.0)
HUC12_TARGET_BYTES = 1_000_000
GRID_DEG = 1e-5
LOWER48_MAX_HUC2 = "18"
GDB = "WBD_National_GDB.gdb"
HUC12_TABLE = "huc12_5070.parquet"


def huc8_names(wbd: Path) -> dict:
    import pyogrio
    df = pyogrio.read_dataframe(Path(wbd) / GDB, layer="WBDHU8", columns=["huc8", "name"], read_geometry=False)
    return dict(zip(df["huc8"].astype(str), df["name"].fillna("").astype(str)))


def _simplify(codes: list, names: list, geoms_5070, tolerance: float) -> list:
    """``[(code, name, geometry in lon, lat)]`` sorted by code, simplified as one coverage."""
    import shapely
    from pyproj import Transformer
    order = sorted(range(len(codes)), key=lambda i: codes[i])
    geoms = np.asarray([geoms_5070[i] for i in order], dtype=object)
    geoms = np.asarray(shapely.make_valid(geoms), dtype=object)
    simple = shapely.coverage_simplify(geoms, tolerance)
    back = Transformer.from_crs(5070, 4269, always_xy=True)
    lonlat = shapely.transform(simple, lambda xy: np.column_stack(back.transform(xy[:, 0], xy[:, 1])))
    snapped = shapely.set_precision(lonlat, GRID_DEG)
    out = []
    for i, geom in zip(order, snapped):
        if geom is None or shapely.is_empty(geom):
            continue
        out.append((codes[i], names[i], geom))
    return out


def _round(coords):
    if isinstance(coords, (list, tuple)) and coords and isinstance(coords[0], (int, float)):
        return [round(float(coords[0]), 5), round(float(coords[1]), 5)]
    return [_round(c) for c in coords]


def feature_collection(items: list, code: str) -> bytes:
    """GeoJSON bytes (compact, keys in a fixed order) of ``[(code, name, geometry)]``."""
    import shapely
    feats = []
    for c, name, geom in items:
        gj = json.loads(shapely.to_geojson(geom))
        feats.append({"type": "Feature", "properties": {code: c, "name": name},
                      "geometry": {"type": gj["type"], "coordinates": _round(gj["coordinates"])}})
    doc = {"type": "FeatureCollection", "features": feats}
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def gzipped(raw: bytes) -> bytes:
    """Gzip with no file name and a zero time stamp, so the same bytes give the same file."""
    return gzip.compress(raw, compresslevel=9, mtime=0)


def huc8_outline(wbd: Path, tolerance: float = HUC8_TOLERANCE_M) -> bytes:
    import pyogrio
    gdf = pyogrio.read_dataframe(Path(wbd) / GDB, layer="WBDHU8", columns=["huc8", "name"])
    gdf = gdf[gdf["huc8"].astype(str).str[:2] <= LOWER48_MAX_HUC2]
    gdf = gdf[gdf.geometry.notna()]
    g = gdf.to_crs(5070).geometry.values
    items = _simplify(list(gdf["huc8"].astype(str)), list(gdf["name"].fillna("").astype(str)), list(g), tolerance)
    return feature_collection(items, "huc8")


def huc12_table(wbd: Path, huc4s: list):
    """The HUC12 polygons (EPSG:5070) of the given HUC4s: ``{huc4: (codes, names, geoms)}``."""
    import pyarrow.parquet as pq
    import shapely
    import pyarrow as pa
    t = pq.read_table(Path(wbd) / HUC12_TABLE, columns=["huc12", "name", "wkb"])
    codes = t.column("huc12").to_pylist()
    names = t.column("name").to_pylist()
    want = set(huc4s)
    keep = [i for i, c in enumerate(codes) if c and c[:4] in want]
    wkb = t.column("wkb").cast(pa.large_binary()).take(pa.array(keep, type=pa.int64()))
    geoms = shapely.from_wkb(wkb.to_numpy(zero_copy_only=False))
    out: dict = {}
    for c, n, g in zip([codes[i] for i in keep], [names[i] for i in keep], geoms):
        entry = out.setdefault(c[:4], ([], [], []))
        entry[0].append(c)
        entry[1].append(n or "")
        entry[2].append(g)
    return out


def huc12_outline_from(table: dict, huc4: str, tolerance: float = HUC12_TOLERANCE_M) -> bytes:
    codes, names, geoms = table.get(huc4, ([], [], []))
    return feature_collection(_simplify(codes, names, geoms, tolerance) if codes else [], "huc12")


class LazyHuc12:
    """The HUC12 polygons, read once and only when a HUC4's outline has to be made."""

    def __init__(self, wbd: Path):
        self.wbd = Path(wbd)
        self._t = None

    def get(self, huc4: str) -> dict:
        import pyarrow as pa
        import pyarrow.parquet as pq
        import shapely
        if self._t is None:
            t = pq.read_table(self.wbd / HUC12_TABLE, columns=["huc12", "name", "wkb"])
            self._t = (t.column("huc12").to_pylist(), t.column("name").to_pylist(),
                       t.column("wkb").cast(pa.large_binary()))
        codes, names, wkb = self._t
        keep = [i for i, c in enumerate(codes) if c and c[:4] == huc4]
        geoms = shapely.from_wkb(wkb.take(pa.array(keep, type=pa.int64())).to_numpy(zero_copy_only=False))
        return {huc4: ([codes[i] for i in keep], [names[i] or "" for i in keep], list(geoms))}


def is_cached(cache: Path, name: str, key: dict) -> bool:
    data, meta = cache / f"{name}.json.gz", cache / f"{name}.key.json"
    return data.exists() and meta.exists() and json.loads(meta.read_text(encoding="utf-8")) == key


def cached_outline(cache: Path, name: str, key: dict, make) -> bytes:
    """An outline's raw GeoJSON from the cache when made with the same key, else made and kept."""
    cache.mkdir(parents=True, exist_ok=True)
    data, meta = cache / f"{name}.json.gz", cache / f"{name}.key.json"
    if data.exists() and meta.exists() and json.loads(meta.read_text(encoding="utf-8")) == key:
        return gzip.decompress(data.read_bytes())
    raw = make()
    data.write_bytes(gzipped(raw))
    meta.write_text(json.dumps(key, sort_keys=True), encoding="utf-8")
    return raw
