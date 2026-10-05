#!/usr/bin/env python3
"""Download, verify, and install complete assets, including updates to existing files."""
import argparse
import hashlib
import json
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

DESTINATIONS = {
    "audio.tar.gz": "apps/web/public",
    "data.zip": "apps/web/public/data",
    "data-source.zip": "data",
    "story-images.zip": "apps/web/public/story-images",
    "textbook-pages.zip": "apps/web/public/textbook-pages",
}


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def target_path(destination, name):
    parts = PurePosixPath(name.replace("\\", "/"))
    if parts.is_absolute() or ".." in parts.parts or ":" in name:
        raise ValueError(f"Unsafe archive path: {name}")
    target = destination.joinpath(*parts.parts)
    if not target.resolve().is_relative_to(destination.resolve()):
        raise ValueError(f"Archive path escapes destination: {name}")
    return target


def extract(path, destination):
    destination.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            for item in archive.infolist():
                target = target_path(destination, item.filename)
                if (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("Archive links are not supported")
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as source, target.open("wb") as dest:
                        shutil.copyfileobj(source, dest)
    else:
        with tarfile.open(path, "r:gz") as archive:
            for item in archive:
                target = target_path(destination, item.name)
                if not item.isfile():
                    raise ValueError("Only regular audio files are supported")
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(item) as source, target.open("wb") as dest:
                    shutil.copyfileobj(source, dest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default="v1.2.0-assets")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--archives-dir", type=Path, help="Use already downloaded archives + manifest")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="china-study-assets-") as temporary:
        cache = args.archives_dir or Path(temporary)
        base = f"https://github.com/wuwangzhang1216/ChinaTextbookStudyFree/releases/download/{args.tag}"
        if not args.archives_dir:
            urllib.request.urlretrieve(base + "/manifest.json", cache / "manifest.json")
        manifest = json.loads((cache / "manifest.json").read_text())
        if manifest.get("schema_version") != 1 or manifest.get("tag") != args.tag:
            raise ValueError("Manifest version/tag mismatch")
        assets = {a["name"]: a for a in manifest["assets"]}
        # Verify ALL packages before changing the installation.
        for name in DESTINATIONS:
            if not args.archives_dir:
                print(f"Downloading {name}…", flush=True)
                urllib.request.urlretrieve(base + "/" + name, cache / name)
            path, item = cache / name, assets[name]
            if path.stat().st_size != item["bytes"] or sha256(path) != item["sha256"]:
                raise ValueError(f"Size/SHA-256 mismatch: {name}")
            print(f"Verified {name}", flush=True)
        for name, destination in DESTINATIONS.items():
            print(f"Installing {name}…", flush=True)
            extract(cache / name, args.root / destination)
        (args.root / "ASSETS-VERSION.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"Installed {args.tag} in {args.root.resolve()}")


if __name__ == "__main__":
    main()
