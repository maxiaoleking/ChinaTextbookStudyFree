/** Web achievement history is permanent; read status remains a separate concern. */
import {
  ALL_ACHIEVEMENTS,
  computeUnlockedAchievementIds as computeCurrentUnlocks,
  type Achievement,
  type AchievementProgressSnapshot,
} from "@cstf/core/achievements";
import { useProgressStore } from "@/store/progress";
import { courseRecord } from "./courseProgress";

export { ALL_ACHIEVEMENTS };
export type { Achievement, AchievementCategory, AchievementProgressSnapshot } from "@cstf/core/achievements";

const EARNED_KEY = "csf-achievements-earned-v1";
const SEEN_KEY = "csf-achievements-seen-v1";
const knownIds = new Set(ALL_ACHIEVEMENTS.map(achievement => achievement.id));
const earnedMemory = new Set<string>();
const seenMemory = new Set<string>();
const listeners = new Set<() => void>();

function readHistory(key: string, fallback: Set<string>): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === "string" && knownIds.has(id)) fallback.add(id);
    }
  } catch { /* Restricted storage retains this session's in-memory history. */ }
  return new Set(fallback);
}

function writeHistory(key: string, values: Set<string>) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, JSON.stringify([...values])); }
  catch { /* The in-memory history is already updated. */ }
}

function notifyChanges() {
  for (const listener of [...listeners]) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key === EARNED_KEY || event.key === SEEN_KEY || event.key === null) notifyChanges();
}

/** Navigation can react to unlock/read changes without depending on a progress mutation. */
export function subscribeAchievementChanges(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function achievementProgressSnapshot(snapshot: AchievementProgressSnapshot): AchievementProgressSnapshot {
  return { ...snapshot,
    completedLessons: courseRecord(snapshot.completedLessons),
    perfectedLessons: courseRecord(snapshot.perfectedLessons),
  };
}

function readEarned(): Set<string> {
  const earned = readHistory(EARNED_KEY, earnedMemory);
  // A previously viewed achievement is proof of an earlier unlock in older releases.
  readHistory(SEEN_KEY, seenMemory).forEach(id => earned.add(id));
  return earned;
}

/** Pure with respect to persistent storage: rendering only reads history and current progress. */
export function computeUnlockedAchievementIds(snapshot: AchievementProgressSnapshot): string[] {
  const unlocked = readEarned();
  computeCurrentUnlocks(achievementProgressSnapshot(snapshot)).forEach(id => unlocked.add(id));
  return ALL_ACHIEVEMENTS.filter(achievement => unlocked.has(achievement.id)).map(achievement => achievement.id);
}

/** Called by the watcher, never as a render-time side effect. */
export function rememberUnlockedAchievementIds(ids: Iterable<string>): void {
  if (typeof window === "undefined") return;
  const before = readHistory(EARNED_KEY, earnedMemory);
  const earned = readEarned();
  for (const id of ids) if (knownIds.has(id)) earned.add(id);
  if (earned.size === before.size) return;
  earned.forEach(id => earnedMemory.add(id));
  writeHistory(EARNED_KEY, earnedMemory);
  notifyChanges();
}

export function diffNewlyUnlocked(before: AchievementProgressSnapshot, after: AchievementProgressSnapshot): Achievement[] {
  const prior = new Set(computeUnlockedAchievementIds(before));
  const current = new Set(computeUnlockedAchievementIds(after));
  return ALL_ACHIEVEMENTS.filter(achievement => current.has(achievement.id) && !prior.has(achievement.id));
}

export function hasUnseenAchievements(): boolean {
  if (typeof window === "undefined") return false;
  const seen = readHistory(SEEN_KEY, seenMemory);
  return computeUnlockedAchievementIds(useProgressStore.getState()).some(id => !seen.has(id));
}

export function markAllSeen(): void {
  if (typeof window === "undefined") return;
  const unlocked = computeUnlockedAchievementIds(useProgressStore.getState());
  rememberUnlockedAchievementIds(unlocked);
  const before = readHistory(SEEN_KEY, seenMemory);
  unlocked.forEach(id => seenMemory.add(id));
  if (seenMemory.size === before.size) return;
  writeHistory(SEEN_KEY, seenMemory);
  notifyChanges();
}
