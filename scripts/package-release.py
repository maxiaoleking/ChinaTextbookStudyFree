#!/usr/bin/env python3
"""Package the current, tested Web snapshot and complete legacy + revised assets."""
import argparse
import hashlib
import json
import re
import subprocess
import tarfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "apps/web/public"


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def files(base, suffixes):
    return sorted(p for p in base.rglob("*") if p.is_file() and not p.is_symlink()
                  and p.suffix in suffixes
                  and not any(x.startswith(".") for x in p.relative_to(base).parts))


def write_zip(destination, entries, compressed=True):
    with zipfile.ZipFile(destination, "w", compression=(zipfile.ZIP_DEFLATED if compressed
                                                     else zipfile.ZIP_STORED)) as archive:
        for path, name in entries:
            archive.write(path, name)
    with zipfile.ZipFile(destination) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError(f"ZIP CRC failed: {bad}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", nargs="?", default="v1.2.0-assets")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.tag):
        parser.error("Invalid tag")
    out = args.out or ROOT / "release-assets" / args.tag
    out.mkdir(parents=True, exist_ok=False)
    manifest = {"schema_version": 1, "tag": args.tag,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "source_base_commit": subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "source_includes_local_changes": True, "assets": []}

    def record(path, entries, destination):
        item = {"name": path.name, "bytes": path.stat().st_size,
                "sha256": digest(path), "files": len(entries),
                "uncompressed_bytes": sum(p.stat().st_size for p, _ in entries),
                "extract_to": destination}
        manifest["assets"].append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)

    for name, base, extensions, target, compressed in [
        ("data.zip", PUBLIC / "data", {".json"}, "apps/web/public/data", True),
        ("story-images.zip", PUBLIC / "story-images", {".jpg", ".png", ".webp"},
         "apps/web/public/story-images", False),
        ("textbook-pages.zip", PUBLIC / "textbook-pages", {".jpg", ".json"},
         "apps/web/public/textbook-pages", False),
    ]:
        entries = [(p, p.relative_to(base).as_posix()) for p in files(base, extensions)]
        if not entries:
            raise RuntimeError(f"No files for {name}")
        write_zip(out / name, entries, compressed)
        record(out / name, entries, target)

    # Only published book JSON, never .cache, generation logs, backups or credentials.
    entries = [(p, p.relative_to(ROOT / "data").as_posix())
               for kind in ("passages", "stories")
               for p in sorted((ROOT / "data" / kind).glob("*/*.json"))
               if not p.name.startswith(".") and not p.is_symlink()]
    write_zip(out / "data-source.zip", entries)
    record(out / "data-source.zip", entries, "data")

    # Keep the original and Web formats in separate assets so neither exceeds
    # GitHub's per-asset size limit after adding the compatible format.
    for audio_name, suffixes in [('audio.tar.gz', {'.opus'}),
                                 ('audio-web-mp3.tar.gz', {'.mp3'})]:
        entries = [(p, "audio/" + p.relative_to(PUBLIC / "audio").as_posix())
                   for p in files(PUBLIC / "audio", suffixes)]
        if not entries:
            continue
        print(f"Packing {audio_name}…", flush=True)
        with tarfile.open(out / audio_name, "w:gz", compresslevel=1) as archive:
            for i, (path, name) in enumerate(entries):
                info = archive.gettarinfo(str(path), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                info.pax_headers = {}
                with path.open("rb") as stream:
                    archive.addfile(info, stream)
                if i and i % 10000 == 0:
                    print(f"  audio {i}/{len(entries)}", flush=True)
        record(out / audio_name, entries, "apps/web/public")

    # A complete matching Web source tree, not an overlay over a newer main branch.
    tracked = subprocess.check_output(["git", "ls-files", "-z", "--",
                                      "apps/web", "packages/core", "output"], cwd=ROOT)
    names = {x.decode() for x in tracked.split(b"\0") if x}
    # Include reviewed local source additions as well as tracked source files.
    # Generated public data/media remain in their dedicated resource archives.
    names.update(p.relative_to(ROOT).as_posix()
                 for p in (ROOT/'apps/web/src').rglob('*')
                 if p.is_file() and p.suffix in {'.ts','.tsx','.css'})
    names.update(["package.json", "package-lock.json", "LICENSE", ".gitignore", "README.md",
                  "scripts/package-release.sh", "scripts/package-release.py",
                  "scripts/install-release.py", "scripts/download-assets.sh",
                  "scripts/tts/web_audio.py",
                  "scripts/download-assets.ps1", "scripts/check-choice-grading.ts",
                  "scripts/check-story-grading.ts", "docs/content-quality-review.md",
                  "docs/content-audit.json", "docs/content-revision-results.json",
                  "docs/content-revision-samples.json", "docs/release-install.md",
                  "apps/web/public/content-revision.html",
                  "apps/web/public/content-revision-status.json"])
    entries = []
    for name in sorted(names):
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"Missing or linked source file: {name}")
        if any(part in {"node_modules", ".next", ".env", ".cache"} for part in path.parts):
            raise RuntimeError(f"Unsafe source file: {name}")
        if path.suffix in {".json", ".py", ".ts", ".tsx", ".md", ".sh", ".ps1", ".mjs"}:
            if re.search(rb"sk-or-v1-[a-zA-Z0-9]{20,}", path.read_bytes()):
                raise RuntimeError(f"Credential detected in {name}")
        entries.append((path, "ChinaTextbookStudyFree-web/" + name))
    write_zip(out / "web-source.zip", entries)
    with zipfile.ZipFile(out / "web-source.zip", "a", compression=zipfile.ZIP_DEFLATED) as archive:
        version = json.dumps({
            "tag": args.tag, "base_commit": manifest["source_base_commit"],
            "includes_local_changes": True,
            "description": "Tested local Web/core and source data build inputs; not current main."}, indent=2)
        archive.writestr("ChinaTextbookStudyFree-web/SOURCE-VERSION.json", version)
    record(out / "web-source.zip", entries, "NEW_DIRECTORY_ONLY")
    manifest["assets"][-1]["files"] += 1
    manifest["assets"][-1]["uncompressed_bytes"] += len(version.encode())
    manifest["content"] = {"books": 44, "lessons": 2166, "unit_questions": 6545,
                           "passages": 779, "stories": 284, "revised_chinese_stories": 188,
                           "revised_chinese_questions": 936, "new_story_images": 188}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (out / "RELEASE-INSTALL.md").write_text((ROOT / "docs/release-install.md").read_text())
    checksums = "".join(f"{digest(p)}  {p.name}\n" for p in sorted(out.iterdir()) if p.is_file())
    (out / "SHA256SUMS").write_text(checksums)
    print(f"Complete: {out}", flush=True)


if __name__ == "__main__":
    main()
