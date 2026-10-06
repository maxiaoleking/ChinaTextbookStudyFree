import { describe, expect, it } from "vitest";
import { gradeAnswer, resolveChoiceLetter, choiceLetterOrNull } from "../grade";
import type { Question } from "../types";

function q(partial: Partial<Question> & Pick<Question, "type" | "answer" | "options">): Question {
  return {
    id: 1,
    score: 5,
    difficulty: 1,
    knowledge_point: "t",
    question: "t",
    explanation: "t",
    ...partial,
  } as Question;
}

describe("choiceLetterOrNull", () => {
  it("仅整串 A-D/a-d 才是选项字母", () => {
    expect(choiceLetterOrNull("A")).toBe("A");
    expect(choiceLetterOrNull("b")).toBe("B");
    expect(choiceLetterOrNull("dì")).toBeNull();
    expect(choiceLetterOrNull("bà")).toBeNull();
    expect(choiceLetterOrNull("de")).toBeNull();
  });
});

describe("resolveChoiceLetter — 拼音答案不得被当成选项字母", () => {
  const pinyinQ = q({
    type: "choice",
    question: "「地」的正确读音是？（提示词：土地）",
    options: ["tiān", "rén", "dì", "nǐ"],
    answer: "dì",
    explanation: "「地」读作 dì，可以组词「土地」。",
  });

  it("答案 dì 应反查为 C，而不是 D", () => {
    expect(resolveChoiceLetter(pinyinQ)).toBe("C");
  });

  it("选 C（dì）判对，选 D（nǐ）判错", () => {
    expect(gradeAnswer(pinyinQ, "C")).toBe(true);
    expect(gradeAnswer(pinyinQ, "D")).toBe(false);
  });

  it("用户直接提交选项正文也可判分", () => {
    expect(gradeAnswer(pinyinQ, "dì")).toBe(true);
    expect(gradeAnswer(pinyinQ, "nǐ")).toBe(false);
  });

  it("字母型答案仍按字母处理", () => {
    const letterQ = q({
      type: "choice",
      options: ["苹果", "香蕉", "梨", "橘子"],
      answer: "B",
    });
    expect(resolveChoiceLetter(letterQ)).toBe("B");
    expect(gradeAnswer(letterQ, "B")).toBe(true);
    expect(gradeAnswer(letterQ, "A")).toBe(false);
    expect(gradeAnswer(letterQ, "香蕉")).toBe(true);
  });

  it("b 开头拼音（bà）不会被当成 B", () => {
    const baQ = q({
      type: "choice",
      options: ["dú", "jiāo", "bà", "shuāi"],
      answer: "bà",
    });
    expect(resolveChoiceLetter(baQ)).toBe("C");
    expect(gradeAnswer(baQ, "B")).toBe(false);
    expect(gradeAnswer(baQ, "C")).toBe(true);
  });
});
