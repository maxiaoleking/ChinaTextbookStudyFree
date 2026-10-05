import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { isNewLessonTimeLimited, localStudyDate } from "../../apps/web/src/lib/learningLimit";
import { countCompletedCourses, courseRecord, courseResults, isCourseLessonId } from "../../apps/web/src/lib/courseProgress";

const now = new Date(2026, 9, 5, 12).getTime();
const initial = { dailyTimeLimitMs: 20 * 60_000, todayTimeMs: 20 * 60_000, lastXpDate: localStudyDate(now), activeLesson: null };
let passed = 0, failed = 0;
function test(name: string, run: () => void) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
}
test("no configured daily limit never blocks a new course", () => {
  assert.equal(isNewLessonTimeLimited({ ...initial, dailyTimeLimitMs: 0 }, "math", now), false);
});
test("elapsed time below the daily limit remains eligible", () => {
  assert.equal(isNewLessonTimeLimited({ ...initial, todayTimeMs: initial.dailyTimeLimitMs - 1 }, "math", now), false);
});
test("the exact daily threshold blocks a new course", () => {
  assert.equal(isNewLessonTimeLimited(initial, "math", now), true);
});
test("elapsed time above the daily limit remains blocked", () => {
  assert.equal(isNewLessonTimeLimited({ ...initial, todayTimeMs: initial.dailyTimeLimitMs + 1 }, "math", now), true);
});
test("a completed prior day's time never blocks today before the next timer reset", () => {
  assert.equal(isNewLessonTimeLimited({ ...initial, lastXpDate: "2026-10-04" }, "math", now), false);
});
test("a missing daily date never treats stale time as today's time", () => {
  assert.equal(isNewLessonTimeLimited({ ...initial, lastXpDate: "" }, "math", now), false);
});
test("an ongoing session for the same course can finish at the daily limit", () => {
  assert.equal(isNewLessonTimeLimited({ ...initial, activeLesson: { lessonId: "math" } }, "math", now), false);
});
test("an ongoing different course does not bypass the daily limit", () => {
  assert.equal(isNewLessonTimeLimited({ ...initial, activeLesson: { lessonId: "chinese" } }, "math", now), true);
});
test("local midnight releases yesterday's exhausted limit without a store mutation", () => {
  const midnight = new Date(2026, 9, 6, 0, 0, 0).getTime();
  const state = { ...initial, lastXpDate: localStudyDate(midnight - 1) };
  assert.equal(isNewLessonTimeLimited(state, "math", midnight - 1), true);
  assert.equal(isNewLessonTimeLimited(state, "math", midnight), false);
});
test("shared study date follows local calendar fields rather than UTC dates", () => {
  const time = new Date(2026, 9, 6, 0, 5).getTime();
  assert.equal(localStudyDate(time), "2026-10-06");
});

const rail = source("apps/web/src/components/layout/RightRail.tsx");
function railData(component: string, snapshot: Record<string, unknown>, time = now) {
  const body = componentBody(rail, component);
  const code = body.statements.filter(ts.isVariableStatement).map(s => s.getText(rail)).join("\n");
  const fields = component === "DailyQuestsCard" ? "{ displayXp, pct, target }" : "{ completed, remaining, reached, pct }";
  return evaluate({
    useProgressStore: (select: (state: Record<string, unknown>) => unknown) => select(snapshot),
    useProgressTicker: () => time, localStudyDate, countCompletedCourses,
  }, `${code}; const result = ${fields};`, "result");
}
test("actual daily card displays zero for yesterday's XP", () => {
  assert.deepEqual(railData("DailyQuestsCard", { todayXp: 50, lastXpDate: "2026-10-04" }), { displayXp: 0, pct: 0, target: 10 });
});
test("actual daily card displays today's partial progress", () => {
  assert.deepEqual(railData("DailyQuestsCard", { todayXp: 5, lastXpDate: localStudyDate(now) }), { displayXp: 5, pct: 50, target: 10 });
});
test("actual daily card progress caps at 100 percent", () => {
  assert.deepEqual(railData("DailyQuestsCard", { todayXp: 50, lastXpDate: localStudyDate(now) }), { displayXp: 50, pct: 100, target: 10 });
});
test("actual daily card resets on the ticker's new local day without changing stored XP", () => {
  const midnight = new Date(2026, 9, 6, 0, 0, 0).getTime();
  const snapshot = { todayXp: 10, lastXpDate: localStudyDate(midnight - 1) };
  assert.equal(railData("DailyQuestsCard", snapshot, midnight - 1).pct, 100);
  assert.equal(railData("DailyQuestsCard", snapshot, midnight).pct, 0);
  assert.equal(snapshot.todayXp, 10);
});

const mixed = { "g1up-u1-kp1": { stars: 3 }, "chinese-g2up-u1-kp1": { stars: 2 },
  "passage-demo-listen": { stars: 3 }, "passage-demo-read": { stars: 3 }, "story-demo": { stars: 3 } };
