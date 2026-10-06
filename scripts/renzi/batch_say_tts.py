#!/usr/bin/env python3
"""用 macOS `say` 离线批量合成认字（及其他缺失）TTS，写入 apps/web/public/audio。

与 build-data 的内容寻址规则一致：
  normalize(text) = strip + 折叠空白
  path = public/audio/<sha1[:2]>/<sha1>.opus
实际容器与现网一致：MP3（libmp3lame 64k / 24kHz / mono），扩展名仍为 .opus。

用法：
  python3 scripts/renzi/batch_say_tts.py --subject renzi
  python3 scripts/renzi/batch_say_tts.py --subject renzi --workers 6 --limit 200
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "output"
AUDIO_ROOT = ROOT / "apps" / "web" / "public" / "audio"

# 低龄优先用婷婷（大陆普通话）
VOICE = os.environ.get("RENZI_SAY_VOICE", "Tingting (Chinese (China mainland))")
HAN_RE = re.compile(r"[一-鿿]")
LATIN_RE = re.compile(r"[A-Za-z]")

TONE_MAP = {
    "ā": "a", "á": "a", "ǎ": "a", "à": "a",
    "ē": "e", "é": "e", "ě": "e", "è": "e",
    "ī": "i", "í": "i", "ǐ": "i", "ì": "i",
    "ō": "o", "ó": "o", "ǒ": "o", "ò": "o",
    "ū": "u", "ú": "u", "ǔ": "u", "ù": "u",
    "ǖ": "v", "ǘ": "v", "ǚ": "v", "ǜ": "v", "ü": "v",
}
TONE_NUM = {
    "ā": "1", "á": "2", "ǎ": "3", "à": "4",
    "ē": "1", "é": "2", "ě": "3", "è": "4",
    "ī": "1", "í": "2", "ǐ": "3", "ì": "4",
    "ō": "1", "ó": "2", "ǒ": "3", "ò": "4",
    "ū": "1", "ú": "2", "ǔ": "3", "ù": "4",
    "ǖ": "1", "ǘ": "2", "ǚ": "3", "ǜ": "4",
}


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def text_hash(text: str) -> str:
    return hashlib.sha1(normalize(text).encode("utf-8")).hexdigest()


def is_speakable(text: str) -> bool:
    text = (text or "").strip()
    if not text or len(text) > 400:
        return False
    return bool(HAN_RE.search(text) or LATIN_RE.search(text) or any(c.isdigit() for c in text))


def to_say_text(text: str) -> str:
    """纯拼音选项交给 say 时，转成更稳的读法：tiān → tian 一声。"""
    t = normalize(text)
    if re.fullmatch(r"[a-zA-züÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+", t or ""):
        tone = ""
        base = ""
        for ch in t:
            if ch in TONE_MAP:
                base += TONE_MAP[ch]
                if not tone and ch in TONE_NUM:
                    tone = TONE_NUM[ch]
            else:
                base += ch.lower()
        label = {
            "1": "一声", "2": "二声", "3": "三声", "4": "四声",
        }.get(tone, "轻声")
        return f"读作 {' '.join(base)}. {label}"
    return t.replace("「", "").replace("」", "")


def collect_texts(subject: str | None) -> dict[str, str]:
    """hash -> original text（field 优先级覆盖）"""
    priority = {
        "question": 0,
        "option": 1,
        "explanation": 2,
        "kp_point": 3,
        "kp_core": 3,
        "kp_formula": 3,
        "kp_tips": 3,
        "kp_mistake": 4,
    }
    items: dict[str, tuple[int, str, str]] = {}  # hash -> (pr, field, text)

    subjects = [subject] if subject else sorted(p.name for p in OUTPUT_DIR.iterdir() if p.is_dir())
    for sid in subjects:
        quiz_dir = OUTPUT_DIR / sid / "quizzes"
        if not quiz_dir.exists():
            continue
        for fp in sorted(quiz_dir.glob("*.json")):
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"⚠️ parse {fp.name}: {e}", file=sys.stderr)
                continue

            def push(text: str, field: str):
                text = normalize(text or "")
                if not is_speakable(text):
                    return
                h = text_hash(text)
                pr = priority.get(field, 9)
                if h not in items or pr < items[h][0]:
                    items[h] = (pr, field, text)

            for section in ("unit_test", "exam"):
                qs = (data.get(section) or {}).get("questions") or []
                for q in qs:
                    push(q.get("question", ""), "question")
                    for opt in q.get("options") or []:
                        clean = re.sub(r"^[A-Da-d][.、]\s*", "", opt or "")
                        push(clean, "option")
                    push(q.get("explanation", ""), "explanation")
            for ks in data.get("knowledge_summary") or []:
                push(ks.get("point", ""), "kp_point")
                push(ks.get("core_concept", ""), "kp_core")
                push(ks.get("key_formula", ""), "kp_formula")
                push(ks.get("tips", ""), "kp_tips")
                for cm in ks.get("common_mistakes") or []:
                    push(cm, "kp_mistake")

    # 保留 field 信息，供排序；对外仍返回 hash->text
    collect_texts._meta = {h: (pr, field) for h, (pr, field, _t) in items.items()}  # type: ignore[attr-defined]
    return {h: text for h, (_pr, _f, text) in items.items()}


def synthesize_one(payload: tuple[str, str, str, str]) -> tuple[str, bool, str]:
    h, text, audio_root, voice = payload
    rel = f"{h[:2]}/{h}.opus"
    out = Path(audio_root) / rel
    if out.exists() and out.stat().st_size > 400:
        return rel, True, "exists"
    out.parent.mkdir(parents=True, exist_ok=True)
    say_text = to_say_text(text)
    with tempfile.TemporaryDirectory() as td:
        aiff = Path(td) / "t.aiff"
        mp3 = Path(td) / "t.mp3"
        r1 = subprocess.run(
            ["say", "-v", voice, "-o", str(aiff), say_text],
            capture_output=True,
            text=True,
        )
        if r1.returncode != 0 or not aiff.exists() or aiff.stat().st_size < 100:
            return rel, False, f"say fail: {r1.stderr.strip()[:120]}"
        r2 = subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(aiff),
                "-codec:a", "libmp3lame", "-b:a", "64k",
                "-ar", "24000", "-ac", "1",
                str(mp3),
            ],
            capture_output=True,
            text=True,
        )
        if r2.returncode != 0 or not mp3.exists() or mp3.stat().st_size < 200:
            return rel, False, f"ffmpeg fail: {r2.stderr.strip()[-120:]}"
        tmp_out = out.with_suffix(".opus.tmp")
        tmp_out.write_bytes(mp3.read_bytes())
        tmp_out.replace(out)
    return rel, True, "ok"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", default="renzi")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0, help="0=不限制")
    ap.add_argument("--voice", default=VOICE)
    ap.add_argument("--audio-root", default=str(AUDIO_ROOT))
    ap.add_argument(
        "--fields",
        default="question,option,explanation,kp_point,kp_core,kp_formula,kp_tips,kp_mistake",
        help="只合成指定 field，逗号分隔",
    )
    args = ap.parse_args()

    texts = collect_texts(args.subject)
    meta: dict[str, tuple[int, str]] = getattr(collect_texts, "_meta", {})
    wanted_fields = {f.strip() for f in args.fields.split(",") if f.strip()}

    missing: list[tuple[str, str, int, str]] = []
    for h, text in texts.items():
        pr, field = meta.get(h, (9, "other"))
        if field not in wanted_fields:
            continue
        rel = f"{h[:2]}/{h}.opus"
        p = Path(args.audio_root) / rel
        if not (p.exists() and p.stat().st_size > 400):
            missing.append((h, text, pr, field))

    # 严格按 field 优先级：question → option → explanation → knowledge
    missing.sort(key=lambda x: (x[2], len(x[1])))
    if args.limit > 0:
        missing = missing[: args.limit]

    print(f"学科={args.subject} 可读文本={len(texts)} 待合成={len(missing)}")
    print(f"音色={args.voice}")
    print(f"输出={args.audio_root}")
    if not missing:
        print("无需合成")
        return 0

    ok = fail = exists = 0
    payloads = [(h, text, args.audio_root, args.voice) for h, text, _pr, _f in missing]
    with ProcessPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futs = [ex.submit(synthesize_one, p) for p in payloads]
        for i, fut in enumerate(as_completed(futs), 1):
            rel, success, msg = fut.result()
            if msg == "exists":
                exists += 1
            elif success:
                ok += 1
            else:
                fail += 1
                if fail <= 8:
                    print(f"  ✗ {rel} {msg}")
            if i % 200 == 0 or i == len(futs):
                print(f"  进度 {i}/{len(futs)} ok={ok} exists={exists} fail={fail}")

    print(f"完成: ok={ok} exists={exists} fail={fail}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
