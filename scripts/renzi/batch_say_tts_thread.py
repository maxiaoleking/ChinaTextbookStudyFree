#!/usr/bin/env python3
"""线程池版 say TTS 批量合成（比 ProcessPool 更稳，适合 macOS say + ffmpeg）。"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from batch_say_tts import (  # noqa: E402
    AUDIO_ROOT,
    VOICE,
    collect_texts,
    synthesize_one,
    text_hash,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", default="renzi")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--voice", default=VOICE)
    ap.add_argument("--audio-root", default=str(AUDIO_ROOT))
    ap.add_argument(
        "--fields",
        default="question,option,explanation,kp_point,kp_core,kp_formula,kp_tips,kp_mistake",
    )
    args = ap.parse_args()

    texts = collect_texts(args.subject)
    meta = getattr(collect_texts, "_meta", {})
    wanted = {f.strip() for f in args.fields.split(",") if f.strip()}

    missing = []
    for h, text in texts.items():
        pr, field = meta.get(h, (9, "other"))
        if field not in wanted:
            continue
        rel = f"{h[:2]}/{h}.opus"
        p = Path(args.audio_root) / rel
        if not (p.exists() and p.stat().st_size > 400):
            missing.append((h, text, pr, field))
    missing.sort(key=lambda x: (x[2], len(x[1])))
    if args.limit:
        missing = missing[: args.limit]

    print(f"待合成={len(missing)} workers={args.workers} voice={args.voice}")
    if not missing:
        print("无需合成")
        return 0

    ok = fail = exists = 0
    payloads = [(h, t, args.audio_root, args.voice) for h, t, _p, _f in missing]
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futs = [ex.submit(synthesize_one, p) for p in payloads]
        for i, fut in enumerate(as_completed(futs), 1):
            rel, success, msg = fut.result()
            if msg == "exists":
                exists += 1
            elif success:
                ok += 1
            else:
                fail += 1
                if fail <= 5:
                    print(f"  ✗ {rel} {msg}", flush=True)
            if i % 100 == 0 or i == len(futs):
                print(f"  进度 {i}/{len(futs)} ok={ok} exists={exists} fail={fail}", flush=True)

    print(f"完成: ok={ok} exists={exists} fail={fail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
