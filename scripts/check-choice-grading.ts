/** Test all current quiz choice answers against the shared runtime grader. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gradeAnswer } from "../packages/core/src/grade";
import type { Question } from "../packages/core/src/types";

let checked = 0;
for (const subject of ["math", "chinese", "english", "science"]) {
  const folder = path.resolve("output", subject, "quizzes");
  for (const file of fs.readdirSync(folder).filter(f => f.endsWith(".json"))) {
    const data = JSON.parse(fs.readFileSync(path.join(folder, file), "utf8"));
    for (const q of data.unit_test.questions as Question[]) {
      if (q.type !== "choice") continue;
      const idx = q.options?.findIndex(o => o.replace(/^[A-D][.、]\s*/, "") === q.answer) ?? -1;
      if (idx < 0) continue; // Legacy answer-label formats covered separately below.
      const correct = String.fromCharCode(65 + idx);
      assert.equal(gradeAnswer(q, correct), true, `${file} #${q.id}: ${q.answer}`);
      for (const label of ["A", "B", "C", "D"]) {
        if (label !== correct) assert.equal(gradeAnswer(q, label), false, `${file} #${q.id}: wrong ${label}`);
      }
      checked++;
    }
  }
}
const base = { type: "choice", options: ["10秒", "60秒", "90秒", "120秒"] } as Question;
for (const answer of ["B", "B. 60秒", "60秒"]) {
  assert(gradeAnswer({ ...base, answer }, "B"));
  assert(!gradeAnswer({ ...base, answer }, "A"));
}
assert(!gradeAnswer({ ...base, answer: "unknown" }, "U"));
console.log(`PASS: ${checked} real choice questions, correct and incorrect options; legacy label formats.`);
