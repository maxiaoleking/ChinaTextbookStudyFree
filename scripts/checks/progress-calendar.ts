import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { localStudyDate } from "../../apps/web/src/lib/learningLimit";

const path = "apps/web/src/components/WeeklyReportCard.tsx";
const currentSource = readFileSync(path, "utf8");
// Optional in-memory regression replay; never changes app files or the build.
const sourceText = process.argv.includes("--previous-dependencies")
  ? currentSource.replace("[xpHistory, lessonHistory, todayKey]", "[xpHistory, lessonHistory]")
  : currentSource;
const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === "WeeklyReportCard");
assert.ok(component && ts.isFunctionDeclaration(component) && component.body);
const functions = source.statements.filter(s => ts.isFunctionDeclaration(s) &&
  ["ymd", "startOfWeek"].includes(s.name?.text ?? "")).map(s => s.getText(source)).join("\n");
const labelStatement = source.statements.find(s => ts.isVariableStatement(s) && s.getText(source).includes("const WEEKDAY_LABELS"));
assert.ok(labelStatement);
const body = component.body.statements.filter(ts.isVariableStatement).map(s => s.getText(source)).join("\n");
const executable = ts.transpileModule(`${functions}; ${labelStatement.getText(source)}; ${body};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const renderFromActualSource = new Function("scope", `with (scope) { ${executable}; return data; }`);
const RealDate = Date;
let clock = new RealDate(2026, 9, 4, 23, 59, 59).getTime();
class CalendarDate extends RealDate {
  constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof RealDate ? value.getTime() : value); }
  static now() { return clock; }
}

function makeReport(xpHistory: Record<string, number>, lessonHistory: Record<string, number>) {
  let previousDeps: unknown[] | null = null;
  let previousResult: unknown;
  let computations = 0;
  const scope = {
    Date: CalendarDate, localStudyDate, useProgressTicker: () => clock,
    useProgressStore: (select: (state: { xpHistory: Record<string, number>; lessonHistory: Record<string, number> }) => unknown) => select({ xpHistory, lessonHistory }),
    // Match React useMemo's dependency identity comparison. The callback and
    // dependency list come directly from the real WeeklyReportCard source.
    useMemo: (calculate: () => unknown, deps: unknown[]) => {
      if (!previousDeps || deps.some((value, i) => !Object.is(value, previousDeps![i]))) {
        previousResult = calculate(); previousDeps = [...deps]; computations++;
      }
      return previousResult;
    },
  };
  return { render: () => renderFromActualSource(scope), computations: () => computations };
}
let passed = 0, failed = 0;
function test(name: string, run: () => void) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
}
test("Sunday report starts on the preceding Monday and computes history totals", () => {
  clock = new RealDate(2026, 9, 4, 23, 59, 59).getTime();
  const report = makeReport({ "2026-10-04": 30, "2026-09-27": 10 }, { "2026-10-04": 2, "2026-09-27": 1 });
  const data = report.render();
  assert.equal(data.thisWeek[0].date, "2026-09-28");
  assert.equal(data.thisWeek[6].date, "2026-10-04");
  assert.equal(data.totalXp, 30); assert.equal(data.totalLessons, 2); assert.equal(data.activeDays, 1);
  assert.equal(data.xpDelta, 20); assert.equal(data.lessonDelta, 1);
});
test("Sunday-to-Monday midnight recomputes the actual memo while history identities remain unchanged", () => {
  clock = new RealDate(2026, 9, 4, 23, 59, 59).getTime();
  const report = makeReport({ "2026-10-04": 30 }, { "2026-10-04": 2 });
  assert.equal(report.render().totalXp, 30);
  clock = new RealDate(2026, 9, 5, 0, 0, 0).getTime();
  const data = report.render();
  assert.equal(data.thisWeek[0].date, "2026-10-05"); assert.equal(data.thisWeek[6].date, "2026-10-11");
  assert.equal(data.totalXp, 0); assert.equal(data.totalLessons, 0); assert.equal(data.xpDelta, -30);
  assert.equal(data.thisWeek[0].isToday, true); assert.equal(report.computations(), 2);
});
test("same-day ticker changes retain memo caching while a new day moves the today marker", () => {
  clock = new RealDate(2026, 9, 5, 12).getTime();
  const report = makeReport({ "2026-10-05": 15 }, { "2026-10-05": 1 });
  const first = report.render(); clock += 1000;
  assert.equal(report.render(), first); assert.equal(report.computations(), 1);
  clock = new RealDate(2026, 9, 6, 0, 0, 0).getTime();
  const next = report.render();
  assert.equal(next.totalXp, 15); assert.equal(next.thisWeek[0].isToday, false);
  assert.equal(next.thisWeek[1].isToday, true); assert.equal(report.computations(), 2);
});
console.log(`Progress calendar: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
