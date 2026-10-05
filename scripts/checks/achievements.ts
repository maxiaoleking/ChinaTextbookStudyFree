import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as core from "../../packages/core/src/achievements";
import * as courses from "../../apps/web/src/lib/courseProgress";
import type { AchievementProgressSnapshot } from "../../packages/core/src/achievements";

type WebAchievements = typeof import("../../apps/web/src/lib/achievements");
const empty: AchievementProgressSnapshot = {
  xp: 0, streak: 0, lifetimeGems: 0, completedLessons: {}, perfectedLessons: {}, ownedCosmetics: {}, mistakesBank: [],
};
function makeStore(state = { ...empty }) {
  const listeners = new Set<(state: AchievementProgressSnapshot) => void>();
  return {
    getState: () => state,
    subscribe: (listener: (state: AchievementProgressSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (next: Partial<AchievementProgressSnapshot>) => { state = { ...state, ...next }; [...listeners].forEach(listener => listener(state)); },
  };
}
function makeBrowser(data = new Map<string, string>(), restricted = false) {
  let writes = 0;
  const browser = new EventTarget() as EventTarget & { localStorage: Storage };
  Object.defineProperty(browser, "localStorage", { get() {
    if (restricted) throw new Error("Storage denied");
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { writes++; data.set(key, value); },
    };
  } });
  return { browser, data, writes: () => writes };
}
// Fresh module evaluation simulates a reload without touching real browser/user storage.
function loadAchievements(store: ReturnType<typeof makeStore>, browser: ReturnType<typeof makeBrowser>["browser"]): WebAchievements {
  const code = ts.transpileModule(readFileSync("apps/web/src/lib/achievements.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const require = (path: string) => {
    if (path === "@cstf/core/achievements") return core;
    if (path === "@/store/progress") return { useProgressStore: store };
    if (path === "./courseProgress") return courses;
    throw new Error(`Unexpected achievement dependency ${path}`);
  };
  new Function("exports", "require", "window", code)(exports, require, browser);
  return exports as WebAchievements;
}
function watch(store: ReturnType<typeof makeStore>, module: WebAchievements, messages: string[]) {
  const path = "apps/web/src/components/AchievementWatcher.tsx";
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found: { effect?: ts.ArrowFunction } = {};
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
      && ts.isArrowFunction(node.arguments[0])) found.effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(found.effect);
  const code = ts.transpileModule(`const effect = ${found.effect.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const dependencies = { useProgressStore: store, seen: { current: null },
    computeUnlockedAchievementIds: module.computeUnlockedAchievementIds,
    rememberUnlockedAchievementIds: module.rememberUnlockedAchievementIds,
    ALL_ACHIEVEMENTS: module.ALL_ACHIEVEMENTS, toast: { success: (message: string) => messages.push(message) }, playSfx() {}, haptic() {},
  };
  const effect = new Function(...Object.keys(dependencies), `${code}\nreturn effect;`)(...Object.values(dependencies));
  return effect() as () => void;
}

function main() {
  const store = makeStore(); const storage = makeBrowser(); const module = loadAchievements(store, storage.browser);
  let notifications = 0;
  const unsubscribeChanges = module.subscribeAchievementChanges(() => { notifications++; });
  const qualifying = { ...empty, streak: 7, mistakesBank: [{ correctCount: 1 }] };
  const unlocked = module.computeUnlockedAchievementIds(qualifying);
  assert.deepEqual(unlocked, ["streak-3", "streak-7", "first-review"]);
  assert.equal(storage.writes(), 0, "compute must never persist from a render");
  module.rememberUnlockedAchievementIds(unlocked);
  assert.equal(notifications, 1); assert.equal(storage.writes(), 1);
  module.rememberUnlockedAchievementIds(unlocked);
  assert.equal(notifications, 1, "remembering existing unlocks does not notify again");
  assert.equal(storage.writes(), 1);
  assert.deepEqual(module.computeUnlockedAchievementIds(empty), unlocked, "streak loss and clearing reviews do not relock earned badges");
  assert.deepEqual(module.diffNewlyUnlocked(empty, qualifying), []);
  assert.equal(module.hasUnseenAchievements(), true, "earned badges remain unread until viewed");
  module.markAllSeen(); assert.equal(module.hasUnseenAchievements(), false); assert.equal(notifications, 2);
  module.markAllSeen(); assert.equal(notifications, 2, "marking read twice does not notify again");
  unsubscribeChanges();

  const reloaded = loadAchievements(store, storage.browser);
  assert.deepEqual(reloaded.computeUnlockedAchievementIds(empty), unlocked);
  assert.equal(reloaded.hasUnseenAchievements(), false, "reload preserves read state separately from unlocks");
  const reloadToasts: string[] = []; const unwatchReload = watch(store, reloaded, reloadToasts);
  store.update({ streak: 7, mistakesBank: [{ correctCount: 1 }] });
  assert.equal(reloadToasts.length, 0, "returning to an old streak or cleared review never toasts again after reload");
  unwatchReload();

  const lifecycleStore = makeStore(); const lifecycleStorage = makeBrowser();
  const lifecycle = loadAchievements(lifecycleStore, lifecycleStorage.browser);
  const messages: string[] = []; const unwatch = watch(lifecycleStore, lifecycle, messages);
  lifecycleStore.update({ streak: 3, mistakesBank: [{ correctCount: 1 }] });
  assert.equal(messages.length, 2);
  lifecycleStore.update({ streak: 0, mistakesBank: [] });
  lifecycleStore.update({ streak: 3, mistakesBank: [{ correctCount: 1 }] });
  assert.equal(messages.length, 2, "the actual watcher permanently unions its toast history");
  lifecycleStore.update({ streak: 7 }); assert.equal(messages.length, 3);
  assert.ok(lifecycle.computeUnlockedAchievementIds(lifecycleStore.getState()).includes("first-review"));
  unwatch();
  const watcherReload = loadAchievements(lifecycleStore, lifecycleStorage.browser);
  const postReloadMessages: string[] = []; const postReloadStop = watch(lifecycleStore, watcherReload, postReloadMessages);
  lifecycleStore.update({ streak: 0, mistakesBank: [] });
  lifecycleStore.update({ streak: 7, mistakesBank: [{ correctCount: 1 }] });
  assert.equal(postReloadMessages.length, 0); postReloadStop();

  const restrictedStore = makeStore(); const restrictedStorage = makeBrowser(new Map(), true);
  const restricted = loadAchievements(restrictedStore, restrictedStorage.browser); const restrictedToasts: string[] = [];
  let restrictedChanges = 0; const unlistenRestricted = restricted.subscribeAchievementChanges(() => { restrictedChanges++; });
  let restrictedStop = watch(restrictedStore, restricted, restrictedToasts);
  restrictedStore.update({ streak: 3, mistakesBank: [{ correctCount: 1 }] });
  restrictedStore.update({ streak: 0, mistakesBank: [] });
  restrictedStore.update({ streak: 3, mistakesBank: [{ correctCount: 1 }] });
  assert.equal(restrictedToasts.length, 2); assert.equal(restrictedChanges, 1);
  restrictedStop(); restrictedStore.update({ streak: 0, mistakesBank: [] });
  restrictedStop = watch(restrictedStore, restricted, restrictedToasts);
  restrictedStore.update({ streak: 3, mistakesBank: [{ correctCount: 1 }] });
  assert.equal(restrictedToasts.length, 2, "storage denied still retains unlocks across watcher remounts in this session");
  assert.equal(restricted.hasUnseenAchievements(), true); restricted.markAllSeen();
  assert.equal(restricted.hasUnseenAchievements(), false); assert.equal(restrictedChanges, 2);
  restrictedStop(); unlistenRestricted();

  const syntheticStore = makeStore({ ...empty,
    completedLessons: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i % 2 ? "story" : "passage"}-${i}`, {}])),
    perfectedLessons: { "passage-test-listen": true, "story-test": true },
  });
  const synthetic = loadAchievements(syntheticStore, makeBrowser().browser);
  const syntheticIds = synthetic.computeUnlockedAchievementIds(syntheticStore.getState());
  assert.ok(!syntheticIds.includes("first-lesson") && !syntheticIds.includes("ten-lessons") && !syntheticIds.includes("perfect-1"));
  syntheticStore.update({ completedLessons: { ...syntheticStore.getState().completedLessons, "g1up-u1-kp1": {} },
    perfectedLessons: { ...syntheticStore.getState().perfectedLessons, "g1up-u1-kp1": true } });
  assert.deepEqual(synthetic.computeUnlockedAchievementIds(syntheticStore.getState()), ["first-lesson", "perfect-1"]);
  const snapshot = synthetic.achievementProgressSnapshot(syntheticStore.getState());
  assert.equal(core.ALL_ACHIEVEMENTS.find(a => a.id === "ten-lessons")!.getProgress(snapshot), 1);

  const legacyData = new Map([["csf-achievements-seen-v1", JSON.stringify(["streak-3", "streak-7", "first-review", "invalid-id"])]]);
  const legacyStore = makeStore(); const legacyBrowser = makeBrowser(legacyData); const legacy = loadAchievements(legacyStore, legacyBrowser.browser);
  assert.deepEqual(legacy.computeUnlockedAchievementIds(empty), unlocked);
  const legacyToasts: string[] = []; const legacyStop = watch(legacyStore, legacy, legacyToasts);
  assert.equal(legacy.hasUnseenAchievements(), false); assert.equal(legacyToasts.length, 0);
  assert.deepEqual(JSON.parse(legacyData.get("csf-achievements-earned-v1")!), unlocked);
  legacyData.set("csf-achievements-earned-v1", "bad-json");
  assert.deepEqual(legacy.computeUnlockedAchievementIds(empty), unlocked, "corrupt storage preserves already loaded memory history");
  legacyStop();
  console.log("PASS: real web achievement shim and watcher: permanent streak/review unlocks, reload, read/unread notifications, denied-storage session fallback, course-only counts, legacy migration and corrupt history.");
}
main();
