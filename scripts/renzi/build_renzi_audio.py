#!/usr/bin/env python3
"""把认字科目的朗读音频落到本地：拼音音节走真人录音，题干/讲解走统一 AI 女声。

  python3 scripts/renzi/build_renzi_audio.py syllables   # 588 个音节 mp3
  python3 scripts/renzi/build_renzi_audio.py texts       # 题干 + 讲解（sha1 寻址）
  python3 scripts/renzi/build_renzi_audio.py all

音节优先用 refresh_pinyin_index.py 解析出的 Commons / Lingua Libre 真人录音
（转码为 24k 单声道 mp3），没有真人源的音节用 edge-tts 晓伊合成同一音色兜底。
题干与讲解按 sha1(规范化原文) 落成 audio/<xx>/<hash>.mp3，因此文件名与
build-data.ts 的 audioFor() 完全对齐；正文里出现的拼音串会先换成同音汉字再合成，
否则 TTS 会把 tiān 按英文字母念。

依赖：ffmpeg，pip install pypinyin edge-tts；构建期需联网，产物落地后前端完全离线。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import renzi_audio_lib as L  # noqa: E402

SOURCES = HERE / "audio" / "pinyin-sources.json"
CREDITS = L.PINYIN_DIR / "CREDITS.json"
MIN_BYTES = 700
MAX_SECONDS = 14.0
FFMPEG_FILTER = (
    "silenceremove=start_periods=1:start_duration=0.03:start_threshold=-45dB,"
    "loudnorm=I=-16:TP=-1.5:LRA=11"
)


def sh(cmd: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def probe(path: Path) -> tuple[float, int]:
    out = sh(["ffprobe", "-v", "error", "-show_entries", "format=duration",
              "-of", "csv=p=0", str(path)]).stdout.strip()
    try:
        return float(out), path.stat().st_size
    except ValueError:
        return -1.0, path.stat().st_size if path.exists() else 0


def check(path: Path) -> tuple[bool, str]:
    if not path.exists() or path.stat().st_size < MIN_BYTES:
        return False, "missing/too-small"
    dur, size = probe(path)
    if dur <= 0:
        return False, "unreadable"
    if not (0.12 <= dur <= MAX_SECONDS):
        return False, f"duration={dur:.2f}s"
    return True, f"{dur:.2f}s {size}B"


GATE = threading.Lock()
_slot = [0.0]
MIN_INTERVAL = 1.2  # --min-interval 覆盖；Wikimedia 按出口 IP 限流
# 命中限流就不再骚扰对方：本轮全部走 AI，稍后用 --retry-human 补真人音
THROTTLED = threading.Event()


def _gate() -> None:
    with GATE:
        now = time.monotonic()
        wait = max(0.0, _slot[0] - now)
        _slot[0] = now + wait + MIN_INTERVAL
    if wait:
        time.sleep(wait)


def download(url: str, dest: Path, tries: int = 5) -> str | None:
    """成功返回 None，失败返回原因。429 退避重试，404 直接放弃。"""
    last = "unknown"
    for i in range(tries):
        _gate()
        try:
            with L.urlopen(url, timeout=40) as r, open(dest, "wb") as f:
                shutil.copyfileobj(r, f)
            if dest.stat().st_size > MIN_BYTES:
                return None
            last = "too-small"
        except urllib.error.HTTPError as e:
            last = f"http {e.code}"
            if e.code == 404:
                return last
            if e.code == 429:
                if THROTTLED.is_set():
                    return last
                THROTTLED.set()
                ra = e.headers.get("Retry-After")
                time.sleep(min(30, int(ra) if (ra or "").isdigit() else 8))
                continue
        except Exception as e:
            last = type(e).__name__
        time.sleep(2 * (i + 1))
    return last


def ffmpeg_to(src: Path, dest: Path, *, normalize: bool) -> bool:
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src)]
    if normalize:
        cmd += ["-af", FFMPEG_FILTER]
    cmd += ["-ar", "24000", "-ac", "1", "-b:a", "64k", str(dest)]
    r = sh(cmd, timeout=120)
    return r.returncode == 0 and dest.exists() and dest.stat().st_size > MIN_BYTES


def transcode(src: Path, dest: Path) -> bool:
    # loudnorm 对极短样本偶尔失败：退回不做响度归一的转码
    return ffmpeg_to(src, dest, normalize=True) or ffmpeg_to(src, dest, normalize=False)


async def synth(text: str, dest: Path, voice: str, sem: asyncio.Semaphore, tries: int = 4) -> tuple[bool, str]:
    import edge_tts

    for i in range(tries):
        async with sem:
            try:
                tmp = dest.with_suffix(".part")
                await edge_tts.Communicate(text, voice).save(str(tmp))
                if tmp.stat().st_size < MIN_BYTES:
                    raise RuntimeError(f"empty output {tmp.stat().st_size}B")
                tmp.replace(dest)
                return True, ""
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
        await asyncio.sleep(1.5 * (i + 1))
    return False, err


def run_async(coro):
    return asyncio.run(coro)


async def synth_many(items: list[tuple[str, str, Path]], voice: str, workers: int) -> int:
    """items: (id, 要念的文本, 目标路径)。返回失败数。"""
    sem = asyncio.Semaphore(workers)
    done = fails = skipped = 0
    todo = []
    for key, text, dest in items:
        if dest.exists() and dest.stat().st_size > MIN_BYTES:
            skipped += 1
            continue
        todo.append((key, text, dest))
    print(f"待合成 {len(todo)}，已存在跳过 {skipped}")

    async def one(key: str, text: str, dest: Path):
        nonlocal done, fails
        dest.parent.mkdir(parents=True, exist_ok=True)
        ok, err = await synth(text, dest, voice, sem)
        if ok:
            good, info = check(dest)
            if good:
                done += 1
            else:
                dest.unlink(missing_ok=True)
                fails += 1
                print(f"  ✗ {key} 合成结果异常: {info}")
        else:
            fails += 1
            if fails <= 12:
                print(f"  ✗ {key} {err[:90]}")
        if (done + fails) % 200 == 0 and (done + fails):
            print(f"  … {done + fails}/{len(todo)} ok={done} fail={fails}", flush=True)

    await asyncio.gather(*(one(*it) for it in todo))
    print(f"合成完成 ok={done} fail={fails} skip={skipped}")
    return fails


# ---------------------------------------------------------------- syllables

RAW_DIR = HERE / "audio" / "raw"  # 原始下载缓存：断点续跑用，不进 public/


def fetch_human(key: str, src: dict, force: bool) -> tuple[bool, str]:
    """下载 + 转码一个真人音节，成功即落 audio/pinyin/{key}.mp3。"""
    dest = L.PINYIN_DIR / f"{key}.mp3"
    if dest.exists() and dest.stat().st_size > MIN_BYTES and not force:
        return True, "exists"
    if THROTTLED.is_set():
        return False, "对方限流"
    dest.unlink(missing_ok=True)
    raw = RAW_DIR / (key + Path(src["url"].split("?")[0]).suffix)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if not (raw.exists() and raw.stat().st_size > MIN_BYTES):
        err = download(src["url"], raw)
        if err:
            raw.unlink(missing_ok=True)
            return False, f"下载失败 {err}"
    if not transcode(raw, dest):
        raw.unlink(missing_ok=True)
        return False, "转码失败"
    ok, info = check(dest)
    if not ok:
        dest.unlink(missing_ok=True)
        raw.unlink(missing_ok=True)
        return False, f"校验失败 {info}"
    raw.unlink(missing_ok=True)  # 缓存只服务失败的续跑，成功就落 mp3
    return True, info


def stage_syllables(args) -> int:
    global MIN_INTERVAL
    MIN_INTERVAL = args.min_interval
    data = L.load_json(SOURCES)
    sources: dict = data["sources"]
    voice = data.get("ai_voice", "zh-CN-XiaoyiNeural")
    L.PINYIN_DIR.mkdir(parents=True, exist_ok=True)
    need = L.needed_syllable_keys()
    credits: dict[str, dict] = {}
    if CREDITS.exists():
        credits = json.loads(CREDITS.read_text(encoding="utf8")).get("items", {})

    if args.retry_human:
        for key, c in credits.items():
            if c.get("kind") == "ai" and c.get("pending_human"):
                (L.PINYIN_DIR / f"{key}.mp3").unlink(missing_ok=True)

    def ai_job(key: str) -> tuple[str, str, Path] | None:
        ch = L.homophone_char(key, set())
        return None if ch is None else (key, ch, L.PINYIN_DIR / f"{key}.mp3")

    ai_jobs: list[tuple[str, str, Path]] = []
    todo: list[tuple[str, dict]] = []
    for key in need:
        src = sources.get(key) or {"kind": "ai"}
        if src["kind"] == "ai":
            j = ai_job(key)
            if j:
                ai_jobs.append(j)
            else:
                print(f"  ✗ {key} 无替换字，跳过")
        else:
            todo.append((key, src))
    if args.limit:
        todo = todo[: args.limit]

    done = human_ok = 0
    pending: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch_human, k, s, args.force): (k, s) for k, s in todo}
        for fu in as_completed(futs):
            key, src = futs[fu]
            ok, info = fu.result()
            done += 1
            if ok:
                human_ok += 1
                if info == "exists":
                    # 文件是上一轮留下的（可能是 AI 兜底），不能据此声称拿到了真人音
                    continue
                credits[key] = {"title": src["title"], "artist": src.get("artist", ""),
                                "license": src.get("license", ""), "url": src["url"],
                                "kind": src["kind"]}
            else:
                print(f"  ✗ {key} {info}（{src['title']}）→ 转 AI，待 --retry-human 升级")
                pending[key] = {"title": src["title"], "url": src["url"]}
                j = ai_job(key)
                if j:
                    ai_jobs.append(j)
            if done % 50 == 0:
                print(f"  真人 {done}/{len(todo)} ok={human_ok}", flush=True)
    print(f"真人音节 {human_ok}/{len(todo)}，AI 补 {len(ai_jobs)} 条")
    if THROTTLED.is_set():
        print("  ! Wikimedia 按出口 IP 限流，本轮未取真人音；"
              f"稍后重跑 python3 {Path(__file__).name} syllables --retry-human 可升级为真人")

    if ai_jobs:
        for key, _t, _d in ai_jobs:
            credits.pop(key, None)
        run_async(synth_many(ai_jobs, voice, args.workers))
        for key, text, _ in ai_jobs:
            if (L.PINYIN_DIR / f"{key}.mp3").exists():
                credits[key] = {"title": f"edge-tts {voice}（同音字「{text}」）",
                                "artist": "Microsoft Edge TTS",
                                "license": "在线服务条款，仅限本机/局域网自用",
                                "url": "", "kind": "ai"}
                if pending.get(key):
                    credits[key]["pending_human"] = pending[key]

    CREDITS.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "真人音频来自 Wikimedia Commons / Lingua Libre，版权归原作者，"
                "多为 CC BY 2.0 / CC BY-SA 3.0/4.0；本包仅用于家庭与局域网教学，不公开分发。",
        "items": dict(sorted(credits.items())),
    }, ensure_ascii=False, indent=1), encoding="utf8")
    return 0


# ---------------------------------------------------------------- texts

def stage_texts(args) -> int:
    data = L.load_json(SOURCES, {"ai_voice": "zh-CN-XiaoyiNeural"})
    voice = data.get("ai_voice", "zh-CN-XiaoyiNeural")
    plan = L.needed_texts()
    items: list[tuple[str, str, Path]] = []
    stale = 0
    for rel, (orig, speak) in sorted(plan.items()):
        dest = L.AUDIO_ROOT / rel
        if dest.exists() and dest.stat().st_size > MIN_BYTES and not args.force:
            stale += 1
            continue
        if not speak.strip():
            continue
        items.append((rel, speak, dest))
    print(f"题干/讲解文本 {len(plan)} 条：已生成 {stale}，待合成 {len(items)}")
    if args.limit:
        items = items[: args.limit]
    if not items:
        return 0
    return run_async(synth_many(items, voice, args.workers))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", nargs="?", default="all", choices=["syllables", "texts", "all"])
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true", help="重跑覆盖已有音频")
    ap.add_argument("--min-interval", type=float, default=1.2,
                    help="相邻请求最小间隔秒数（Wikimedia 按出口 IP 限流）")
    ap.add_argument("--retry-human", action="store_true",
                    help="重下此前限流失败、已用 AI 顶上的音节（CREDITS 里带 pending_human 的）")
    args = ap.parse_args()
    if shutil.which("ffmpeg") is None:
        raise SystemExit("需要 ffmpeg")
    rc = 0
    if args.stage in ("syllables", "all"):
        rc |= stage_syllables(args)
    if args.stage in ("texts", "all"):
        rc |= stage_texts(args)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
