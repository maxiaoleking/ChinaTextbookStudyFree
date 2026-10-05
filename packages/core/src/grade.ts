/**
 * grade.ts — 答案判分逻辑
 *
 * 不同题型有不同的判分规则。容忍：空格、全/半角、中英文标点、数字格式。
 */

import type { Question } from "./types";

const TRUE_VALUES = new Set(["对", "正确", "true", "t", "✓", "√", "y", "yes"]);
const FALSE_VALUES = new Set(["错", "错误", "false", "f", "✗", "×", "n", "no"]);

function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/，/g, ",")
    .replace(/。/g, ".")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/：/g, ":");
}

interface NumericAnswer {
  numerator: bigint;
  denominator: bigint;
  unit: string;
}

const UNIT_ALIASES: Record<string, string> = {
  米: "m", m: "m", 厘米: "cm", cm: "cm", 分米: "dm", dm: "dm", 毫米: "mm", mm: "mm",
  千米: "km", 公里: "km", km: "km", 平方米: "m2", m2: "m2", 平方厘米: "cm2", cm2: "cm2",
  平方分米: "dm2", dm2: "dm2", 立方米: "m3", m3: "m3", 立方厘米: "cm3", cm3: "cm3",
  立方分米: "dm3", dm3: "dm3", 克: "g", g: "g", 千克: "kg", 公斤: "kg", kg: "kg", 吨: "t", t: "t",
  毫克: "mg", mg: "mg", 升: "l", l: "l", 毫升: "ml", ml: "ml", 元: "元", 角: "角", 分: "分",
  秒: "s", s: "s", 分钟: "min", min: "min", 小时: "h", h: "h", 天: "天", 日: "天", 年: "年",
  月: "月", 周: "周", 度: "度", "°": "度", 摄氏度: "摄氏度", "°c": "摄氏度",
  "米/秒": "m/s", "m/s": "m/s", "千米/小时": "km/h", "km/h": "km/h",
};
const COUNT_UNITS = new Set("个 只 支 张 本 条 朵 辆 次 人 岁 块 组 份 瓶 袋 箱 杯 枚 件 套 台 棵 颗 把 双 根 头 匹 排 桌".split(" "));

/** Keep answer boundaries; commas are never discarded or treated as digit glue. */
function splitAnswerParts(value: string): string[] {
  const text = value.normalize("NFKC").trim().replace(/[−–]/g, "-")
    .replace(/[，、；;]/g, ",").replace(/\s*\/\s*/g, "/");
  if (text.includes(",")) return text.split(",").map(part => part.trim());
  return text.split(/\s+(?=[+-]?(?:\d|\.\d))/).map(part => part.trim());
}

