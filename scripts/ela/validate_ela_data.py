"""ELA 题库结构 + 语义自检（一次性验收脚本）。"""
import json
import re
from pathlib import Path

QDIR = Path("output/ela/quizzes")
BARE = re.compile(r"^[A-Da-d]$")
issues: list[str] = []
global_fill: dict[str, str] = {}


def bad(msg: str) -> None:
    issues.append(msg)


def rime(word: str) -> str:
    i = min((word.find(v) for v in "aeiou" if v in word), default=-1)
    return word[i:] if i >= 0 else word


def global_fill_check(tag: str, question: str, answer: str) -> None:
    prev = global_fill.get(question)
    if prev is not None and prev != answer:
        bad(f"{tag} 跨单元题干歧义 {prev!r} / {answer!r}: {question}")
    global_fill.setdefault(question, answer)


for fp in sorted(QDIR.glob("*.json")):
    data = json.loads(fp.read_text(encoding="utf-8"))
    unit = data["unit_number"]
    seen: dict[str, list[str]] = {}
    for q in data["unit_test"]["questions"]:
        tag = f"u{unit}#{q['id']}"
        t, question, answer, opts = q["type"], q["question"], q["answer"], q.get("options") or []
        if not str(q.get("explanation", "")).strip():
            bad(f"{tag} 无讲解")
        if t == "choice" and BARE.match(answer.strip()):
            bad(f"{tag} choice 裸字母答案 {answer!r}")
        for prev_ans, prev_opts in seen.get(question, []):
            if prev_opts == tuple(sorted(opts)) and prev_ans != answer:
                bad(f"{tag} 同题干同选项但答案不同 {prev_ans!r} vs {answer!r}")
        seen.setdefault(question, []).append((answer, tuple(sorted(opts))))
        non_ascii = [c for c in question if ord(c) > 127]
        if non_ascii:
            bad(f"{tag} 题干含非 ASCII {non_ascii}: {question}")

        if t == "choice":
            if len(opts) != 4:
                bad(f"{tag} choice 选项数 {len(opts)}")
            if len(set(opts)) != 4:
                bad(f"{tag} choice 选项重复 {opts}")
            if answer not in opts:
                bad(f"{tag} 答案不在选项 {opts}")
            for o in opts:
                if BARE.match(o.strip()):
                    bad(f"{tag} 裸字母选项 {o!r}")
            # 语义：唯一正确项
            m = re.search(r"begins with the sound '(\w)'", question)
            if m and sum(o.startswith(m.group(1)) for o in opts) != 1:
                bad(f"{tag} 首音多解 {opts} {m.group(1)}")
            m = re.search(r"ends with the sound '(\w)'", question)
            if m and sum(o.endswith(m.group(1)) for o in opts) != 1:
                bad(f"{tag} 尾音多解 {opts} {m.group(1)}")
            m = re.search(r"has the (sh|ch|th|wh|ck|ph) sound", question)
            if m and sum(m.group(1) in o for o in opts) != 1:
                bad(f"{tag} digraph 多解 {opts} {m.group(1)}")
            m = re.search(r"begins with the blend (\w\w)", question)
            if m and sum(o.startswith(m.group(1)) for o in opts) != 1:
                bad(f"{tag} blend 多解 {opts} {m.group(1)}")
            m = re.search(r"uses the vowel team (\w\w\w?)", question)
            if m and sum(m.group(1) in o for o in opts) != 1:
                bad(f"{tag} vowel team 多解 {opts} {m.group(1)}")
            m = re.search(r"is in the (\w+) family", question)
            if m and sum(o.endswith(m.group(1)) for o in opts) != 1:
                bad(f"{tag} 词族多解 {opts} {m.group(1)}")
            m = re.search(r"does NOT belong to the (\w+) family", question)
            if m:
                n = sum(o.endswith(m.group(1)) for o in opts)
                if n != 3:
                    bad(f"{tag} 不属于题应恰有 3 项属于该族，实为 {n}: {opts}")
            m = re.search(r"rhymes with (\w+)", question)
            if m and sum(rime(o) == rime(m.group(1)) for o in opts) != 1:
                bad(f"{tag} rhyme 多解 {opts} {m.group(1)}")
        elif t == "true_false":
            if answer not in ("对", "错"):
                bad(f"{tag} 判断题答案 {answer!r}")
            truth = answer == "对"
            m = re.fullmatch(r"(\w+) has the (sh|ch|th|wh|ck|ph) sound\.", question)
            if m and m.group(1) != "who" and ((m.group(2) in m.group(1)) != truth):
                bad(f"{tag} 判断与事实相反 {question} -> {answer}")
            m = re.fullmatch(r"(\w+) belongs to the (\w+) family\.", question)
            if m and (m.group(1).endswith(m.group(2)) != truth):
                bad(f"{tag} 判断与词族相反 {question} -> {answer}")
            m = re.fullmatch(r"'?(\w+)'? has a (short|long) ([aeiou]) sound\.", question)
            if m:
                w, kind, v = m.group(1), m.group(2), m.group(3)
                teams = [t for t in ("ee", "ea", "oa", "ai", "ay", "igh") if t in w]
                if not teams and rime(w)[:1] != v:
                    bad(f"{tag} 判断元音不符 {question}")
                is_long = bool(teams) or (w.endswith("e") and len(w) >= 3)
                if truth != (is_long == (kind == "long")):
                    bad(f"{tag} 长短元音判断相反 {question} -> {answer}")
        elif t == "matching":
            if len(opts) != 8:
                bad(f"{tag} matching 选项数 {len(opts)}")
            left, right = opts[:4], opts[4:]
            if len(set(left)) != 4 or len(set(right)) != 4:
                bad(f"{tag} matching 两侧有重复 {opts}")
            for pair in answer.split(","):
                lm, _, rm = pair.partition("-")
                if lm not in "ABCD" or rm not in "1234":
                    bad(f"{tag} matching 答案格式 {answer}")
            if len(set(answer.split(","))) != 4:
                bad(f"{tag} matching 答案重复 {answer}")
        elif t == "word_order":
            parts = answer.split(",")
            if sorted(parts) != sorted(opts):
                bad(f"{tag} word_order 选项与答案不符 {opts} vs {parts}")
            if any("," in o for o in opts):
                bad(f"{tag} word_order 选项含逗号 {opts}")
        elif t == "fill_blank_text":
            global_fill_check(tag, question, answer.strip().lower())
            if not answer.strip():
                bad(f"{tag} 填空答案为空")
            if any(ord(c) > 127 for c in answer):
                bad(f"{tag} 填空答案含非 ASCII {answer!r}")
    # exam 与 unit_test 的重复
    exam_q = {q["question"] for q in data["exam"]["questions"]}
    for q in data["exam"]["questions"]:
        if q["type"] == "choice" and len(set(q.get("options") or [])) != 4:
            bad(f"exam u{unit}#{q['id']} 选项重复")
        if q["type"] == "matching" and len(q.get("options") or []) != 8:
            bad(f"exam u{unit}#{q['id']} matching 选项数")
        if q["type"] == "word_order":
            if sorted(q["answer"].split(",")) != sorted(q.get("options") or []):
                bad(f"exam u{unit}#{q['id']} word_order 不符")
    if not exam_q:
        bad(f"u{unit} exam 为空")

print(f"题目总数检查完成；issue={len(issues)}")
for i in issues[:200]:
    print(" -", i)
