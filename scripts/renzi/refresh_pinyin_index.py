#!/usr/bin/env python3
"""解析 588 个拼音音节该用哪段真人录音，产出 audio/pinyin-sources.json。

音源优先级：
  1. Wikimedia Commons 上按拼音（带声调符号或数字调）命名的单音节录音，
     如 File:Zh-tiān.ogg、File:Zh-ma3.ogg —— 真人录制，CC BY / CC BY-SA 系；
  2. Lingua Libre 上传到 Commons 的单字录音 File:LL-Q9192 (cmn)-<说话人>-<字>.wav，
     取「读音正好等于该音节」的汉字（一个字的读音就是一个音节+声调，等价于音节录音）；
  3. 都没有 → 标记 kind=ai，由 build_renzi_audio.py 用 edge-tts 晓伊合成。

索引需要联网跑 Commons API（约 15 个请求）；结果落盘后 build 阶段可离线重放。
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import socket
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import renzi_audio_lib as L  # noqa: E402

API = "https://commons.wikimedia.org/w/api.php"
OUT = Path(__file__).resolve().parent / "audio" / "pinyin-sources.json"

PY_LETTERS = "a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ"
SYLLABLE_NAME = re.compile(rf"^File:Zh-([{PY_LETTERS}]+)([1-5]?)\.(ogg|oga|mp3|wav)$")
LL_SINGLE = re.compile(r"^File:LL-Q9192(?: \(cmn\))?[—-]([^-]+?)[—-](.+?)\.(wav|ogg)$")

# 明显不是人声的描述特征（Wiktionary 上有少量机器音档）
SYNTH_HINTS = re.compile(r"tts|text[- ]to[- ]speech|speech synth|espeak|festival|mbrola|机器|合成|自动语音", re.I)


def api(params: dict[str, str], retries: int = 5) -> dict:
    url = API + "?" + urllib.parse.urlencode(params)
    last: Exception | None = None
    for i in range(retries):
        try:
            with L.urlopen(url, timeout=45) as r:
                return json.loads(r.read())
        except Exception as e:  # 429/503/网络抖动都退避重试
            last = e
            time.sleep(4 * (i + 1))
    raise SystemExit(f"Commons API 连续失败：{last}")


def enum_titles(prefix: str, max_pages: int = 400) -> list[str]:
    out: list[str] = []
    cont: dict[str, str] = {}
    for _ in range(max_pages):
        params = {"action": "query", "list": "allimages", "aiprefix": prefix,
                  "ailimit": "500", "format": "json"}
        params.update(cont)
        r = api(params)
        out += [x["title"] for x in r["query"]["allimages"]]
        cont = r.get("continue", {})
        if not cont:
            break
        time.sleep(0.2)
    return out


def imageinfo(titles: list[str]) -> dict[str, dict]:
    """批量取 url / 授权 / 作者 / 描述。API 单请求上限 50 个 title。"""
    out: dict[str, dict] = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        r = api({"action": "query", "titles": "|".join(chunk), "prop": "imageinfo",
                 "iiprop": "url|size|mime|extmetadata", "format": "json",
                 "iiextmetadatafilter": "LicenseShortName|Artist|ImageDescription"})
        for p in r["query"]["pages"].values():
            if p.get("missing") is not None or "imageinfo" not in p:
                continue
            ii = p["imageinfo"][0]
            em = ii.get("extmetadata", {})

            def meta(key: str) -> str:
                return re.sub(r"<[^>]+>", "", em.get(key, {}).get("value", "")).strip()

            out[p["title"]] = {
                "url": ii["url"], "size": ii.get("size", 0), "mime": ii.get("mime", ""),
                "license": meta("LicenseShortName"), "artist": meta("Artist"),
                "description": meta("ImageDescription")[:300],
            }
        time.sleep(0.3)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline-titles", help="调试用：指向已缓存的标题列表文件前缀")
    args = ap.parse_args()

    need = L.needed_syllable_keys()
    print(f"题库需要音节 key: {len(need)}")

    zh_titles = enum_titles("Zh-")
    ll_titles = enum_titles("LL-Q9192")
    print(f"Commons 枚举：Zh-* {len(zh_titles)} 条，LL-Q9192* {len(ll_titles)} 条")

    by_key: dict[str, list[str]] = collections.defaultdict(list)
    for t in zh_titles:
        m = SYLLABLE_NAME.match(t)
        if not m:
            continue
        letters, digit = m.group(1), m.group(2)
        key = L.to_key(letters) if not digit else None
        if key is None and digit:
            base = letters.replace("ü", "v")
            if re.match(rf"^[{PY_LETTERS.replace('ü', 'v')}]+$", base):
                key = f"{base}{'0' if digit == '5' else digit}"
        if key:
            by_key[key].append(t)

    char_files: dict[str, list[str]] = collections.defaultdict(list)
    for t in ll_titles:
        m = LL_SINGLE.match(t)
        if m and len(m.group(2)) == 1 and "一" <= m.group(2) <= "鿿":
            char_files[m.group(2)].append(t)
    print(f"按音节命名 {len(by_key)} 个 key，单字录音 {len(char_files)} 个字")

    from pypinyin import Style, pinyin

    def char_key(ch: str) -> str | None:
        r = pinyin(ch, style=Style.TONE3)[0][0]
        m = re.match(r"^([a-zv]+)([1-4])$", r)
        return f"{m.group(1)}{m.group(2)}" if m else f"{r}0"

    sources: dict[str, dict] = {}
    for key in need:
        if by_key.get(key):
            sources[key] = {"kind": "commons", "title": sorted(by_key[key])[0]}
            continue
        # 找一个「默认读音就是这个音节」且本身单读的汉字
        hit_char = next((c for c in L.syllable_to_char().get(key, [])
                         if c in char_files and char_key(c) == key), None)
        if hit_char:
            sources[key] = {"kind": "lingualibre", "title": sorted(char_files[hit_char])[0],
                            "char": hit_char}
        else:
            sources[key] = {"kind": "ai"}

    titles = sorted({v["title"] for v in sources.values() if v.get("title")})
    info = imageinfo(titles)
    demoted = 0
    for key, val in sources.items():
        t = val.get("title")
        if not t:
            continue
        meta = info.get(t)
        if not meta:
            sources[key] = {"kind": "ai"}
            demoted += 1
            continue
        blob = f"{meta['description']} {meta['artist']}"
        if SYNTH_HINTS.search(blob):
            sources[key] = {"kind": "ai", "demoted_reason": f"元数据疑似合成音：{t}"}
            demoted += 1
            continue
        val.update(meta)
    human = sum(1 for v in sources.values() if v["kind"] in ("commons", "lingualibre"))
    print(f"真人命中 {human}/{len(need)}；走 AI {len(need) - human}（含 {demoted} 条因缺元数据或疑似合成音降级）")

    OUT.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ai_voice": "zh-CN-XiaoyiNeural",
        "note": "真人录音版权归 Commons 原作者，多为 CC BY / CC BY-SA，需随包署名（见 CREDITS.json）",
        "sources": sources,
    }, ensure_ascii=False, indent=1), encoding="utf8")
    print(f"写出 {OUT}")
    return 0


if __name__ == "__main__":
    socket.setdefaulttimeout(45)
    raise SystemExit(main())
