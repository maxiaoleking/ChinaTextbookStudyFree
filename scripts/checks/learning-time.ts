import assert from "node:assert/strict";
import { LearningClock, startLearningTime } from "../../apps/web/src/lib/learningClock";

let passed = 0;
let failed = 0;
function test(name: string, run: () => void) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
}
function makeClock(idle = 5000) {
  const additions: number[] = [];
  return {
    additions,
    clock: new LearningClock(ms => additions.push(ms), 0, idle),
    total: () => additions.reduce((sum, n) => sum + n, 0),
  };
}

test("inactive clock never accrues study time", () => {
  const t = makeClock();
  t.clock.tick(1000);
  t.clock.activity(2000);
  t.clock.tick(3000);
  assert.equal(t.total(), 0);
});

test("repeated timer timestamps never count the same duration twice", () => {
  const t = makeClock();
  t.clock.setActive(true, 0);
  t.clock.tick(1000);
  t.clock.tick(1000);
  t.clock.tick(2000);
  assert.equal(t.total(), 2000);
  assert.deepEqual(t.additions, [1000, 1000]);
});

test("moving to background flushes the tail and excludes hidden time", () => {
  const t = makeClock();
  t.clock.setActive(true, 0);
  t.clock.tick(1000);
  t.clock.setActive(false, 1300);
  t.clock.tick(9000);
  t.clock.setActive(true, 10000);
  t.clock.tick(11000);
  assert.equal(t.total(), 2300);
  assert.deepEqual(t.additions, [1000, 300, 1000]);
});

test("a late suspended timer caps unattended foreground time at the idle limit", () => {
  const t = makeClock();
  t.clock.setActive(true, 0);
  t.clock.tick(2000);
  t.clock.tick(20_000);
  t.clock.tick(25_000);
  assert.equal(t.total(), 5000);
});

test("interaction resumes after idle without crediting the inactive gap", () => {
  const t = makeClock();
  t.clock.setActive(true, 0);
  t.clock.tick(20_000);
  t.clock.activity(25_000);
  t.clock.tick(27_000);
  assert.equal(t.total(), 7000);
  assert.deepEqual(t.additions, [5000, 2000]);
});

test("interaction flushes once and extends the foreground idle deadline", () => {
  const t = makeClock();
  t.clock.setActive(true, 0);
  t.clock.activity(4000);
  t.clock.tick(8000);
  assert.equal(t.total(), 8000);
  t.clock.tick(20_000);
  assert.equal(t.total(), 9000);
});

test("a clock moving backward never credits an already counted interval again", () => {
  const t = makeClock();
  t.clock.setActive(true, 0);
  t.clock.tick(1000);
  t.clock.tick(500);
  t.clock.tick(1500);
  assert.equal(t.total(), 1500);
});

test("backward foreground events do not reopen an already credited interval", () => {
  const t = makeClock();
  t.clock.setActive(true, 0);
  t.clock.tick(1000);
  t.clock.setActive(false, 500);
  t.clock.setActive(true, 750);
  t.clock.tick(1500);
  assert.equal(t.total(), 1500);
});

