/**
 * writing.ts — 写字练习判分（纯函数，无 DOM，vitest 可直跑）
 *
 * 坐标系统一用字形数据的「glyph 空间」：0..GLYPH_BOX 见方、y 轴向上。
 * 组件负责把指针像素坐标换算到这里，本模块只管几何与打分。
 *
 * 两种模式：
 *   trace  按标准笔顺逐笔跟写 → judgeStroke() + scoreTrace()
 *   whole  整字自由书写 → scoreWhole()（栅格化后与标准字形比对）
 */

import type { CharacterGlyph } from "./types";

export const GLYPH_BOX = 1024;

/** 短于此长度（≈字宽 3%）的一笔按「点了一下」处理，不认作有效笔画 */
const MIN_STROKE_LEN = 30;
/** whole 模式栅格边长（格数），56 格 → 单格约 18 glyph 单位 */
const GRID = 56;
/** 标准笔画半宽 / 用户墨迹半宽（glyph 单位，楷体笔画实测约 60-70 全宽） */
const TARGET_R = 34;
const INK_R = 30;

export interface Pt {
  x: number;
  y: number;
}

/** 用户写出的一笔（glyph 坐标，按书写顺序） */
export type Ink = Pt[];

// ============================================================
// 几何工具
// ============================================================

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function pathLength(pts: Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
}

/** 等弧长重采样（step 单位）；点数 <2 时原样返回 */
export function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen === 0) continue;
    while (acc + segLen >= step) {
      const t = (step - acc) / segLen;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(p);
      a = p;
      segLen = Math.hypot(b.x - a.x, b.y - a.y);
      acc = 0;
    }
    acc += segLen;
  }
  return out;
}

/** 点到折线的最短距离 + 该最近点在折线上的弧长位置（0..1） */
function nearestOnPolyline(p: Pt, poly: Pt[]): { dist: number; t: number } {
  let acc = 0;
  let total = 0;
  let best = Infinity;
  let bestT = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const proj = len2 === 0 ? 0 : clamp01(((p.x - a.x) * vx + (p.y - a.y) * vy) / len2);
    const cx = a.x + vx * proj;
    const cy = a.y + vy * proj;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < best) {
      best = d;
      bestT = (acc + segLen * proj) || 0;
    }
    acc += segLen;
    total += segLen;
  }
  return { dist: best, t: total > 0 ? bestT / total : 0 };
}

export function medianPoints(glyph: CharacterGlyph, strokeNum: number): Pt[] {
  const raw = glyph.medians[strokeNum] ?? [];
  return raw.map(([x, y]) => ({ x, y }));
}

// ============================================================
// trace 模式：逐笔判定
// ============================================================

export interface StrokeJudge {
  ok: boolean;
  reason: "ok" | "too_short" | "off_target" | "wrong_direction" | "incomplete";
  /** 用户笔迹各点到标准中线的平均距离（glyph 单位） */
  avgDist: number;
  /** 本次判定用到的容差 */
  tol: number;
  /** 沿标准笔画的覆盖比例（0..1） */
  coverage: number;
  /** 起收笔方向与标准相反 */
  backwards: boolean;
}

export interface JudgeOptions {
  /** 越大越宽松，默认 1 */
  leniency?: number;
  /** 是否容忍反向笔画（只扣分不判错），默认 false */
  acceptBackwards?: boolean;
}

export function judgeStroke(drawn: Ink, median: Pt[], opts: JudgeOptions = {}): StrokeJudge {
  const leniency = opts.leniency ?? 1;
  const pts = resample(drawn, 8);
  const target = resample(median, 8);
  const drawnLen = pathLength(pts);
  const base: StrokeJudge = {
    ok: false,
    reason: "too_short",
    avgDist: 0,
    tol: 0,
    coverage: 0,
    backwards: false,
  };
  if (pts.length < 2 || drawnLen < MIN_STROKE_LEN) return base;
  if (target.length < 2) return { ...base, reason: "ok", ok: true };

  let sum = 0;
  let tMin = 1;
  let tMax = 0;
  for (const p of pts) {
    const hit = nearestOnPolyline(p, target);
    sum += hit.dist;
    tMin = Math.min(tMin, hit.t);
    tMax = Math.max(tMax, hit.t);
  }
  const avgDist = sum / pts.length;
  const coverage = tMax - tMin;
  const targetLen = pathLength(target);
  const tol = Math.min(120, (0.055 * targetLen + 42) * leniency);

  const d0 = pts[0];
  const d1 = pts[pts.length - 1];
  const m0 = target[0];
  const m1 = target[target.length - 1];
  const cos = angleCos(d1.x - d0.x, d1.y - d0.y, m1.x - m0.x, m1.y - m0.y);
  const backwards = cos < -0.15;

  let reason: StrokeJudge["reason"] = "ok";
  if (backwards && !opts.acceptBackwards) reason = "wrong_direction";
  else if (avgDist > tol) reason = "off_target";
  else if (coverage < 0.55 || tMin > 0.3 || tMax < 0.7) reason = "incomplete";

  return { ok: reason === "ok", reason, avgDist, tol, coverage, backwards };
}

