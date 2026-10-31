#!/usr/bin/env python3
# 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）：把两份已校验的分包清单比较成一份增量 ZIP。
"""Compare verified resource ZIPs and build a browser-importable v2 delta ZIP.

Uses only Python's standard library. No resources are extracted to disk.
"""

import argparse
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit
import zipfile


MANIFEST = "stronghold-resources.json"
FORMAT = "stronghold-resource-zip"
MAX_ARCHIVE_BYTES = 2 * 1024**3
MAX_MANIFEST_BYTES = 32 * 1024**2
MAX_FILE_BYTES = 24 * 1024**2
MAX_FILES = 50_000
CHUNK_BYTES = 1024**2
EXTENSIONS = frozenset(
    "png jpg jpeg webp gif svg mp3 ogg wav m4a mp4 woff woff2 ttf otf css atlas obj skel bin".split()
)
BOARD_JSON = frozenset(
    "/assets/local/map/" + suffix for suffix in (
        "fx/materials.json", "fx/prefab.json", "autochess/materials.json", "autochess/tiles.json"
    )
) | frozenset(
    f"/assets/local/scene/{season}_m{index:02}/scene.json"
    for season, maximum in (("act1autochess", 7), ("act2autochess", 4))
    for index in range(1, maximum + 1)
)


def canonical_resource_path(value):
    """Mirror the stable, root-relative identities accepted by archive.js."""
    if not isinstance(value, str) or not 0 < len(value) <= 512:
        raise ValueError("Invalid resource URL")
    if not value.startswith(("/assets/", "/fonts/")):
        raise ValueError(f"Resource must use a stable /assets/ or /fonts/ path: {value}")
    if re.search(r"""[\s?#\\"'<>\x00-\x1f]""", value):
        raise ValueError(f"Unsafe resource URL: {value}")
    if re.search(r"%(?![0-9a-fA-F]{2})", value):
        raise ValueError(f"Invalid resource URL encoding: {value}")
    parsed = urlsplit(value)
    decoded = unquote(parsed.path, errors="strict")
    if re.search(r"[\\\x00-\x1f?#]", decoded) or any(
        part in (".", "..") for part in decoded.split("/")
    ):
        raise ValueError(f"Unsafe resource URL: {value}")
    canonical = parsed.path.replace("[", "%5B").replace("]", "%5D")
    extension = canonical.rsplit(".", 1)[-1].lower() if "." in canonical else ""
    if canonical not in BOARD_JSON and extension not in EXTENSIONS:
        raise ValueError(f"Not an importable resource: {value}")
    return canonical


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def hex_digest(value, length):
    return isinstance(value, str) and re.fullmatch(rf"[0-9a-f]{{{length}}}", value) is not None


