import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { correctChoiceLetter, gradeAnswer } from "../grade";
import type { Question } from "../types";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../../output/math/quizzes/义务教育教科书 · 数学六年级上册_unit1.json", import.meta.url,
), "utf8"));

describe("choice grading (issue #2)", () => {
  it("grades the reported a < b question by its full option text", () => {
    const question: Question = fixture.unit_test.questions.find((q: Question) => q.id === 9);
    expect(question.options[1]).toBe(question.answer);
    expect(correctChoiceLetter(question)).toBe("B");
    for (const [i, letter] of ["A", "B", "C", "D"].entries()) {
      expect(gradeAnswer(question, letter)).toBe(i === 1);
    }
  });

  it.each(["apple", "banana", "cat", "dog", "a", "a + b"])(
    "looks up option text before interpreting %s as a label", (answer) => {
      const question = { type: "choice", answer, options: ["none", answer, "other", "last"] } as Question;
      expect(gradeAnswer(question, "B")).toBe(true);
      expect(gradeAnswer(question, "A")).toBe(false);
    },
  );

  it.each(["B", "B. yes", "B、yes"])("supports legacy answer labels %s", (answer) => {
    const question = { type: "choice", answer, options: ["no", "yes", "maybe", "unknown"] } as Question;
    expect(gradeAnswer(question, "B")).toBe(true);
    expect(gradeAnswer(question, "A")).toBe(false);
  });

  it("rejects invalid labels rather than accepting their first character", () => {
    const question = { type: "choice", answer: "B", options: ["no", "yes"] } as Question;
    expect(gradeAnswer(question, "banana")).toBe(false);
    expect(gradeAnswer(question, "")).toBe(false);
  });
});