function angleCos(ax: number, ay: number, bx: number, by: number): number {
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return 1;
  return (ax * bx + ay * by) / (la * lb);
}

/** 每笔的重数越多扣分越重：0 次=满分，1 次=0.85，≥3 次=0.55 */
function attemptWeight(mistakes: number): number {
  if (mistakes <= 0) return 1;
  if (mistakes === 1) return 0.85;
  if (mistakes === 2) return 0.7;
  return 0.55;
}

export interface TraceAttempt {
  strokeNum: number;
  mistakes: number;
}

export function scoreTrace(attempts: TraceAttempt[], strokesExpected: number): number {
  if (strokesExpected <= 0) return 0;
  const sum = attempts.reduce((s, a) => s + attemptWeight(a.mistakes), 0);
  return clamp01(sum / strokesExpected);
}

// ============================================================
// whole 模式：整字栅格比对
// ============================================================

export interface WholeScore {
  score: number;
  /** 标准字形被覆盖的比例（漏笔 / 太短会低） */
  recall: number;
  /** 用户墨迹落在标准字形附近的比例（写出格 / 多余笔画会低） */
  precision: number;
  /** 重心偏移归一化，1 = 完全居中 */
  centered: number;
  /** 逐笔最优匹配质量的均值（1 = 每笔都写得像） */
  strokeQuality: number;
  /** 每条标准笔画匹配到的质量（0 = 完全没写上），组件可用来逐笔提示 */
  strokeQualities: number[];
  strokesWritten: number;
  strokesExpected: number;
  /** 没写到位的笔画序号（1 起） */
  missingStrokes: number[];
}

function stampSegment(cells: Uint8Array, a: Pt, b: Pt, radius: number): void {
  const size = GLYPH_BOX / GRID;
  const step = radius;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / step));
  const r = Math.ceil(radius / size);
  for (let i = 0; i <= n; i++) {
    const px = a.x + ((b.x - a.x) * i) / n;
    const py = a.y + ((b.y - a.y) * i) / n;
    const c0x = Math.floor(px / size);
    const c0y = Math.floor((GLYPH_BOX - py) / size);
    // 以落点为中心盖一个圆（按格心距离）
    const rr = (radius / size) * (radius / size);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = c0x + dx;
        const cy = c0y + dy;
        if (cx < 0 || cx >= GRID || cy < 0 || cy >= GRID) continue;
        const dxc = cx + 0.5 - px / size;
        const dyc = cy + 0.5 - (GLYPH_BOX - py) / size;
        if (dxc * dxc + dyc * dyc > rr) continue;
        cells[cy * GRID + cx] = 1;
      }
    }
  }
}

function stampPolylines(paths: Pt[][], radius: number): Uint8Array {
  const cells = new Uint8Array(GRID * GRID);
  for (const poly of paths) {
    const dense = resample(poly, Math.max(6, radius / 2));
    for (let i = 1; i < dense.length; i++) stampSegment(cells, dense[i - 1], dense[i], radius);
  }
  return cells;
}

/** 膨胀 1 格（8 邻域），用于给判分留容差 */
function dilate(cells: Uint8Array): Uint8Array {
  const out = new Uint8Array(cells.length);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!cells[y * GRID + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID) continue;
          out[ny * GRID + nx] = 1;
        }
      }
    }
  }
  return out;
}

function countCells(cells: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < cells.length; i++) n += cells[i] ? 1 : 0;
  return n;
}

function intersect(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i] && b[i] ? 1 : 0;
  return n;
}