class ResourcePackage:
    """Validate archive structure first, then CRC/size/digests while streaming."""

    def __init__(self, path):
        self.path = Path(path)
        if self.path.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ValueError(f"ZIP exceeds 2 GiB: {self.path}")
        self.zip = zipfile.ZipFile(self.path)
        try:
            self._load()
        except BaseException:
            self.close()
            raise

    def _load(self):
        infos = self.zip.infolist()
        names = [info.filename for info in infos]
        if not 1 < len(infos) <= MAX_FILES + 1 or len(set(names)) != len(names):
            raise ValueError(f"Duplicate entries or invalid file count: {self.path}")
        self.entries = {info.filename: info for info in infos}
        for info in infos:
            if (
                info.flag_bits & 1
                or info.is_dir()
                or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                or (info.filename != MANIFEST and not re.fullmatch(r"resources/\d{1,5}", info.filename))
            ):
                raise ValueError(f"Unsupported ZIP entry: {info.filename}")
            limit = MAX_MANIFEST_BYTES if info.filename == MANIFEST else MAX_FILE_BYTES
            if info.file_size < 0 or info.file_size > limit:
                raise ValueError(f"ZIP entry size exceeds limit: {info.filename}")
        if sum(info.file_size for info in infos) > MAX_ARCHIVE_BYTES:
            raise ValueError("Uncompressed ZIP exceeds 2 GiB")
        if MANIFEST not in self.entries:
            raise ValueError(f"Missing {MANIFEST}: {self.path}")
        self.doc = json.loads(self.zip.read(MANIFEST))
        if (
            not isinstance(self.doc, dict)
            or self.doc.get("format") != FORMAT
            or not integer(self.doc.get("version"))
            or self.doc["version"] not in (1, 2)
            or not isinstance(self.doc.get("files"), list)
            or not 0 < len(self.doc["files"]) <= MAX_FILES
            or len(infos) != len(self.doc["files"]) + 1
        ):
            raise ValueError(f"Unsupported manifest: {self.path}")
        self.version = self.doc["version"]
        self.rows = {}
        paths = set()
        for row in self.doc["files"]:
            if not isinstance(row, dict):
                raise ValueError("Invalid manifest row")
            path = row.get("path")
            url = canonical_resource_path(row.get("url"))
            size = row.get("size")
            if (
                not isinstance(path, str)
                or not re.fullmatch(r"resources/\d{1,5}", path)
                or path in paths
                or url in self.rows
                or path not in self.entries
                or not integer(size)
                or not 0 <= size <= MAX_FILE_BYTES
                or self.entries[path].file_size != size
                or not hex_digest(row.get("hash"), 12)
            ):
                raise ValueError(f"Invalid or duplicate manifest row: {url}")
            if self.version == 1:
                if not hex_digest(row.get("sha256"), 64):
                    raise ValueError(f"Legacy v1 requires SHA-256: {url}")
            elif not hex_digest(row.get("sha1"), 40) or row["sha1"][:12] != row["hash"]:
                raise ValueError(f"Invalid v2 SHA-1: {url}")
            paths.add(path)
            self.rows[url] = {**row, "url": url}

    def verify_row(self, row, destination=None):
        sha1 = hashlib.sha1()
        sha256 = hashlib.sha256() if self.version == 1 else None
        size = 0
        # ZipExtFile checks CRC, local-header names, truncation and overlapping entries.
        with self.zip.open(row["path"]) as source:
            while chunk := source.read(CHUNK_BYTES):
                size += len(chunk)
                if size > row["size"] or size > MAX_FILE_BYTES:
                    raise ValueError(f"Decompressed size exceeds limit: {row['url']}")
                sha1.update(chunk)
                if sha256 is not None:
                    sha256.update(chunk)
                if destination is not None:
                    destination.write(chunk)
        digest = sha1.hexdigest()
        if (
            size != row["size"]
            or digest[:12] != row["hash"]
            or (self.version == 2 and digest != row["sha1"])
            or (sha256 is not None and sha256.hexdigest() != row["sha256"])
        ):
            raise ValueError(f"Resource checksum mismatch: {row['url']}")
        return digest

    def verify(self, progress=None):
        verified = {}
        for index, (url, row) in enumerate(self.rows.items(), 1):
            verified[url] = {"url": url, "size": row["size"], "sha1": self.verify_row(row)}
            if progress and (index % 1000 == 0 or index == len(self.rows)):
                progress(index, len(self.rows))
        return verified

    def close(self):
        self.zip.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def summarize(rows):
    return {"count": len(rows), "bytes": sum(row["size"] for row in rows)}


def compare_resources(base, target):
    added, changed, unchanged = [], [], []
    for url, row in target.items():
        previous = base.get(url)
        if previous is None:
            added.append(row)
        elif (previous["size"], previous["sha1"]) != (row["size"], row["sha1"]):
            changed.append({"url": url, "before": previous, "after": row})
        else:
            unchanged.append(row)
    absent = [row for url, row in base.items() if url not in target]
    selected = added + [row["after"] for row in changed]
    # Preserve target order for predictable manifests and sequential source reads.
    wanted = {row["url"] for row in selected}
    selected = [row for url, row in target.items() if url in wanted]
    groups = {}
    for row in selected:
        group = "/".join(row["url"].strip("/").split("/")[:-1][:3])
        stat = groups.setdefault(group, {"count": 0, "bytes": 0})
        stat["count"] += 1
        stat["bytes"] += row["size"]
    return {
        "summary": {
            "base": summarize(list(base.values())),
            "target": summarize(list(target.values())),
            "added": summarize(added),
            "changed": summarize([row["after"] for row in changed]),
            "unchanged": summarize(unchanged),
            "absentFromTarget": summarize(absent),
            "delta": summarize(selected),
        },
        "added": added,
        "changed": changed,
        "absentFromTarget": absent,
        "deltaGroups": dict(sorted(groups.items())),
    }, selected


@contextmanager
def exclusive_output(path, mode):
    """Never overwrite an input/existing output; remove our incomplete file on failure."""
    stream = Path(path).open(mode)
    try:
        with stream:
            yield stream
    except BaseException:
        Path(path).unlink(missing_ok=True)
        raise


