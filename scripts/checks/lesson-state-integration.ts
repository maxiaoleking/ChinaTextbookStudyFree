import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { gradeAnswer } from "../../packages/core/src/grade";
import { decideMascotMood, decideMascotReaction } from "../../packages/core/src/mascotTriggers";
import { isAnswerComplete } from "../../apps/web/src/lib/questionAnswer";
import { isNewLessonTimeLimited, localStudyDate } from "../../apps/web/src/lib/learningLimit";
import type { Question } from "../../packages/core/src/types";

// Run the actual component handlers/effects, extracted through TypeScript's AST,
// with batched state setters and the real persisted store. Only visual/sound
// callbacks and scheduled animations are stubbed; grading/rewards are real.
async function main() {
  const RealDate = Date;
  let now = new RealDate(2026, 9, 5, 12).getTime();
  class FixedDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? now : value instanceof RealDate ? value.getTime() : value);
    }
    static now() { return now; }
  }
  globalThis.Date = FixedDate as DateConstructor;
  const storage = new Map<string, string>();
  globalThis.localStorage = {
    get length() { return storage.size; }, clear: () => storage.clear(),
    getItem: key => storage.get(key) ?? null, key: i => [...storage.keys()][i] ?? null,
    removeItem: key => { storage.delete(key); }, setItem: (key, value) => { storage.set(key, value); },
  };
  const { useProgressStore: store, FIRST_PERFECT_XP_BONUS, isWeekendBonusActive } = await import("../../apps/web/src/store/progress");
  const initial = store.getInitialState();
  const runnerSource = parse("apps/web/src/components/LessonRunner.tsx");
  const modalSource = parse("apps/web/src/components/LessonStartModal.tsx");
  const runner = namedFunction(runnerSource, "LessonRunner");
  const effects = runner.body!.statements
    .filter(ts.isExpressionStatement).map(s => s.expression)
    .filter(ts.isCallExpression).filter(c => c.expression.getText(runnerSource) === "useEffect")
    .map(c => c.arguments[0]);
  const restoration = effects.find(effect => effect.getText(runnerSource).includes("const stored ="))!;
  const persistence = effects.find(effect => effect.getText(runnerSource).includes("upsertLessonSession({"))!;
  const clearing = effects.find(effect => effect.getText(runnerSource).includes("if (done || failed)"))!;
  const xpPerCorrect = moduleConstant(runnerSource, "XP_PER_CORRECT");
  const perfectBonus = moduleConstant(runnerSource, "PERFECT_BONUS");
  const question: Question = {
    id: 1, type: "choice", score: 10, difficulty: 1, knowledge_point: "计数",
    question: "1+1等于几？", options: ["1", "2", "3", "4"], answer: "B", explanation: "等于2。",
  };
  let passed = 0, failed = 0;
  async function test(name: string, run: () => void | Promise<void>) {
    now = new RealDate(2026, 9, 5, 12).getTime();
    storage.clear(); store.setState(initial, true); store.setState({ dailyGoal: 500 });
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  }
  function makeRunner(count = 2, withChest = false) {
    const questions = Array.from({ length: count }, (_, i) => ({ ...question, id: i + 1 }));
    const pending = new Map<string, unknown>();
    let clearFinishedSession = () => {};
    const scope: Record<string, any> = {
      lesson: { id: "test-lesson", title: "计数", bookId: "math", questions },
      index: 0, answer: "", phase: "answering", isCorrect: null,
      correctCount: 0, mistakeCount: 0, combo: 0, maxCombo: 0, sessionXpPreview: 0,
      done: false, failed: false, ready: false, showIntro: false, timeLimited: false, sessionStats: null,
      checkedIndexRef: { current: -1 }, continuedIndexRef: { current: -1 },
      startTimeRef: { current: now }, xpTargetRef: { current: null }, xpFloatIdRef: { current: 0 },
      chestSlot: withChest ? { id: "test-chest", afterLessonId: "test-lesson" } : null,
      XP_PER_CORRECT: xpPerCorrect, PERFECT_BONUS: perfectBonus, FIRST_PERFECT_XP_BONUS,
      useProgressStore: store, isWeekendBonusActive, isNewLessonTimeLimited, gradeAnswer, isAnswerComplete,
      decideMascotMood, decideMascotReaction,
      recordComplete: store.getState().recordLessonComplete, loseHeart: store.getState().loseHeart,
      addMistake: store.getState().addMistake, upsertLessonSession: store.getState().upsertLessonSession,
      clearLessonSession: store.getState().clearLessonSession, addGems: store.getState().addGems,
      claimChest: store.getState().claimChest, rollChestReward: () => ({ gems: 15, tier: "common" }),
      prefersReduced: true, window: undefined, setTimeout: () => 0,
      haptic: () => {}, playSfx: () => {}, triggerReact: () => {}, showBubble: () => {},
      showComboOverlay: () => {},
    };
    for (const key of ["index", "answer", "phase", "isCorrect", "correctCount", "mistakeCount", "combo",
      "maxCombo", "sessionXpPreview", "done", "failed", "ready", "showIntro", "timeLimited", "sessionStats",
      "mascotMood", "mascotReact", "xpFloats"]) {
      scope[`set${key[0].toUpperCase()}${key.slice(1)}`] = (next: any) => {
        const before = pending.has(key) ? pending.get(key) : scope[key];
        pending.set(key, typeof next === "function" ? next(before) : next);
      };
    }
    const render = () => {
      scope.total = questions.length; scope.current = questions[scope.index];
      scope.hearts = store.getState().hearts;
      scope.alreadyPerfected = !!store.getState().perfectedLessons[scope.lesson.id];
      scope.chestAlreadyClaimed = !!(scope.chestSlot && store.getState().claimedChests[scope.chestSlot.id]);
    };
    const flush = () => {
      for (const [key, value] of pending) scope[key] = value;
      pending.clear(); render(); clearFinishedSession();
    };
    render();
    const check = compile(scope, declaration(runner, runnerSource, "handleCheck"), "handleCheck");
    const proceed = compile(scope, declaration(runner, runnerSource, "handleContinue"), "handleContinue");
    const restore = compile(scope, `const extracted = ${restoration.getText(runnerSource)};`, "extracted");
    const persist = compile(scope, `const extracted = ${persistence.getText(runnerSource)};`, "extracted");
    clearFinishedSession = compile(scope, `const extracted = ${clearing.getText(runnerSource)};`, "extracted");
    return { scope, render, flush, check, proceed, restore, persist };
  }
  function answerCorrect(t: ReturnType<typeof makeRunner>) {
    t.scope.answer = "B"; t.check(); t.flush(); t.persist();
  }
  function finish(t: ReturnType<typeof makeRunner>) {
    for (let i = t.scope.index; i < t.scope.total; i++) {
      answerCorrect(t); t.proceed(); t.proceed(); t.flush();
    }
    return t.scope.sessionStats;
  }
  function makeModal() {
    const routes: string[] = [];
    const modal = namedFunction(modalSource, "LessonStartModal");
    const fakeStore = Object.assign((select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()),
      { getState: store.getState });
    const declarations = modal.body!.statements.filter(ts.isVariableStatement).map(s => s.getText(modalSource)).join("\n");
    const scope = {
      useProgressStore: fakeStore, useProgressTicker: () => now,
      useRouter: () => ({ push: (path: string) => routes.push(path) }),
      isNewLessonTimeLimited, lessonId: "test-lesson", bookId: "math", questionCount: 2,
      playSfx: () => {}, haptic: () => {},
    };
    return { routes, ...compile(scope,
      `${declarations}
       ${declaration(modal, modalSource, "handleStart")}
       ${declaration(modal, modalSource, "handleRestart")}
       const result = { start: handleStart, restart: handleRestart, canStart, canRestart, timeLimited };`, "result") };
  }

  await test("blank checking and continuing an unanswered question do nothing", () => {
    const t = makeRunner();
    t.check(); t.proceed(); t.flush();
    assert.equal(t.scope.phase, "answering");
    assert.equal(t.scope.correctCount, 0); assert.equal(t.scope.index, 0);
    assert.equal(store.getState().xp, 0);
  });

  await test("rapid duplicate check and continue calls count and advance only once", () => {
    const t = makeRunner(3);
    t.scope.answer = "B";
    for (let i = 0; i < 10; i++) t.check();
    t.flush();
    assert.equal(t.scope.correctCount, 1); assert.equal(t.scope.combo, 1);
    assert.equal(t.scope.sessionXpPreview, xpPerCorrect);
    for (let i = 0; i < 10; i++) t.proceed();
    t.flush();
    assert.equal(t.scope.index, 1); assert.equal(t.scope.phase, "answering");
  });

  await test("checked correct answer survives refresh and cannot be counted twice", async () => {
    const t = makeRunner(); t.scope.ready = true;
    answerCorrect(t);
    await store.persist.rehydrate();
    const restored = makeRunner(); restored.restore(); restored.flush();
    assert.equal(restored.scope.phase, "checked");
    assert.equal(restored.scope.answer, "B"); assert.equal(restored.scope.isCorrect, true);
    restored.check(); restored.flush();
    assert.equal(restored.scope.correctCount, 1);
    restored.proceed(); restored.flush();
    assert.equal(restored.scope.index, 1); assert.equal(store.getState().hearts, 5);
  });

  await test("checked incorrect answer survives refresh without another lost heart", async () => {
    const t = makeRunner(); t.scope.ready = true; t.scope.answer = "A";
    t.check(); t.check(); t.flush(); t.persist();
    assert.equal(store.getState().hearts, 4);
    await store.persist.rehydrate();
    const restored = makeRunner(); restored.restore(); restored.flush();
    assert.equal(restored.scope.phase, "checked"); assert.equal(restored.scope.isCorrect, false);
    restored.check(true); restored.flush();
    assert.equal(store.getState().hearts, 4); assert.equal(restored.scope.mistakeCount, 1);
  });

  await test("legacy checked session cannot double score even without answer or phase", () => {
    store.getState().upsertLessonSession({
      lessonId: "test-lesson", index: 0, correctCount: 1, mistakeCount: 0, combo: 1, startedAt: now,
    });
    const t = makeRunner(); t.restore(); t.flush();
    assert.equal(t.scope.phase, "checked"); assert.equal(t.scope.isCorrect, null);
    t.scope.answer = "B"; t.check(); t.flush();
    assert.equal(t.scope.correctCount, 1);
    t.proceed(); t.flush();
    assert.equal(t.scope.index, 1);
  });

  await test("legacy answering session remains answerable without granting prior credit", () => {
    store.getState().upsertLessonSession({
      lessonId: "test-lesson", index: 1, correctCount: 1, mistakeCount: 0, combo: 1, startedAt: now,
    });
    const t = makeRunner(); t.restore(); t.flush();
    assert.equal(t.scope.phase, "answering"); assert.equal(t.scope.correctCount, 1);
    assert.equal(finish(t).accuracy, 1);
  });

  await test("refreshing the checked final answer completes once with the original score", async () => {
    const t = makeRunner(); t.scope.ready = true;
    answerCorrect(t); t.proceed(); t.flush(); answerCorrect(t);
    await store.persist.rehydrate();
    const restored = makeRunner(); restored.restore(); restored.flush();
    assert.equal(restored.scope.index, 1); assert.equal(restored.scope.correctCount, 2);
    restored.proceed(); restored.proceed(); restored.flush();
    assert.equal(restored.scope.sessionStats.accuracy, 1);
    assert.equal(restored.scope.sessionStats.xp, 30);
    assert.equal(Object.values(store.getState().lessonHistory).reduce((a, b) => a + b, 0), 1);
  });

  await test("restoring an oversized legacy session clamps credit to visible answered questions", () => {
    store.getState().upsertLessonSession({
      lessonId: "test-lesson", index: 50, correctCount: 50, mistakeCount: 1, combo: 0, startedAt: now,
    });
    const t = makeRunner(); t.restore(); t.flush();
    assert.equal(t.scope.index, 1); assert.equal(t.scope.correctCount, 1);
    assert.equal(t.scope.mistakeCount, 1);
    t.proceed(); t.flush();
    assert.equal(t.scope.sessionStats.accuracy, 0.5);
    assert.equal(t.scope.sessionStats.perfect, false);
    assert.equal(t.scope.sessionStats.firstPerfect, false);
  });

  await test("restoring a negative legacy index still presents the first valid question", () => {
    store.getState().upsertLessonSession({
      lessonId: "test-lesson", index: -5, correctCount: 0, mistakeCount: 0, combo: 0, startedAt: now,
    });
    const t = makeRunner(); t.restore(); t.flush();
    assert.equal(t.scope.index, 0); assert.equal(t.scope.current.id, 1);
    assert.equal(t.scope.correctCount, 0); assert.equal(t.scope.phase, "answering");
  });

  await test("a replenished heart since render prevents a false failure", () => {
    store.setState({ hearts: 1, nextHeartAt: now + 300_000 });
    const t = makeRunner();
    store.setState({ hearts: 2 }); // ticker updates store before React applies its next render.
    t.scope.answer = "A"; t.check(); t.flush();
    assert.equal(store.getState().hearts, 1); assert.equal(t.scope.failed, false);
  });

  await test("mounting an expired zero-heart state restores hearts before deciding failure", () => {
    store.setState({ hearts: 0, nextHeartAt: now - 1 });
    const t = makeRunner(); assert.equal(t.scope.ready, false);
    t.restore(); t.flush();
    assert.equal(store.getState().hearts, 1); assert.equal(t.scope.failed, false);
  });

  await test("blocked direct course entry neither writes a session nor discards another ongoing course", () => {
    const other = { lessonId: "other-lesson", index: 1, correctCount: 1, mistakeCount: 0, combo: 1, startedAt: now };
    store.setState({ dailyTimeLimitMs: 60_000, todayTimeMs: 60_000, lastXpDate: localStudyDate(now), activeLesson: other });
    const t = makeRunner(); t.restore(); t.flush(); t.persist();
    assert.equal(t.scope.timeLimited, true); assert.equal(t.scope.ready, true);
    assert.deepEqual(store.getState().activeLesson, other); assert.equal(store.getState().xp, 0);
  });

  await test("same-course direct entry resumes an ongoing session after the daily limit", () => {
    const ongoing = { lessonId: "test-lesson", index: 1, correctCount: 1, mistakeCount: 0, combo: 1, startedAt: now };
    store.setState({ dailyTimeLimitMs: 60_000, todayTimeMs: 60_000, lastXpDate: localStudyDate(now), activeLesson: ongoing });
    const t = makeRunner(); t.restore(); t.flush(); t.persist();
    assert.equal(t.scope.timeLimited, false); assert.equal(t.scope.index, 1);
    assert.equal(store.getState().activeLesson?.lessonId, "test-lesson");
  });

  await test("unlimited and prior-day direct entries begin a new course normally", () => {
    for (const patch of [{ dailyTimeLimitMs: 0 }, { dailyTimeLimitMs: 60_000, lastXpDate: "2026-10-04" }]) {
      store.setState({ todayTimeMs: 60_000, lastXpDate: localStudyDate(now), activeLesson: null, ...patch });
      const t = makeRunner(); t.restore(); t.flush(); t.persist();
      assert.equal(t.scope.timeLimited, false); assert.equal(store.getState().activeLesson?.lessonId, "test-lesson");
    }
  });

  await test("the start modal blocks new-course navigation at the daily limit", () => {
    store.setState({ dailyTimeLimitMs: 60_000, todayTimeMs: 60_000, lastXpDate: localStudyDate(now) });
    const modal = makeModal();
    assert.equal(modal.canStart, false); assert.equal(modal.timeLimited, true);
    modal.start(); assert.deepEqual(modal.routes, []);
  });

  await test("the start handler rechecks a newly reached limit after its last render", () => {
    store.setState({ dailyTimeLimitMs: 60_000, todayTimeMs: 59_000, lastXpDate: localStudyDate(now) });
    const modal = makeModal(); assert.equal(modal.canStart, true);
    store.getState().addLearningTimeMs(1000);
    modal.start(); assert.deepEqual(modal.routes, []);
  });

  await test("restarting cannot clear or bypass the ongoing-course exemption at the limit", () => {
    const ongoing = { lessonId: "test-lesson", index: 1, correctCount: 1, mistakeCount: 0, combo: 1, startedAt: now };
    store.setState({ dailyTimeLimitMs: 60_000, todayTimeMs: 60_000, lastXpDate: localStudyDate(now), activeLesson: ongoing });
    const modal = makeModal();
    assert.equal(modal.canStart, true); assert.equal(modal.canRestart, false);
    modal.restart(); assert.deepEqual(modal.routes, []); assert.deepEqual(store.getState().activeLesson, ongoing);
    modal.start(); assert.deepEqual(modal.routes, ["/lesson/math/test-lesson/"]);
  });

  await test("restart rechecks a newly reached limit and preserves the saved session", () => {
    const ongoing = { lessonId: "test-lesson", index: 1, correctCount: 1, mistakeCount: 0, combo: 1, startedAt: now };
    store.setState({ dailyTimeLimitMs: 60_000, todayTimeMs: 59_000, lastXpDate: localStudyDate(now), activeLesson: ongoing });
    const modal = makeModal(); assert.equal(modal.canRestart, true);
    store.getState().addLearningTimeMs(1000);
    modal.restart(); assert.deepEqual(modal.routes, []); assert.deepEqual(store.getState().activeLesson, ongoing);
  });

  await test("unlimited restart clears old progress and navigates exactly once", () => {
    store.setState({ dailyTimeLimitMs: 0 });
    store.getState().upsertLessonSession({ lessonId: "test-lesson", index: 1, correctCount: 1, mistakeCount: 0, combo: 1, startedAt: now });
    const modal = makeModal(); modal.restart();
    assert.equal(store.getState().activeLesson, null); assert.deepEqual(modal.routes, ["/lesson/math/test-lesson/"]);
  });

  await test("losing the final heart fails the session and clears persisted course progress", () => {
    store.setState({ hearts: 1, nextHeartAt: now + 300_000 });
    store.getState().upsertLessonSession({
      lessonId: "test-lesson", index: 0, correctCount: 0, mistakeCount: 0, combo: 0, startedAt: now,
    });
    const t = makeRunner(); t.scope.ready = true; t.scope.answer = "A";
    t.check(); t.flush(); t.persist();
    assert.equal(store.getState().hearts, 0); assert.equal(t.scope.failed, true);
    assert.equal(store.getState().activeLesson, null);
    t.proceed(); t.flush(); assert.equal(store.getState().xp, 0);
  });

  await test("retry callback cannot run at zero hearts and clears the session before a full reload", () => {
    let reloads = 0;
    const scope: Record<string, any> = {
      canRetry: false, playSfx: () => {}, haptic: () => {},
      clearLessonSession: store.getState().clearLessonSession,
      window: { location: { reload: () => { reloads++; } } },
    };
    scope.onRetry = compile(scope, `const callback = ${jsxAttributeExpression(runner, runnerSource, "onRetry")};`, "callback");
    const failScreen = namedFunction(runnerSource, "FailScreen");
    const click = compile(scope,
      `const callback = ${jsxAttributeExpression(failScreen, runnerSource, "onClick", "onRetry()")};`, "callback");
    click(); assert.equal(reloads, 0);
    store.getState().upsertLessonSession({
      lessonId: "test-lesson", index: 0, correctCount: 0, mistakeCount: 0, combo: 0, startedAt: now,
    });
    scope.canRetry = true; click();
    assert.equal(reloads, 1); assert.equal(store.getState().activeLesson, null);
  });

  await test("weekday first perfect completion rewards and display use actual XP/gems deltas", () => {
    const t = makeRunner(2, true);
    const stats = finish(t);
    assert.equal(stats.xp, 30); assert.equal(stats.gemsEarned, 43);
    assert.equal(stats.xp, store.getState().xp); assert.equal(stats.gemsEarned, store.getState().gems);
    assert.equal(stats.firstPerfect, true); assert.equal(stats.bonusMultiplier, 1);
    assert.equal(store.getState().claimedChests["test-chest"], true);
    assert.equal(store.getState().perfectedLessons["test-lesson"], true);
    assert.equal(store.getState().activeLesson, null);
    assert.equal(Object.values(store.getState().lessonHistory).reduce((a, b) => a + b, 0), 1);
  });

  await test("weekend first perfect completion display includes doubled XP and both doubled badges", () => {
    now = new RealDate(2026, 9, 10, 12).getTime();
    const t = makeRunner(); const stats = finish(t);
    assert.equal(stats.xp, 60); assert.equal(stats.gemsEarned, 28);
    assert.equal(stats.bonusMultiplier, 2);
    const badgeScope = { PERFECT_BONUS: perfectBonus, FIRST_PERFECT_XP_BONUS, bonusMultiplier: stats.bonusMultiplier };
    assert.equal(compile(badgeScope, `const value = ${badgeExpression(runnerSource, "零失误")};`, "value"), 10);
    assert.equal(compile(badgeScope, `const value = ${badgeExpression(runnerSource, "首次完美")};`, "value"), 10);
  });

  await test("replaying a perfect lesson neither repeats its first-perfect XP nor chest reward", () => {
    finish(makeRunner(2, true));
    const xpBefore = store.getState().xp, gemsBefore = store.getState().gems;
    const stats = finish(makeRunner(2, true));
    assert.equal(stats.firstPerfect, false); assert.equal(stats.xp, 25); assert.equal(stats.gemsEarned, 13);
    assert.equal(store.getState().xp - xpBefore, stats.xp);
    assert.equal(store.getState().gems - gemsBefore, stats.gemsEarned);
    assert.equal(stats.chestReward, null);
  });

  await test("completion gem display includes the same-day goal and streak milestone", () => {
    store.setState({ dailyGoal: 20, streak: 2, lastActiveDate: "2026-10-04" });
    const stats = finish(makeRunner());
    assert.equal(stats.gemsEarned, 78); // 28 lesson + 20 goal + 30 streak.
    assert.equal(stats.gemsEarned, store.getState().gems);
  });

  await test("start modal recognizes and counts a legacy checked first-question session", () => {
    const activeLesson = { lessonId: "test-lesson", index: 0, correctCount: 1, mistakeCount: 0, combo: 1, startedAt: now };
    const modal = namedFunction(modalSource, "LessonStartModal");
    const vars = modal.body!.statements.filter(ts.isVariableStatement).flatMap(s => s.declarationList.declarations);
    const resumeIndex = vars.findIndex(d => d.name.getText(modalSource) === "resume");
    const remainingIndex = vars.findIndex(d => d.name.getText(modalSource) === "remaining");
    assert.ok(resumeIndex >= 0 && remainingIndex >= resumeIndex);
    const declarations = vars.slice(resumeIndex, remainingIndex + 1).map(d => `const ${d.getText(modalSource)};`).join("\n");
    const result = compile({ activeLesson, lessonId: "test-lesson", questionCount: 2 },
      `${declarations}
       const result = { resume, remaining };`, "result");
    assert.ok(result.resume); assert.equal(result.remaining, 1);
  });

  globalThis.Date = RealDate;
  console.log(`Lesson state integration: ${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

function parse(path: string) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(declaration && ts.isFunctionDeclaration(declaration), `Missing function ${name}`);
  return declaration;
}
function declaration(component: ts.FunctionDeclaration, source: ts.SourceFile, name: string) {
  const found = component.body!.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(found, `Missing handler ${name}`);
  return found.getText(source);
}
function moduleConstant(source: ts.SourceFile, name: string) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const found = statement.declarationList.declarations.find(d => d.name.getText(source) === name);
    if (found?.initializer) return Number(found.initializer.getText(source));
  }
  throw new Error(`Missing constant ${name}`);
}
function badgeExpression(source: ts.SourceFile, label: string) {
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "span" &&
      node.children.some(child => ts.isJsxText(child) && child.text.includes(label))) {
      const child = node.children.find(ts.isJsxExpression);
      if (child?.expression) expression = child.expression.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(expression, `Missing badge ${label}`); return expression;
}
function jsxAttributeExpression(component: ts.FunctionDeclaration, source: ts.SourceFile, name: string, contains = "") {
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === name && node.initializer &&
      ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const value = node.initializer.expression.getText(source);
      if (value.includes(contains)) expression = value;
    }
    ts.forEachChild(node, visit);
  }
  visit(component); assert.ok(expression, `Missing JSX ${name}`); return expression;
}
function compile(scope: Record<string, any>, code: string, result: string): any {
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function("scope", `with (scope) { ${output}; return ${result}; }`)(scope);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