class LearningDocument extends EventTarget {
  visibilityState = "visible";
  focused = true;
  hasFocus() { return this.focused; }
}
class LearningWindow extends EventTarget {
  timers = new Map<number, () => void>();
  private nextId = 0;
  setInterval(handler: () => void, ms: number) {
    assert.equal(ms, 10_000);
    const id = ++this.nextId;
    this.timers.set(id, handler);
    return id;
  }
  clearInterval(id: number) { this.timers.delete(id); }
  fireTimers() { [...this.timers.values()].forEach(handler => handler()); }
}
function makeLifecycle({ enabled = true, initiallyVisible = true, initiallyFocused = true } = {}) {
  const learningDocument = new LearningDocument();
  const learningWindow = new LearningWindow();
  const additions: number[] = [];
  let time = 0;
  learningDocument.visibilityState = initiallyVisible ? "visible" : "hidden";
  learningDocument.focused = initiallyFocused;
  const cleanup = startLearningTime({
    enabled, document: learningDocument, window: learningWindow,
    now: () => time, addTime: ms => additions.push(ms),
  });
  return {
    additions, cleanup, learningDocument, learningWindow,
    total: () => additions.reduce((sum, ms) => sum + ms, 0),
    at: (now: number) => { time = now; },
    timerAt: (now: number) => { time = now; learningWindow.fireTimers(); },
    visibilityAt: (now: number, visible: boolean) => {
      time = now; learningDocument.visibilityState = visible ? "visible" : "hidden";
      learningDocument.dispatchEvent(new Event("visibilitychange"));
    },
    focusAt: (now: number, focused: boolean) => {
      time = now; learningDocument.focused = focused;
      learningWindow.dispatchEvent(new Event(focused ? "focus" : "blur"));
    },
    activityAt: (now: number, type: "pointerdown" | "keydown" | "scroll") => {
      time = now; learningDocument.dispatchEvent(new Event(type));
    },
  };
}

test("actual lifecycle flushes visibility transitions and excludes all hidden timer ticks", () => {
  const t = makeLifecycle();
  t.timerAt(10_000);
  t.visibilityAt(12_000, false);
  t.timerAt(60_000);
  t.activityAt(70_000, "scroll");
  t.visibilityAt(100_000, true);
  t.timerAt(110_000);
  assert.equal(t.total(), 22_000);
  t.cleanup();
});

test("actual lifecycle excludes an unfocused visible tab and resumes on focus", () => {
  const t = makeLifecycle();
  t.focusAt(3000, false);
  t.timerAt(80_000);
  t.focusAt(100_000, true);
  t.timerAt(110_000);
  assert.equal(t.total(), 13_000);
  t.cleanup();
});

test("initially hidden or unfocused pages do not accrue until they enter foreground", () => {
  for (const initial of [{ initiallyVisible: false }, { initiallyFocused: false }]) {
    const t = makeLifecycle(initial);
    t.timerAt(90_000);
    assert.equal(t.total(), 0);
    t.visibilityAt(100_000, true);
    t.focusAt(100_000, true);
    t.timerAt(110_000);
    assert.equal(t.total(), 10_000);
    t.cleanup();
  }
});

test("disabled tracking remains disabled after focus, visibility and activity events", () => {
  const t = makeLifecycle({ enabled: false });
  t.timerAt(10_000);
  t.visibilityAt(20_000, false);
  t.visibilityAt(30_000, true);
  t.focusAt(40_000, true);
  t.activityAt(45_000, "pointerdown");
  t.timerAt(50_000);
  t.cleanup();
  assert.equal(t.total(), 0);
});

test("actual cleanup flushes the last partial interval exactly once and removes timers/listeners", () => {
  const t = makeLifecycle();
  t.timerAt(10_000);
  t.at(12_345);
  t.cleanup();
  t.cleanup();
  assert.equal(t.total(), 12_345);
  assert.equal(t.learningWindow.timers.size, 0);
  t.visibilityAt(20_000, true);
  t.focusAt(30_000, true);
  t.activityAt(40_000, "keydown");
  t.timerAt(50_000);
  assert.equal(t.total(), 12_345);
});

test("all three activity sources resume an idle lifecycle without crediting the idle gap", () => {
  for (const type of ["pointerdown", "keydown", "scroll"] as const) {
    const t = makeLifecycle();
    t.timerAt(600_000);
    assert.equal(t.total(), 300_000);
    t.activityAt(650_000, type);
    t.timerAt(660_000);
    assert.equal(t.total(), 310_000);
    t.cleanup();
  }
});

test("actual timer plus activity and visibility events never duplicate elapsed intervals", () => {
  const t = makeLifecycle();
  t.timerAt(10_000);
  t.activityAt(10_000, "pointerdown");
  t.activityAt(10_000, "keydown");
  t.visibilityAt(10_000, true);
  t.timerAt(20_000);
  t.at(20_000);
  t.cleanup();
  assert.deepEqual(t.additions, [10_000, 10_000]);
});

console.log(`Learning time: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
