/** Input capabilities, shared by the renderer and keypad. Units need not be typed. */
export interface NumericInputConfig {
  value: string;
  extraKeys: string[];
}

export function numericInputConfig(answer: string): NumericInputConfig | null {
  const normalized = answer.normalize("NFKC").replace(/\s*\/\s*/g, "/");
  if (/\d\s+[+-]?(?:\d|\.\d)/.test(normalized)) return null;
  const compact = normalized.replace(/\s+/g, "");
  const match = compact.match(/^([+-]?\d+(?:\.\d+)?(?:\/[+-]?\d+(?:\.\d+)?)?%?)(?:[a-zA-Z\u3400-\u9fff°²³]*)$/);
  if (!match) return null;
  return {
    value: match[1],
    extraKeys: ["-", "/", "%", "+"].filter(key => match[1].includes(key)),
  };
}

export function answerInputLimit(correctAnswer: string): number {
  return Math.max(100, correctAnswer.length * 2 + 20);
}

export function appendAnswerKey(answer: string, key: string, correctAnswer: string): string {
  if (key === "⌫") return Array.from(answer).slice(0, -1).join("");
  if (answer.length + key.length > answerInputLimit(correctAnswer)) return answer;
  return answer + key;
}