/** 从墨迹点求栅格重心（0..1，y 向下），无点时返回 null */
function centroid(cells: Uint8Array): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!cells[y * GRID + x]) continue;
      sx += x + 0.5;
      sy += y + 0.5;
      n++;
    }
  }
  if (!n) return null;
  return { x: sx / n / GRID, y: sy / n / GRID };
}

/** 整字模式认为「这一笔完全没写」的质量线 */
const MISSING_Q = 0.35;

/**
 * 一条用户笔迹对某条标准笔画的匹配质量（0..1）：
 * 离中线多远 × 写得够不够长 × 起收笔方向是否相反。
 *
 * 两点取舍：
 * - 只罚写短，不罚写长 —— 手抖会让折线弧长虚高（点、提这类短笔能翻两三倍），
 *   而「一笔盖两笔」由整字里的一对一匹配和笔画数系数处理。
 * - 沿程覆盖只对长笔画要求 —— 短笔就两三个采样点，投影挤在一处不代表没写，
 *   否则写得没问题的点会被算成漏笔。
 */
function qualityOf(drawn: Pt[], target: Pt[], leniency: number): number {
  const pts = resample(drawn, 8);
  const tgt = resample(target, 8);
  if (pts.length < 2 || tgt.length < 2) return 0;
  const targetLen = pathLength(tgt);
  const drawnLen = pathLength(pts);
  const tol = Math.min(120, (0.055 * targetLen + 42) * leniency);

  let sum = 0;
  let tMin = 1;
  let tMax = 0;
  for (const p of pts) {
    const hit = nearestOnPolyline(p, tgt);
    sum += hit.dist;
    tMin = Math.min(tMin, hit.t);
    tMax = Math.max(tMax, hit.t);
  }
  const distTerm = clamp01(1 - sum / pts.length / (tol * 1.6));

  const ratio = drawnLen / targetLen;
  // 只罚「写得太短」。过长不罚：手抖会让折线弧长虚高（点、提这类短笔尤其明显，
  // 实测能翻两三倍），而「一笔盖两笔」由一对一匹配和笔画数系数处理。
  let covTerm = ratio < 0.65 ? clamp01((ratio - 0.3) / 0.35) : 1;
  if (targetLen > 220) {
    // 只有长笔画才要求沿程铺开：短笔就两三个采样点，投影挤在一起不代表没写
    const arc = clamp01((tMax - tMin - 0.3) / 0.5);
    covTerm = Math.min(arc, covTerm) * (tMin > 0.3 ? 0.7 : 1) * (tMax < 0.7 ? 0.7 : 1);
  }

  const d0 = pts[0];
  const d1 = pts[pts.length - 1];
  const cos = angleCos(
    d1.x - d0.x,
    d1.y - d0.y,
    tgt[tgt.length - 1].x - tgt[0].x,
    tgt[tgt.length - 1].y - tgt[0].y,
  );
  return distTerm * covTerm * (cos < -0.3 ? 0.35 : 1);
}

