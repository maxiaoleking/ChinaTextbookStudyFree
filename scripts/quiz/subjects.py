"""
subjects.py — 学科配置中心（单一事实源）

pipeline.py 和 prompts.py 都从这里取数。新增学科只需在此加一条。

设计原则：
1. 一个学科一条 dict 记录
2. 每条包含：显示名、课标名、GitHub 路径、教材列表、年级范围、prompt/schema 名称、题型集
3. 教材文件名列表在实施时通过 GitHub API / raw 页面实际枚举填入
4. grade_range = (1, 6) 默认；英语 PEP 三年级起点是 (3, 6)
"""

from __future__ import annotations
from typing import TypedDict, Literal

SubjectId = Literal["math", "chinese", "renzi", "english", "ela", "science"]


class SubjectConfig(TypedDict):
    display_name: str
    curriculum: str
    github_path: str
    publisher_label: str
    textbooks: list[str]       # PDF 文件名（不含路径，含 .pdf 后缀）
    grade_range: tuple[int, int]
    quiz_prompt: str           # prompts.py 中的常量名
    quiz_schema: str           # prompts.py 中的 schema 名
    question_types: list[str]


# ============================================================
# 数学：人教版，6 年级 × 2 学期 = 12 册（已上线）
# ============================================================
MATH: SubjectConfig = {
    "display_name": "数学",
    "curriculum": "《义务教育数学课程标准（2022年版）》",
    "github_path": "小学/数学/人教版",
    "publisher_label": "人教版",
    "textbooks": [
        "义务教育教科书 · 数学一年级上册.pdf",
        "义务教育教科书 · 数学二年级上册.pdf",
        "义务教育教科书 · 数学三年级上册.pdf",
        "义务教育教科书 · 数学四年级上册.pdf",
        "义务教育教科书 · 数学五年级上册.pdf",
        "义务教育教科书 · 数学六年级上册.pdf",
        "义务教育教科书·数学一年级下册.pdf",
        "义务教育教科书·数学二年级下册.pdf",
        "义务教育教科书·数学三年级下册.pdf",
        "义务教育教科书·数学四年级下册.pdf",
        "义务教育教科书·数学五年级下册.pdf",
        "义务教育教科书·数学六年级下册.pdf",
    ],
    "grade_range": (1, 6),
    "quiz_prompt": "QUIZ_PROMPT_MATH",
    "quiz_schema": "QUIZ_SCHEMA_MATH",
    "question_types": ["true_false", "choice", "fill_blank", "calculation"],
}


# ============================================================
# 语文：统编版，6 年级 × 2 学期 = 12 册
# TODO: 实施前用 GitHub API 确认实际 PDF 文件名
# ============================================================
CHINESE: SubjectConfig = {
    "display_name": "语文",
    "curriculum": "《义务教育语文课程标准（2022年版）》",
    "github_path": "小学/语文/统编版",
    "publisher_label": "统编版",
    # 已通过 GitHub API 验证
    "textbooks": [
        "义务教育教科书·语文一年级上册.pdf",
        "义务教育教科书·语文二年级上册.pdf",
        "义务教育教科书·语文三年级上册.pdf",
        "义务教育教科书·语文四年级上册.pdf",
        "义务教育教科书·语文五年级上册.pdf",
        "义务教育教科书·语文六年级上册.pdf",
        "义务教育教科书·语文一年级下册.pdf",
        "义务教育教科书·语文二年级下册.pdf",
        "义务教育教科书·语文三年级下册.pdf",
        "义务教育教科书·语文四年级下册.pdf",
        "义务教育教科书·语文五年级下册.pdf",
        "义务教育教科书·语文六年级下册.pdf",
    ],
    "grade_range": (1, 6),
    "quiz_prompt": "QUIZ_PROMPT_CHINESE",
    "quiz_schema": "QUIZ_SCHEMA_CHINESE",
    "question_types": ["true_false", "choice", "fill_blank_text", "word_order", "matching"],
}


# ============================================================
# 认字：统编版识字表衍生，一至三年级 × 2 学期 = 6 册（拼音 + 生字练习）
# ============================================================
RENZI: SubjectConfig = {
    "display_name": "认字",
    "curriculum": "《义务教育语文课程标准（2022年版）》识字与写字",
    "github_path": "小学/语文/统编版",
    "publisher_label": "统编版",
    "textbooks": [
        "义务教育教科书·认字一年级上册.json",
        "义务教育教科书·认字一年级下册.json",
        "义务教育教科书·认字二年级上册.json",
        "义务教育教科书·认字二年级下册.json",
        "义务教育教科书·认字三年级上册.json",
        "义务教育教科书·认字三年级下册.json",
    ],
    "grade_range": (1, 3),
    "quiz_prompt": "QUIZ_PROMPT_RENZI",
    "quiz_schema": "QUIZ_SCHEMA_RENZI",
    "question_types": ["true_false", "choice", "fill_blank_text"],
}


