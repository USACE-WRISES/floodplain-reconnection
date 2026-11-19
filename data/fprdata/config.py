"""Rules, codes and paths of the reach layer.

Every path comes from a command-line flag, a local paths file or an environment variable, never
from this repository, so the public repository names no machine.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Optional

# --------------------------------------------------------------------------- #
# the rule (each constant goes into the data version)
# --------------------------------------------------------------------------- #
#: a chain of flowlines is cut into runs of about this many sections (about 1,000 ft)
UNIT_SECTIONS = 10
#: a chain continues into the next flowline only while it drains at least this share of it
DA_BREAK = 0.5
#: the name of the quality rule (the why bits and tiers below)
QUALITY = "fpr-q1"
RULE = {"unit_sections": UNIT_SECTIONS, "da_break": DA_BREAK, "quality": QUALITY}

#: the pass-1 cache layout; a change rebuilds every region (2: cut vertices placed in EPSG:5070)
CACHE_LAYOUT = 2
#: the web index format
INDEX_FORMAT = 1
#: the folder the layer is published in (inside the data host)
FOLDER = "floodplain-reconnection"
#: the grid's section spacing (100 ft)
SPACING_M = 30.48

# --------------------------------------------------------------------------- #
# lines kept, by NHD feature type (fcode // 100), and their class in the layer
# --------------------------------------------------------------------------- #
FCLASS = {460: 1, 336: 2, 558: 3, 334: 4}
FCLASS_STREAM, FCLASS_CANAL, FCLASS_ARTIFICIAL, FCLASS_CONNECTOR = 1, 2, 3, 4
#: the classes the grid samples (a chain never joins the two)
GRIDDED_CLASSES = (FCLASS_STREAM, FCLASS_CANAL)

# --------------------------------------------------------------------------- #
# the grid release's codes (release.json "codes")
# --------------------------------------------------------------------------- #
STATUS_OK, STATUS_UNBALANCED, STATUS_NO_DEM, STATUS_TOO_FEW, STATUS_OK_REFERENCE = 0, 1, 2, 3, 4
SCORED = (STATUS_OK, STATUS_OK_REFERENCE)
UNMEASURED = (STATUS_UNBALANCED, STATUS_TOO_FEW)
FLAG_CAPPED, FLAG_EDGE, FLAG_AREA_EDGE, FLAG_EXTRAPOLATED = 1, 2, 4, 8
BANK_CREST_SCAN = 1
#: the bank height ratio cap (x100): the default low bank never sits above the flood-prone stage
BHR_CAP_X100 = 200
#: the bankfull depth at or below which a capped section's 2.00 is the bank detector's floor
#: (K2b ``cap_unreachable_depth``: half the climb floor, 0.10 m on 1 m lidar, 0.30 m otherwise)
FLOOR_DEPTH_FINE_M = 0.05
FLOOR_DEPTH_COARSE_M = 0.15
FINE_DEM_MAX_M = 1.5

# --------------------------------------------------------------------------- #
# quality: the why bits and the tiers
# --------------------------------------------------------------------------- #
WHY_FEW = 1            # fewer than 3 scored sections
WHY_BHR_RANGE = 2      # median bank height ratio at or below 0
WHY_ER_RANGE = 4       # median entrenchment ratio below 1
WHY_CAP_FLOOR = 8      # median at the cap only through sections at the detector's floor
WHY_EXTRAPOLATED = 16  # bankfull extrapolated on most scored sections
WHY_CREST_SCAN = 32    # every scored section found its bank by the crest scan
WHY_THIN = 64          # only 3 or 4 scored sections
WHY_EDGE = 128         # the median entrenchment ratio's section is edge-limited
WHY_COARSE = 256       # the coarsest scored elevation model is 3 m or 10 m
WHY_AT_CAP = 512       # median bank height ratio reads "at least 2.00" (information only)
WHY_NO_DEM = 1024      # no section has elevation data
Q2_BITS = WHY_FEW | WHY_BHR_RANGE | WHY_ER_RANGE | WHY_CAP_FLOOR | WHY_NO_DEM
Q1_BITS = WHY_EXTRAPOLATED | WHY_CREST_SCAN | WHY_THIN | WHY_EDGE | WHY_COARSE
Q_NONE, Q_CAUTION, Q_NOT_ENOUGH, Q_NOT_SAMPLED = 0, 1, 2, 3

# --------------------------------------------------------------------------- #
# screening (the web app implements the same rules)
# --------------------------------------------------------------------------- #
SQKM_PER_SQMI = 2.589988110336
M_PER_FT = 0.3048
DEFAULT_CRITERIA = {"includeCaution": True, "skipCanals": True, "daMinSqmi": 2, "daMaxSqmi": None,
                    "bhrMin": 1.5, "countCapped": True, "erMin": 2.2, "minSiteFt": 1000, "gapReaches": 1}
PRESETS = {
    "A": {"label": "BHR 1.5 or more, ER 2.2 or more", "bhrMin": 1.5, "erMin": 2.2},
    "B": {"label": "BHR 1.5 or more", "bhrMin": 1.5, "erMin": None},
    "C": {"label": "BHR 1.3 or more, ER 2.2 or more", "bhrMin": 1.3, "erMin": 2.2},
}


def preset_criteria(key: str) -> dict:
    """The full criteria of a preset (the defaults with the preset's values)."""
    out = dict(DEFAULT_CRITERIA)
    out.update((k, v) for k, v in PRESETS[key].items() if k != "label")
    return out


# --------------------------------------------------------------------------- #
# paths
# --------------------------------------------------------------------------- #
ENV = {"release": "FPR_RELEASE", "lines": "FPR_LINES", "values": "FPR_VALUES", "wbd": "FPR_WBD",
       "out": "FPR_OUT", "staf": "FPR_STAF"}
#: a local file naming the paths (never committed; data/.gitignore)
LOCAL_PATHS = Path(__file__).resolve().parent.parent / "paths.local.json"


@dataclass
class Paths:
    release: Optional[Path] = None   # the grid release folder (release.json, xs-<vpu>*.parquet)
    lines: Optional[Path] = None     # the slim NHDPlus HR lines (lines2_<vpu>.parquet, manifest.json)
    values: Optional[Path] = None    # the per-line values (extras2_<vpu>.parquet)
    wbd: Optional[Path] = None       # the WBD national geodatabase folder
    out: Optional[Path] = None       # where cache/, site/, fixtures/ and report/ go
    staf: Optional[Path] = None      # a STAF checkout, for the parity tests

    @classmethod
    def load(cls, flags: Optional[dict] = None, paths_file: Optional[Path] = None) -> "Paths":
        """Flags first, then the paths file (``paths_file`` or the local one), then the environment."""
        found: dict = {}
        source = Path(paths_file) if paths_file else LOCAL_PATHS
        if source.exists():
            found.update((k, v) for k, v in json.loads(source.read_text(encoding="utf-8")).items() if v)
        for name, env in ENV.items():
            if name not in found and os.environ.get(env):
                found[name] = os.environ[env]
        for k, v in (flags or {}).items():
            if v:
                found[k] = v
        return cls(**dict((f.name, Path(found[f.name]) if found.get(f.name) else None) for f in fields(cls)))

    def need(self, *names: str) -> None:
        missing = [n for n in names if getattr(self, n) is None]
        if missing:
            raise SystemExit("missing paths: " + ", ".join(f"--{n} (or {ENV[n]})" for n in missing))

    @property
    def cache(self) -> Path:
        return self.out / "cache"

    @property
    def site(self) -> Path:
        return self.out / "site" / FOLDER
