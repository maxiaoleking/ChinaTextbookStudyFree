#!/usr/bin/env python3
"""审计认字题库：选项/答案一致性、拼音合法性、易错读音、朗读音频覆盖。

  python3 scripts/renzi/audit_renzi_data.py            # 查源题库（output/renzi/quizzes）
  python3 scripts/renzi/audit_renzi_data.py --built    # 查构建产物（apps/web/out/data）
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUIZ_DIR = ROOT / "output" / "renzi" / "quizzes"


TAGS = ("answer_not_in_options", "expl_ans_mismatch", "polyphone_wrong",
      "fill_bad_ans", "audio_missing", "audio_dangling")

# 带声调拼音元音
TONED = set("āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ")
PINYIN_RE = re.compile(r"^[a-zA-ZüÜ" + re.escape("".join(TONED)) + r"]+$")

# 课标常见多音字在「该词」下的标准读音（词 → 读音）
WORD_PY = {
    "土地": "dì", "地方": "dì", "大地": "dì", "地上": "dì",
    "好的": "de", "慢慢地": "de",
    "音乐": "yuè", "快乐": "lè", "乐曲": "yuè",
    "长大": "zhǎng", "很长": "cháng", "长江": "cháng",
    "种子": "zhǒng", "种地": "zhòng",
    "干杯": "gān", "树干": "gàn", "干活": "gàn",
    "数学": "shù", "数数": "shǔ",
    "教书": "jiāo", "教师": "jiào", "教室": "jiào",
    "觉得": "jué", "睡觉": "jiào",
    "首都": "dū", "都是": "dōu",
    "还书": "huán", "还有": "hái",
    "为人": "wèi", "因为": "wèi", "作为": "wéi",
    "干净": "gān",
    "重新": "chóng", "重要": "zhòng",
    "衣服": "fu", "服从": "fú",
    "行": "xíng", "银行": "háng",
    "得": "dé", "得到": "dé",
}


def _check_q(web_root: Path, tag: str, q: dict, stats: Counter, issues: list[str]) -> None:
    """题干 / 选项 / 解析三类朗读槽位：既要有路径，路径也要能在磁盘上找到。"""
    audio = q.get("audio") or {}

    def slot(field: str, text: str, got: str | None) -> None:
        if not (text or "").strip():
            return
        kind = field.split("[")[0]
        stats[kind] += 1
        if not got:
            issues.append(f"{tag} audio_missing {field} text={text[:24]!r}")
            return
        if not (web_root / got.lstrip("/")).exists():
            issues.append(f"{tag} audio_dangling {field} -> {got}")
            return
        stats[kind + "_ok"] += 1

    slot("stem", q.get("question"), audio.get("question"))
    slot("expl", q.get("explanation"), audio.get("explanation"))
    slots = audio.get("options") or []
    for i, o in enumerate(q.get("options") or []):
        slot(f"opt[{i}]", o, slots[i] if i < len(slots) else None)


def audit_audio() -> tuple[Counter, list[str]]:
    """源题库（output/renzi/quizzes）：音频路径由 inject_renzi_audio.py 写入。"""
    stats: Counter = Counter()
    issues: list[str] = []
    web_root = ROOT / "apps" / "web" / "public"
    for fp in sorted(QUIZ_DIR.glob("*.json")):
        data = json.loads(fp.read_text(encoding="utf-8"))
        for sec in ("unit_test", "exam"):
            for q in (data.get(sec) or {}).get("questions") or []:
                _check_q(web_root, f"{fp.name}#{q.get('id')}", q, stats, issues)
    return stats, issues


def audit_built() -> tuple[Counter, list[str]]:
    """构建产物（apps/web/out/data/books/renzi-*）：前端实际拿到的就是这份。"""
    stats: Counter = Counter()
    issues: list[str] = []
    out = ROOT / "apps" / "web" / "out"
    lessons = sorted((out / "data" / "books").glob("renzi-*/lessons/*.json"))
    if not lessons:
        return stats, [f"audio_missing 构建产物不存在，先跑 npm run build"]
    for fp in lessons:
        data = json.loads(fp.read_text(encoding="utf-8"))
        for q in data.get("questions") or []:
            _check_q(out, f"{fp.parent.parent.name}/{fp.name}#{q.get('id')}", q, stats, issues)
    return stats, issues


def audit() -> int:
    issues: list[str] = []
    stats = Counter()
    for fp in sorted(QUIZ_DIR.glob("*.json")):
        data = json.loads(fp.read_text(encoding="utf-8"))
        for sec in ("unit_test", "exam"):
            for q in (data.get(sec) or {}).get("questions") or []:
                stats["q"] += 1
                ans = (q.get("answer") or "").strip()
                opts = q.get("options") or []
                qtype = q.get("type")
                qtext = q.get("question") or ""
                expl = q.get("explanation") or ""

                if qtype == "choice":
                    stats["choice"] += 1
                    if ans not in opts:
                        # 允许 answer 与 option 仅差前缀
                        stripped = [re.sub(r"^[A-Da-d][.、]\s*", "", o) for o in opts]
                        if ans not in stripped:
                            issues.append(f"{fp.name}#{q.get('id')} answer_not_in_options ans={ans!r} opts={opts}")
                    # 拼音选项应全为合法拼音
                    if opts and all(PINYIN_RE.match(o.replace("^[A-D][.、]", "")) or True for o in opts):
                        opt_body = [re.sub(r"^[A-Da-d][.、]\s*", "", o) for o in opts]
                        if all(PINYIN_RE.match(o) for o in opt_body):
                            if ans and not PINYIN_RE.match(ans):
                                issues.append(f"{fp.name}#{q.get('id')} pinyin_choice_bad_ans ans={ans!r}")
                            # 答案应与解析中的「X」读作 Y 一致
                            m = re.search(r"「(.+?)」读作\s*([a-zA-ZüÜ" + re.escape("".join(TONED)) + r"]+)", expl)
                            if m and ans and m.group(2) != ans:
                                issues.append(
                                    f"{fp.name}#{q.get('id')} expl_ans_mismatch ans={ans!r} expl_py={m.group(2)!r} q={qtext[:40]}"
                                )
                            # 题干「字」与词的多音字校验
                            m2 = re.search(r"「(.+?)」的正确读音是？（提示词：(.+?)）", qtext)
                            if m2:
                                ch, word = m2.group(1), m2.group(2)
                                if word in WORD_PY and WORD_PY[word] != ans:
                                    issues.append(
                                        f"{fp.name}#{q.get('id')} polyphone_wrong char={ch} word={word} ans={ans} expect={WORD_PY[word]}"
                                    )

                if qtype == "fill_blank_text" and "拼音" in qtext:
                    stats["py_fill"] += 1
                    if ans and not PINYIN_RE.match(ans) and not re.fullmatch(r"[一-鿿]", ans):
                        issues.append(f"{fp.name}#{q.get('id')} fill_bad_ans ans={ans!r} q={qtext[:40]}")

    a_stats, a_issues = audit_audio()
    print("audio_stats", dict(a_stats))  # stem/expl/opt = 总槽位，*_ok = 路径可用
    print("audio_issues", len(a_issues))
    for line in a_issues[:20]:
        print(" -", line)
    issues += a_issues
    print("stats", dict(stats))
    print("issues", len(issues))
    for line in issues[:40]:
        print(" -", line)
    # 分类汇总
    kinds = Counter()
    for i in issues:
        kinds[next((k for k in TAGS if k in i), "other")] += 1
    print("by_kind", dict(kinds))
    print("audio_missing",
          {k: a_stats[k] - a_stats.get(f"{k}_ok", 0) for k in ("stem", "expl", "opt") if k in a_stats})
    return len(issues)

if __name__ == "__main__":
    import sys

    if "--built" in sys.argv:
        st, iss = audit_built()
        print("audio_stats", dict(st))
        print("audio_issues", len(iss))
        for line in iss[:30]:
            print(" -", line)
        raise SystemExit(0 if not iss else 1)
    raise SystemExit(0 if audit() == 0 else 1)
