/**
 * writing-selftest.ts —— 写字练习判分的离线标定/回归（npx tsx scripts/writing-selftest.ts）
 *
 * 没有真实儿童笔迹，就用「合成笔迹」定标：从标准 median 出发按不同失真等级
 * 生成笔画，检查判分单调、阈值合理。改算法或改阈值后必须重跑。
 *
 *   good     照着笔顺写，只带轻微手抖 + 起收笔不到位
 *   sloppy   手抖更大、笔画缩短、偶尔多一笔
 *   bad      缺笔 / 整字偏移 12% / 左右镜像
 */

import { readFileSync, readdirSync } from "fs";
import path from "path";
import {
  judgeStroke,
  resample,
  scoreWhole,
  wholeHints,
  type Ink,
  type Pt,
} from "@cstf/core/writing";
import type { CharacterGlyph } from "@cstf/core/types";

const GLYPH_DIR = path.resolve(process.cwd(), "public/writing/glyphs");

/** 完美字形镜像后仍能达到这个分，就认为该字左右近似对称（详见 evaluate 注释） */
const SYMMETRIC_BAR = 0.6;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从 median 生成一条笔迹：jitter = 抖动幅度，shrink = 起收笔各截掉的百分比 */
function synthStroke(median: Pt[], r: () => number, jitter: number, shrink: number): Ink {
  const pts = resample(median, 12);
  if (pts.length < 2) return pts.slice();
  const keep = pts.slice(
    Math.floor(pts.length * shrink),
    Math.max(2, Math.ceil(pts.length * (1 - shrink))),
  );
  return keep.map(p => ({
    x: p.x + (r() * 2 - 1) * jitter,
    y: p.y + (r() * 2 - 1) * jitter,
  }));
}

/**
 * 镜像 = 位置左右翻转、书写方向不变（孩子镜像写字就是这个样子：
 * 横仍然从左写到右，只是字形整个翻了）。再叠加「镜像轴取字形自身 bbox 中线」
 * 两件事，才能让 一/二/中 这类对称字被判为对称而豁免。
 * （若连点序一起翻转，任何字的一横都会变成从右写，对称字也会被冤枉。）
 */
function mirrorAxis(meds: Pt[][]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const m of meds) {
    for (const p of m) {
      min = Math.min(min, p.x);
      max = Math.max(max, p.x);
    }
  }
  return (min + max) / 2;
}

function mirror(ink: Ink, axis: number): Ink {
  return ink
    .map(p => ({ x: 2 * axis - p.x, y: p.y }))
    .reverse();
}

function shift(ink: Ink, dx: number, dy: number): Ink {
  return ink.map(p => ({ x: p.x + dx, y: p.y + dy }));
}

function medians(glyph: CharacterGlyph): Pt[][] {
  return glyph.medians.map(m => m.map(([x, y]) => ({ x, y })));
}

interface Sample {
  char: string;
  strokes: number;
  /** 工整书写（trace）逐笔通过率，必须为 1 */
  tracePass: number;
  /** 镜像书写的 trace 通过率（观察量，对称字天然偏高） */
  mirrorTracePass: number;
  good: number;
  sloppy: number;
  badMissing: number;
  badShift: number;
  badMirror: number;
  /** 左右对称的字镜像写出来仍是这个字，不参与镜像判负 */
  symmetric: boolean;
}

