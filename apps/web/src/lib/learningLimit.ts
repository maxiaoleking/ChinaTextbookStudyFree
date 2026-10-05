/** Calendar day in the student's local timezone, matching persisted XP/time. */
export function localStudyDate(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

interface LearningLimitState {
  dailyTimeLimitMs: number;
  todayTimeMs: number;
  lastXpDate: string;
  activeLesson: { lessonId: string } | null;
}

/** Daily limits block new courses, while an already started course can finish. */
export function isNewLessonTimeLimited(state: LearningLimitState, lessonId: string, now = Date.now()): boolean {
  return state.dailyTimeLimitMs > 0 &&
    state.lastXpDate === localStudyDate(now) &&
    state.todayTimeMs >= state.dailyTimeLimitMs &&
    state.activeLesson?.lessonId !== lessonId;
}