# ============================================================
# 英语：人教版 PEP 三年级起点，3-6 年级 × 2 学期 = 8 册
# TODO: 实施前用 GitHub API 确认实际 PDF 文件名
# ============================================================
ENGLISH: SubjectConfig = {
    "display_name": "英语",
    "curriculum": "《义务教育英语课程标准（2022年版）》",
    "github_path": "小学/英语/人教版（PEP）（三年级起点）（主编：吴欣）",
    "publisher_label": "人教版PEP",
    # 注意 GitHub 上 上册 / 下册 命名不一致：
    # - 上册：义务教育教科书·英语（PEP）（三年级起点）N年级上册.pdf
    # - 下册：义务教育教科书·英语（三年级起点）N年级下册.pdf
    "textbooks": [
        "义务教育教科书·英语（PEP）（三年级起点）三年级上册.pdf",
        "义务教育教科书·英语（PEP）（三年级起点）四年级上册.pdf",
        "义务教育教科书·英语（PEP）（三年级起点）五年级上册.pdf",
        "义务教育教科书·英语（PEP）（三年级起点）六年级上册.pdf",
        "义务教育教科书·英语（三年级起点）三年级下册.pdf",
        "义务教育教科书·英语（三年级起点）四年级下册.pdf",
        "义务教育教科书·英语（三年级起点）五年级下册.pdf",
        "义务教育教科书·英语（三年级起点）六年级下册.pdf",
    ],
    "grade_range": (3, 6),
    "quiz_prompt": "QUIZ_PROMPT_ENGLISH",
    "quiz_schema": "QUIZ_SCHEMA_ENGLISH",
    "question_types": ["true_false", "choice", "fill_blank_text", "word_order", "matching"],
}


# ============================================================
# 美国英语（ELA）：CCSS Grade 1。数据由 scripts/ela/generate_ela_data.py 本地生成，
# 没有配套 PDF 教材 —— 因此刻意不进 ALL_SUBJECT_IDS，PDF→LLM 管线不处理该学科。
# ============================================================
ELA: SubjectConfig = {
    "display_name": "美国英语",
    "curriculum": "Common Core State Standards — English Language Arts, Grade 1",
    "github_path": "",
    "publisher_label": "CCSS",
    "textbooks": [],
    "grade_range": (1, 1),
    "quiz_prompt": "QUIZ_PROMPT_ENGLISH",
    "quiz_schema": "QUIZ_SCHEMA_ENGLISH",
    "question_types": ["true_false", "choice", "fill_blank_text", "word_order", "matching"],
}


# ============================================================
# 科学：教科版，6 年级 × 2 学期 = 12 册
# TODO: 实施前用 GitHub API 确认实际 PDF 文件名
# ============================================================
SCIENCE: SubjectConfig = {
    "display_name": "科学",
    "curriculum": "《义务教育科学课程标准（2022年版）》",
    "github_path": "小学/科学/教科版",
    "publisher_label": "教科版",
    "textbooks": [
        "义务教育教科书·科学一年级上册.pdf",
        "义务教育教科书·科学二年级上册.pdf",
        "义务教育教科书·科学三年级上册.pdf",
        "义务教育教科书·科学四年级上册.pdf",
        "义务教育教科书·科学五年级上册.pdf",
        "义务教育教科书·科学六年级上册.pdf",
        "义务教育教科书·科学一年级下册.pdf",
        "义务教育教科书·科学二年级下册.pdf",
        "义务教育教科书·科学三年级下册.pdf",
        "义务教育教科书·科学四年级下册.pdf",
        "义务教育教科书·科学五年级下册.pdf",
        "义务教育教科书·科学六年级下册.pdf",
    ],
    "grade_range": (1, 6),
    "quiz_prompt": "QUIZ_PROMPT_SCIENCE",
    "quiz_schema": "QUIZ_SCHEMA_SCIENCE",
    "question_types": ["true_false", "choice", "fill_blank", "fill_blank_text"],
}


SUBJECTS: dict[str, SubjectConfig] = {
    "math": MATH,
    "chinese": CHINESE,
    "renzi": RENZI,
    "english": ENGLISH,
    "ela": ELA,
    "science": SCIENCE,
}


ALL_SUBJECT_IDS = ["math", "chinese", "renzi", "english", "science"]


def get_subject_cfg(subject_id: str) -> SubjectConfig:
    if subject_id not in SUBJECTS:
        raise ValueError(f"未知学科: {subject_id}。可选: {ALL_SUBJECT_IDS}")
    return SUBJECTS[subject_id]


def detect_subject_from_stem(stem: str) -> str:
    """从教材文件名（stem，不含后缀）推断学科。"""
    if "认字" in stem:
        return "renzi"
    if "语文" in stem:
        return "chinese"
    if "美国英语" in stem:
        return "ela"
    if "英语" in stem or "PEP" in stem:
        return "english"
    if "科学" in stem:
        return "science"
    # 默认数学（兼容老文件名）
    return "math"


def get_grade_semester(stem: str) -> str:
    """从文件名提取 'N年级上/下册'，学科无关。"""
    for grade_name in ["一", "二", "三", "四", "五", "六"]:
        for sem in ["上册", "下册"]:
            needle = f"{grade_name}年级{sem}"
            if needle in stem:
                return needle
    return "未知年级"
