import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fprdata import config as C  # noqa: E402


@pytest.fixture(scope="session")
def paths() -> C.Paths:
    return C.Paths.load()


@pytest.fixture(scope="session")
def site(paths) -> Path:
    if paths.out is None or not (paths.site / "web-manifest.json").exists():
        pytest.skip("no built site (set FPR_OUT or write data/paths.local.json)")
    return paths.site


@pytest.fixture(scope="session")
def index(site) -> dict:
    return json.loads((site / "web-manifest.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def release_doc(paths) -> dict:
    snap = paths.out / "cache" / "release_snapshot.json" if paths.out else None
    if snap is None or not snap.exists():
        pytest.skip("no release snapshot from a build")
    return json.loads(snap.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def geomorph(paths):
    """STAF's own geometry rules (the parity reference), from a STAF checkout."""
    if paths.staf is None or not (paths.staf / "libs" / "site_engine").exists():
        pytest.skip("no STAF checkout (set FPR_STAF or data/paths.local.json)")
    sys.path.insert(0, str(paths.staf / "libs" / "site_engine"))
    from site_engine._extracted import geomorph as g
    return g
