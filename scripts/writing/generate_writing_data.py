#!/usr/bin/env python3
"""生成写字练习科目：output/writing/{outlines,quizzes} + public/writing/glyphs。

生字范围直接复用认字科目的一年级生字表（scripts/renzi/generate_renzi_data.py 里的
BOOKS['g1up'] / BOOKS['g1down']），保证「先认后写」两科的进度对齐。

字形数据（笔画轮廓 SVG path + 每笔 median 折线，1024 见方 y 轴向上）来自
hanzi-writer-data（派生自 makemeahanzi / Arphic 字体），许可见输出的 ATTRIBUTION.md。
默认从 npm 拉一次并缓存在 .cache/hanzi-writer-data/，也可 --source 指向本地解包目录。

产物：
  apps/web/public/writing/glyphs/{char}.json   仅本科目用到的字（约 310 个 / 640KB）
  apps/web/public/writing/{ATTRIBUTION.md,ARPHICPL.TXT}
  output/writing/outlines/<stem>.json
  output/writing/quizzes/<stem>_unit<N>.json

题型：unit_test = 逐笔跟写（trace），exam = 整字自由书写（whole → 单元挑战课）。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
WEB_PUBLIC = ROOT / "apps" / "web" / "public"
GLYPH_DIR = WEB_PUBLIC / "writing" / "glyphs"
OUTLINE_DIR = ROOT / "output" / "writing" / "outlines"
QUIZ_DIR = ROOT / "output" / "writing" / "quizzes"
CACHE_DIR = ROOT / ".cache" / "hanzi-writer-data"
AUDIO_PINYIN = WEB_PUBLIC / "audio" / "pinyin"

DATA_PKG = "hanzi-writer-data@2.0.1"
GROUP_SIZE = 4  # 每课 4 个生字
EXAM_SIZE = 6   # 单元挑战 6 个生字

sys.path.insert(0, str(ROOT / "scripts" / "renzi"))
import renzi_audio_lib as L  # noqa: E402  (to_key: tiān → tian1)


# ============================================================
# 生字表：直接读认字科目的生成器，避免两张表走偏
# ============================================================

def renzi_books() -> dict[str, dict[str, Any]]:
    spec = importlib.util.spec_from_file_location(
        "renzi_gen", ROOT / "scripts" / "renzi" / "generate_renzi_data.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.BOOKS


# ============================================================
# 字形数据源
# ============================================================

def ensure_glyph_source(source: str | None) -> Path:
    if source:
        p = Path(source)
        if not p.is_dir():
            raise SystemExit(f"--source 目录不存在: {p}")
        return p
    pkg = CACHE_DIR / "package"
    if pkg.is_dir() and any(pkg.glob("天.json")):
        return pkg
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tgz = subprocess.run(
        ["npm", "pack", DATA_PKG, "--silent"],
        cwd=CACHE_DIR, capture_output=True, text=True, check=True,
    ).stdout.strip().splitlines()[-1]
    with tarfile.open(CACHE_DIR / tgz) as tf:
        tf.extractall(CACHE_DIR, filter="data")
    if not pkg.is_dir():
        raise SystemExit(f"解包后未找到 {pkg}")
    return pkg


def load_glyph(src: Path, char: str) -> dict[str, Any]:
    raw = json.loads((src / f"{char}.json").read_text(encoding="utf-8"))
    strokes = raw.get("strokes") or []
    medians = raw.get("medians") or []
    if len(strokes) != len(medians) or not strokes:
        raise SystemExit(f"{char} 字形数据异常: strokes={len(strokes)} medians={len(medians)}")
    out: dict[str, Any] = {"strokes": strokes, "medians": medians}
    if raw.get("radStrokes"):
        out["radStrokes"] = raw["radStrokes"]
    return out


# ============================================================
# 判分参数（apps/web/scripts/writing-selftest.ts 会读 config.json 复核标定）
# ============================================================

TRACE_THRESHOLD = 0.7
# 笔画越密，栅格比对的绝对分越低，合格线随之放宽
WHOLE_THRESHOLDS = [
    {"maxStrokes": 4, "threshold": 0.62},
    {"maxStrokes": 8, "threshold": 0.56},
    {"maxStrokes": 99, "threshold": 0.5},
]


def trace_threshold(strokes: int) -> float:
    return TRACE_THRESHOLD


def whole_threshold(strokes: int) -> float:
    for bucket in WHOLE_THRESHOLDS:
        if strokes <= bucket["maxStrokes"]:
            return bucket["threshold"]
    return WHOLE_THRESHOLDS[-1]["threshold"]


def difficulty_for(strokes: int) -> int:
    if strokes <= 3:
        return 1
    if strokes <= 6:
        return 2
    if strokes <= 10:
        return 3
    return 4


def pinyin_audio(py: str) -> dict[str, str] | None:
    key = L.to_key(py)
    if key and (AUDIO_PINYIN / f"{key}.mp3").exists():
        return {"question": f"/audio/pinyin/{key}.mp3"}
    return None


def make_question(
    qid: int, char: str, py: str, word: str, kp: str, strokes: int, mode: str
) -> dict[str, Any]:
    threshold = trace_threshold(strokes) if mode == "trace" else whole_threshold(strokes)
    if mode == "trace":
        stem = f"照笔顺一笔一画写「{char}」（{py}，{word}）"
        explain = f"「{char}」共 {strokes} 画，跟着高亮从第一笔开始写，起笔收笔都落在灰色笔画上。"
    else:
        stem = f"在田字格里写出「{char}」（{py}，{word}）"
        explain = f"「{char}」共 {strokes} 画，写在格子正中，横平竖直、笔画写满整格。"
    q: dict[str, Any] = {
        "id": qid,
        "type": "writing",
        "score": 25,  # 单题分值（Web 端不读，仅 iOS 显示用）
        "difficulty": difficulty_for(strokes),
        "knowledge_point": kp,
        "question": stem,
        "options": [],
        "answer": "",
        "explanation": explain,
        "writing": {
            "char": char,
            "pinyin": py,
            "word": word,
            "mode": mode,
            "threshold": threshold,
        },
    }
    audio = pinyin_audio(py)
    if audio:
        q["audio"] = audio
    return q


# ============================================================
# 一本书（上册 / 下册）
# ============================================================

def build_book(
    book_meta: dict[str, Any],
    glyph_cache: dict[str, dict[str, Any]],
) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
    grade_name = {1: "一年级"}.get(book_meta["grade"], f'{book_meta["grade"]}年级')
    sem_name = {"up": "上册", "down": "下册"}[book_meta["semester"]]
    stem = f"义务教育教科书·写字练习{grade_name}{sem_name}"
    textbook = f"统编版小学写字练习{grade_name}{sem_name}"

    outline_units: list[dict[str, Any]] = []
    quizzes: list[dict[str, Any]] = []

    for u_idx, unit in enumerate(book_meta["units"], start=1):
        seen: set[str] = set()
        uniq: list[tuple[str, str, str]] = []
        for c, p, w in unit["chars"]:
            if c in seen:
                continue  # 同字在单元内重复出现时只留第一次（跟写一遍足够）
            seen.add(c)
            uniq.append((c, p, w))

        groups = [uniq[i : i + GROUP_SIZE] for i in range(0, len(uniq), GROUP_SIZE)]
        unit_questions: list[dict[str, Any]] = []
        kps: list[dict[str, Any]] = []
        qid = 1
        for gi, group in enumerate(groups, start=1):
            kp = f"写字 第{gi}组"
            kps.append(
                {
                    "name": kp,
                    "description": f"在「{unit['title']}」里按笔顺写「{'、'.join(c for c, _, _ in group)}」。",
                    "difficulty": max(
                        difficulty_for(len(glyph_cache[c]["strokes"])) for c, _, _ in group
                    ),
                    "question_types": ["写字"],
                }
            )
            for char, py, word in group:
                strokes = len(glyph_cache[char]["strokes"])
                unit_questions.append(
                    make_question(qid, char, py, word, kp, strokes, "trace")
                )
                qid += 1

        # 单元挑战：从本单元随机但不失真地抽 EXAM_SIZE 个字做整字书写
        exam_chars = uniq[:: max(1, len(uniq) // EXAM_SIZE)][:EXAM_SIZE]
        exam_questions = [
            make_question(
                i + 1, char, py, word, "整字默写", len(glyph_cache[char]["strokes"]), "whole"
            )
            for i, (char, py, word) in enumerate(exam_chars)
        ]

        knowledge_summary = [
            {
                "point": kp["name"],
                "core_concept": kp["description"],
                "key_formula": "先横后竖，先撇后捺，从上到下，从左到右",
                "common_mistakes": [
                    "起笔位置偏出灰色笔画",
                    "把两笔连成一笔写",
                    "笔顺颠倒（先写右边再写左边）",
                ],
                "tips": "握笔轻一点，看准起笔的那个小黑点再下笔。",
            }
            for kp in kps
        ]

        outline_units.append(
            {
                "unit_number": u_idx,
                "title": unit["title"],
                "knowledge_points": kps,
            }
        )
        quizzes.append(
            {
                "textbook": textbook,
                "unit": unit["title"],
                "unit_number": u_idx,
                "unit_test": {
                    "title": f"第{u_idx}单元「{unit['title']}」写字练习",
                    "total_score": 100,
                    "time_minutes": 15,
                    "questions": unit_questions,
                },
                "exam": {
                    "title": f"第{u_idx}单元写字挑战",
                    "total_score": 100,
                    "time_minutes": 10,
                    "questions": exam_questions,
                },
                "knowledge_summary": knowledge_summary,
            }
        )

    outline = {"textbook": textbook, "units": outline_units}
    return stem, outline, quizzes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", help="hanzi-writer-data 解包目录（默认 npm 拉取并缓存）")
    ap.add_argument("--grades", default="1", help="逗号分隔的年级，目前只支持 1")
    args = ap.parse_args()

    books = renzi_books()
    wanted = {
        "1": ["g1up", "g1down"],
    }
    keys: list[str] = []
    for g in args.grades.split(","):
        keys += wanted.get(g.strip(), [])
    if not keys:
        raise SystemExit(f"暂不支持的年级参数: {args.grades}")

    src = ensure_glyph_source(args.source)
    GLYPH_DIR.mkdir(parents=True, exist_ok=True)

    used: dict[str, dict[str, Any]] = {}
    for key in keys:
        for unit in books[key]["units"]:
            for char, _py, _w in unit["chars"]:
                if char in used:
                    continue
                used[char] = load_glyph(src, char)

    for char, glyph in sorted(used.items()):
        (GLYPH_DIR / f"{char}.json").write_text(
            json.dumps(glyph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )

    # 字形一变，版本锁必须同步变（validate-data 会逐字比对 sha256）
    subprocess.run(
        ["npx", "tsx", str(ROOT / "scripts" / "lock-glyphs.ts")],
        cwd=ROOT,
        check=True,
    )

    attr = WEB_PUBLIC / "writing"
    attr.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src / "ARPHICPL.TXT", attr / "ARPHICPL.TXT")
    (attr / "ATTRIBUTION.md").write_text(
        "# 写字练习字形数据说明\n\n"
        "`glyphs/*.json` 派生自 [Hanzi Writer Data](https://github.com/chanind/hanzi-writer-data) "
        f"（{DATA_PKG}），其上游是 [Make Me A Hanzi](https://github.com/skishore/makemeahanzi) "
        "与 Arphic Technology 的字形。\n\n"
        "- 库代码（Hanzi Writer）为 MIT；本目录**只使用其数据**，未引入库代码。\n"
        "- 数据按 Arphic Public License 分发，全文见同目录 `ARPHICPL.TXT`。\n"
        "- 每个文件字段：`strokes` 每笔轮廓 SVG path、`medians` 每笔中线折线（顺序即标准笔顺）、"
        "`radStrokes` 部件分组，坐标系 1024 见方、y 轴向上。\n"
        "- 本项目仅在局域网/家庭教学内使用；对外分发前需按上游许可逐项核对。\n",
        encoding="utf-8",
    )

    (attr / "config.json").write_text(
        json.dumps(
            {
                "traceThreshold": TRACE_THRESHOLD,
                "wholeThresholds": WHOLE_THRESHOLDS,
                "glyphBox": 1024,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    OUTLINE_DIR.mkdir(parents=True, exist_ok=True)
    QUIZ_DIR.mkdir(parents=True, exist_ok=True)
    total_trace = 0
    total_whole = 0
    for key in keys:
        stem, outline, quizzes = build_book(books[key], used)
        (OUTLINE_DIR / f"{stem}.json").write_text(
            json.dumps(outline, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        for quiz in quizzes:
            total_trace += len(quiz["unit_test"]["questions"])
            total_whole += len(quiz["exam"]["questions"])
            (QUIZ_DIR / f"{stem}_unit{quiz['unit_number']}.json").write_text(
                json.dumps(quiz, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        print(
            f"  ✓ {stem}: {len(outline['units'])} 单元 / "
            f"{sum(len(q['unit_test']['questions']) for q in quizzes)} 道跟写题"
        )

    print(
        f"✅ 写字练习数据: {len(used)} 个字形 → {GLYPH_DIR.relative_to(ROOT)}，"
        f"{len(keys)} 本教材，{total_trace} 道跟写题 + {total_whole} 道整字挑战题"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
