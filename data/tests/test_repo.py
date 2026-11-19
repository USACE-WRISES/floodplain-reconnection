"""The builder's files name no machine, no AI tool, and use no em or en dashes."""
import codecs
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _rot(s: str) -> str:
    return codecs.decode(s, "rot13")


#: words and paths the public repository never names (encoded, so this file does not name them)
_WORDS = [_rot(w) for w in ("pynhqr", "nageuebcvp", "pbqrk", "bcranv", "pbcvybg", "pungtcg", "trzvav")]
_PATHS = re.compile(r"[A-Za-z]:[\\/](" + _rot("Pbqr|Qngn|Hfref") + r")|/" + _rot("Hfref") + r"/|[\\/]" + _rot("tgzra") + r"[\\/]")
_DASHES = (chr(0x2014), chr(0x2013))


def _files():
    for p in sorted(ROOT.rglob("*")):
        if p.is_file() and "__pycache__" not in p.parts and ".pytest_cache" not in p.parts \
                and p.name != "paths.local.json" and p.suffix in (".py", ".md", ".txt", ".ini", ".json", ""):
            yield p


def test_no_machine_paths_or_tool_names():
    for p in _files():
        text = p.read_text(encoding="utf-8")
        assert not _PATHS.search(text), p
        low = text.lower()
        for w in _WORDS:
            assert w not in low, (p, w)
        assert re.search(r"\bgpt-\d", low) is None, p


def test_no_long_dashes():
    for p in _files():
        text = p.read_text(encoding="utf-8")
        assert not any(d in text for d in _DASHES), p
