/** Correct, clearly wrong, empty, and structurally invalid submissions. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gradeAnswer } from "../../packages/core/src/grade";
import type { Question } from "../../packages/core/src/types";

let lessons = 0;
let stories = 0;
const types = new Map<string, number>();
function check(question: Question, label: string) {
  let submitted = question.answer;
  if (question.type === "choice") {
    const index = question.options.findIndex(option => option.trim() === question.answer.trim());
    assert(index >= 0, label + ": choice fixture has no exact correct option");
    submitted = String.fromCharCode(65 + index);
    question.options.forEach((_, i) => {
      assert.equal(gradeAnswer(question, String.fromCharCode(65 + i)), i === index, label);
    });
  }
  assert(gradeAnswer(question, submitted), label + ": correct answer rejected");
  assert(gradeAnswer(question, ` ${submitted} `), label + ": surrounding whitespace rejected");
  assert(!gradeAnswer(question, ""), label + ": empty accepted");
  assert(!gradeAnswer(question, "   "), label + ": blank accepted");
  assert(!gradeAnswer(question, "不存在的答案"), label + ": unrelated answer accepted");
  if (question.type === "true_false") assert(!gradeAnswer(question, ["对", "正确", "true"].includes(question.answer.toLowerCase()) ? "错" : "对"), label);
  if (question.type === "matching") {
    assert(gradeAnswer(question, submitted.split(",").reverse().join(",")), label + ": unordered valid pairs rejected");
    assert(!gradeAnswer(question, submitted + "," + submitted.split(",")[0]), label + ": duplicate pair accepted");
    assert(!gradeAnswer(question, submitted + ",invalid"), label + ": extra garbage accepted");
    assert(!gradeAnswer(question, submitted.split(",").slice(0, -1).join(",")), label + ": incomplete matching accepted");
  }
  types.set(question.type, (types.get(question.type) ?? 0) + 1);
}
const root = path.resolve("apps/web/public/data/books");
for (const book of fs.readdirSync(root)) {
  const folder = path.join(root, book);
  for (const file of fs.readdirSync(path.join(folder, "lessons"))) {
    const lesson = JSON.parse(fs.readFileSync(path.join(folder, "lessons", file), "utf8"));
    for (const question of lesson.questions as Question[]) { check(question, `${lesson.id} #${question.id}`); lessons++; }
  }
  const storyFile = path.join(folder, "stories.json");
  if (fs.existsSync(storyFile)) {
    const doc = JSON.parse(fs.readFileSync(storyFile, "utf8"));
    for (const story of doc.stories) for (const question of story.questions as Question[]) {
      check(question, `${story.id} #${question.id}`); stories++;
    }
  }
}
function numeric(correct: string, user: string, expected: boolean, type = "fill_blank") {
  assert.equal(gradeAnswer({ type, answer: correct } as Question, user), expected, `${type}: ${correct} ← ${user}`);
}
for (const [correct, user, expected] of [
  ["1/2", "1/3", false], ["1/2", "1", false], ["1/2", "0.5", true], ["1/2", "2/4", true],
  ["1", "1/0", false], ["1", "1/2/3", false], ["1", "1..2", false], ["1", "1wrong", false],
  ["2,4", "24", false], ["24", "2,4", false], ["2,4", "4,2", false], ["2,4", "2; 4", true],
  ["2,4", "2 4", true], ["2 4", "24", false], ["2,4", "2,4,4", false], ["2,4", "2,,4", false],
  ["5", "005.000", true], ["0.5", ".5", true], ["12.5", "１２．５", true], ["-3", "−3", true],
  ["25%", "0.25", true], ["25%", "1/4", true], ["25%", "25", false], ["25", "25%", false],
  ["1", "1.0000001", true], ["1", "1.000001", false], ["1", "1.00001", false],
  ["12厘米", "12", true], ["12厘米", "12 cm", true], ["12厘米", "12米", false],
  ["12", "12个", true], ["12", "错误12", false], ["12", "12胡说", false], ["12", "12%kg", false],
  ["9007199254740993", "9007199254740992", false], ["-2", "2", false], ["亿", "亿", true], ["亿", "1", false],
] as const) numeric(correct, user, expected);
numeric("2,4", "24", false, "fill_blank_text");
numeric("2,4", "2，4", true, "fill_blank_text");
numeric("24", "2,4", false, "fill_blank_text");
numeric("太阳,月亮", "太阳月亮", false, "fill_blank_text");
numeric("太阳,月亮", "太阳；月亮", true, "fill_blank_text");
numeric("thirty-first", "thirty-first", true, "fill_blank_text");
assert(gradeAnswer({ type: "true_false", answer: "对" } as Question, "T"));
assert(gradeAnswer({ type: "true_false", answer: "错" } as Question, "f"));
assert(!gradeAnswer({ type: "true_false", answer: "unknown" } as Question, "错"));
console.log(`PASS: ${lessons} lesson and ${stories} story questions; correct/wrong/empty submissions, fractions, percentages, units, full-width inputs, ordered blanks, matching structure, and numeric precision.`);