export function scoreWhole(
  ink: Ink[],
  glyph: CharacterGlyph,
  opts: { leniency?: number } = {},
): WholeScore {
  const leniency = opts.leniency ?? 1;
  const strokesExpected = glyph.medians.length;
  const written = ink.filter(s => pathLength(s) >= MIN_STROKE_LEN);
  const strokesWritten = written.length;
  const empty: WholeScore = {
    score: 0,
    recall: 0,
    precision: 0,
    centered: 0,
    strokeQuality: 0,
    strokeQualities: [],
    strokesWritten,
    strokesExpected,
    missingStrokes: Array.from({ length: strokesExpected }, (_, i) => i + 1),
  };
  const user = stampPolylines(written, INK_R);
  const userCount = countCells(user);
  if (userCount === 0) return empty;

  const target = stampPolylines(
    glyph.medians.map((_, i) => medianPoints(glyph, i)),
    TARGET_R,
  );
  const targetCount = countCells(target);
  if (targetCount === 0) return empty;

  const dilUser = dilate(user);
  const dilTarget = dilate(target);
  const recall = intersect(target, dilUser) / targetCount;
  const precision = intersect(user, dilTarget) / userCount;

  const tc = centroid(target)!;
  const uc = centroid(user)!;
  const offset = Math.hypot(uc.x - tc.x, uc.y - tc.y);
  const centered = clamp01(1 - offset / 0.18);

  // 漏笔判定改看「每条标准笔画有没有一条写得像的用户笔画」：
  // 整字栅格的 recall 对少一笔太宽容（相邻笔画膨胀后就把它盖住了）。
  // 且必须一对一匹配——放开成「一笔可满足多笔」，漏写的竖弯钩会被相邻的横蒙混过关。
  const targets = glyph.medians.map((_, i) => resample(medianPoints(glyph, i), 8));
  const quality: number[] = [];
  const pairs: { t: number; u: number; q: number }[] = [];
  targets.forEach((tgt, t) => {
    if (tgt.length < 2) {
      quality[t] = 1; // 退化笔画（数据里极少）不参与判定，避免误判漏笔
      return;
    }
    written.forEach((stk, u) => {
      const q = qualityOf(stk, tgt, leniency);
      if (q > 0) pairs.push({ t, u, q });
    });
  });
  pairs.sort((a, b) => b.q - a.q);
  const usedTarget = new Set<number>();
  const usedInk = new Set<number>();
  for (const p of pairs) {
    if (usedTarget.has(p.t) || usedInk.has(p.u)) continue;
    usedTarget.add(p.t);
    usedInk.add(p.u);
    quality[p.t] = p.q;
  }

  const missingStrokes: number[] = [];
  const strokeQualities: number[] = [];
  let qSum = 0;
  for (let i = 0; i < targets.length; i++) {
    const q = quality[i] ?? 0;
    strokeQualities.push(q);
    qSum += q;
    if (q < MISSING_Q) missingStrokes.push(i + 1);
  }
  const strokeQuality = strokesExpected > 0 ? qSum / strokesExpected : 0;

  const delta = Math.abs(strokesWritten - strokesExpected);
  const countFactor = Math.max(0.4, 1 - 0.5 * (delta / Math.max(1, strokesExpected)));
  const base = 0.6 * recall + 0.25 * precision + 0.15 * centered;
  // 漏一整笔是硬伤（字形就不成立了）：每漏一笔直接对折
  const missingFactor = Math.pow(0.5, missingStrokes.length);
  const score = clamp01(
    base * (0.85 + 0.15 * strokeQuality) * missingFactor * countFactor,
  );
  return {
    score,
    recall,
    precision,
    centered,
    strokeQuality,
    strokeQualities,
    strokesWritten,
    strokesExpected,
    missingStrokes,
  };
}

// ============================================================
// 判分结果 → Question.answer 字符串（LessonRunner 受控组件协议）
// ============================================================
export interface WritingReport {
  v: 1;
  mode: "trace" | "whole";
  char: string;
  score: number;
  strokesWritten: number;
  strokesExpected: number;
  hints: string[];
}

export function encodeWritingReport(r: WritingReport): string {
  return JSON.stringify({ ...r, score: Math.round(r.score * 100) / 100 });
}

export function decodeWritingReport(raw: string): WritingReport | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<WritingReport>;
    if (o?.v !== 1 || typeof o.score !== "number" || (o.mode !== "trace" && o.mode !== "whole")) {
      return null;
    }
    return {
      v: 1,
      mode: o.mode,
      char: String(o.char ?? ""),
      score: o.score,
      strokesWritten: Number(o.strokesWritten ?? 0),
      strokesExpected: Number(o.strokesExpected ?? 0),
      hints: Array.isArray(o.hints) ? o.hints.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** whole 模式面向小朋友的反馈文案 */
export function wholeHints(s: WholeScore, glyph: CharacterGlyph): string[] {
  const out: string[] = [];
  if (s.strokesWritten < s.strokesExpected) {
    out.push(`只有 ${s.strokesWritten} 笔，这个字有 ${s.strokesExpected} 笔哦`);
  } else if (s.strokesWritten > s.strokesExpected) {
    out.push(`写了 ${s.strokesWritten} 笔，这个字只有 ${s.strokesExpected} 笔`);
  }
  const missing = s.missingStrokes.filter(n => n <= glyph.medians.length);
  if (missing.length && s.strokesWritten >= s.strokesExpected) {
    out.push(`第 ${missing.join("、")} 笔没写在标准位置上`);
  }
  if (s.precision < 0.62) out.push("有些笔画跑到格子外面了，写在田字格中间试试");
  if (s.recall < 0.6) out.push("笔画写得太轻太短，写满整个格子");
  if (s.centered < 0.6) out.push("字写歪了，对准格子的中心");
  if (!out.length && s.score < 0.85) out.push("再写一遍会更工整哦");
  return out;
}
