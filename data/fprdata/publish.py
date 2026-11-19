"""Publish the reach layer to its folder of the Hugging Face dataset (`floodplain-reconnection/`).

Every stored file is checked against `web-manifest.json` first (size and sha256), then uploaded
(resumable, only what the dataset lacks), and `web-index.json.gz` and `web-manifest.json` go last, so a
page never reads an index that names a file not there yet. Only this folder is touched: the dataset's
other files are STAF's. It needs a Python with `huggingface_hub` and a login with write access
(`hf auth login`); the token is read by the library, never by this code.

    python data/fprdata/publish.py --site <the folder that holds floodplain-reconnection/>          # a dry run
    python data/fprdata/publish.py --site <...> --yes                                               # upload
    python data/fprdata/publish.py --site <...> --verify                                            # compare the hub
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

FOLDER = 'floodplain-reconnection'
INDEX = 'web-index.json.gz'
MANIFEST = 'web-manifest.json'
REPO = 'gtmenichino/staf-data'


def entries(site: Path) -> dict[str, tuple[str, int, str]]:
    """The manifest's files: logical name -> (stored path in the folder, bytes, sha256)."""
    manifest = json.loads((site / FOLDER / MANIFEST).read_text(encoding='utf-8'))
    out = {}
    for logical, e in manifest['files'].items():
        if isinstance(e, dict):
            out[logical] = (e['path'], int(e['bytes']), e['sha256'])
        else:
            out[logical] = (e[0], int(e[1]), e[2])
    return out


def check(site: Path, log=print) -> tuple[int, int]:
    """Every stored file is there, with its size and sha256; returns (files, bytes)."""
    root = site / FOLDER
    bad = []
    total = 0
    files = entries(site)
    for logical, (path, size, sha) in sorted(files.items()):
        p = root / path
        if not p.is_file():
            bad.append(f'{logical}: missing')
            continue
        data = p.read_bytes()
        total += len(data)
        if len(data) != size or hashlib.sha256(data).hexdigest() != sha:
            bad.append(f'{logical}: differs from the manifest')
    for name in (INDEX, MANIFEST):
        if not (root / name).is_file():
            bad.append(f'{name}: missing')
    if bad:
        raise SystemExit('not published, the folder does not match its manifest:\n  ' + '\n  '.join(bad[:20]))
    log(f'{len(files)} files, {total / 1e9:.3f} GB, all match the manifest')
    return len(files), total


def publish(site: Path, repo_id: str = REPO, workers: int | None = None, log=print) -> None:
    from huggingface_hub import HfApi
    check(site, log)
    root = site / FOLDER
    api = HfApi()
    log(f'logged in to Hugging Face as {api.whoami()["name"]}; uploading to datasets/{repo_id}/{FOLDER}')
    # exactly the files the manifest names (a file a rebuild left behind never goes up)
    named = [f'{FOLDER}/{path}' for path, _, _ in entries(site).values()]
    api.upload_large_folder(repo_id=repo_id, repo_type='dataset', folder_path=str(site),
                            allow_patterns=named, num_workers=workers)
    built = json.loads((root / MANIFEST).read_text(encoding='utf-8')).get('data_version', '')
    for name in (INDEX, MANIFEST):
        api.upload_file(path_or_fileobj=str(root / name), path_in_repo=f'{FOLDER}/{name}', repo_id=repo_id,
                        repo_type='dataset', commit_message=f'{FOLDER}/{name} ({built}), written last')
    log(f'uploaded; the app reads https://huggingface.co/datasets/{repo_id}/resolve/main/{FOLDER}/{INDEX}')


def verify(site: Path, repo_id: str = REPO, log=print) -> int:
    """The hub holds every stored file of the manifest, at its size; returns how many differ."""
    from huggingface_hub import HfApi
    api = HfApi()
    files = entries(site)
    paths = [f'{FOLDER}/{p}' for p, _, _ in files.values()] + [f'{FOLDER}/{INDEX}', f'{FOLDER}/{MANIFEST}']
    have = {}
    for i in range(0, len(paths), 500):
        for info in api.get_paths_info(repo_id, paths[i:i + 500], repo_type='dataset'):
            have[info.path] = getattr(info, 'size', None)
    bad = 0
    for logical, (path, size, _) in files.items():
        got = have.get(f'{FOLDER}/{path}')
        if got != size:
            bad += 1
            log(f'  {logical}: hub has {got}, manifest {size}')
    log(f'{len(files) - bad} of {len(files)} stored files on the hub at their size')
    return bad


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--site', required=True, type=Path, help='the folder that holds floodplain-reconnection/')
    ap.add_argument('--repo', default=REPO)
    ap.add_argument('--yes', action='store_true', help='upload (without it: check only)')
    ap.add_argument('--verify', action='store_true', help='compare the hub with the manifest')
    ap.add_argument('--workers', type=int, default=None)
    a = ap.parse_args()
    if a.verify:
        raise SystemExit(1 if verify(a.site, a.repo) else 0)
    if a.yes:
        publish(a.site, a.repo, a.workers)
    else:
        check(a.site)
        print('a dry run: nothing uploaded (add --yes to upload)')
