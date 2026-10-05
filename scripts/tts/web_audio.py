#!/usr/bin/env python3
"""Build browser-compatible MP3 siblings from the audio actually used by the web.

The existing .opus files are immutable inputs (some contain MP3 already). No
generated JSON is changed until every referenced asset has been built. A manifest
validates both source and output hashes, so content changes cannot reuse old audio.
Only the Python standard library and an FFmpeg build with libmp3lame are required.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PUBLIC = ROOT / "apps/web/public"
DEFAULT_UI = ROOT / "apps/web/src/lib/uiAudio.ts"
DEFAULT_MANIFEST = ROOT / "deploy-output/web-audio-manifest.json"
DEFAULT_REPORT = ROOT / "deploy-output/web-audio-report.json"
CONFIG = {"schema": 1, "codec": "libmp3lame", "bitrate": "64k", "channels": 1,
          "sample_rate": 24000, "threads": 1, "existing_mp3": "copy_current_source"}
CONFIG_SHA256 = hashlib.sha256(json.dumps(CONFIG, sort_keys=True).encode()).hexdigest()
UI_PAIR = re.compile(r'("(?:[^"\\]|\\.)*")\s*:\s*("/audio/(?:[^"\\]|\\.)*")')
JSON_STRING = re.compile(r'"(?:[^"\\]|\\.)*"')


class AudioBuildError(RuntimeError):
    pass


@dataclass(frozen=True)
class Reference:
    url: str
    document: str
    pointer: str


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def atomic_json(path: Path, value: Any) -> None:
    atomic_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def audio_path(public: Path, url: str) -> Path:
    rel = PurePosixPath(url)
    if not url.startswith("/audio/") or "?" in url or "#" in url or "\\" in url or ".." in rel.parts:
        raise AudioBuildError(f"Unsupported audio URL: {url}")
    if rel.suffix not in {".opus", ".mp3"}:
        raise AudioBuildError(f"Unsupported audio extension: {url}")
    path = public.joinpath(*rel.parts[1:]).resolve()
    if not path.is_relative_to((public / "audio").resolve()):
        raise AudioBuildError(f"Audio URL leaves public/audio: {url}")
    return path


def walk_references(value: Any, document: str, pointer: str = "") -> Iterator[Reference]:
    if isinstance(value, str) and value.startswith("/audio/"):
        yield Reference(value, document, pointer or "/")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_references(child, document, f"{pointer}/{index}")
    elif isinstance(value, dict):
        for key, child in value.items():
            escaped = str(key).replace("~", "~0").replace("/", "~1")
            yield from walk_references(child, document, f"{pointer}/{escaped}")


def collect_json(public: Path) -> tuple[list[Reference], dict[Path, bytes]]:
    data = public / "data"
    documents = sorted(data.rglob("*.json")) if data.is_dir() else []
    if not documents:
        raise AudioBuildError(f"No generated JSON found in {data}")
    refs: list[Reference] = []
    originals: dict[Path, bytes] = {}
    for path in documents:
        raw = path.read_bytes()
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError) as exc:
            raise AudioBuildError(f"Invalid generated JSON: {path}") from exc
        refs.extend(walk_references(value, path.relative_to(public).as_posix()))
        originals[path] = raw
    return refs, originals


def collect_ui(ui_path: Path) -> list[tuple[str, str]]:
    if not ui_path.is_file():
        raise AudioBuildError(f"UI audio module is missing: {ui_path}")
    pairs = [(json.loads(key), json.loads(url)) for key, url in UI_PAIR.findall(ui_path.read_text("utf-8"))]
    if not pairs:
        raise AudioBuildError(f"No UI audio map entries found: {ui_path}")
    return pairs


def _mp3_frame_size(header: bytes) -> int:
    if len(header) != 4 or header[0] != 0xFF or header[1] & 0xE0 != 0xE0:
        return 0
    version = (header[1] >> 3) & 3
    layer = (header[1] >> 1) & 3
    bitrate_index, sample_index = header[2] >> 4, (header[2] >> 2) & 3
    if version == 1 or layer != 1 or bitrate_index in {0, 15} or sample_index == 3:
        return 0  # MPEG Layer III only; free-format data is deliberately unsupported.
    rates = [44100, 48000, 32000]
    sample_rate = rates[sample_index] // (1 if version == 3 else 2 if version == 2 else 4)
    bitrates = ([0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
                if version == 3 else [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])
    return (144000 if version == 3 else 72000) * bitrates[bitrate_index] // sample_rate + ((header[2] >> 1) & 1)


def audio_format(path: Path) -> str:
    """Identify real Ogg or two consecutive MPEG Layer III frames, not a suffix/ID3 alone."""
    if not path.is_file() or path.stat().st_size == 0:
        return "empty_or_missing"
    size = path.stat().st_size
    with path.open("rb") as stream:
        head = stream.read(10)
        if head.startswith(b"OggS"):
            return "ogg"
        offset = 0
        if head.startswith(b"ID3"):
            if len(head) != 10 or any(byte & 0x80 for byte in head[6:10]):
                return "unknown"
            offset = 10 + sum(byte << shift for byte, shift in zip(head[6:10], [21, 14, 7, 0]))
            if head[3] == 4 and head[5] & 0x10:
                offset += 10  # Optional ID3v2.4 footer.
        if offset >= size:
            return "unknown"
        stream.seek(offset)
        # Allow a little padding between a valid ID3 tag and the first frame.
        block = stream.read(min(4096, size - offset))
        for index in range(max(0, len(block) - 3)):
            frame_size = _mp3_frame_size(block[index:index + 4])
            if not frame_size:
                continue
            second = offset + index + frame_size
            if second + 4 > size:
                continue
            stream.seek(second)
            if _mp3_frame_size(stream.read(4)):
                return "mp3"
        return "unknown"


def require_ffmpeg(binary: str) -> tuple[str, str]:
    resolved = shutil.which(binary)
    if not resolved:
        raise AudioBuildError(f"FFmpeg is missing: {binary}. Generated JSON is unchanged.")
    try:
        version = subprocess.run([resolved, "-version"], capture_output=True, text=True, check=True, timeout=30)
        encoders = subprocess.run([resolved, "-hide_banner", "-encoders"], capture_output=True, text=True, check=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        raise AudioBuildError("FFmpeg cannot run. Generated JSON is unchanged.") from exc
    if "libmp3lame" not in encoders.stdout:
        raise AudioBuildError("FFmpeg has no libmp3lame encoder. Generated JSON is unchanged.")
    return resolved, version.stdout.splitlines()[0]


def build_one(item: dict[str, Any], binary: str) -> dict[str, Any]:
    source, target = Path(item["source"]), Path(item["target"])
    started = time.monotonic()
    fd, name = tempfile.mkstemp(prefix=f".{target.stem}.", suffix=".mp3", dir=target.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        if item["input_format"] == "mp3":
            shutil.copyfile(source, temporary)
            action = "copied_mp3"
        else:
            command = [binary, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                       "-threads", "1", "-i", str(source), "-map", "0:a:0", "-vn",
                       "-c:a", "libmp3lame", "-b:a", "64k", "-ac", "1", "-ar", "24000",
                       "-threads", "1", "-f", "mp3", str(temporary)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=600)
            if result.returncode:
                raise AudioBuildError(f"FFmpeg failed for {item['source_url']}: {result.stderr[-2000:].strip()}")
            action = "transcoded_ogg"
        if audio_format(temporary) != "mp3":
            raise AudioBuildError(f"Output is empty or not genuine MP3: {item['target_url']}")
        if digest(source) != item["source_sha256"]:
            raise AudioBuildError(f"Source changed during conversion: {item['source_url']}")
        output_hash, output_bytes = digest(temporary), temporary.stat().st_size
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        return {"source_url": item["source_url"], "target_url": item["target_url"],
                "source_sha256": item["source_sha256"], "target_sha256": output_hash,
                "config_sha256": CONFIG_SHA256, "input_format": item["input_format"],
                "source_bytes": source.stat().st_size, "target_bytes": output_bytes,
                "action": action, "elapsed_seconds": round(time.monotonic() - started, 3)}
    finally:
        temporary.unlink(missing_ok=True)


def rewrite_json(originals: dict[Path, bytes], replacements: dict[str, str]) -> int:
    staged: list[tuple[Path, bytes]] = []
    for path, raw in originals.items():
        def replace(match: re.Match[str]) -> str:
            value = json.loads(match.group())
            return json.dumps(replacements[value]) if value in replacements else match.group()
        updated = JSON_STRING.sub(replace, raw.decode("utf-8")).encode("utf-8")
        if updated != raw:
            json.loads(updated)
            staged.append((path, updated))
    # Detect a concurrent build before writing any JSON.
    for path, raw in originals.items():
        if path.read_bytes() != raw:
            raise AudioBuildError(f"Generated JSON changed during conversion: {path}; refusing to overwrite it.")
    changed: list[Path] = []
    try:
        for path, updated in staged:
            atomic_bytes(path, updated)
            changed.append(path)
    except BaseException:
        # Per-file writes are atomic. Also roll back completed writes if commit fails.
        for path in reversed(changed):
            atomic_bytes(path, originals[path])
        raise
    return len(staged)


def run(args: argparse.Namespace) -> int:
    started = time.monotonic()
    report: dict[str, Any] = {"status": "running", "started_at": datetime.now(timezone.utc).isoformat(),
                             "config": CONFIG, "workers": args.workers, "json_files_changed": 0,
                             "assets": [], "errors": []}
    entries: dict[str, Any] = {}
    try:
        binary, version = require_ffmpeg(args.ffmpeg)
        report["ffmpeg"] = version
        refs, originals = collect_json(args.public_root)
        ui_pairs = collect_ui(args.ui_audio)
        refs.extend(Reference(url, args.ui_audio.name, key) for key, url in ui_pairs)
        urls = sorted({ref.url for ref in refs})
        if not urls:
            raise AudioBuildError("No referenced web audio was found.")
        report.update(json_documents=len(originals), reference_count=len(refs), unique_references=len(urls))
        cached: dict[str, Any] = {}
        if args.manifest.is_file():
            try:
                old = json.loads(args.manifest.read_text("utf-8"))
                cached = old.get("entries", {}) if isinstance(old, dict) else {}
                if not isinstance(cached, dict):
                    cached = {}
            except (ValueError, OSError):
                cached = {}
        items: dict[str, dict[str, Any]] = {}
        replacements: dict[str, str] = {}
        last_progress = time.monotonic()
        print(f"[web-audio] preflight: {len(urls)} unique references, {args.workers} workers", flush=True)
        for index, url in enumerate(urls, 1):
            referenced = audio_path(args.public_root, url)
            source = referenced.with_suffix(".opus")
            # Prefer the current immutable source even when JSON already references MP3.
            if not source.is_file():
                if referenced.suffix == ".mp3" and referenced.is_file():
                    raise AudioBuildError(f"Original .opus source is missing for {url}; refusing an unverifiable cached MP3.")
                raise AudioBuildError(f"Referenced source is missing: {url}")
            target = source.with_suffix(".mp3")
            source_url = "/" + source.relative_to(args.public_root.resolve()).as_posix()
            target_url = "/" + target.relative_to(args.public_root.resolve()).as_posix()
            if url.endswith(".opus"):
                replacements[url] = target_url
            if source_url not in items:
                fmt = audio_format(source)
                if fmt not in {"mp3", "ogg"}:
                    raise AudioBuildError(f"Empty or unrecognized audio ({fmt}): {source_url}")
                items[source_url] = {"source": str(source), "target": str(target),
                                     "source_url": source_url, "target_url": target_url,
                                     "source_sha256": digest(source), "input_format": fmt}
            if time.monotonic() - last_progress >= 5:
                print(f"[web-audio] preflight {index}/{len(urls)}", flush=True)
                last_progress = time.monotonic()
        pending = []
        for key, item in items.items():
            old = cached.get(key)
            target = Path(item["target"])
            if (isinstance(old, dict) and old.get("source_sha256") == item["source_sha256"]
                    and old.get("config_sha256") == CONFIG_SHA256 and audio_format(target) == "mp3"
                    and old.get("target_sha256") == digest(target)):
                entries[key] = {**old, "action": "cached", "elapsed_seconds": 0}
            else:
                pending.append(item)
            if time.monotonic() - last_progress >= 5:
                print(f"[web-audio] cache checked {len(entries) + len(pending)}/{len(items)}", flush=True)
                last_progress = time.monotonic()
        report["source_assets"] = len(items)
        print(f"[web-audio] build: {len(pending)} pending, {len(entries)} cached", flush=True)
        errors: list[str] = []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(build_one, item, binary): item for item in pending}
            # A completion-independent heartbeat keeps long-running audio visible.
            from threading import Event, Thread
            stop = Event()
            def heartbeat() -> None:
                while not stop.wait(5):
                    print(f"[web-audio] completed {len(entries)}/{len(items)}; failures {len(errors)}; "
                          f"elapsed {int(time.monotonic() - started)}s", flush=True)
            monitor = Thread(target=heartbeat, daemon=True)
            monitor.start()
            try:
                for future in as_completed(futures):
                    try:
                        built = future.result()
                        entries[built["source_url"]] = built
                    except CancelledError:
                        pass
                    except Exception as exc:
                        errors.append(str(exc))
                        for remaining in futures:
                            remaining.cancel()
            finally:
                stop.set()
                monitor.join()
        report["errors"] = errors
        if errors:
            raise AudioBuildError(f"{len(errors)} conversion failure(s); generated JSON is unchanged.")
        # All sources and siblings must still match at the commit boundary.
        for index, (key, item) in enumerate(items.items(), 1):
            if digest(Path(item["source"])) != item["source_sha256"]:
                raise AudioBuildError(f"Source changed before JSON commit: {key}")
            if audio_format(Path(item["target"])) != "mp3" or digest(Path(item["target"])) != entries[key]["target_sha256"]:
                raise AudioBuildError(f"MP3 changed before JSON commit: {item['target_url']}")
            if time.monotonic() - last_progress >= 5:
                print(f"[web-audio] final validation {index}/{len(items)}", flush=True)
                last_progress = time.monotonic()
        report["json_files_changed"] = rewrite_json(originals, replacements)
        report["status"] = "passed"
    except Exception as exc:
        report["status"] = "failed"
        report["errors"].append(str(exc))
        print(f"[web-audio] FAILED: {exc}", file=sys.stderr, flush=True)
    finally:
        report["assets"] = [entries[key] for key in sorted(entries)]
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        # Successful assets remain reusable after a failed run; JSON never references
        # a partial conversion batch. Write the final report only after manifest.
        manifest_entries = entries
        if report["status"] == "failed" and args.manifest.is_file():
            # A missing decoder/bad new input must not erase otherwise reusable
            # siblings. Every retained entry is hash-checked on the next run.
            try:
                previous = json.loads(args.manifest.read_text("utf-8"))
                previous_entries = previous.get("entries", {}) if isinstance(previous, dict) else {}
                if isinstance(previous_entries, dict):
                    manifest_entries = {**previous_entries, **entries}
            except (ValueError, OSError):
                pass
        atomic_json(args.manifest, {"schema": 1, "config": CONFIG, "config_sha256": CONFIG_SHA256,
                                    "status": report["status"], "entries": manifest_entries})
        atomic_json(args.report, report)
    actions: dict[str, int] = {}
    for entry in entries.values():
        action = entry["action"]
        actions[action] = actions.get(action, 0) + 1
    print(f"[web-audio] {report['status']}: {len(entries)} assets {actions}; "
          f"{report['json_files_changed']} JSON files changed; report: {args.report}", flush=True)
    return 0 if report["status"] == "passed" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=8, help="Parallel conversions (1–12, default 8)")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--public-root", type=Path, default=DEFAULT_PUBLIC)
    parser.add_argument("--ui-audio", type=Path, default=DEFAULT_UI)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    if not 1 <= args.workers <= 12:
        parser.error("--workers must be between 1 and 12")
    args.public_root = args.public_root.resolve()
    args.ui_audio = args.ui_audio.resolve()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
