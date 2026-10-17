#!/usr/bin/env python3
# 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）：部署端把预载清单切成 ≤16 MB 的分类 ZIP 分包。
"""Build optional category resource ZIP packs capped at 16,000,000 bytes.

The output is deployment data, not source art. It consumes data/resource-manifest.json
or the equivalent resource-manifest JSON and writes v2 browser-importable ZIPs plus
resource-packs.json. ZIP entries are stored because the payloads are already compressed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote
import zipfile

MAX_PACK_BYTES = 16_000_000
MANIFEST = "stronghold-resources.json"
PACK_FORMAT = "stronghold-resource-pack-index"
RESOURCE_FORMAT = "stronghold-resource-zip"
EXTENSIONS = set("png jpg jpeg webp gif svg mp3 ogg wav m4a mp4 woff woff2 ttf otf css atlas obj skel bin".split())


def digest(data):
    return hashlib.sha1(data).hexdigest()


def write_stored(archive, name, data):
    """Stable ZIP metadata: packaging time, host OS and umask are not content."""
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    info.compress_type = zipfile.ZIP_STORED
    archive.writestr(info, data)


def canonical(url):
    if not isinstance(url, str) or not re.match(r"^/((assets|fonts)/)", url):
        raise ValueError(f"invalid resource URL: {url}")
    if any(part in (".", "..", "") for part in url.split("/")[1:-1]):
        raise ValueError(f"unsafe resource URL: {url}")
    suffix = url.rsplit(".", 1)[-1].lower()
    board_json = re.match(r"^/assets/local/(?:map/(?:fx/(?:materials|prefab)|autochess/(?:materials|tiles))|fx/(?:index|textures|(?:prefabs|mesh)/[A-Za-z0-9_.-]+)|scene/(?:act1autochess_m0[1-7]|act2autochess_m0[1-4])/scene)\.json$", url)
    if suffix not in EXTENSIONS and not board_json:
        raise ValueError(f"unsupported resource URL: {url}")
    return url.replace("[", "%5B").replace("]", "%5D")


def group(row):
    path = row["url"]
    if row["tier"] == 2:
        if "/assets/local/fx/" in path:
            return "fx"
        for key in ("voice/cn", "voice/jp", "voice/en", "voice/kr", "voice", "sfx", "bgm"):
            if f"/audio/{key}/" in path:
                return key.replace("/", "_")
        return "other"
    if "/spine/" in path or path.endswith((".skel", ".atlas", ".webp.atlas")):
        return "spine"
    if "/local/map/" in path or "/local/scene/" in path or path.endswith(".obj"):
        return "map"
    if re.search(r"/(char|enemy|token)/", path):
        return "character"
    return "ui"


def make_rows(files):
    rows = []
    for index, row in enumerate(files):
        rows.append({"path": f"resources/{index}", "url": canonical(row["url"]),
                     "size": row["size"], "hash": row["hash"], "sha1": row["sha1"]})
    return rows


def package_size(files):
    rows = make_rows(files)
    manifest = json.dumps({"format": RESOURCE_FORMAT, "version": 2, "resourceVersion": "",
                           "files": rows}, ensure_ascii=False, separators=(",", ":")).encode()
    # Local headers + central directory are stable enough to reserve exactly; the
    # final ZIP size is still checked after writing.
    return len(manifest) + sum(len(row["url"].encode()) + row["size"] + 128 for row in rows) + 22


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--assets-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--index", required=True, type=Path)
    parser.add_argument("--max-bytes", type=int, default=MAX_PACK_BYTES)
    args = parser.parse_args()
    if args.max_bytes != MAX_PACK_BYTES or args.max_bytes <= 0:
        raise SystemExit(f"max-bytes must remain {MAX_PACK_BYTES}")
    source = json.loads(args.manifest.read_text("utf-8"))
    files = []
    for row in source.get("files", []):
        url = canonical(row["url"])
        # Manifest URLs use canonical %5B/%5D encoding, while the extracted
        # filesystem keeps literal brackets.
        path = args.assets_root / unquote(url.lstrip("/"))
        data = path.read_bytes()
        full = digest(data)
        if full[:12] != row.get("hash") or (row.get("size") is not None and row["size"] != len(data)):
            raise SystemExit(f"manifest mismatch: {url}")
        files.append({"url": url, "tier": row["tier"], "size": len(data), "hash": full[:12],
                      "sha1": full, "data": data})
    args.output.mkdir(parents=True, exist_ok=True)
    packs = []
    for key in sorted({group(row) for row in files}):
        selected = sorted((row for row in files if group(row) == key), key=lambda row: row["url"])
        chunks = []
        current = []
        for row in selected:
            if current and package_size(current + [row]) > args.max_bytes:
                chunks.append(current); current = []
            current.append(row)
            if package_size(current) > args.max_bytes:
                raise SystemExit(f"single resource cannot fit in pack: {row['url']}")
        if current: chunks.append(current)
        for number, chunk in enumerate(chunks, 1):
            pack_id = f"{key}-{number:02d}"
            rows = make_rows(chunk)
            # This informational version describes only this package. Embedding
            # the global manifest version invalidated every ZIP after any update.
            version = digest(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))[:12]
            manifest = {"format": RESOURCE_FORMAT, "version": 2, "resourceVersion": version, "files": rows}
            temporary = args.output / f".{pack_id}.zip.tmp"
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
                for row, original in zip(rows, chunk):
                    write_stored(archive, row["path"], original["data"])
                write_stored(archive, MANIFEST, json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
            if temporary.stat().st_size > args.max_bytes:
                temporary.unlink()
                raise SystemExit(f"pack exceeds limit: {temporary}")
            package_hash = digest(temporary.read_bytes())[:12]
            target = args.output / f"{pack_id}-{package_hash}.zip"
            temporary.replace(target)
            packs.append({"id": pack_id, "url": f"/resource-packs/{target.name}",
                          "group": key, "tier": min(row["tier"] for row in chunk),
                          "count": len(chunk), "bytes": sum(row["size"] for row in chunk),
                          "size": target.stat().st_size, "sha1": digest(target.read_bytes()),
                          "files": [{"url": row["url"], "size": row["size"], "hash": row["hash"]} for row in rows]})
    index = {"format": PACK_FORMAT, "version": 1, "resourceVersion": source["version"],
             "maxBytes": args.max_bytes, "packs": packs}
    args.index.parent.mkdir(parents=True, exist_ok=True)
    args.index.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"packs": len(packs), "bytes": sum(pack["size"] for pack in packs)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
