import { describe, expect, it } from "vitest";
import {
  decodeWritingReport,
  encodeWritingReport,
  judgeStroke,
  resample,
  scoreTrace,
  scoreWhole,
  wholeHints,
  type Ink,
  type Pt,
} from "../writing";
import { gradeAnswer } from "../grade";
import type { CharacterGlyph, Question } from "../types";

const V = (x: number, y0: number, y1: number): Pt[] => [
  { x, y: y0 },
  { x, y: (y0 + y1) / 2 },
  { x, y: y1 },
];

function glyph(medians: Pt[][]): CharacterGlyph {
  return {
    medians: medians.map(m => m.map(p => [p.x, p.y] as [number, number])),
    strokes: medians.map(() => "M0 0"),
  };
}

/** 三笔竖，形如「川」 */
const tri = glyph([V(250, 800, 200), V(512, 850, 170), V(774, 800, 200)]);
const triInk = tri.medians.map(m => m.map(([x, y]) => ({ x, y })));

function jitter(ink: Ink[], amp: number, seed = 1): Ink[] {
  let s = seed;
  const r = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648) * 2 - 1;
  };
  return ink.map(stroke => resample(stroke, 12).map(p => ({ x: p.x + r() * amp, y: p.y + r() * amp })));
}

describe("judgeStroke", () => {
  it("沿中线书写判对", () => {
    expect(judgeStroke(V(512, 850, 170), V(512, 850, 170)).ok).toBe(true);
  });
  it("反向书写判 wrong_direction", () => {
    const j = judgeStroke(V(512, 850, 170).slice().reverse(), V(512, 850, 170));
    expect(j.reason).toBe("wrong_direction");
    expect(j.backwards).toBe(true);
  });
  it("整体偏离中线判 off_target", () => {
    expect(judgeStroke(V(512 + 300, 850, 170), V(512, 850, 170)).reason).toBe("off_target");
  });
  it("只点一下判 too_short", () => {
    expect(judgeStroke([{ x: 512, y: 500 }], V(512, 850, 170)).reason).toBe("too_short");
  });
  it("只写一半判 incomplete", () => {
    expect(judgeStroke(V(512, 850, 600), V(512, 850, 170)).reason).toBe("incomplete");
  });
});

describe("scoreTrace", () => {
  it("一次写对满格，重试次数越多分越低", () => {
    const mk = (mistakes: number[]) => mistakes.map((m, i) => ({ strokeNum: i + 1, mistakes: m }));
    expect(scoreTrace(mk([0, 0, 0]), 3)).toBe(1);
    expect(scoreTrace(mk([1, 0, 0]), 3)).toBeCloseTo(0.95, 2);
    expect(scoreTrace(mk([3, 3, 3]), 3)).toBeCloseTo(0.55, 2);
    expect(scoreTrace([], 0)).toBe(0);
  });
});

describe("scoreWhole", () => {
  it("照标准笔顺写：满分附近且无漏笔", () => {
    const r = scoreWhole(triInk, tri);
    expect(r.score).toBeGreaterThan(0.95);
    expect(r.missingStrokes).toEqual([]);
    expect(r.strokeQualities).toHaveLength(3);
  });
  it("轻手抖不影响合格", () => {
    expect(scoreWhole(jitter(triInk, 12), tri).score).toBeGreaterThan(0.85);
  });
  it("漏写中间一笔：得分对折并指出是第 2 笔", () => {
    const r = scoreWhole([triInk[0], triInk[2]], tri);
    expect(r.missingStrokes).toEqual([2]);
    expect(r.score).toBeLessThan(0.5);
  });
  it("整字平移：判不合格", () => {
    const moved = triInk.map(s => s.map(p => ({ x: p.x + 150, y: p.y - 130 })));
    expect(scoreWhole(moved, tri).score).toBeLessThan(0.5);
  });
  it("空墨迹得 0 分并列出全部漏笔", () => {
    const r = scoreWhole([], tri);
    expect(r.score).toBe(0);
    expect(r.missingStrokes).toEqual([1, 2, 3]);
  });
  it("反馈文案能指出笔画数不对", () => {
    const hints = wholeHints(scoreWhole([triInk[0]], tri), tri);
    expect(hints.join("")).toContain("3 笔");
  });
});

describe("判分结果 → 答题判定", () => {
  const q = {
    id: 1,
    type: "writing",
    question: "写一写",
    options: [],
    answer: "",
    score: 25,
    difficulty: 1,
    knowledge_point: "写字",
    explanation: "",
    writing: { char: "三", pinyin: "sān", word: "三个", mode: "whole", threshold: 0.62 },
  } as Question;

  it("报告编解码可往返", () => {
    const raw = encodeWritingReport({
      v: 1,
      mode: "whole",
      char: "三",
      score: 0.734,
      strokesWritten: 3,
      strokesExpected: 3,
      hints: ["写得不错"],
    });
    const back = decodeWritingReport(raw)!;
    expect(back.score).toBeCloseTo(0.73, 2);
    expect(back.hints).toEqual(["写得不错"]);
  });
  it("非报告字符串一律判错", () => {
    for (const raw of ["", "A", '{"v":2}', "not json"]) {
      expect(decodeWritingReport(raw)).toBeNull();
      expect(gradeAnswer(q, raw)).toBe(false);
    }
  });
  it("过线判对，未过线判错", () => {
    const mk = (score: number) =>
      encodeWritingReport({
        v: 1,
        mode: "whole",
        char: "三",
        score,
        strokesWritten: 3,
        strokesExpected: 3,
        hints: [],
      });
    expect(gradeAnswer(q, mk(0.8))).toBe(true);
    expect(gradeAnswer(q, mk(0.62))).toBe(true);
    expect(gradeAnswer(q, mk(0.61))).toBe(false);
  });
});
