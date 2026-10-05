import type { Question } from "@cstf/core";

export function matchingPairs(answer: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const pair of answer.replace(/，/g, ",").replace(/\s+/g, "").split(",")) {
    const match = /^([A-Z])-(\d+)$/.exec(pair.toUpperCase());
    if (match) pairs[match[1]] = match[2];
  }
  return pairs;
}

/** Recover selected option identities from a persisted ordering answer, including repeats. */
export function wordOrderIndices(options: string[], answer: string): number[] {
  const picked: number[] = [];
  if (!answer.trim()) return picked;
  for (const token of answer.replace(/，/g, ",").split(",").map(word => word.trim())) {
    const index = options.findIndex((word, i) => word.trim() === token && !picked.includes(i));
    if (index >= 0) picked.push(index);
  }
  return picked;
}

/** Prevent checking a partly completed pairing or sentence ordering task. */
export function isAnswerComplete(question: Question, answer: string): boolean {
  if (!answer.trim()) return false;
  if (question.type === "matching") {
    const count = question.options.length / 2;
    if (!Number.isInteger(count) || count < 1) return false;
    const pairs = answer.trim().replace(/，/g, ",").replace(/\s+/g, "").split(",");
    if (pairs.length !== count) return false;
    const left = new Set<string>();
    const right = new Set<number>();
    for (const pair of pairs) {
      const match = /^([A-Z])-(\d+)$/.exec(pair.toUpperCase());
      if (!match) return false;
      const key = match[1];
      const index = key.charCodeAt(0) - 65;
      const target = Number(match[2]);
      if (index < 0 || index >= count || target < 1 || target > count || left.has(key) || right.has(target)) return false;
      left.add(key); right.add(target);
    }
    return true;
  }
  if (question.type === "word_order") {
    const tokens = answer.replace(/，/g, ",").split(",").map(word => word.trim());
    if (tokens.length !== question.options.length) return false;
    const available = [...question.options].map(word => word.trim());
    for (const token of tokens) {
      const index = available.indexOf(token);
      if (index < 0) return false;
      available.splice(index, 1);
    }
    return available.length === 0;
  }
  return true;
}
