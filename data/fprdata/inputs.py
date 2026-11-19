"""The inputs: the grid release (checked against the release.json read at the start), the slim
NHDPlus HR lines (checked against their manifest) and the per-line values."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Optional

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

LINE_COLUMNS = ["nhdplusid", "gnis_name", "reachcode", "totdasqkm", "slope", "fcode", "streamorde",
                "hydroseq", "dn_step", "up_step", "dn_out", "up_out", "x", "y", "parts"]
NUMBER_COLUMNS = ["nhdplusid", "part", "k", "n_sec", "res", "status", "bank", "flags",
                  "er", "bhr", "bfd", "bfw", "fpw"]


def sha256_file(path: Path, chunk: int = 1 << 22) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


class InputChanged(RuntimeError):
    """An input file differs from the manifest read at the start of the build."""


class Release:
    """The grid release as ``release.json`` said at the start of the build."""

    def __init__(self, folder: Path, doc: Optional[dict] = None):
        self.folder = Path(folder)
        if doc is None:
            doc = json.loads((self.folder / "release.json").read_text(encoding="utf-8"))
        if doc.get("format") != 3:
            raise ValueError(f"release format {doc.get('format')}: this builder reads format 3")
        self.doc = doc

    @property
    def packed(self) -> list[str]:
        return sorted(self.doc["regions"])

    @property
    def pending(self) -> list[str]:
        return sorted(self.doc.get("pending") or [])

    @property
    def lower48(self) -> list[str]:
        return sorted(set(self.packed) | set(self.pending))

    def asset_names(self, vpu: str) -> dict:
        return {"numbers": f"xs-{vpu}.parquet", "sections": f"xs-{vpu}-sections.parquet",
                "median": f"xs-{vpu}-median.parquet"}

    def asset(self, name: str, verify: bool = True) -> Path:
        """The path of a release file, its size and sha256 checked against the snapshot."""
        entry = self.doc["assets"].get(name)
        if entry is None:
            raise KeyError(f"{name} is not in the release snapshot")
        path = self.folder / name
        if verify:
            if path.stat().st_size != entry["bytes"] or sha256_file(path) != entry["sha256"]:
                raise InputChanged(f"{name} differs from the release.json read at the start")
        return path

    def asset_sha256(self, name: str) -> str:
        return self.doc["assets"][name]["sha256"]


class Lines:
    """The slim NHDPlus HR lines and their manifest."""

    def __init__(self, folder: Path, values: Path, doc: Optional[dict] = None):
        self.folder = Path(folder)
        self.values = Path(values)
        if doc is None:
            doc = json.loads((self.folder / "manifest.json").read_text(encoding="utf-8"))
        self.doc = doc

    @property
    def built(self) -> str:
        return self.doc["built"]

    def lines_path(self, vpu: str, verify: bool = True) -> Path:
        entry = self.doc["vpus"][vpu]["lines"]
        path = self.folder / entry["file"]
        if verify and (path.stat().st_size != entry["bytes"] or sha256_file(path) != entry["sha256"]):
            raise InputChanged(f"{entry['file']} differs from the lines manifest")
        return path

    def lines_sha256(self, vpu: str) -> str:
        return self.doc["vpus"][vpu]["lines"]["sha256"]

    def extras_path(self, vpu: str) -> Path:
        return self.values / f"extras2_{vpu}.parquet"

    def hydroseq_range(self, vpu: str) -> tuple[int, int]:
        lo, hi = self.doc["vpus"][vpu]["hydroseq_range"]
        return int(lo), int(hi)


def check_same_bundle(release: Release, lines: Lines) -> None:
    built = release.doc["grid"].get("bundle_built")
    if built != lines.built:
        raise ValueError(f"the grid was placed on lines built {built}, but the lines here were built {lines.built}")


def _int(col: pa.ChunkedArray, fill: int = 0, dtype=np.int64) -> np.ndarray:
    return col.cast(pa.int64()).fill_null(fill).to_numpy().astype(dtype)


def read_lines(path: Path) -> dict:
    """The lines of a region as numpy arrays; geometry as flat int vertex arrays with offsets."""
    t = pq.read_table(path, columns=LINE_COLUMNS)
    parts = t.column("parts").combine_chunks()
    n_parts = np.diff(parts.offsets.to_numpy())
    if len(n_parts) and not (n_parts == 1).all():
        raise ValueError(f"{path.name}: a line with {int(n_parts.max())} parts (one part per line expected)")
    xs = t.column("x").combine_chunks()
    ys = t.column("y").combine_chunks()
    off = xs.offsets.to_numpy().astype(np.int64)
    if not (ys.offsets.to_numpy() == xs.offsets.to_numpy()).all():
        raise ValueError(f"{path.name}: x and y vertex counts differ")
    names = t.column("gnis_name").to_pylist()
    return {
        "nhdplusid": _int(t.column("nhdplusid")),
        "gnis_name": [n or "" for n in names],
        "reachcode": _int(t.column("reachcode")),
        "totdasqkm": t.column("totdasqkm").fill_null(np.nan).to_numpy().astype(np.float64),
        "slope": t.column("slope").fill_null(np.nan).to_numpy().astype(np.float64),
        "fcode": _int(t.column("fcode"), dtype=np.int32),
        "streamorde": _int(t.column("streamorde"), fill=0, dtype=np.int64),
        "hydroseq": _int(t.column("hydroseq")),
        "dn_step": _int(t.column("dn_step")),
        "up_step": _int(t.column("up_step")),
        "dn_out": _int(t.column("dn_out")),
        "up_out": _int(t.column("up_out")),
        "voff": off,
        "vx": xs.values.to_numpy().astype(np.int64),
        "vy": ys.values.to_numpy().astype(np.int64),
    }


def read_huc12(path: Path, ids: np.ndarray) -> np.ndarray:
    t = pq.read_table(path, columns=["nhdplusid", "huc12_50"])
    if t.num_rows != len(ids) or not (t.column("nhdplusid").to_numpy() == ids).all():
        raise ValueError(f"{path.name} is not in the lines' row order")
    return _int(t.column("huc12_50"))


def read_numbers(path: Path) -> dict:
    t = pq.read_table(path, columns=NUMBER_COLUMNS)
    out = {}
    for name in ("nhdplusid", "part", "k", "n_sec", "res", "status", "bank", "flags"):
        out[name] = _int(t.column(name))
    for name in ("er", "bhr", "bfd", "bfw", "fpw"):
        out[name] = _int(t.column(name), fill=-1)
    return out


def read_low_bank(path: Path, ids: np.ndarray, k: np.ndarray) -> np.ndarray:
    """The low-bank height above the thalweg (m) of every section, in the numbers' row order."""
    t = pq.read_table(path, columns=["nhdplusid", "k", "lb_m"])
    if t.num_rows != len(ids) or not (t.column("nhdplusid").to_numpy() == ids).all() \
            or not (t.column("k").to_numpy() == k).all():
        raise ValueError(f"{path.name} is not in the numbers' row order")
    return t.column("lb_m").fill_null(np.nan).to_numpy().astype(np.float64)


def read_section_xy(path: Path, ids: np.ndarray, k: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Each section's stored point (EPSG:5070), in the numbers' row order (for the checks)."""
    t = pq.read_table(path, columns=["nhdplusid", "k", "x", "y"])
    if t.num_rows != len(ids) or not (t.column("nhdplusid").to_numpy() == ids).all() \
            or not (t.column("k").to_numpy() == k).all():
        raise ValueError(f"{path.name} is not in the numbers' row order")
    return t.column("x").to_numpy().astype(np.float64), t.column("y").to_numpy().astype(np.float64)


def read_median_keys(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """The (nhdplusid, k) of each line's stored profile."""
    t = pq.read_table(path, columns=["nhdplusid", "part", "k"])
    return _int(t.column("nhdplusid")), _int(t.column("k"))


def valid_mask(col: pa.ChunkedArray) -> np.ndarray:
    return pc.is_valid(col).to_numpy(zero_copy_only=False)