function evaluate(char: string, glyph: CharacterGlyph, seed: number): Sample {
  const meds = medians(glyph);
  const n = meds.length;
  const axis = mirrorAxis(meds);

  const goodInk = meds.map((m, i) => synthStroke(m, rng(seed + i), 10, 0.04));
  const sloppyInk = meds.map((m, i) => synthStroke(m, rng(seed + 100 + i), 34, 0.12));
  // 只有一画的字无从「缺一笔」，跳过该项
  const badMissingInk = n > 1 ? sloppyInk.slice(0, -1) : [];
  const badShiftInk = meds.map((m, i) => shift(synthStroke(m, rng(seed + 200 + i), 12, 0.05), 120, -110));
  const badMirrorInk = meds.map((m, i) => mirror(synthStroke(m, rng(seed + 300 + i), 10, 0.04), axis));
  const perfectMirror = meds.map(m => mirror(m, axis));

  const good = scoreWhole(goodInk, glyph).score;
  const badMirror = scoreWhole(badMirrorInk, glyph).score;
  // 把「完美字形」整个镜像后得分仍高 → 这个字本身接近左右对称，整字形状比对
  // 在原理上分不开镜像（实测 310 字里只有 一/二/三 越过这条线，最高 0.81，
  // 其余全在 0.39 以下），这类字不参与镜像判负；笔顺方向由 trace 模式把关。
  const symmetric = scoreWhole(perfectMirror, glyph).score >= SYMMETRIC_BAR;

  // trace 模式：按笔顺逐笔判定
  const passed = (ink: Ink[]) =>
    ink.filter((s, i) => judgeStroke(s, meds[i], { leniency: 1 }).ok).length / n;
  const goodTrace = passed(goodInk);

  return {
    char,
    strokes: n,
    good,
    tracePass: goodTrace,
    // 镜像字在 trace 下的通过率：逐笔比对对「左右对称部件」天然宽容，
    // 只作为观察量打印，不判失败（整字模式负责抓镜像）
    mirrorTracePass: passed(badMirrorInk),
    sloppy: scoreWhole(sloppyInk, glyph).score,
    badMissing: scoreWhole(badMissingInk, glyph).score,
    badShift: scoreWhole(badShiftInk, glyph).score,
    badMirror,
    symmetric,
  };
}

function bucket(strokes: number): string {
  if (strokes <= 4) return "1-4画";
  if (strokes <= 8) return "5-8画";
  return "9+画";
}

/** 合格线以生成脚本落到 public/writing/config.json 的表为准（只定义一次） */
function loadThresholdTable(): { maxStrokes: number; threshold: number }[] | null {
  const file = path.resolve(process.cwd(), "public/writing/config.json");
  try {
    const cfg = JSON.parse(readFileSync(file, "utf-8")) as {
      wholeThresholds?: { maxStrokes: number; threshold: number }[];
    };
    return cfg.wholeThresholds?.length ? cfg.wholeThresholds : null;
  } catch {
    return null;
  }
}

