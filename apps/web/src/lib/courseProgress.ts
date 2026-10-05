/** Reader/listening rewards share the XP store but are separate from courses. */
export function isCourseLessonId(id: string): boolean {
  return !id.startsWith("passage-") && !id.startsWith("story-");
}

export function courseResults<T>(record: Record<string, T>): T[] {
  return Object.entries(record).filter(([id]) => isCourseLessonId(id)).map(([, result]) => result);
}

export function courseRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => isCourseLessonId(id)));
}

export function countCompletedCourses(record: Record<string, unknown>): number {
  return Object.keys(record).filter(isCourseLessonId).length;
}
