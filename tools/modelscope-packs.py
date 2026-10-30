#!/usr/bin/env python3
"""Publish content-addressed ZIPs to ModelScope; credentials never enter artifacts.

Dry run by default. --apply uploads only the ZIPs named by the current index,
then the index. Existing remote files (including legacy full ZIPs) are retained.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

DEFAULT_DATASET = "Misyra/Arknight_Assets"
ENDPOINT = "https://modelscope.cn"


def fingerprint(file):
    sha1 = hashlib.sha1()
    size = 0
    with file.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha1.update(chunk)
            size += len(chunk)
    return size, sha1.hexdigest()


def publication_files(root):
    index_path = root / "data/resource-packs.json"
    index = json.loads(index_path.read_text("utf-8"))
    if (index.get("format") != "stronghold-resource-pack-index"
            or index.get("version") != 1 or index.get("maxBytes") != 16_000_000
            or not isinstance(index.get("packs"), list) or not index["packs"]):
        raise ValueError("Invalid/empty resource-packs.json; run npm run resources:packs first")
    files = []
    names = set()
    for pack in index["packs"]:
        url = pack.get("url", "")
        if not re.fullmatch(r"/resource-packs/[A-Za-z0-9._-]+\.zip", url):
            raise ValueError("Pack index must contain local /resource-packs/*.zip URLs")
        name = url.rsplit("/", 1)[-1]
        if name in names:
            raise ValueError("Duplicate ZIP in pack index")
        names.add(name)
        file = root / "public" / url.lstrip("/")
        size, digest = fingerprint(file)
        if size != pack.get("size") or digest != pack.get("sha1") or size > 16_000_000:
            raise ValueError(f"Pack size/digest mismatch: {name}")
        files.append((file, name))
    return files, index_path


def credential():
    token = (os.environ.get("MODELSCOPE_API_KEY") or os.environ.get("MODELSCOPE_TOKEN")
             or os.environ.get("MODELSCOPE_API_TOKEN"))
    return token or getpass.getpass("ModelScope token (hidden, not saved): ")


def verify_token(token):
    request = Request(ENDPOINT + "/openapi/v1/users/me", headers={"Authorization": f"Bearer {token}"})
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result.get("success") is not True:
        raise ValueError("ModelScope rejected the token")
    print("ModelScope authentication verified; credentials were not saved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--revision", default="master")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--check-auth", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", args.dataset):
        raise ValueError("Invalid dataset; expected owner/name")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", args.revision):
        raise ValueError("Invalid revision")
    token = credential() if args.apply or args.check_auth else None
    if token:
        verify_token(token)
    if args.check_auth and not args.apply:
        return
    files, index = publication_files(args.root.resolve())
    print(f"{'UPLOAD' if args.apply else 'DRY RUN'}: {len(files)} ZIPs -> {args.dataset}")
    route = f"{ENDPOINT}/datasets/{args.dataset}/resolve/{args.revision}/{{file}}"
    print("SP_RESOURCE_PACK_ROUTES=" + json.dumps([route]))
    if not args.apply:
        print("No uploads. --apply uploads ZIP payloads first, then resource-packs.json. No remote files are deleted.")
        return
    # Keep the SDK's anonymous session/cache inside the publishing workspace.
    # Authentication remains constructor-only and is never written here.
    os.environ.setdefault("MODELSCOPE_HOME", str(args.root.resolve() / ".local/modelscope-home"))
    os.environ.setdefault("MODELSCOPE_CACHE", str(args.root.resolve() / ".cache/modelscope"))
    try:
        from modelscope_hub import HubApi
    except ImportError:
        # Allow an isolated SDK install without changing the user's Python.
        sdk = args.root.resolve() / ".local/modelscope-sdk"
        sys.path.insert(0, str(sdk))
        try:
            from modelscope_hub import HubApi
        except ImportError:
            raise RuntimeError("Install publishing dependency: python -m pip install modelscope-hub==0.4.6") from None
    api = HubApi(token=token, endpoint=ENDPOINT)
    # No login(): constructor authentication avoids persisting credentials.
    # The folder API batches commits and retries/resumes payloads; one commit
    # per small skin ZIP needlessly hits the Hub's repository commit limits.
    tracker = args.root.resolve() / ".cache/modelscope-publish" / (
        args.dataset.replace("/", "--") + "-" + args.revision + "-" + fingerprint(index)[1] + ".json")
    tracker.parent.mkdir(parents=True, exist_ok=True)
    def progress(event):
        if event.get("event") in ("batch_committed", "recovery_committed"):
            count = event.get("committed_files", 0) + event.get("skipped_files", 0)
            print(f"Committed ZIP payloads: {count}/{len(files)}", flush=True)
    api.upload_folder(repo_id=args.dataset, repo_type="dataset",
                      folder_path=str(args.root.resolve() / "public/resource-packs"),
                      allow_patterns=[name for _, name in files], revision=args.revision,
                      commit_message="Publish verified resource pack payloads",
                      max_workers=4, use_cache=True, tracker_path=str(tracker),
                      sync_remote_repo=False, disable_tqdm=True, progress_callback=progress)
    api.upload_file(repo_id=args.dataset, repo_type="dataset", path_or_fileobj=str(index),
                    path_in_repo="resource-packs.json", revision=args.revision,
                    commit_message="Publish completed resource pack index", disable_tqdm=True)
    print("Published. Deploy data/resource-packs.json with the matching asset fingerprints. Legacy ZIPs remain available.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SDK/HTTP exception text can contain signed URLs or authentication data.
        print(f"Publication stopped ({type(error).__name__}). Check credentials, SDK and pack files; index was not published early.", file=sys.stderr)
        sys.exit(1)
