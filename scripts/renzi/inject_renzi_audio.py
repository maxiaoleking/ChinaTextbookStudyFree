#!/usr/bin/env python3
"""把本地朗读音频路径写进认字题库 JSON。

音源来自 build_renzi_audio.py 的产物，只写磁盘上确实存在的文件：
  - 拼音选项      → /audio/pinyin/{key}.mp3（真人音节，缺真人时同音色 AI）
  - 汉字选项      → 同一条音节镜像（按生字表读音；答案项优先用题干给的拼音）
  - 题干 / 解析   → /audio/<sha1 前两位>/<sha1>.mp3（按可朗读改写文本合成）

缺文件就留空而不是注入 404；build-data.ts 的 decorateQuestion 只补空槽，
不会覆盖这里写好的路径。改过字表或重跑生成器后需要再跑一次本脚本。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import renzi_audio_lib as L  # noqa: E402

OPT_PREFIX = re.compile(r"^[A-Da-d][.、]\s*")
HAN = re.compile(r"^[一-鿿]$")


def _has(rel: str) -> str | None:
    return rel if (L.AUDIO_ROOT / rel.removeprefix("/audio/")).exists() else None


def pinyin_audio(key: str | None) -> str | None:
    return _has(f"/audio/pinyin/{key}.mp3") if key else None


def content_audio(text: str) -> str | None:
    t = L.normalize_text(text)
    return _has("/audio/" + L.content_audio_rel(t)) if t else None


def stem_pinyin_key(question: str) -> str | None:
    m = re.search(rf"拼音「({L.PY_TOKEN})」", question or "")
    return L.to_key(m.group(1)) if m else None


def option_audio(opt: str, *, stem_key: str | None, answer: str | None) -> str | None:
    body = OPT_PREFIX.sub("", opt or "").strip()
    if not body:
        return None
    if L.is_pinyin(body):
        return pinyin_audio(L.to_key(body))
    if HAN.match(body):
        keys: list[str | None] = []
        if stem_key and answer and body == answer.strip():
            keys.append(stem_key)
        default = L.default_reading().get(body)
        keys += [default] + list(L.char_readings().get(body, []))
        for k in keys:
            got = pinyin_audio(k)
            if got:
                return got
    return content_audio(body)


def decorate(q: dict) -> tuple[int, int]:
    """返回 (写入槽位数, 可注入槽位总数)。"""
    stem = q.get("question") or ""
    expl = q.get("explanation") or ""
    key = stem_pinyin_key(stem)
    out: dict = {}
    have = total = 0

    qa = content_audio(stem)
    total += 1 if stem.strip() else 0
    have += 1 if qa else 0
    if qa:
        out["question"] = qa

    opts = q.get("options") or []
    if opts:
        slots = [option_audio(o, stem_key=key, answer=q.get("answer")) for o in opts]
        total += len(opts)
        have += sum(1 for s in slots if s)
        if any(slots):
            out["options"] = slots

    ea = content_audio(expl)
    total += 1 if expl.strip() else 0
    have += 1 if ea else 0
    if ea:
        out["explanation"] = ea

    if out:
        q["audio"] = out
    else:
        q.pop("audio", None)
    return have, total


def main() -> int:
    files = sorted(L.QUIZ_DIR.glob("*.json"))
    if not files:
        raise SystemExit(f"{L.QUIZ_DIR} 下没有题库，先跑 generate_renzi_data.py")
    have = total = changed = 0
    for fp in files:
        data = json.loads(fp.read_text(encoding="utf-8"))
        for section in ("unit_test", "exam"):
            for q in (data.get(section) or {}).get("questions") or []:
                h, t = decorate(q)
                have += h
                total += t
        text = json.dumps(data, ensure_ascii=False, indent=2)  # 与生成器同款写法，不留尾换行
        if fp.read_text(encoding="utf-8") != text:
            fp.write_text(text, encoding="utf-8")
            changed += 1
    print(f"题库 {len(files)} 个文件（改写 {changed}），音频槽位 {have}/{total} 已注入本地路径")
    if have < total:
        print("  缺口通常是音频还没生成：跑 build_renzi_audio.py texts / syllables 后重跑本脚本")
    return 0 if have == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