function parseNumericAnswers(value: string): NumericAnswer[] | null {
  const result: NumericAnswer[] = [];
  for (const part of splitAnswerParts(value)) {
    const compact = part.replace(/\s+/g, "").toLowerCase();
    const match = compact.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\/([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?(%)?(.*)$/);
    if (!match) return null;
    const first = decimalRatio(match[1]);
    const second = decimalRatio(match[2] ?? "1");
    if (second.numerator === 0n) return null;
    const rawUnit = match[4];
    let unit = "";
    if (rawUnit) {
      if (match[3]) return null;
      unit = UNIT_ALIASES[rawUnit] ?? (COUNT_UNITS.has(rawUnit) ? rawUnit : "");
      if (!unit) return null;
    }
    let numerator = first.numerator * second.denominator;
    let denominator = first.denominator * second.numerator * (match[3] ? 100n : 1n);
    if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
    result.push({ numerator, denominator, unit });
  }
  return result.length ? result : null;
}

function decimalRatio(value: string): { numerator: bigint; denominator: bigint } {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  return { numerator: BigInt((whole || "0") + fraction) * (negative ? -1n : 1n),
           denominator: 10n ** BigInt(fraction.length) };
}

function gradeNumeric(correct: string, user: string): boolean {
  const expected = parseNumericAnswers(correct);
  const submitted = parseNumericAnswers(user);
  // A legacy numeric question may actually ask for a word, such as “亿”.
  if (!expected) return normalize(correct) === normalize(user);
  if (!submitted || submitted.length !== expected.length) return false;
  return expected.every((answer, index) => {
    const actual = submitted[index];
    if (answer.unit && actual.unit && answer.unit !== actual.unit) return false;
    const delta = answer.numerator * actual.denominator - actual.numerator * answer.denominator;
    const distance = delta < 0n ? -delta : delta;
    // Rational comparison avoids prefix matches and large-integer rounding.
    return distance * 1_000_000n < answer.denominator * actual.denominator;
  });
}

export function gradeAnswer(question: Question, userAnswer: string): boolean {
  if (!userAnswer || !userAnswer.trim()) return false;
  const correct = question.answer;

  switch (question.type) {
    case "true_false": {
      const u = normalize(userAnswer);
      const c = normalize(correct);
      const userIsTrue = TRUE_VALUES.has(u);
      const userIsFalse = FALSE_VALUES.has(u);
      const correctIsTrue = TRUE_VALUES.has(c);
      const correctIsFalse = FALSE_VALUES.has(c);
      if ((userIsTrue || userIsFalse) && (correctIsTrue || correctIsFalse)) return userIsTrue === correctIsTrue;
      return u === c;
    }

    case "choice": {
      // The answer may be option text (including "a", "apple", "a+3") or a label.
      // Match full text first; its first letter is not necessarily the option label.
      const strip = (s: string) => s.replace(/^[A-D][.、]\s*/, "");
      const options = question.options ?? [];
      let idx = options.findIndex(o => o.trim() === correct.trim());
      if (idx < 0) idx = options.findIndex(o => strip(o).trim() === correct.trim());
      if (idx < 0) idx = options.findIndex(o => normalize(strip(o)) === normalize(correct));
      const label = idx >= 0
        ? String.fromCharCode(65 + idx)
        : correct.trim().match(/^([A-D])(?:$|[.、]\s*)/i)?.[1].toUpperCase();
      return !!label && userAnswer.normalize("NFKC").trim().toUpperCase() === label;
    }

    case "fill_blank":
    case "calculation":
    case "word_problem": {
      return gradeNumeric(correct, userAnswer);
    }

    case "fill_blank_text": {
      // 文字填空（中文 / 英文单词）— 去空格、去大小写、去标点严格对比
      const expectedParts = correct.normalize("NFKC").replace(/[，、；;]/g, ",").split(",");
      if (expectedParts.length > 1) {
        const userParts = userAnswer.normalize("NFKC").replace(/[，、；;]/g, ",").split(",");
        return userParts.length === expectedParts.length && expectedParts.every((part, index) =>
          normalizeText(part) === normalizeText(userParts[index]));
      }
      if (parseNumericAnswers(correct)) return gradeNumeric(correct, userAnswer);
      return normalizeText(userAnswer) === normalizeText(correct);
    }

    case "word_order": {
      // 用户答案应该是用逗号连接的词语序列
      const u = normalizeWordOrder(userAnswer);
      const c = normalizeWordOrder(correct);
      return u === c;
    }

    case "matching": {
      // 配对：A-1,B-2,C-3,D-4 顺序无关，集合相等即可
      const userPairs = parseMatchingAnswer(userAnswer);
      const correctPairs = parseMatchingAnswer(correct);
      if (!userPairs || !correctPairs) return false;
      if (userPairs.size !== correctPairs.size) return false;
      for (const [k, v] of userPairs) {
        if (correctPairs.get(k) !== v) return false;
      }
      return true;
    }

    default:
      return normalize(userAnswer) === normalize(correct);
  }
}

/** 文字填空规范化：trim、小写、去空格、去标点 */
function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？：；,.!?:;()（）"'`]/g, "");
}

/** 排序题规范化：去掉空格，统一英文逗号 */
function normalizeWordOrder(s: string): string {
  return s.normalize("NFKC").trim().replace(/，/g, ",").replace(/\s+/g, "");
}

/** 解析连线答案 "A-1,B-2,C-3,D-4" → Map { A: 1, B: 2, ... } */
function parseMatchingAnswer(s: string): Map<string, string> | null {
  const map = new Map<string, string>();
  const cleaned = s.normalize("NFKC").trim().replace(/，/g, ",").replace(/\s+/g, "");
  if (!cleaned) return null;
  const rights = new Set<string>();
  for (const pair of cleaned.split(",")) {
    const parsed = pair.match(/^([A-D])-([1-4])$/i);
    if (!parsed) return null;
    const [, key, value] = parsed;
    const k = key.toUpperCase();
    if (map.has(k) || rights.has(value)) return null;
    map.set(k, value);
    rights.add(value);
  }
  return map;
}