def write_delta(target, selected, output):
    rows = [
        {"path": f"resources/{index}", "url": row["url"], "size": row["size"],
         "hash": row["sha1"][:12], "sha1": row["sha1"]}
        for index, row in enumerate(selected)
    ]
    doc = {"format": FORMAT, "version": 2,
           "resourceVersion": target.doc.get("resourceVersion"), "files": rows}
    manifest = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(manifest) > MAX_MANIFEST_BYTES:
        raise ValueError("Delta manifest exceeds 32 MiB")
    with exclusive_output(output, "xb") as stream:
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
            for original, row in zip(selected, rows):
                with archive.open(row["path"], "w") as destination:
                    digest = target.verify_row(target.rows[row["url"]], destination)
                if digest != original["sha1"]:
                    raise ValueError(f"Target changed while writing: {row['url']}")
            archive.writestr(MANIFEST, manifest)
        stream.flush()
        # Verify the completed output independently before reporting success.
        with ResourcePackage(output) as package:
            expected = {row["url"]: row for row in selected}
            if package.verify() != expected:
                raise ValueError("Generated delta does not match the verified target")


def build_delta(base_path, target_path, output, report_path, *, analyze_only=False, progress=None):
    base_path, target_path = Path(base_path).resolve(), Path(target_path).resolve()
    output, report_path = Path(output).resolve(), Path(report_path).resolve()
    if output in (base_path, target_path) or report_path in (base_path, target_path, output):
        raise ValueError("Output/report paths must be distinct from each other and both inputs")
    for path in ([report_path] if analyze_only else [output, report_path]):
        if path.exists():
            raise FileExistsError(f"Refusing to overwrite existing file: {path}")
        if not path.parent.is_dir():
            raise ValueError(f"Output directory does not exist: {path.parent}")
    with ResourcePackage(base_path) as base, ResourcePackage(target_path) as target:
        base_files = base.verify(
            (lambda done, total: progress("base", done, total)) if progress else None
        )
        target_files = target.verify(
            (lambda done, total: progress("target", done, total)) if progress else None
        )
        report, selected = compare_resources(base_files, target_files)
        generated = bool(selected) and not analyze_only
        if generated:
            write_delta(target, selected, output)
        report.update({
            "format": "stronghold-resource-delta-report",
            "version": 1,
            "base": {"path": str(base_path), "manifestVersion": base.version,
                     "resourceVersion": base.doc.get("resourceVersion"),
                     "zipBytes": base_path.stat().st_size},
            "target": {"path": str(target_path), "manifestVersion": target.version,
                       "resourceVersion": target.doc.get("resourceVersion"),
                       "zipBytes": target_path.stat().st_size},
            "output": {"path": str(output), "zipBytes": output.stat().st_size} if generated else None,
            "verification": {"base": "all CRC/size/version-specific digests",
                             "target": "all CRC/size/version-specific digests",
                             "output": "all CRC/size/SHA-1" if generated else None},
            "notes": [
                "Delta contains complete added/changed files, not binary patches.",
                "absentFromTarget means missing from the target ZIP, not necessarily deleted from the game.",
                "No deletion instructions; existing browser import accepts this partial v2 package.",
                "Install the base first. Current server fingerprints determine reuse; missing selected resources download.",
            ],
        })
        with exclusive_output(report_path, "x") as stream:
            json.dump(report, stream, ensure_ascii=True, indent=2)
            stream.write("\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, type=Path, help="Old full resource ZIP")
    parser.add_argument("--target", required=True, type=Path, help="New resource ZIP")
    parser.add_argument("--output", type=Path, help="Delta ZIP (default: beside target, <target>-delta.zip)")
    parser.add_argument("--report", type=Path, help="JSON analysis (default: <output stem>.report.json)")
    parser.add_argument("--analyze-only", action="store_true", help="Verify/compare and write report only")
    args = parser.parse_args()
    output = args.output or args.target.with_name(args.target.stem + "-delta.zip")
    report_path = args.report or output.with_suffix(".report.json")
    try:
        report = build_delta(args.base, args.target, output, report_path,
                             analyze_only=args.analyze_only,
                             progress=lambda label, done, total: print(
                                 f"Verify {label}: {done}/{total}", file=sys.stderr))
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        parser.exit(1, f"Error: {error}\n")
    print(json.dumps(report["summary"], ensure_ascii=True, indent=2))
    print(f"Report: {report_path}")
    if report["output"]:
        print(f"Delta: {output} ({report['output']['zipBytes']:,} bytes)")
    elif args.analyze_only:
        print("Analysis only; no ZIP written.")
    else:
        print("No added/changed resources; no empty ZIP written (the browser rejects empty packages).")


if __name__ == "__main__":
    main()
