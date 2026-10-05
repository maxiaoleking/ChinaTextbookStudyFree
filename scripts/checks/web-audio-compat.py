#!/usr/bin/env python3
"""Check actual web JSON and uiAudio() references, MP3 signatures and sample decodes.

No app data/audio is changed. The checker executes the real TypeScript uiAudio
function, so it validates returned URLs rather than assuming the literal map's
suffix is the runtime suffix. Decoder samples include the reported core concept
and intro bubble, plus deterministic passage/story samples when present.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/tts"))
from web_audio import (  # noqa: E402
    AudioBuildError, DEFAULT_PUBLIC, DEFAULT_UI, Reference, atomic_json, audio_format,
    audio_path, collect_json, collect_ui, digest,
)


def actual_ui_references(ui_path: Path) -> list[Reference]:
    pairs = collect_ui(ui_path)
    tsx = ROOT / "node_modules/.bin/tsx"
    if not tsx.is_file():
        raise AudioBuildError("Local tsx is missing; install workspace dependencies to check actual uiAudio().")
    keys = [key for key, _ in pairs]
    program = (f"import {{ uiAudio }} from {json.dumps(str(ui_path))};\n"
               f"const keys = {json.dumps(keys, ensure_ascii=False)};\n"
               "console.log(JSON.stringify(keys.map(key => ({key, url: uiAudio(key)}))));")
    # A file entry point also works with newer Node releases where tsx -e can
    # exit before running its evaluation under the deprecated loader API.
    with tempfile.TemporaryDirectory(prefix="web-audio-ui-") as directory:
        entry = Path(directory) / "check-ui.ts"
        entry.write_text(program, "utf-8")
        result = subprocess.run([str(tsx), "--tsconfig", str(ROOT / "apps/web/tsconfig.json"), str(entry)],
                                capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise AudioBuildError(f"Cannot execute actual uiAudio(): {result.stderr[-2000:].strip()}")
    try:
        values = json.loads(result.stdout.strip())
    except ValueError as exc:
        raise AudioBuildError("Actual uiAudio() did not return valid results.") from exc
    refs = []
    for value in values:
        url = value.get("url")
        if not isinstance(url, str) or not url.startswith("/audio/"):
            raise AudioBuildError(f"uiAudio() returned no local audio for {value.get('key')!r}")
        refs.append(Reference(url, ui_path.name, value["key"]))
    return refs


def decoder_samples(refs: list[Reference], count: int, explicit: list[str]) -> list[dict[str, str]]:
    samples: dict[str, str] = {}
    selectors = [
        ("reported_core_concept_52238", lambda r: PureName(r.url).startswith("52238")),
        ("reported_intro_bubble_ccd353", lambda r: PureName(r.url).startswith("ccd353")),
        ("passage", lambda r: r.document.endswith("passages.json")),
        ("story", lambda r: r.document.endswith("stories.json")),
    ]
    ordered = sorted(refs, key=lambda ref: (ref.document, ref.pointer, ref.url))
    for label, condition in selectors:
        match = next((ref for ref in ordered if condition(ref)), None)
        if match:
            samples[match.url] = label
    for url in explicit:
        if url not in {ref.url for ref in refs}:
            raise AudioBuildError(f"Requested decoder sample is not an actual reference: {url}")
        samples[url] = "explicit"
    unique = sorted({ref.url for ref in refs})
    # Spread deterministic additional samples across the whole content-addressed set.
    if count > len(samples) and unique:
        for index in range(count):
            url = unique[min(len(unique) - 1, index * len(unique) // count)]
            if len(samples) >= count:
                break
            samples.setdefault(url, "deterministic")
    return [{"url": url, "category": label} for url, label in samples.items()]


def PureName(url: str) -> str:
    return url.rsplit("/", 1)[-1]


def check(public: Path, ui_path: Path, binary: str, sample_count: int, explicit: list[str]) -> dict[str, Any]:
    refs, originals = collect_json(public)
    refs.extend(actual_ui_references(ui_path))
    errors: list[dict[str, str]] = []
    by_url: dict[str, list[Reference]] = {}
    for ref in refs:
        by_url.setdefault(ref.url, []).append(ref)
    assets: list[dict[str, Any]] = []
    for url in sorted(by_url):
        source = by_url[url][0]
        entry: dict[str, Any] = {"url": url, "references": len(by_url[url]),
                                 "document": source.document, "pointer": source.pointer}
        try:
            path = audio_path(public, url)
            fmt = audio_format(path)
            entry["format"] = fmt
            if not url.endswith(".mp3"):
                errors.append({"url": url, "reason": "Final runtime reference must use .mp3"})
            if fmt != "mp3":
                errors.append({"url": url, "reason": f"Missing, empty or non-MP3 asset: {fmt}"})
            else:
                entry["bytes"] = path.stat().st_size
        except (AudioBuildError, OSError) as exc:
            errors.append({"url": url, "reason": str(exc)})
        assets.append(entry)
    resolved = shutil.which(binary)
    samples = decoder_samples(refs, sample_count, explicit)
    if not resolved:
        errors.append({"url": "", "reason": "FFmpeg is required for the real decoder check"})
    else:
        for sample in samples:
            path = audio_path(public, sample["url"])
            if not sample["url"].endswith(".mp3") or audio_format(path) != "mp3":
                sample["result"] = "failed_signature_or_extension"
                continue
            command = [resolved, "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror",
                       "-threads", "1", "-i", str(path), "-map", "0:a:0", "-vn", "-f", "null", "-"]
            result = subprocess.run(command, capture_output=True, text=True, timeout=600)
            sample["result"] = "passed" if result.returncode == 0 else "failed_decoder"
            if result.returncode:
                errors.append({"url": sample["url"], "reason": f"Real decoder failed: {result.stderr[-2000:].strip()}"})
    return {"status": "passed" if not errors else "failed", "json_documents": len(originals),
            "reference_count": len(refs), "unique_assets": len(by_url), "assets": assets,
            "decoder_samples": samples, "errors": errors}


def self_test() -> int:
    """Small real-codec fixtures only; never converts the repository audio library."""
    binary = shutil.which("ffmpeg")
    if not binary:
        raise AudioBuildError("FFmpeg is required for fixture tests")
    passed: list[str] = []
    converter = ROOT / "scripts/tts/web_audio.py"
    with tempfile.TemporaryDirectory(prefix="web-audio-compat-") as temporary:
        root = Path(temporary)
        public, ui = root / "public", root / "uiAudio.ts"
        audio, data = public / "audio/aa", public / "data"
        audio.mkdir(parents=True)
        data.mkdir(parents=True)
        document = data / "fixture.json"
        manifest, report = root / "manifest.json", root / "report.json"
        opus_mp3, opus_ogg = audio / "copied.opus", audio / "encoded.opus"
        def generate(path: Path, codec: str, frequency: int = 440) -> None:
            container = "mp3" if codec == "libmp3lame" else "ogg"
            subprocess.run([binary, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                            f"sine=frequency={frequency}:duration=0.35", "-c:a", codec, "-f", container, str(path)],
                           check=True, capture_output=True)
        generate(opus_mp3, "libmp3lame")
        generate(opus_ogg, "libopus")
        ui.write_text('const UI_AUDIO_MAP = {"fixture": "/audio/aa/copied.opus"};\n'
                      'export function uiAudio(text: string) { return UI_AUDIO_MAP[text]?.replace(/\\.opus$/, ".mp3"); }\n', "utf-8")
        def reset_document(extra: str | None = None) -> bytes:
            payload = {"copy": "/audio/aa/copied.opus", "encode": "/audio/aa/encoded.opus"}
            if extra:
                payload["extra"] = extra
            document.write_text(json.dumps(payload, indent=2) + "\n", "utf-8")
            return document.read_bytes()
        def convert(ffmpeg: str = binary, expect: int = 0) -> dict[str, Any]:
            result = subprocess.run([sys.executable, str(converter), "--workers", "2", "--public-root", str(public),
                                     "--ui-audio", str(ui), "--report", str(report), "--manifest", str(manifest),
                                     "--ffmpeg", ffmpeg], capture_output=True, text=True, timeout=120)
            if result.returncode != expect:
                raise AssertionError(f"Converter exit {result.returncode}, expected {expect}: {result.stdout} {result.stderr}")
            return json.loads(report.read_text("utf-8"))
        reset_document()
        original_hashes = [digest(opus_mp3), digest(opus_ogg)]
        result = convert()
        assert {asset["action"] for asset in result["assets"]} == {"copied_mp3", "transcoded_ogg"}
        assert digest(opus_mp3) == digest(opus_mp3.with_suffix(".mp3"))
        assert [digest(opus_mp3), digest(opus_ogg)] == original_hashes
        assert check(public, ui, binary, 2, ["/audio/aa/encoded.mp3"])["status"] == "passed"
        passed.append("real MP3 copy and Ogg encode; actual UI function; decoder; sources immutable")
        result = convert()
        assert all(asset["action"] == "cached" for asset in result["assets"])
        assert result["json_files_changed"] == 0
        passed.append("idempotent rerun uses source/config/output-hash cache")
        generate(opus_mp3, "libmp3lame", 880)
        result = convert()
        assert next(asset for asset in result["assets"] if asset["source_url"].endswith("copied.opus"))["action"] == "copied_mp3"
        assert digest(opus_mp3) == digest(opus_mp3.with_suffix(".mp3"))
        passed.append("updated current source replaces old sibling even with already-MP3 JSON")
        opus_mp3.with_suffix(".mp3").write_bytes(b"not an MP3")
        result = convert()
        assert next(asset for asset in result["assets"] if asset["source_url"].endswith("copied.opus"))["action"] == "copied_mp3"
        passed.append("corrupt output invalidates cache")
        for name, content in [("empty", b""), ("unknown", b"RIFFnot supported"), ("tag_only", b"ID3\x04\x00\x00\x00\x00\x00\x00")]:
            (audio / f"{name}.opus").write_bytes(content)
            before = reset_document(f"/audio/aa/{name}.opus")
            convert(expect=1)
            assert document.read_bytes() == before
            passed.append(f"{name} input fails without any JSON rewrite")
        before = reset_document("/audio/aa/missing.opus")
        convert(expect=1)
        assert document.read_bytes() == before
        passed.append("missing source fails without JSON rewrite")
        before = reset_document()
        convert(ffmpeg=str(root / "missing-ffmpeg"), expect=1)
        assert document.read_bytes() == before
        passed.append("missing FFmpeg fails without JSON rewrite")
        assert len(json.loads(manifest.read_text("utf-8"))["entries"]) == 2
        result = convert()
        assert all(asset["action"] == "cached" for asset in result["assets"])
        passed.append("failed preflight retains valid manifest entries for the next rerun")
        fake = root / "failed-ffmpeg"
        fake.write_text('#!/bin/sh\ncase "$1" in\n-version) echo fixture-ffmpeg; exit 0;;\n'
                        '-hide_banner) if [ "$2" = "-encoders" ]; then echo libmp3lame; exit 0; fi;;\nesac\nexit 1\n', "utf-8")
        fake.chmod(0o755)
        generate(opus_ogg, "libopus", 220)
        before = reset_document()
        convert(ffmpeg=str(fake), expect=1)
        assert document.read_bytes() == before
        passed.append("FFmpeg conversion failure leaves entire JSON batch unchanged")
        convert()
        document.write_text(json.dumps({"wrong_suffix": "/audio/aa/copied.opus"}), "utf-8")
        assert check(public, ui, binary, 2, [])["status"] == "failed"
        passed.append("checker rejects .opus runtime reference even if bytes contain MP3")
        reset_document()
        convert()
        shutil.copyfile(opus_ogg, opus_ogg.with_suffix(".mp3"))
        assert check(public, ui, binary, 2, [])["status"] == "failed"
        passed.append("checker rejects Ogg renamed to .mp3")
        opus_ogg.with_suffix(".mp3").unlink()
        assert check(public, ui, binary, 2, [])["status"] == "failed"
        passed.append("checker rejects missing final MP3")
    for description in passed:
        print(f"PASS {description}")
    print(f"{len(passed)} web audio fixture scenarios passed; no repository audio/data changed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-root", type=Path, default=DEFAULT_PUBLIC)
    parser.add_argument("--ui-audio", type=Path, default=DEFAULT_UI)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--decode-samples", type=int, default=12, help="Deterministic sample target, plus mandatory categories")
    parser.add_argument("--sample", action="append", default=[], help="Additional actual audio URL to fully decode")
    parser.add_argument("--report", type=Path, default=ROOT / "deploy-output/web-audio-compat-report.json")
    parser.add_argument("--self-test", action="store_true", help="Run isolated real-codec fixtures only")
    args = parser.parse_args()
    if args.decode_samples < 1:
        parser.error("--decode-samples must be at least 1")
    try:
        if args.self_test:
            return self_test()
        result = check(args.public_root.resolve(), args.ui_audio.resolve(), args.ffmpeg, args.decode_samples, args.sample)
    except (AudioBuildError, OSError, ValueError, subprocess.SubprocessError) as exc:
        result = {"status": "failed", "errors": [{"reason": str(exc)}]}
    atomic_json(args.report, result)
    print(f"[web-audio-compat] {result['status']}: {result.get('reference_count', 0)} references, "
          f"{result.get('unique_assets', 0)} unique assets, {len(result['errors'])} errors; report: {args.report}")
    for error in result["errors"][:8]:
        print(f"  {error.get('url', '')}: {error['reason']}")
    for sample in result.get("decoder_samples", []):
        print(f"  decode {sample['category']}: {sample['url']} — {sample.get('result', 'not_run')}")
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
