/** Verify that the real bank can be expressed by the input it is assigned to. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gradeAnswer } from "../../packages/core/src/grade";
import type { Question } from "../../packages/core/src/types";
import { answerInputLimit, appendAnswerKey, numericInputConfig } from "../../apps/web/src/lib/questionInput";

let numeric = 0;
let text = 0;
const bank = path.resolve("apps/web/public/data/books");
for (const book of fs.readdirSync(bank)) {
  const lessons = path.join(bank, book, "lessons");
  if (!fs.existsSync(lessons)) continue;
  for (const name of fs.readdirSync(lessons)) {
    const lesson = JSON.parse(fs.readFileSync(path.join(lessons, name), "utf8"));
    for (const q of lesson.questions as Question[]) {
      if (!["fill_blank", "calculation", "word_problem", "fill_blank_text"].includes(q.type)) continue;
      const config = q.type === "fill_blank_text" ? null : numericInputConfig(q.answer);
      const entered = config?.value ?? q.answer;
      assert(entered.length <= answerInputLimit(q.answer), `${lesson.id} #${q.id}: truncated answer`);
      assert(gradeAnswer(q, entered), `${lesson.id} #${q.id}: input cannot express answer`);
      let fromKeys = "";
      for (const key of entered) fromKeys = appendAnswerKey(fromKeys, key, q.answer);
      assert.equal(fromKeys, entered, `${lesson.id} #${q.id}: keypad cannot enter full answer`);
      if (config) numeric++; else text++;
    }
  }
}

assert.equal(numericInputConfig("亿"), null);
assert.equal(numericInputConfig("1，2"), null); // Multiple blanks must use free text.
assert.equal(numericInputConfig("1 2"), null);
assert.equal(numericInputConfig("1 / 2")?.value, "1/2");
assert.equal(numericInputConfig("三十，四十"), null);
assert.equal(numericInputConfig("12厘米")?.value, "12");
assert.equal(numericInputConfig("１２.５千克")?.value, "12.5");
assert.deepEqual(numericInputConfig("-2.5")?.extraKeys, ["-"]);
assert.deepEqual(numericInputConfig("3/4")?.extraKeys, ["/"]);
assert.deepEqual(numericInputConfig("25%")?.extraKeys, ["%"]);
let ordinal = "";
for (const key of "thirty-first") ordinal = appendAnswerKey(ordinal, key, "thirty-first");
assert.equal(ordinal, "thirty-first");
assert.equal(appendAnswerKey("学习😀", "⌫", "学习"), "学习");
assert(answerInputLimit("这是一个需要完整填写的较长答案。".repeat(10)) > 100);
console.log(`PASS: ${numeric} numeric and ${text} text questions from the real bank; text fallback, keyboard formats, long answers, and deletion.`);
