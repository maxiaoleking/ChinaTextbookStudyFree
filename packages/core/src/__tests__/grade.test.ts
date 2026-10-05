/**
 * grade.test.ts —— 选择题判分：内容型答案与位置字母的解析优先级
 *
 * 背景：题库中部分 choice 题的 answer 直接存选项内容（"bookstore"、"a < b"、"an"）。
 * 旧逻辑取首字符当位置字母，"an"→A、"a < b"→A，导致答对判错、错项被高亮（全库 145 题）。
 * 修复后：先按选项内容反查，查不到再按首字符当位置字母。
 */

import { describe, expect, it } from "vitest";
import type { Question } from "../types";
import { gradeAnswer } from "../grade";

function choiceQ(options: string[], answer: string): Question {
  return {
    id: 1,
    type: "choice",
    score: 5,
    difficulty: 1,
    knowledge_point: "kp",
    question: "q",
    options,
    answer,
    explanation: "",
  };
}

/** UI 提交的是位置字母（A=第1个选项） */
const pick = (i: number) => String.fromCharCode(65 + i);

describe("gradeAnswer: choice 内容型答案（内容优先反查）", () => {
  it("答案内容以 a–d 开头时不得误当位置字母（英语 an / bookstore）", () => {
    // english-g6down-u5-exam #14：He has ____ idea. 选项 a/an/some/two，答案 "an"
    const q = choiceQ(["a", "an", "some", "two"], "an");
    expect(gradeAnswer(q, pick(1))).toBe(true); // 选 an（位置 B）
    expect(gradeAnswer(q, pick(0))).toBe(false); // 选 a 不再被误判对
    expect(gradeAnswer(q, pick(2))).toBe(false);
  });

  it("答案内容是比较式 a < b（数学 a×½=b×⅓）", () => {
    // g6up-u1-kp2 #9：选项 a>b / a<b / a=b / 无法比较，答案 "a < b"
    const q = choiceQ(["a > b", "a < b", "a = b", "无法比较"], "a < b");
    expect(gradeAnswer(q, pick(1))).toBe(true); // 选 a<b
    expect(gradeAnswer(q, pick(0))).toBe(false); // 选 a>b 不再被误判对
  });

  it("答案内容是单个字母（数学 a×5/4=b×4/5=c，最大的是 b）", () => {
    // g6up-u1-exam #7：选项 b/a/c/一样大，答案 "b" 指内容 b（位置 A）
    const q = choiceQ(["b", "a", "c", "一样大"], "b");
    expect(gradeAnswer(q, pick(0))).toBe(true); // 选内容 b
    expect(gradeAnswer(q, pick(1))).toBe(false); // 选 a 不再被误判对
  });

  it("内容大小写 / 空格容错", () => {
    const q = choiceQ(["the", "a", "an", "/"], "The");
    expect(gradeAnswer(q, pick(0))).toBe(true);
    expect(gradeAnswer(q, pick(2))).toBe(false);
  });

  it("选项带 A. 前缀时也能按内容反查", () => {
    const q = choiceQ(["A. 苹果", "B. 香蕉", "C. 橘子", "D. 梨"], "橘子");
    expect(gradeAnswer(q, pick(2))).toBe(true);
  });
});

describe("gradeAnswer: choice 位置字母答案（回退路径不回归）", () => {
  it("答案是小写位置字母 b → 第2个选项", () => {
    const q = choiceQ(["60秒", "30秒", "90秒", "120秒"], "b");
    expect(gradeAnswer(q, pick(1))).toBe(true);
    expect(gradeAnswer(q, pick(0))).toBe(false);
  });

  it("答案是大写位置字母 B → 第2个选项", () => {
    const q = choiceQ(["60秒", "30秒", "90秒", "120秒"], "B");
    expect(gradeAnswer(q, pick(1))).toBe(true);
  });

  it("答案带 'B. 内容' 格式 → 第2个选项", () => {
    const q = choiceQ(["60秒", "30秒", "90秒", "120秒"], "B. 30秒");
    expect(gradeAnswer(q, pick(1))).toBe(true);
  });

  it("选项恰为字母 ABCD、答案 'A' → 仍第1个选项（goldenVectors 场景）", () => {
    const q = choiceQ(["A", "B", "C", "D"], "A");
    expect(gradeAnswer(q, pick(0))).toBe(true);
    expect(gradeAnswer(q, pick(1))).toBe(false);
  });

  it("答案既不在选项中也非字母 → 全部判错", () => {
    const q = choiceQ(["甲", "乙", "丙", "丁"], "戊");
    expect(gradeAnswer(q, pick(0))).toBe(false);
    expect(gradeAnswer(q, pick(4 - 1))).toBe(false);
  });
});
