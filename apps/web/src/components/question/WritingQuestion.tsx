"use client";

/**
 * WritingQuestion — 写字练习（iPad + Apple Pencil / 手指兜底）
 *
 * 两种模式（由 question.writing.mode 决定）：
 *   trace 逐笔描红：按标准笔顺一笔一笔写，每笔抬手即判定，写对才前进
 *   whole 整字书写：默认只给田字格（考查记忆），每笔抬手重算分数，点「检查」后才公布
 *
 * 输入用 Pointer Events：pen 优先级高于手指（同一根手指的后续 pointer 一律忽略，
 * 顺带解决掌误触），`touch-action: none` 禁掉页面滚动，pressure 决定笔画粗细。
 * 坐标统一换算进字形数据的 1024 见方、y 轴向上的空间，判分交给 @cstf/core/writing。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GLYPH_BOX,
  decodeWritingReport,
  encodeWritingReport,
  judgeStroke,
  medianPoints,
  pathLength,
  resample,
  scoreTrace,
  scoreWhole,
  wholeHints,
  type Pt,
} from "@cstf/core/writing";
import type { CharacterGlyph } from "@/types";
import { cn } from "@/lib/cn";
import { MathText } from "@/components/MathText";
import { TTSButton } from "@/components/TTSButton";
import { playSfx } from "@/lib/sfx";
import { haptic } from "@/lib/haptic";
import { useAutoNarrate } from "@/lib/useAutoNarrate";
import type { QuestionRendererProps } from "./QuestionRenderer";

/** 一条落笔的采样点（含压力，用来画粗细） */
interface Dot extends Pt {
  w: number;
}
interface Stroke {
  dots: Dot[];
}

const glyphCache = new Map<string, CharacterGlyph>();

async function loadGlyph(char: string): Promise<CharacterGlyph | null> {
  const hit = glyphCache.get(char);
  if (hit) return hit;
  try {
    const res = await fetch(`/writing/glyphs/${encodeURIComponent(char)}.json`);
    if (!res.ok) throw new Error(String(res.status));
    const glyph = (await res.json()) as CharacterGlyph;
    glyphCache.set(char, glyph);
    return glyph;
  } catch {
    return null; // 失败不进缓存：网络抖一下，下一题还能重新拿
  }
}

const TRACE_REASON: Record<string, string> = {
  too_short: "这一笔太短了，从起点一路写到终点",
  off_target: "没写到灰色笔画上，对准了再写一次",
  wrong_direction: "起笔方向反啦，跟着小圆点和箭头写",
  incomplete: "只写了一半，这一笔要拖到末端收笔",
};

/** 笔画基准宽度（字形单位）：楷体横画实测约 60，允许压力上下浮动 */
const BASE_W = 58;