function main(): number {
  const files = readdirSync(GLYPH_DIR).filter(f => f.endsWith(".json"));
  const rows: Sample[] = [];
  for (const f of files) {
    const char = f.replace(/\.json$/, "");
    const glyph = JSON.parse(readFileSync(path.join(GLYPH_DIR, f), "utf-8")) as CharacterGlyph;
    if (glyph.medians.length !== glyph.strokes.length) {
      console.error(`  ✗ ${char} strokes/medians 数量不一致`);
      return 1;
    }
    rows.push(evaluate(char, glyph, char.codePointAt(0)! * 7919));
  }

  const groups = new Map<string, Sample[]>();
  for (const r of rows) {
    const k = bucket(r.strokes);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const pct = (arr: number[], p: number) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  };
  const table = loadThresholdTable();
  if (!table) {
    console.error("未找到 public/writing/config.json，请先跑 scripts/writing/generate_writing_data.py");
    return 1;
  }
  const thresholdFor = (strokes: number) =>
    (table.find(t => strokes <= t.maxStrokes) ?? table[table.length - 1]).threshold;

  console.log(`\n字形数据: ${rows.length} 个 / ${GLYPH_DIR}\n`);
  let failures = 0;
  let asymmetric = 0;
  for (const [name, list] of groups) {
    const stat = (key: keyof Sample) => list.map(r => r[key] as number);
    const bad = (key: keyof Sample, filter?: (r: Sample) => boolean) =>
      list.filter(r => (filter ? filter(r) : true) && (r[key] as number) < thresholdFor(r.strokes));
    const goodFail = bad("good");
    const sloppyFail = bad("sloppy");
    const missingPass = list.filter(
      r => r.strokes > 1 && r.badMissing >= thresholdFor(r.strokes),
    );
    const shiftPass = list.filter(r => r.badShift >= thresholdFor(r.strokes));
    const mirrorList = list.filter(r => !r.symmetric);
    asymmetric += mirrorList.length;
    const mirrorPass = mirrorList.filter(r => r.badMirror >= thresholdFor(r.strokes));
    const traceFail = list.filter(r => r.tracePass < 1);
    const th = thresholdFor(list[0].strokes);
    const show = (arr: Sample[]) => arr.slice(0, 6).map(r => r.char).join("");
    const avg = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
    console.log(
      `${name} (${list.length}字, 其中 ${mirrorList.length} 字非左右对称) 合格线≈${th}\n` +
        `  good   p50=${pct(stat("good"), 0.5).toFixed(3)} p5=${pct(stat("good"), 0.05).toFixed(3)} 不合格 ${goodFail.length}\n` +
        `  sloppy p50=${pct(stat("sloppy"), 0.5).toFixed(3)} p95=${pct(stat("sloppy"), 0.95).toFixed(3)} 不合格 ${sloppyFail.length}${sloppyFail.length ? " " + show(sloppyFail) : ""}\n` +
        `  缺笔   p50=${pct(stat("badMissing"), 0.5).toFixed(3)} p95=${pct(stat("badMissing"), 0.95).toFixed(3)} 仍及格 ${missingPass.length}\n` +
        `  偏移   p50=${pct(stat("badShift"), 0.5).toFixed(3)} p95=${pct(stat("badShift"), 0.95).toFixed(3)} 仍合格 ${shiftPass.length}\n` +
        `  镜像   p50=${pct(mirrorList.map(r => r.badMirror), 0.5).toFixed(3)} p95=${pct(mirrorList.map(r => r.badMirror), 0.95).toFixed(3)} 仍及格 ${mirrorPass.length}\n` +
        `  trace  工整书写逐笔全通过 ${list.length - traceFail.length}/${list.length}（镜像书写的逐笔通过率均值 ${avg(mirrorList.map(r => r.mirrorTracePass)).toFixed(2)}，仅供参考）`,
    );
    if (traceFail.length) {
      console.error(`  ✗ 照着笔顺写仍被 trace 判错: ${show(traceFail)}`);
      failures++;
    }
    if (goodFail.length) {
      console.error(`  ✗ 工整书写的字被判不合格: ${show(goodFail)}`);
      failures++;
    }
    if (sloppyFail.length > list.length * 0.1) {
      console.error(
        `  ✗ 潦草但完整的字不合格过多（${sloppyFail.length}/${list.length}: ${show(sloppyFail)}），判分过严`,
      );
      failures++;
    }
    if (missingPass.length) {
      console.error(`  ✗ 缺笔仍被判合格: ${show(missingPass)}`);
      failures++;
    }
    if (mirrorPass.length > mirrorList.length * 0.05) {
      console.error(
        `  ✗ 明显不对称的字镜像写仍合格（${mirrorPass.length}/${mirrorList.length}: ${show(mirrorPass)}）`,
      );
      failures++;
    }
    if (shiftPass.length > list.length * 0.2) {
      console.error(
        `  ✗ 整字偏移 12% 仍有过多被判合格（${shiftPass.length}/${list.length}: ${show(shiftPass)}）`,
      );
      failures++;
    }
  }
  console.log(`\n非对称字占比: ${asymmetric}/${rows.length}`);

  // 抽一个字看看反馈文案是否可用
  const demo = rows.find(r => r.strokes >= 4)!;
  const demoGlyph = JSON.parse(
    readFileSync(path.join(GLYPH_DIR, `${demo.char}.json`), "utf-8"),
  ) as CharacterGlyph;
  const demoBad = scoreWhole(
    medians(demoGlyph).slice(0, -1).map((m, i) => synthStroke(m, rng(i + 1), 30, 0.15)),
    demoGlyph,
  );
  console.log(
    `\n反馈示例「${demo.char}」缺笔: score=${demoBad.score.toFixed(2)} 提示=${wholeHints(demoBad, demoGlyph).join(" / ")}`,
  );
  const shortInk = medians(demoGlyph).map((m, i) => synthStroke(m, rng(i + 5), 14, 0.05));
  console.log(`       好字: score=${scoreWhole(shortInk, demoGlyph).score.toFixed(2)}`);

  if (failures) {
    console.error(`\n❌ 标定未通过: ${failures} 项`);
    return 1;
  }
  console.log("\n✅ 判分标定通过");
  return 0;
}

process.exit(main());
