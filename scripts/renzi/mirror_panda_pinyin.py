#!/usr/bin/env python3
"""从 Panda Learn Chinese 的 Polly 接口镜像认字题库用到的拼音发音。

站点模式（见其 /pinyin 页脚本）：
  字母/声母静态文件: /sites/default/files/pinyin/audio/{letter}.mp3
  汉字/音节在线合成: /polly/speak/{urlencoded text}  → audio/mpeg

本脚本把题库中出现的拼音音节下载为本地文件：
  apps/web/public/audio/pinyin/{ascii_tone_key}.mp3
例如 tiān → tian1.mp3，wǒ → wo3.mp3，de → de0.mp3

仅用于聪聪学堂本机/局域网家庭教学的离线缓存；版权归原站点与 Polly 服务方，
勿将本目录公开分发。
"""

from __future__ import annotations

import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUIZ_DIR = ROOT / "output" / "renzi" / "quizzes"
OUT_DIR = ROOT / "apps" / "web" / "public" / "audio" / "pinyin"
POLLY = "https://www.pandalearnchinese.com/polly/speak/"
UA = "Mozilla/5.0 (compatible; CongCongXueTang/1.0; home-lab offline mirror)"

TONE_MAP = {
    "ā": ("a", 1), "á": ("a", 2), "ǎ": ("a", 3), "à": ("a", 4),
    "ē": ("e", 1), "é": ("e", 2), "ě": ("e", 3), "è": ("e", 4),
    "ī": ("i", 1), "í": ("i", 2), "ǐ": ("i", 3), "ì": ("i", 4),
    "ō": ("o", 1), "ó": ("o", 2), "ǒ": ("o", 3), "ò": ("o", 4),
    "ū": ("u", 1), "ú": ("u", 2), "ǔ": ("u", 3), "ù": ("u", 4),
    "ǖ": ("v", 1), "ǘ": ("v", 2), "ǚ": ("v", 3), "ǜ": ("v", 4),
    "ü": ("v", 0),
}
TONED = set(TONE_MAP)
PINYIN_RE = re.compile(r"^[a-zA-ZüÜ" + re.escape("".join(TONED)) + r"]+$")


def to_key(py: str) -> str:
    """tiān → tian1；de → de0；lü → lv0"""
    t = py.strip()
    tone = 0
    base = []
    for ch in t:
        if ch in TONE_MAP:
            b, n = TONE_MAP[ch]
            base.append(b)
            if n:
                tone = n
        else:
            base.append(ch.lower())
    return "".join(base) + str(tone)


def collect_pinyin() -> set[str]:
    out: set[str] = set()
    for fp in QUIZ_DIR.glob("*.json"):
        import json
        data = json.loads(fp.read_text(encoding="utf-8"))
        for sec in ("unit_test", "exam"):
            for q in (data.get(sec) or {}).get("questions") or []:
                for opt in q.get("options") or []:
                    o = re.sub(r"^[A-Da-d][.、]\s*", "", opt or "").strip()
                    if o and PINYIN_RE.match(o):
                        out.add(o)
                ans = (q.get("answer") or "").strip()
                if ans and PINYIN_RE.match(ans):
                    out.add(ans)
    return out


def download(py: str, ctx: ssl.SSLContext) -> tuple[str, bool, str]:
    key = to_key(py)
    dest = OUT_DIR / f"{key}.mp3"
    if dest.exists() and dest.stat().st_size > 400:
        return key, True, "exists"
    url = POLLY + urllib.parse.quote(py)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "audio/mpeg,*/*"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
            data = r.read()
            ctype = r.headers.get("Content-Type", "")
    except Exception as e:
        return key, False, f"{e}"
    if len(data) < 400 or not (data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2") or b"mp3" in ctype or "mpeg" in ctype or "audio" in ctype):
        # still accept if reasonably large audio
        if len(data) < 400:
            return key, False, f"short/bad type={ctype} n={len(data)}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".mp3.tmp")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return key, True, f"ok {len(data)}"


def main() -> int:
    ctx = ssl._create_unverified_context()
    pys = sorted(collect_pinyin())
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"pinyin syllables={len(pys)} out={OUT_DIR}")
    ok = fail = exists = 0
    for i, py in enumerate(pys, 1):
        key, success, msg = download(py, ctx)
        if msg == "exists":
            exists += 1
        elif success:
            ok += 1
        else:
            fail += 1
            if fail <= 8:
                print(f"  ✗ {py} ({key}) {msg}")
        if i % 50 == 0 or i == len(pys):
            print(f"  {i}/{len(pys)} ok={ok} exists={exists} fail={fail}", flush=True)
        time.sleep(0.05)  # 对方站点友好限速
    print(f"done ok={ok} exists={exists} fail={fail}")
    # 打样
    for sample in ["tiān", "dì", "wǒ", "nǐ", "rén", "de"]:
        k = to_key(sample)
        p = OUT_DIR / f"{k}.mp3"
        print(f"  sample {sample} -> {p.name} {'OK' if p.exists() and p.stat().st_size>400 else 'MISS'}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