export function WritingQuestion({
  question,
  answer,
  phase,
  onChange,
  locked = false,
}: QuestionRendererProps) {
  const spec = question.writing;
  const disabled = phase === "checked";
  const char = spec?.char ?? "";
  const mode = spec?.mode ?? "whole";

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [glyph, setGlyph] = useState<CharacterGlyph | null>(null);
  const [failed, setFailed] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [live, setLive] = useState<Dot[] | null>(null);
  const [strokeNum, setStrokeNum] = useState(0); // trace：当前第几笔（0 起）
  const [misses, setMisses] = useState<number[]>([]); // trace：每笔的重写次数
  const [hint, setHint] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  /** 「看笔顺」已扫完的笔画数：这些笔画留在格子里，让整字逐步成形 */
  const [demoDone, setDemoDone] = useState(0);

  const pointerId = useRef<number | null>(null);
  const dotsRef = useRef<Dot[]>([]);
  const interactive = !disabled && !demo && !!glyph;
  const cancelNarrate = useAutoNarrate([question.audio?.question], question.id);

  // 换题：清空一切（画布状态只在题目 id 变化时重置）
  useEffect(() => {
    setStrokes([]);
    setLive(null);
    setStrokeNum(0);
    setMisses([]);
    setHint(null);
    setDemo(false);
    setFailed(false);
    setGlyph(null);
    pointerId.current = null;
    dotsRef.current = [];
    if (!spec) return;
    let dead = false;
    void loadGlyph(spec.char).then(g => {
      if (dead) return;
      setGlyph(g);
      setFailed(!g);
      setMisses(g ? g.medians.map(() => 0) : []);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id]);

  // ============================================================
  // 画布绘制
  // ============================================================

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const css = canvas.clientWidth;
    if (css === 0) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(css * dpr)) {
      canvas.width = Math.round(css * dpr);
      canvas.height = Math.round(css * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const PAD = 6;
    const k = (css - PAD * 2) / GLYPH_BOX;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 之后一律用字形坐标（y 轴向上）作画；线宽要换算成字形单位
    ctx.setTransform(k * dpr, 0, 0, -k * dpr, PAD * dpr, (css - PAD) * dpr);
    const px = (n: number) => n / k;
    const color = getComputedStyle(canvas).color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 田字格（字形框已按 PAD 内缩，边框就画在 0..GLYPH_BOX 的四边上）
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = px(2);
    ctx.strokeRect(0, 0, GLYPH_BOX, GLYPH_BOX);
    ctx.globalAlpha = 0.22;
    ctx.setLineDash([px(7), px(7)]);
    ctx.lineWidth = px(1.5);
    ctx.beginPath();
    ctx.moveTo(GLYPH_BOX / 2, 0);
    ctx.lineTo(GLYPH_BOX / 2, GLYPH_BOX);
    ctx.moveTo(0, GLYPH_BOX / 2);
    ctx.lineTo(GLYPH_BOX, GLYPH_BOX / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 描红底字：trace 逐笔给足提示，whole 默写时只在「看笔顺」里出现
    if (glyph) {
      const outline = (i: number, alpha: number) => {
        const p = glyph.strokes[i];
        if (!p) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fill(new Path2D(p));
      };
      if (mode === "trace") {
        glyph.strokes.forEach((_, i) => outline(i, i < strokeNum ? 0.1 : 0.06));
        outline(strokeNum, 0.16);
        const med = medianPoints(glyph, strokeNum);
        if (med.length > 1) {
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = color;
          ctx.lineWidth = px(2);
          ctx.setLineDash([px(6), px(6)]);
          ctx.beginPath();
          ctx.moveTo(med[0].x, med[0].y);
          for (const p of med.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
          // 起笔点小圆 + 收笔点箭头：一眼看出往哪个方向写
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(med[0].x, med[0].y, px(7), 0, Math.PI * 2);
          ctx.fill();
          const last = med[med.length - 1];
          const prev = med[med.length - 2];
          const a = Math.atan2(last.y - prev.y, last.x - prev.x);
          ctx.save();
          ctx.translate(last.x, last.y);
          ctx.rotate(a);
          ctx.beginPath();
          ctx.moveTo(px(12), 0);
          ctx.lineTo(-px(6), px(8));
          ctx.lineTo(-px(6), -px(8));
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      } else if (demo) {
        // 扫过的笔画留住实墨，整字逐步成形；没扫到的留淡描红当预告
        glyph.strokes.forEach((_, i) => outline(i, i < demoDone ? 0.9 : 0.12));
      }
    }

    // 已写好的笔画 + 正在写的一笔
    const paint = (dots: Dot[], alpha: number) => {
      if (dots.length < 2) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      for (let i = 1; i < dots.length; i++) {
        ctx.lineWidth = (dots[i - 1].w + dots[i].w) / 2;
        ctx.beginPath();
        ctx.moveTo(dots[i - 1].x, dots[i - 1].y);
        ctx.lineTo(dots[i].x, dots[i].y);
        ctx.stroke();
      }
    };
    strokes.forEach(s => paint(s.dots, 0.9));
    if (live) paint(live, 0.9);
    ctx.globalAlpha = 1;
  }, [glyph, strokes, live, strokeNum, mode, demo, demoDone]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  // 「看笔顺」：逐笔把标准笔画扫一遍，扫过的留在格子里，写完整个字停一下再收
  useEffect(() => {
    if (!demo || !glyph) return;
    let raf = 0;
    let hold = 0;
    let stroke = 0;
    let t0 = performance.now();
    const step = (now: number) => {
      const med = resample(medianPoints(glyph, stroke), 8);
      const dur = 620;
      const frac = Math.min(1, (now - t0) / dur);
      setLive(med.slice(0, Math.max(2, Math.round(med.length * frac))).map(p => ({ ...p, w: 60 })));
      if (frac >= 1) {
        stroke += 1;
        t0 = now;
        setDemoDone(stroke);
        if (stroke >= glyph.medians.length) {
          setLive(null);
          hold = window.setTimeout(() => setDemo(false), 900);
          return;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hold);
    };
  }, [demo, glyph]);

  // iPad 锁屏/切走会冻结 rAF，示范会一直停在 demo=true —— 画布被 pointer-events-none
  // 锁死，回到页面就变成「怎么写都没字」。切走时直接收掉示范。
  useEffect(() => {
    if (!demo) return;
    const onHide = () => {
      if (!document.hidden) return;
      setDemo(false);
      setDemoDone(0);
      setLive(null);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [demo]);

  // ============================================================
  // 指针输入
  // ============================================================

  function toGlyphPt(e: React.PointerEvent<HTMLCanvasElement>): Pt {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = (rect.width - 12) / GLYPH_BOX;
    return {
      x: (e.clientX - rect.left - 6) / k,
      y: GLYPH_BOX - (e.clientY - rect.top - 6) / k,
    };
  }

  function widthOf(e: React.PointerEvent<HTMLCanvasElement>): number {
    const p = e.pointerType === "pen" ? e.pressure || 0.5 : Math.max(0.35, e.pressure || 0.5);
    return BASE_W * (0.62 + 0.72 * p);
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled || demo || !spec || !glyph) return;
    if (locked) {
      e.preventDefault();
      return;
    }
    // 书写期间手掌压屏产生的 touch 一律挡掉；但手掌先落屏抢了槽位时，
    // Pencil 必须能把槽位夺回来，否则整节课都写不出字
    const held = pointerId.current;
    if (held !== null && !(e.pointerType === "pen" && held !== e.pointerId)) return;
    pointerId.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 指针已失效（抬得比事件到达还快）：不捕获也照常收点，抬笔时靠 lostpointer 收尾
    }
    e.preventDefault();
    cancelNarrate();
    setHint(null);
    const p = toGlyphPt(e);
    dotsRef.current = [{ ...p, w: widthOf(e) }];
    setLive(dotsRef.current);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (pointerId.current !== e.pointerId) return;
    e.preventDefault();
    const native = e.nativeEvent;
    const batch =
      typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [native];
    for (const ev of batch.length ? batch : [native]) {
      const rect = e.currentTarget.getBoundingClientRect();
      const k = (rect.width - 12) / GLYPH_BOX;
      const w =
        ev.pointerType === "pen"
          ? BASE_W * (0.62 + 0.72 * (ev.pressure || 0.5))
          : widthOf(e);
      dotsRef.current.push({
        x: (ev.clientX - rect.left - 6) / k,
        y: GLYPH_BOX - (ev.clientY - rect.top - 6) / k,
        w,
      });
    }
    setLive(dotsRef.current.slice());
  }

  /** 抬笔即收笔；id 对不上说明这根 pointer 早被忽略，不能替它收尾 */
  function endStroke(id: number) {
    if (pointerId.current !== id) return;
    pointerId.current = null;
    const dots = dotsRef.current;
    dotsRef.current = [];
    setLive(null);
    if (!glyph || !spec) return;
    const ink = dots.map(d => ({ x: d.x, y: d.y }));
    if (pathLength(ink) < 24) return; // 误碰一下，不算一笔

    if (mode === "trace") {
      const judge = judgeStroke(ink, medianPoints(glyph, strokeNum), {
        leniency: 1 + 0.3 * (misses[strokeNum] ?? 0), // 越写不出越宽容，避免孩子卡死
      });
      if (!judge.ok) {
        setMisses(m => m.map((v, i) => (i === strokeNum ? v + 1 : v)));
        setHint(TRACE_REASON[judge.reason] ?? "再试一次");
        playSfx("wrong", { volume: 0.3 });
        haptic("medium");
        return;
      }
      const next = strokes.length + 1;
      setStrokes(s => [...s, { dots }]);
      playSfx("correct", { volume: 0.45 });
      haptic("light");
      if (next >= glyph.medians.length) {
        const attempts = glyph.medians.map((_, i) => ({ strokeNum: i + 1, mistakes: misses[i] ?? 0 }));
        const retry = attempts.filter(a => a.mistakes > 0).map(a => a.strokeNum);
        emit(
          "trace",
          scoreTrace(attempts, glyph.medians.length),
          next,
          glyph.medians.length,
          retry.length ? [`第 ${retry.join("、")} 笔多写了几次，注意起笔位置`] : [],
        );
      } else {
        setStrokeNum(next);
      }
      return;
    }

    const written = [...strokes, { dots }];
    setStrokes(written);
    const r = scoreWhole(
      written.map(s => s.dots.map(d => ({ x: d.x, y: d.y }))),
      glyph,
    );
    emit("whole", r.score, written.length, glyph.medians.length, wholeHints(r, glyph));
  }

  function emit(m: "trace" | "whole", score: number, written: number, expected: number, hints: string[]) {
    onChange(
      encodeWritingReport({
        v: 1,
        mode: m,
        char,
        score,
        strokesWritten: written,
        strokesExpected: expected,
        hints,
      }),
    );
  }

  function clearAll() {
    setStrokes([]);
    setLive(null);
    setStrokeNum(0);
    setMisses(glyph ? glyph.medians.map(() => 0) : []);
    setHint(null);
    onChange("");
  }

  const report = disabled ? decodeWritingReport(answer) : null;
  const total = glyph?.medians.length ?? 0;

  return (
    <div className="w-full">
      <div className="flex items-start gap-3 mb-4">
        <div className="text-lg font-bold text-ink leading-relaxed whitespace-pre-wrap flex-1">
          <MathText text={question.question} />
        </div>
        <TTSButton src={question.audio?.question} className="mt-1" label="朗读题目" />
      </div>

      {failed ? (
        <div className="rounded-xl bg-danger/10 border-2 border-danger/40 px-4 py-6 text-center text-sm font-bold text-danger-dark">
          找不到「{char}」的笔顺数据，本题可跳过
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-extrabold text-ink-softer">
            {mode === "trace" ? (
              <span>
                第 {Math.min(strokeNum + 1, total) || 1} / {total || "?"} 笔
              </span>
            ) : (
              <span>写完整个字</span>
            )}
            {total > 0 && mode === "trace" && (
              <span className="flex gap-1" aria-hidden>
                {Array.from({ length: total }, (_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "w-2 h-2 rounded-full",
                      i < strokeNum ? "bg-primary" : i === strokeNum ? "bg-ink-softer" : "bg-bg-softer",
                    )}
                  />
                ))}
              </span>
            )}
          </div>

          <canvas
            ref={canvasRef}
            width={320}
            height={320}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={e => endStroke(e.pointerId)}
            onPointerCancel={e => endStroke(e.pointerId)}
            onLostPointerCapture={e => endStroke(e.pointerId)}
            className={cn(
              "text-humpback bg-white rounded-xl border-2 border-bg-softer w-full max-w-[min(72vw,340px)] aspect-square",
              interactive ? "cursor-crosshair" : "pointer-events-none select-none",
            )}
            style={{ touchAction: "none" }}
          />

          <div className="flex items-center gap-2">
            {mode === "whole" && !disabled && (
              <button
                type="button"
                onClick={() => {
                  setDemoDone(0); // 先归零，避免上一轮留下的实墨闪一帧
                  setDemo(d => !d);
                }}
                className="btn-chunky-ghost px-4 py-2 text-sm"
              >
                {demo ? "收起示范" : "看笔顺"}
              </button>
            )}
            {strokes.length > 0 && !disabled && (
              <button
                type="button"
                onClick={clearAll}
                className="btn-chunky-ghost px-4 py-2 text-sm"
              >
                重写
              </button>
            )}
          </div>

          <div className="min-h-[1.25rem] text-center text-sm font-bold">
            {hint && <span className="text-warning">{hint}</span>}
            {!hint && report && (
              <span className={report.score >= (spec?.threshold ?? 0.7) ? "text-primary-dark" : "text-ink-light"}>
                {Math.round(report.score * 100)} 分
                {report.hints.length ? ` · ${report.hints[0]}` : " · 写得很好！"}
              </span>
            )}
            {!hint && !report && mode === "whole" && strokes.length === 0 && (
              <span className="text-ink-softer text-xs">用 Apple Pencil 或手指在格子里写</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
