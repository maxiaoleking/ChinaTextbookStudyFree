#!/usr/bin/env python3
"""给美国英语（ela）科目合成英文朗读音频，落到内容寻址的 audio/<xx>/<hash>.mp3。

  python3 scripts/ela/build_ela_audio.py            # 只补缺的
  python3 scripts/ela/build_ela_audio.py --force     # 全部重做
  python3 scripts/ela/build_ela_audio.py --limit 20  # 先试 20 条

文件名规则与 apps/web/scripts/build-data.ts 的 audioFor() 一致：
sha1(trim + 折叠空白) → audio/<前2位>/<hash>.mp3，所以合完只要重新 build 就能注入。

只处理纯 ASCII 文本（英文题干 / 选项 / 讲解）。knowledge_summary 等中文文案留给
系统中文语音朗读 —— apps/web/src/lib/tts.ts 的兜底固定用 zh-CN，
所以英文文本必须在这里有本地音频，否则会被读成中文。

依赖：pip install edge-tts；构建期需联网，产物落地后前端完全离线。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUIZ_DIR = ROOT / "output" / "ela" / "quizzes"
AUDIO_ROOT = ROOT / "apps" / "web" / "public" / "audio"
VOICE = "en-US-JennyNeural"
RATE = "-10%"
MIN_BYTES = 700
MAX_SECONDS = 30.0
OPTION_PREFIX_RE = re.compile(r"^[A-Da-d][.、]\s*")


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def text_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def dest_for(text: str) -> Path:
    h = text_hash(text)
    return AUDIO_ROOT / h[:2] / f"{h}.mp3"


def needed_texts() -> dict[str, str]:
    """返回 {规范化文本: 出现位置示例}，只收纯英文条目。"""
    out: dict[str, str] = {}

    def take(field: str, raw: str | None) -> None:
        if not raw:
            return
        norm = normalize(raw)
        if not norm or not norm.isascii():
            return
        out.setdefault(norm, field)

    for fp in sorted(QUIZ_DIR.glob("*.json")):
        data = json.loads(fp.read_text(encoding="utf-8"))
        for section in ("unit_test", "exam"):
            for q in data.get(section, {}).get("questions", []):
                take("question", q.get("question"))
                take("explanation", q.get("explanation"))
                for opt in q.get("options") or []:
                    take("option", OPTION_PREFIX_RE.sub("", opt))
    return out


def probe(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return -1.0


def check(path: Path) -> tuple[bool, str]:
    if not path.exists() or path.stat().st_size < MIN_BYTES:
        return False, "missing/too-small"
    dur = probe(path)
    if not (0.1 <= dur <= MAX_SECONDS):
        return False, f"duration={dur:.2f}s"
    return True, f"{dur:.2f}s {path.stat().st_size}B"


async def synth(text: str, dest: Path, sem: asyncio.Semaphore, tries: int = 4) -> tuple[bool, str]:
    import edge_tts

    for i in range(tries):
        async with sem:
            try:
                tmp = dest.with_suffix(".part")
                await edge_tts.Communicate(text, VOICE, rate=RATE).save(str(tmp))
                if tmp.stat().st_size < MIN_BYTES:
                    raise RuntimeError(f"empty output {tmp.stat().st_size}B")
                tmp.replace(dest)
                return True, ""
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
        await asyncio.sleep(1.5 * (i + 1))
    return False, err


async def run(items: list[tuple[str, Path]], workers: int) -> int:
    sem = asyncio.Semaphore(workers)
    done = fails = 0

    async def one(text: str, dest: Path) -> None:
        nonlocal done, fails
        dest.parent.mkdir(parents=True, exist_ok=True)
        ok, err = await synth(text, dest, sem)
        if not ok:
            fails += 1
            print(f"  ✗ {text[:60]!r} {err}")
            return
        good, info = check(dest)
        if good:
            done += 1
        else:
            dest.unlink(missing_ok=True)
            fails += 1
            print(f"  ✗ {text[:60]!r} 质检不过: {info}")

    await asyncio.gather(*(asyncio.create_task(one(t, d)) for t, d in items))
    print(f"成功 {done} 失败 {fails}")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true", help="重跑覆盖已有音频")
    ap.add_argument("--check-only", action="store_true", help="只报告缺失，不合成")
    args = ap.parse_args()

    plan = needed_texts()
    todo: list[tuple[str, Path]] = []
    stale = 0
    for text in sorted(plan):
        dest = dest_for(text)
        if dest.exists() and dest.stat().st_size > MIN_BYTES and not args.force:
            stale += 1
            continue
        todo.append((text, dest))
    print(f"英文文本 {len(plan)} 条：已有 {stale}，待合成 {len(todo)}")
    if args.check_only:
        for text, dest in todo[:40]:
            print("  缺:", text[:70])
        return 0
    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        return 0
    return asyncio.run(run(todo, args.workers))


if __name__ == "__main__":
    raise SystemExit(main())
