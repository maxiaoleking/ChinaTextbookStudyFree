#!/usr/bin/env python3
"""认字音频公用件：拼音 key 归一、生字表读取、可朗读文本转换、内容寻址路径。

被 refresh_pinyin_index.py / build_renzi_audio.py / audit_renzi_data.py 共用。

可朗读文本转换（to_speakable）解决两类读错：
  1. 拼音串（tiān）直接喂 TTS 会被按拉丁字母念 → 换成同音单读汉字；
  2. 多音字目标字（乐 yuè）在「X」的正确读音是 这种孤句里会被念成常用音 →
     改成「这个字」，靠屏幕上已显示的字与提示词承载。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import ssl
import sys
import urllib.parse
import urllib.request
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
QUIZ_DIR = REPO_ROOT / "output" / "renzi" / "quizzes"
OUTLINE_DIR = REPO_ROOT / "output" / "renzi" / "outlines"
AUDIO_ROOT = REPO_ROOT / "apps" / "web" / "public" / "audio"
PINYIN_DIR = AUDIO_ROOT / "pinyin"
GEN_PY = REPO_ROOT / "scripts" / "renzi" / "generate_renzi_data.py"

TONE_MAP = {
    "ā": ("a", 1), "á": ("a", 2), "ǎ": ("a", 3), "à": ("a", 4),
    "ē": ("e", 1), "é": ("e", 2), "ě": ("e", 3), "è": ("e", 4),
    "ī": ("i", 1), "í": ("i", 2), "ǐ": ("i", 3), "ì": ("i", 4),
    "ō": ("o", 1), "ó": ("o", 2), "ǒ": ("o", 3), "ò": ("o", 4),
    "ū": ("u", 1), "ú": ("u", 2), "ǔ": ("u", 3), "ù": ("u", 4),
    "ǖ": ("v", 1), "ǘ": ("v", 2), "ǚ": ("v", 3), "ǜ": ("v", 4),
    "ü": ("v", 0),
}
TONE_CHARS = "".join(re.escape(c) for c in TONE_MAP)
PINYIN_RE = re.compile(rf"^[a-zA-ZüÜ{re.escape(''.join(TONE_MAP))}]+$")


def to_key(py: str | None) -> str | None:
    """tiān → tian1；de → de0；lǜ → lv4。非拼音返回 None。"""
    base: list[str] = []
    tone = 0
    for ch in (py or "").strip():
        hit = TONE_MAP.get(ch)
        if hit:
            base.append(hit[0])
            tone = tone or hit[1]
        elif ch.isascii() and ch.isalpha():
            base.append(ch.lower())
        else:
            return None
    joined = "".join(base)
    if not joined or len(joined) > 6:
        return None
    return f"{joined}{tone}"


def is_pinyin(s: str | None) -> bool:
    s = (s or "").strip()
    return bool(s) and bool(PINYIN_RE.match(s)) and to_key(s) is not None


def normalize_text(text: str) -> str:
    """与 build-data.ts 的 normalizeText 逐字节一致：trim + 折叠空白。"""
    return re.sub(r"\s+", " ", (text or "").strip())


def content_audio_rel(text: str) -> str:
    """sha1(规范化文本) → 相对 public/audio 的路径（.mp3，避免 nginx 按 .opus 误给 MIME）。"""
    h = hashlib.sha1(normalize_text(text).encode("utf8")).hexdigest()
    return f"{h[:2]}/{h}.mp3"


@lru_cache(maxsize=1)
def char_readings() -> dict[str, list[str]]:
    """生字表 char → [pinyin key]（同一字在多册里可能带不同读音）。"""
    spec = importlib.util.spec_from_file_location("generate_renzi_data", GEN_PY)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules[spec.name] = mod  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[arg-type]
    out: dict[str, list[str]] = {}
    for book in mod.BOOKS.values():
        for unit in book["units"]:
            for ch, py, _word in unit["chars"]:
                key = to_key(py)
                if key:
                    lst = out.setdefault(ch, [])
                    if key not in lst:
                        lst.append(key)
    return out


@lru_cache(maxsize=1)
def primary_reading() -> dict[str, str]:
    """char → 生字表里第一次出现的读音 key（用作该字在教学语境下的读法）。"""
    return {ch: ks[0] for ch, ks in char_readings().items()}


@lru_cache(maxsize=1)
def dict_default_key() -> dict[str, str]:
    """任意汉字 → pypinyin 字典首读（单字最常用读法）。TTS 单念一个字就念这个音。"""
    from pypinyin.pinyin_dict import pinyin_dict as PD

    out: dict[str, str] = {}
    for cp, val in PD.items():
        key = to_key(str(val).split(",")[0])
        if key:
            try:
                out[chr(int(cp))] = key
            except ValueError:
                continue
    return out


@lru_cache(maxsize=1)
def default_reading() -> dict[str, str]:
    """char → 常用默认读音（pypinyin 首读），用于判断生字表读音是否属于破读。"""
    dd = dict_default_key()
    return {ch: dd[ch] for ch in char_readings() if ch in dd}


@lru_cache(maxsize=1)
def syllable_to_char() -> dict[str, list[str]]:
    """pinyin key → 候选汉字，按「单念就是这个音 → 越常用 → 码位小」排序。

    首读即目标音的字放最前：TTS 单独念它一定念对；常用度其次，因为生僻字
    （刂 / 忇 / 亇）虽然读音对得上，合成引擎未必认得，念不出来等于没音频。
    """
    from pypinyin.pinyin_dict import pinyin_dict as PD

    dd = dict_default_key()
    sheng = set(char_readings())
    corpus = common_chars()
    cands: dict[str, set[str]] = {}
    for cp, val in PD.items():
        try:
            ch = chr(int(cp))
        except ValueError:
            continue
        if not ("一" <= ch <= "鿿"):
            continue
        for part in str(val).split(","):
            k = to_key(part)
            if k:
                cands.setdefault(k, set()).add(ch)

    def tier(k: str, c: str) -> tuple[int, int, int]:
        reading = 0 if dd.get(c) == k else 1
        freq = 0 if c in sheng else (1 if c in corpus else 2)
        return (reading, freq, ord(c))

    return {k: sorted(v, key=lambda c: tier(k, c)) for k, v in cands.items()}


@lru_cache(maxsize=1)
def common_chars() -> frozenset[str]:
    """常用字代理：本仓库语文课文 / 故事 / 生字表里出现过的字。
    只用 pypinyin 字典挑替换字会选出「働」这类生僻码位，TTS 反而念不出。"""
    out: set[str] = set(char_readings())
    roots = [REPO_ROOT / "data", REPO_ROOT / "output"]
    for root in roots:
        if not root.exists():
            continue
        for fp in root.rglob("*.json"):
            if fp.stat().st_size > 8_000_000:
                continue
            try:
                text = fp.read_text(encoding="utf8")
            except Exception:
                continue
            out |= {c for c in text if "一" <= c <= "鿿"}
    return frozenset(out)


def homophone_char(key: str, avoid: set[str] | None = None) -> str | None:
    """给拼音音节找一个可朗读替换字（候选已按「首读正确 → 常用 → 码位」排好）。

    avoid 里的字（题干答案 / 选项 / 「」框出的字）先跳过，避免「口的读音是口」这种
    同义反复；但没有常用字可用时宁可重复，也不选 劶、忇 这类引擎可能念不出的生僻字。
    """
    cands = syllable_to_char().get(key, [])
    avoid = avoid or set()
    known = common_chars()
    for pick in (
        lambda c: c not in avoid and c in known,
        lambda c: c in known,               # 宁可重复常用字
        lambda c: c not in avoid,           # 再退而求其次用生僻字
        lambda c: True,
    ):
        for c in cands:
            if pick(c):
                return c
    return None


PY_TOKEN = rf"[a-zA-Züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+"
_PINYIN_IN_TEXT = re.compile(rf"({PY_TOKEN})")


def _avoid_chars(text: str, answer: str | None, options: list[str] | None) -> set[str]:
    """替换拼音时不能用的字：答案、选项、以及原文里「」框出的字。
    撞字会让朗读变成「动读作动」这种同义反复，孩子听不出题目在问什么。"""
    out = {c for c in (answer or "") if len(c) == 1}
    for o in options or []:
        body = re.sub(r"^[A-Da-d][.、]\s*", "", o or "").strip()
        if len(body) == 1:
            out.add(body)
    out |= set(re.findall(r"「(.)」", text))
    return out


def _tidy(t: str) -> str:
    t = re.sub(r"[，、]{2,}", "，", t)
    t = re.sub(r"([？。！])[，、]", r"\1", t)
    t = re.sub(r"[，、]([。？！])", r"\1", t)
    t = re.sub(r"。*[。]+$", "。", t) if re.search(r"[。]$", t) else t
    return normalize_text(t)


def speakable_question(text: str, *, answer: str | None = None,
                       options: list[str] | None = None) -> str:
    """题干 → 适合 TTS 的中文口语串。"""
    t = normalize_text(text)
    avoid = _avoid_chars(t, answer, options)

    # 破读目标字（生字表读音 ≠ 常用默认音）不要指望 TTS 念对，改口「这个字」，
    # 字本来就在屏幕上显示着。
    m = re.match(r"^「(.)」", t)
    if m:
        ch = m.group(1)
        keys = char_readings().get(ch, [])
        if keys and keys[0] != default_reading().get(ch):
            t = "这个字" + t[len(m.group(0)):]

    def sub_py(mm: re.Match[str]) -> str:
        py = mm.group(1)
        if not is_pinyin(py):
            return py
        return homophone_char(to_key(py) or "", avoid) or "这个音"

    t = _PINYIN_IN_TEXT.sub(lambda mm: sub_py(mm) if is_pinyin(mm.group(0)) else mm.group(0), t)
    t = re.sub(
        r"（(提示词|词)：([^）]*)）",
        lambda mm: f"，{'提示词是' if mm.group(1) == '提示词' else '例如'}{mm.group(2)}",
        t,
    )
    t = t.replace("「", "").replace("」", "").replace("『", "").replace("』", "")
    t = t.replace("（", "，").replace("）", "")
    return _tidy(t)


# 讲解里有 4 个固定句式，按句式改写比通用替换更自然
_EXPL_TEMPLATES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^「(.)」读作 (\S+)，可以组词「(.+)」。$"), r"\1 的读音是 \2，可以组词 \3。"),
    (re.compile(r"^「(\S+)」写作「(.)」，例如「(.+)」。$"), r"读音 \1 写作汉字 \2，例如 \3。"),
    (re.compile(r"^「(.)」的拼音是 (\S+)。$"), r"\1 的拼音是 \2。"),
    (re.compile(r"^「(\S+)」对应的汉字是「(.)」。$"), r"读音 \1 对应的汉字是 \2。"),
]


def speakable_explanation(text: str) -> str:
    t = normalize_text(text)
    for pat, rep in _EXPL_TEMPLATES:
        m = pat.match(t)
        if m:
            t = m.expand(rep)
            break
    avoid = _avoid_chars(text, None, None)
    t = _PINYIN_IN_TEXT.sub(
        lambda mm: homophone_char(to_key(mm.group(0)) or "", avoid) or "这个音"
        if is_pinyin(mm.group(0)) else mm.group(0), t)
    t = t.replace("「", "").replace("」", "").replace("『", "").replace("』", "")
    t = t.replace("（", "，").replace("）", "")
    return _tidy(t)


def iter_quiz_questions():
    for fp in sorted(QUIZ_DIR.glob("*.json")):
        data = json.loads(fp.read_text(encoding="utf8"))
        for section in ("unit_test", "exam"):
            for q in (data.get(section) or {}).get("questions") or []:
                yield fp.name, q


def iter_outline_texts():
    """讲解页里也会被朗读的字段。"""
    for fp in sorted(OUTLINE_DIR.glob("*.json")):
        data = json.loads(fp.read_text(encoding="utf8"))
        for unit in data.get("units") or []:
            for ks in unit.get("knowledge_points") or []:
                for field in ("point", "core_concept", "key_formula", "tips"):
                    val = ks.get(field)
                    if isinstance(val, str) and val.strip():
                        yield fp.name, f"kp.{field}", val
                for val in ks.get("common_mistakes") or []:
                    if isinstance(val, str) and val.strip():
                        yield fp.name, "kp.common_mistakes", val


def needed_syllable_keys() -> list[str]:
    keys: set[str] = set()
    for _f, q in iter_quiz_questions():
        pool = list(q.get("options") or []) + [q.get("answer") or ""]
        for o in pool:
            o = re.sub(r"^[A-Da-d][.、]\s*", "", (o or "")).strip()
            if is_pinyin(o):
                keys.add(to_key(o) or "")
        for py in re.findall(rf"拼音「({PY_TOKEN})」", q.get("question") or ""):
            if is_pinyin(py):
                keys.add(to_key(py) or "")
    return sorted(k for k in keys if k)


def needed_texts() -> dict[str, tuple[str, str]]:
    """待合成音频：sha1 相对路径 → (原文, 可朗读文本)。"""
    out: dict[str, tuple[str, str]] = {}
    for _f, q in iter_quiz_questions():
        stem = q.get("question") or ""
        if stem.strip():
            sp = speakable_question(stem, answer=q.get("answer"), options=q.get("options"))
            out[content_audio_rel(stem)] = (normalize_text(stem), sp)
        expl = q.get("explanation") or ""
        if expl.strip():
            out[content_audio_rel(expl)] = (normalize_text(expl), speakable_explanation(expl))
        for o in q.get("options") or []:
            body = re.sub(r"^[A-Da-d][.、]\s*", "", (o or "")).strip()
            if not body or is_pinyin(body):
                continue
            if len(body) > 1 or char_readings().get(body) is None:
                out[content_audio_rel(body)] = (body, body)
    for _f, _field, val in iter_outline_texts():
        sp = speakable_explanation(val)
        out[content_audio_rel(val)] = (normalize_text(val), sp)
    return out


def load_json(path: Path, default=None):
    if not path.exists():
        if default is None:
            raise SystemExit(f"缺少 {path}，请先跑 refresh_pinyin_index.py")
        return default
    return json.loads(path.read_text(encoding="utf8"))


# ---------------------------------------------------------------- 联网取音频
# Wikimedia 必须走代理（本机系统代理由 urllib 自动识别），且缺 UA 会被 403；
# 国内源（有道 / Polly）直连更快，显式绕过代理。
PROXIED_HOSTS = ("wikimedia.org", "wikipedia.org")
UA = {"User-Agent": "CongCongXueTang/1.0 (private home-language-learning; low request rate)"}


@lru_cache(maxsize=2)
def _opener(proxied: bool):
    handlers: list = [urllib.request.HTTPSHandler(context=ssl._create_unverified_context())]
    # {} = 完全不走代理；不传 = 沿用 env / macOS 系统代理设置
    handlers.append(urllib.request.ProxyHandler({} if not proxied else None))
    return urllib.request.build_opener(*handlers)


def urlopen(url: str, *, timeout: int = 40, headers: dict | None = None):
    host = urllib.parse.urlsplit(url).hostname or ""
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    return _opener(host.endswith(PROXIED_HOSTS)).open(req, timeout=timeout)
