import assert from "node:assert/strict";
import { computeChestsForBook, findChestAfterLesson } from "../../packages/core/src/chestLogic";
import { ALL_COSMETICS, DEFAULT_EQUIPPED } from "../../packages/core/src/cosmetics";
import { getDueSrsEntries, reviewSrsEntry } from "../../packages/core/src/srs";
import type { Question, PathLessonMeta } from "../../packages/core/src/types";

// Exercise the real persisted store with an isolated clock and local storage.
// This intentionally never reads or modifies a browser user's progress.
async function main() {
const RealDate = Date;
let clock = new RealDate(2026, 9, 5, 12).getTime();
class TestDate extends RealDate {
  constructor(value?: string | number | Date) {
    super(value === undefined ? clock : value instanceof RealDate ? value.getTime() : value);
  }
  static now() { return clock; }
}
globalThis.Date = TestDate as DateConstructor;
const stored = new Map<string, string>();
globalThis.localStorage = {
  get length() { return stored.size; },
  clear: () => stored.clear(),
  getItem: key => stored.get(key) ?? null,
  key: index => Array.from(stored.keys())[index] ?? null,
  removeItem: key => { stored.delete(key); },
  setItem: (key, value) => { stored.set(key, value); },
};

const { useProgressStore: store, HEART_RECHARGE_MS, MAX_HEARTS } = await import("../../apps/web/src/store/progress");
const baseline = store.getInitialState();
const question: Question = {
  id: 1, type: "choice", score: 10, difficulty: 1, knowledge_point: "计数",
  question: "1 + 1 = ?", options: ["1", "2", "3", "4"], answer: "B", explanation: "等于2。",
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
let failures = 0;
let passed = 0;
async function check(name: string, run: () => void | Promise<void>) {
  clock = new RealDate(2026, 9, 5, 12).getTime();
  stored.clear();
  store.setState(baseline, true);
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

await check("grade switching retains XP, mistakes, hearts and active session", () => {
  const session = { lessonId: "math-1", index: 2, correctCount: 1, mistakeCount: 1, combo: 0, startedAt: clock };
  store.getState().upsertLessonSession(session);
  store.getState().addMistake("math-1", "计数", question);
  store.setState({ xp: 100, hearts: 3 });
  store.getState().setSelectedGrade(2);
  store.getState().setSelectedGrade(null);
  store.getState().setSelectedGrade(5);
  assert.equal(store.getState().selectedGrade, 5);
  assert.equal(store.getState().xp, 100);
  assert.equal(store.getState().hearts, 3);
  assert.equal(store.getState().mistakesBank.length, 1);
  assert.deepEqual(store.getState().activeLesson, session);
});

await check("cosmetics cannot be bought without funds or equipped before ownership", () => {
  const item = ALL_COSMETICS.find(c => c.cost > 0)!;
  assert.equal(store.getState().purchaseCosmetic(item.id).ok, false);
  assert.equal(store.getState().equipCosmetic(item.id), false);
  assert.equal(store.getState().purchaseCosmetic("missing").ok, false);
  assert.equal(store.getState().gems, 0);
});

await check("purchase deducts once, auto equips and retains lifetime earnings", async () => {
  const item = ALL_COSMETICS.find(c => c.type === "mascot_skin" && c.cost > 0)!;
  store.getState().addGems(item.cost);
  assert.equal(store.getState().purchaseCosmetic(item.id).ok, true);
  assert.equal(store.getState().purchaseCosmetic(item.id).ok, false);
  assert.equal(store.getState().gems, 0);
  assert.equal(store.getState().lifetimeGems, item.cost);
  assert.equal(store.getState().equippedMascotSkin, item.id);
  assert.equal(store.getState().equipCosmetic(DEFAULT_EQUIPPED.mascotSkin), true);
  await store.persist.rehydrate();
  assert.equal(store.getState().ownedCosmetics[item.id], true);
  assert.equal(store.getState().equippedMascotSkin, DEFAULT_EQUIPPED.mascotSkin);
});

await check("daily login reward is idempotent before and after rehydration", async () => {
  assert.equal(store.getState().claimDailyReward(), 5);
  assert.equal(store.getState().claimDailyReward(), 0);
  await store.persist.rehydrate();
  assert.equal(store.getState().claimDailyReward(), 0);
  assert.equal(store.getState().gems, 5);
  clock += 24 * 60 * 60_000;
  assert.equal(store.getState().claimDailyReward(), 5);
});

await check("heart losses preserve charging deadline and recover after offline time", async () => {
  store.getState().loseHeart();
  const deadline = store.getState().nextHeartAt;
  assert.equal(deadline, clock + HEART_RECHARGE_MS);
  clock += 60_000;
  store.getState().loseHeart();
  assert.equal(store.getState().nextHeartAt, deadline);
  clock = deadline!;
  store.getState().refreshHearts();
  assert.equal(store.getState().hearts, 4);
  assert.equal(store.getState().nextHeartAt, deadline! + HEART_RECHARGE_MS);
  clock += 10 * HEART_RECHARGE_MS;
  await store.persist.rehydrate();
  store.getState().refreshHearts();
  assert.equal(store.getState().hearts, MAX_HEARTS);
  assert.equal(store.getState().nextHeartAt, null);
  for (let i = 0; i < 10; i++) store.getState().loseHeart();
  assert.equal(store.getState().hearts, 0);
});

await check("completed lesson retains best stars and accuracy after a weaker replay", () => {
  store.getState().recordLessonComplete("math-1", "计数", 1, 20);
  store.getState().recordLessonComplete("math-1", "计数", 0.5, 10);
  assert.equal(store.getState().completedLessons["math-1"].stars, 3);
  assert.equal(store.getState().completedLessons["math-1"].accuracy, 1);
  assert.equal(store.getState().xp, 30);
  assert.equal(store.getState().lessonHistory[today()], 2);
});

await check("first perfect gems awarded once, 95% is not a zero-error perfect", () => {
  store.setState({ dailyGoal: 500 });
  store.getState().recordLessonComplete("math-1", "计数", 0.95, 20);
  assert.equal(store.getState().gems, 13);
  assert.equal(store.getState().perfectedLessons["math-1"], undefined);
  store.getState().recordLessonComplete("math-1", "计数", 1, 20);
  assert.equal(store.getState().gems, 41);
  store.getState().recordLessonComplete("math-1", "计数", 1, 20);
  assert.equal(store.getState().gems, 54);
});

await check("weekend XP doubles once while history and daily totals agree", () => {
  clock = new RealDate(2026, 9, 10, 12).getTime();
  store.getState().recordLessonComplete("math-1", "计数", 1, 25);
  assert.equal(store.getState().xp, 50);
  assert.equal(store.getState().todayXp, 50);
  assert.equal(store.getState().xpHistory[today()], 50);
});

await check("daily goal grants only one bonus even after raising the goal", () => {
  store.getState().setDailyGoal(20);
  store.getState().recordLessonComplete("a", "a", 0.5, 20);
  assert.equal(store.getState().gems, 23);
  store.getState().setDailyGoal(50);
  store.getState().recordLessonComplete("b", "b", 0.5, 30);
  assert.equal(store.getState().gems, 26);
  clock += 24 * 60 * 60_000;
  store.getState().recordLessonComplete("c", "c", 0.5, 50);
  assert.equal(store.getState().gems, 49);
});

await check("v6 migration retains earnings, grade, cosmetics and an already claimed goal", async () => {
  const oldState = {
    xp: 400, gems: 200, lifetimeGems: 280, todayXp: 50, dailyGoal: 50,
    lastXpDate: today(), selectedGrade: 2,
    equippedMascotSkin: DEFAULT_EQUIPPED.mascotSkin,
    completedLessons: { a: { lessonId: "a", accuracy: 1, stars: 3, completedAt: new Date().toISOString() } },
  };
  stored.set("csf-progress-v1", JSON.stringify({ state: oldState, version: 6 }));
  await store.persist.rehydrate();
  assert.equal(store.getState().xp, 400);
  assert.equal(store.getState().gems, 200);
  assert.equal(store.getState().selectedGrade, 2);
  assert.equal(store.getState().ownedCosmetics[DEFAULT_EQUIPPED.mascotSkin], true);
  assert.equal(store.getState().lastDailyGoalRewardDate, today());
  store.getState().setDailyGoal(100);
  store.getState().recordLessonComplete("b", "b", 0.5, 50);
  assert.equal(store.getState().gems, 203);
});

await check("early progress migration supplies new defaults while preserving earned progress", async () => {
  stored.set("csf-progress-v1", JSON.stringify({
    state: { xp: 75, streak: 2, lastActiveDate: "2026-10-04", completedLessons: {}, mistakesBank: [] },
    version: 0,
  }));
  await store.persist.rehydrate();
  assert.equal(store.getState().xp, 75);
  assert.equal(store.getState().streak, 2);
  assert.equal(store.getState().autoNarrate, true);
  assert.equal(store.getState().hearts, MAX_HEARTS);
  assert.equal(store.getState().selectedGrade, null);
  assert.equal(store.getState().ownedCosmetics[DEFAULT_EQUIPPED.mascotSkin], true);
});

await check("daily histories remain capped at 60 entries without losing current totals", () => {
  store.setState({ dailyGoal: 500 });
  for (let i = 0; i < 70; i++) {
    store.getState().recordLessonComplete(`lesson-${i}`, "计数", 0.5, 10);
    clock += 24 * 60 * 60_000;
  }
  assert.equal(Object.keys(store.getState().xpHistory).length, 60);
  assert.equal(Object.keys(store.getState().lessonHistory).length, 60);
  assert.equal(Object.keys(store.getState().completedLessons).length, 70);
});

await check("storage write rejection does not break lesson or reward actions", async () => {
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  try {
    assert.doesNotThrow(() => store.getState().loseHeart());
    assert.doesNotThrow(() => store.getState().addMistake("math-1", "计数", question));
    assert.doesNotThrow(() => store.getState().recordLessonComplete("math-1", "计数", 1, 10));
    assert.equal(store.getState().hearts, MAX_HEARTS - 1);
    assert.equal(store.getState().xp, 10);
    assert.equal(store.getState().streak, 1);
    assert.equal(store.getState().perfectedLessons["math-1"], true);
    assert.equal(store.getState().mistakesBank.length, 0);
    await store.persist.rehydrate();
    assert.equal(store.getState().xp, 10);
    assert.equal(store.getState().gems, 28);
  } finally {
    localStorage.setItem = original;
  }
});

await check("learning timer on a new day resets both daily counters before accruing", () => {
  store.getState().recordLessonComplete("a", "a", 0.5, 20);
  store.getState().addLearningTimeMs(1000);
  clock += 24 * 60 * 60_000;
  store.getState().addLearningTimeMs(500);
  assert.equal(store.getState().todayTimeMs, 500);
  assert.equal(store.getState().todayXp, 0);
  store.getState().recordLessonComplete("b", "b", 0.5, 10);
  assert.equal(store.getState().todayXp, 10);
  assert.equal(store.getState().todayTimeMs, 500);
});

await check("first lesson of a new day clears old learning time without a timer tick", () => {
  store.getState().addLearningTimeMs(60_000);
  clock += 24 * 60 * 60_000;
  store.getState().recordLessonComplete("a", "a", 0.5, 10);
  assert.equal(store.getState().todayTimeMs, 0);
});

await check("store SRS follows shared 1 day, 3 day, 7 day progression and resets errors", () => {
  store.getState().addMistake("math-1", "计数", question);
  let expected = store.getState().mistakesBank[0];
  for (let i = 0; i < 3; i++) {
    const next = reviewSrsEntry(expected, true);
    store.getState().reviewMistake("math-1", question.id, true);
    assert.deepEqual(store.getState().mistakesBank[0], next);
    expected = next;
    clock += i === 0 ? 24 * 60 * 60_000 : 3 * 24 * 60 * 60_000;
  }
  store.getState().reviewMistake("math-1", question.id, false);
  const reset = store.getState().mistakesBank[0];
  assert.equal(reset.box, 1);
  assert.equal(reset.correctCount, 0);
  assert.equal(reset.nextReviewDate, today());
  assert.equal(getDueSrsEntries(store.getState().mistakesBank).length, 1);
});

await check("mistake IDs are isolated by lesson and duplicate errors reset only that entry", () => {
  store.getState().addMistake("a", "a", question);
  store.getState().addMistake("b", "b", question);
  store.getState().reviewMistake("a", 1, true);
  store.getState().addMistake("a", "a", question);
  assert.equal(store.getState().mistakesBank.length, 2);
  assert.equal(store.getState().mistakesBank.find(m => m.lessonId === "a")?.box, 1);
  store.getState().clearMistakesForLesson("a");
  assert.equal(store.getState().mistakesBank.length, 1);
  assert.equal(store.getState().mistakesBank[0].lessonId, "b");
});

await check("chest placement uses stable per-unit IDs and claim markers are idempotent", () => {
  const lessons = Array.from({ length: 12 }, (_, i) => ({
    id: `lesson-${i}`, unitNumber: i < 7 ? 1 : 2, unitTitle: i < 7 ? "一" : "二",
  })) as PathLessonMeta[];
  const slots = computeChestsForBook("math", lessons);
  assert.deepEqual(slots.map(s => s.id), ["math-u1-chest-0", "math-u2-chest-0"]);
  assert.deepEqual(slots.map(s => s.afterLessonId), ["lesson-4", "lesson-11"]);
  assert.equal(findChestAfterLesson("math", lessons, "lesson-3"), null);
  assert.equal(store.getState().claimChest(slots[0].id), true);
  assert.equal(store.getState().claimChest(slots[0].id), false);
});

await check("streak increments once per date and consumes only missed-day freezes", () => {
  store.getState().bumpStreakIfNeeded();
  store.getState().bumpStreakIfNeeded();
  assert.equal(store.getState().streak, 1);
  clock += 24 * 60 * 60_000;
  store.getState().bumpStreakIfNeeded();
  assert.equal(store.getState().streak, 2);
  clock += 2 * 24 * 60 * 60_000;
  store.getState().bumpStreakIfNeeded();
  assert.equal(store.getState().streak, 3);
  assert.equal(store.getState().streakFreezes, 1);
  const gems = store.getState().gems;
  store.getState().bumpStreakIfNeeded();
  assert.equal(store.getState().gems, gems);
});

await check("checked session survives persistence without losing answer outcome", async () => {
  const session = {
    lessonId: "math-1", index: 0, correctCount: 1, mistakeCount: 0, combo: 1,
    startedAt: clock, phase: "checked" as const, answer: "B", isCorrect: true,
    maxCombo: 1, sessionXpPreview: 10,
  };
  store.getState().upsertLessonSession(session);
  await store.persist.rehydrate();
  assert.deepEqual(store.getState().activeLesson, session);
  store.getState().clearLessonSession();
  assert.equal(store.getState().activeLesson, null);
});

globalThis.Date = RealDate;
console.log(`State flows: ${passed} passed, ${failures} failed.`);
if (failures) process.exitCode = 1;
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
