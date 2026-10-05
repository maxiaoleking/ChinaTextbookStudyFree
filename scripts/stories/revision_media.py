#!/usr/bin/env python3
"""Generate revision images with Muse and missing speech with Gemini, resumably.

Requires Pillow and ffmpeg. Writes new image IDs and content-addressed Opus files.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from content_api import ROOT, record, request, write_json
from content_audit import audio_path, read
from revise import STAGE, fingerprint, spoken_texts

IMAGE_MODEL = "meta/muse-image"
TTS_MODEL = "google/gemini-3.8-flash-lite-tts"
AUDIO = ROOT / "apps/web/public/audio"


def convert_audio(raw, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source.pcm"
        target = Path(tmp) / "target.opus"
        source.write_bytes(raw)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", str(source), "-vn", "-c:a", "libopus",
                        "-b:a", "48k", str(target)], check=True, capture_output=True)
        if not target.read_bytes().startswith(b"OggS"):
            raise ValueError("Invalid Opus container")
        # Same-filesystem atomic replacement, never expose a half-written audio file.
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".tmp", delete=False) as output:
            staging = Path(output.name)
            output.write(target.read_bytes())
        try:
            staging.replace(destination)
        finally:
            staging.unlink(missing_ok=True)


def synthesize(item):
    target = AUDIO / item["audio_rel"]
    if target.exists() and target.stat().st_size:
        return "cached audio"
    # A stable narrator per age band; sentence clips should not randomly change voice.
    voice = "Leda" if item.get("grade", 4) <= 2 else "Sulafat"
    body, headers = request("audio/speech", {"model": TTS_MODEL, "input": item["text"],
        "voice": voice, "response_format": "pcm"})
    content_type = next((v for k, v in headers.items() if k.lower() == "content-type"), "")
    if "audio/" not in content_type or len(body) < 100:
        raise ValueError(f"Unexpected TTS response: {content_type}")
    convert_audio(body, target)
    record({"model": TTS_MODEL, "voice": voice, "characters": len(item["text"]),
        "audio_rel": item["audio_rel"], "id": next((v for k, v in headers.items() if k.lower() == "x-generation-id"), None)})
    return f"audio {item['audio_rel']} ({voice})"


def image(saved, feedback=None):
    from PIL import Image
    story = saved["story"]
    target = ROOT / "apps/web/public/story-images" / story["bookId"] / f"{story['id']}.jpg"
    meta_path = STAGE / "images" / f"{story['id']}.json"
    digest = fingerprint(story)
    if not feedback and target.exists() and meta_path.exists() and read(meta_path).get("story_fingerprint") == digest:
        return f"cached image {story['id']}"
    prompt = (f"为中国小学{saved['job']['grade']}年级原创故事《{story['title']}》绘制一张高质量儿童文学插画。"
        "横向画幅，统一温暖自然的手绘质感。无任何文字、水印、拼音、字母、气泡，单一场景。"
        "低年级清楚友好，高年级自然写实一些，不用幼儿大头风格。尊重人物动作和物体空间关系。\n"
        + story["image_prompt"])
    if feedback:
        prompt += "\n上一版画面存在这些实质问题，请纠正并重新构图：" + json.dumps(feedback, ensure_ascii=False)
    # Editorial changes to a question need not purchase the same illustration again.
    if not feedback and target.exists() and target.stat().st_size and meta_path.exists():
        meta = read(meta_path)
        if meta.get("prompt") == prompt and meta.get("model") == IMAGE_MODEL:
            meta["story_fingerprint"] = digest
            write_json(meta_path, meta)
            return f"reused unchanged illustration {story['id']}"
    body, _ = request("images", {"model": IMAGE_MODEL, "prompt": prompt,
        "aspect_ratio": "3:2", "resolution": "1K", "output_format": "jpeg"})
    response = json.loads(body)
    record({"model": IMAGE_MODEL, "usage": response.get("usage", {})})
    images = response.get("data", [])
    if not images:
        raise ValueError("Muse 没有返回图片")
    raw = base64.b64decode(images[0]["b64_json"], validate=True)
    picture = Image.open(io.BytesIO(raw))
    picture.load()
    if min(picture.size) < 256:
        raise ValueError("生成图片分辨率过低")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        previous = read(meta_path).get("story_fingerprint", "unknown") if meta_path.exists() else "unknown"
        backup = STAGE / "history/images" / f"{story['id']}-{previous[:12]}.jpg"
        backup.parent.mkdir(parents=True, exist_ok=True)
        if not backup.exists():
            shutil.copy2(target, backup)
    temp = target.with_suffix(".tmp")
    picture.convert("RGB").save(temp, format="JPEG", quality=92)
    temp.replace(target)
    write_json(meta_path, {"model": IMAGE_MODEL, "prompt": prompt, "story_fingerprint": digest,
        "size": list(picture.size), "path": str(target)})
    return f"image {story['id']} {picture.size}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["images", "audio"])
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--include-audit", action="store_true")
    args = parser.parse_args()
    saved = []
    for path in sorted((STAGE / "stories").glob("*.json")):
        d = read(path)
        review_file = STAGE / "reviews" / path.name
        review = read(review_file) if review_file.exists() else {}
        if review.get("approved") and review.get("answers_verified") and not review.get("issues") and review.get("story_fingerprint") == fingerprint(d["story"]) and all(review.get(k, 0) >= 4 for k in ("literary_quality", "grade_fit", "question_quality")):
            saved.append(d)
        else:
            print(f"skip unapproved {path.stem}", flush=True)
    if args.command == "images":
        items, fn = saved, image
    else:
        unique = {}
        for d in saved:
            for text in spoken_texts(d["story"]):
                rel = audio_path(text)
                unique.setdefault(rel, {"text": text, "audio_rel": rel, "grade": d["job"]["grade"]})
        if args.include_audit:
            for item in read(ROOT / "docs/content-audit.json")["missing_audio"]:
                unique.setdefault(item["audio_rel"], item)
        items = [i for i in unique.values() if not (AUDIO / i["audio_rel"]).exists() or not (AUDIO / i["audio_rel"]).stat().st_size]
        write_json(STAGE / "audio-manifest.json", items)
        fn = synthesize
    print(f"{args.command}: {len(items)} tasks", flush=True)
    failed = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        for future in as_completed([executor.submit(fn, item) for item in items]):
            try:
                print(future.result(), flush=True)
            except Exception as e:
                failed.append(str(e))
                print(f"FAILED: {e}", flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