test("course count, record and results share the same synthetic activity filtering", () => {
  assert.equal(countCompletedCourses(mixed), 2);
  assert.deepEqual(courseRecord(mixed), { "g1up-u1-kp1": mixed["g1up-u1-kp1"], "chinese-g2up-u1-kp1": mixed["chinese-g2up-u1-kp1"] });
  assert.equal(courseResults(mixed).reduce((sum, result) => sum + result.stars, 0), 5);
  assert.equal(isCourseLessonId("passage-demo-listen"), false);
  assert.equal(isCourseLessonId("story-demo"), false);
});
test("course helpers preserve input records and support empty progress", () => {
  const before = JSON.stringify(mixed);
  courseRecord(mixed); courseResults(mixed); countCompletedCourses(mixed);
  assert.equal(JSON.stringify(mixed), before);
  assert.deepEqual(courseResults({}), []); assert.deepEqual(courseRecord({}), {}); assert.equal(countCompletedCourses({}), 0);
});
test("actual milestone excludes reading rewards from its ten-course progress", () => {
  assert.deepEqual(railData("LearningMilestoneCard", { completedLessons: mixed }), { completed: 2, remaining: 8, reached: false, pct: 20 });
});
test("actual milestone persists in the reached state after ten completed courses", () => {
  const courses = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`math-course-${i}`, {}]));
  assert.deepEqual(railData("LearningMilestoneCard", { completedLessons: courses }), { completed: 12, remaining: 0, reached: true, pct: 100 });
  const body = componentBody(rail, "LearningMilestoneCard");
  assert.ok(!body.statements.some(s => ts.isIfStatement(s) && s.getText(rail).includes("return null")));
  assert.ok(!body.getText(rail).includes("解锁排行榜"));
});

const review = source("apps/web/src/app/review/ReviewClient.tsx");
const bottom = source("apps/web/src/components/BottomNav.tsx");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(value?: string | number | Date) { super(value === undefined ? now : value instanceof RealDate ? value.getTime() : value); }
  static now() { return now; }
}
function reviewCounts(mistakes: Array<Record<string, unknown>>, hydrated = true) {
  const definitions = review.statements.filter(s => ts.isFunctionDeclaration(s) &&
    ["todayKey", "tomorrowKey", "isDueToday", "isTomorrow", "isLater"].includes(s.name?.text ?? "")).map(s => s.getText(review)).join("\n");
  const reviewBody = componentBody(review, "ReviewClient");
  const dueDeclaration = variables(reviewBody).find(v => v.name.getText(review) === "dueCount")!;
  const navBody = componentBody(bottom, "BottomNav");
  const badgeDeclaration = variables(navBody).find(v => v.name.getText(bottom) === "reviewBadge")!;
  return evaluate({ mistakes, hydrated, Date: FixedDate, today: localStudyDate(now) },
    `${definitions}; const dueCount = ${dueDeclaration.initializer!.getText(review)};
     const reviewBadge = ${badgeDeclaration.initializer!.getText(bottom)};
     const tomorrowCount = mistakes.filter(m => isTomorrow(m.nextReviewDate)).length;
     const laterCount = mistakes.filter(m => isLater(m.nextReviewDate)).length;
     const result = { dueCount, reviewBadge, tomorrowCount, laterCount };`, "result");
}
test("actual review and mobile badge agree on overdue, today, tomorrow and later entries", () => {
  const mistakes = [{ nextReviewDate: "2026-10-04" }, { nextReviewDate: "2026-10-05" },
    { nextReviewDate: "2026-10-06" }, { nextReviewDate: "2026-10-15" }, {}];
  assert.deepEqual(reviewCounts(mistakes), { dueCount: 3, reviewBadge: 3, tomorrowCount: 1, laterCount: 1 });
});
test("scheduled future reviews do not appear as today's tasks or nav badge", () => {
  assert.deepEqual(reviewCounts([{ nextReviewDate: "2026-10-06" }, { nextReviewDate: "2026-10-15" }]),
    { dueCount: 0, reviewBadge: 0, tomorrowCount: 1, laterCount: 1 });
});
test("review badge does not flash persisted counts before hydration", () => {
  const result = reviewCounts([{ nextReviewDate: "2026-10-05" }, {}], false);
  assert.equal(result.dueCount, 0); assert.equal(result.reviewBadge, 0);
});

console.log(`Learning limits and daily semantics: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;

function source(path: string) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function componentBody(file: ts.SourceFile, name: string) {
  const component = file.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(component && ts.isFunctionDeclaration(component) && component.body, `Missing component ${name}`);
  return component.body;
}
function variables(body: ts.Block) {
  return body.statements.filter(ts.isVariableStatement).flatMap(s => s.declarationList.declarations);
}
function evaluate(scope: Record<string, unknown>, code: string, result: string): any {
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function("scope", `with (scope) { ${output}; return ${result}; }`)(scope);
}
