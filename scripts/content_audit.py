#!/usr/bin/env python3
"""Reproducible content inventory; heuristic flags are NOT teacher-approved errors."""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HAN = re.compile(r"[\u4e00-\u9fff]")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def chars(sentences):
    return len(HAN.findall("".join(sentences)))


def median(values):
    return round(statistics.median(values), 1) if values else None


def audio_path(text):
    normalized = re.sub(r"\s+", " ", text.strip())
    digest = hashlib.sha1(normalized.encode()).hexdigest()
    return f"{digest[:2]}/{digest}.opus"


def audit(root=ROOT):
    report = {"scope": "本地数据全量结构统计 + 规则筛查；不代表逐题语义审核", "reading": [],
              "subjects": {}, "flags": [], "missing_audio": [], "invalid_passage_segments": [], "intentional_nonspoken_segments": []}
    for grade in range(1, 7):
        passages, stories = [], []
        for f in sorted((root / "data/passages/chinese").glob(f"chinese-g{grade}*.json")):
            if ".draft." not in f.name:
                passages.extend(read(f)["passages"])
        for f in sorted((root / "data/stories/chinese").glob(f"chinese-g{grade}*.json")):
            stories.extend(read(f)["stories"])
        prose = [p for p in passages if p.get("kind") in ("prose", "story")]
        pmedian = median([chars(p["sentences"]) for p in prose])
        smedian = median([chars(s["sentences"]) for s in stories])
        report["reading"].append({"grade": grade, "passages": len(passages),
            "prose_and_story_count": len(prose), "passage_chars_median": pmedian,
            "stories": len(stories), "story_chars_median": smedian,
            "length_ratio": round(smedian / pmedian, 3) if pmedian and smedian else None,
            "questions_per_story": dict(collections.Counter(len(s["questions"]) for s in stories)),
            "passages_without_unit": sum(p.get("unitNumber") is None for p in passages)})
    for subject in ("math", "chinese", "english", "science"):
        units, questions, exam_questions, kps, uncovered = 0, [], [], [], []
        duplicate_stems = collections.defaultdict(list)
        for f in sorted((root / "output" / subject / "outlines").glob("*.json")):
            outline = read(f)
            for unit in outline["units"]:
                units += 1
                qfile = root / "output" / subject / "quizzes" / f"{f.stem}_unit{unit['unit_number']}.json"
                if not qfile.exists():
                    report["flags"].append({"kind": "missing_quiz", "file": str(qfile.relative_to(root))})
                    continue
                data = read(qfile)
                qs = data.get("unit_test", {}).get("questions", [])
                questions.extend(qs)
                exam_questions.extend(data.get("exam", {}).get("questions", []))
                by_kp = collections.Counter(q.get("knowledge_point", "") for q in qs)
                for kp in unit["knowledge_points"]:
                    n = by_kp[kp["name"]]
                    kps.append(n)
                    if n < 4:
                        uncovered.append({"file": str(qfile.relative_to(root)), "point": kp["name"], "count": n})
                for q in qs:
                    where = {"file": str(qfile.relative_to(root)), "id": q["id"]}
                    duplicate_stems[re.sub(r"\s+", "", q["question"])].append(where)
                    opts = q.get("options", [])
                    stripped = [re.sub(r"^[A-Da-d][.、]\s*", "", o) for o in opts]
                    if q["type"] == "choice" and (len(opts) != 4 or len(set(stripped)) != len(stripped)):
                        report["flags"].append({"kind": "choice_options", **where})
                    if q["type"] == "choice" and q["answer"] not in opts + stripped + list("ABCD"):
                        report["flags"].append({"kind": "choice_answer", **where})
                    if not str(q.get("explanation", "")).strip():
                        report["flags"].append({"kind": "empty_explanation", **where})
                    if q["type"] == "fill_blank_text" and (len(q.get("answer", "")) > 12 or re.search(r"你认为|谈谈|说说|为什么|举例|造句", q["question"])):
                        report["flags"].append({"kind": "exact_match_open_response_candidate", **where, "question": q["question"], "answer": q["answer"]})
        report["subjects"][subject] = {"units": units, "web_questions": len(questions),
            "exam_questions_not_built_into_web": len(exam_questions), "outline_knowledge_points": len(kps),
            "questions_per_outline_point_median": median(kps), "zero_question_points": kps.count(0),
            "points_below_four_questions": sum(n < 4 for n in kps), "low_coverage": uncovered,
            "question_types": dict(collections.Counter(q["type"] for q in questions)),
            "difficulty_labels": dict(collections.Counter(q.get("difficulty") for q in questions)),
            "duplicate_question_stem_groups": [v for v in duplicate_stems.values() if len(v) > 1]}
    audio_root = root / "apps/web/public/audio"
    seen = set()

    def check(text, location):
        if not text or not re.search(r"[\u3400-\u9fffA-Za-z0-9]", text):
            return
        rel = audio_path(text)
        if rel in seen:
            return
        seen.add(rel)
        path = audio_root / rel
        if not path.exists() or not path.stat().st_size:
            report["missing_audio"].append({"text": text, "audio_rel": rel, **location})

    for kind, array in (("passages", "passages"), ("stories", "stories")):
        for f in sorted((root / "data" / kind).glob("*/*.json")):
            if ".draft." in f.name:
                continue
            d = read(f)
            for item in d[array]:
                loc = {"bookId": d["bookId"], "id": item["id"], "subject": d["subject"], "grade": d["grade"]}
                for i, sentence in enumerate(item["sentences"]):
                    if kind == "passages" and i in item.get("nonSpokenSentenceIndices", []) and item.get("readingNote"):
                        report["intentional_nonspoken_segments"].append({**loc, "sentence_index": i, "text": sentence, "reason": item["readingNote"]})
                    elif kind == "passages" and (not re.search(r"[\u3400-\u9fffA-Za-z0-9]", sentence) or "[?]" in sentence):
                        report["invalid_passage_segments"].append({**loc, "sentence_index": i, "text": sentence})
                    else:
                        check(sentence, {**loc, "field": "sentence"})
                for q in item.get("questions", []):
                    for field in ("question", "explanation"):
                        check(q.get(field, ""), {**loc, "field": field})
                    for opt in q.get("options", []):
                        check(opt, {**loc, "field": "option"})
    for f in sorted((root / "output").glob("*/quizzes/*.json")):
        d = read(f)
        loc = {"file": str(f.relative_to(root)), "subject": f.parents[1].name}
        grade_match = re.search(r"([一二三四五六])年级[上下]册", f.name)
        if grade_match:
            loc["grade"] = "一二三四五六".index(grade_match[1]) + 1
        # Only fields actually consumed by build-data.ts, not the unused exam bank.
        for q in d.get("unit_test", {}).get("questions", []):
            for field in ("question", "explanation"):
                check(q.get(field, ""), {**loc, "field": field})
            for opt in q.get("options", []):
                check(re.sub(r"^[A-Da-d][.、]\s*", "", opt), {**loc, "field": "option"})
        for kp in d.get("knowledge_summary", []):
            for field in ("point", "core_concept", "key_formula", "tips"):
                check(kp.get(field, ""), {**loc, "field": field})
            for mistake in kp.get("common_mistakes", []):
                check(mistake, {**loc, "field": "common_mistakes"})
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "docs/content-audit.json")
    args = parser.parse_args()
    report = audit()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"reading": report["reading"], "subjects": {s: {k: v for k, v in d.items() if k not in ("low_coverage", "duplicate_question_stem_groups")} for s, d in report["subjects"].items()}, "flags": dict(collections.Counter(f["kind"] for f in report["flags"])), "missing_audio": len(report["missing_audio"]), "invalid_passage_segments": len(report["invalid_passage_segments"])}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
