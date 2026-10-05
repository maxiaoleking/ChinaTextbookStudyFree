"use client";

/**
 * 连线题：左列 4 项、右列 4 项，点选配对。
 *
 * options: 8 项数组，前 4 是左列（A/B/C/D），后 4 是右列（1/2/3/4）
 * answer:  "A-1,B-2,C-3,D-4" 形式的字符串
 *
 * 交互：
 *   - 点左列某项 → 高亮，等待选右列
 *   - 点右列某项 → 配对完成，连线显示
 *   - 再次点左列已配对的项可以解除该对
 *   - 4 对都配齐后自动写入 answer
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import { MathText } from "@/components/MathText";
import { TTSButton } from "@/components/TTSButton";
import { playSfx } from "@/lib/sfx";
import { haptic } from "@/lib/haptic";
import { playTTS } from "@/lib/tts";
import { useAutoNarrate } from "@/lib/useAutoNarrate";
import { matchingPairs } from "@/lib/questionAnswer";
import type { QuestionRendererProps } from "./QuestionRenderer";

const LEFT_KEYS = ["A", "B", "C", "D"] as const;
const RIGHT_KEYS = ["1", "2", "3", "4"] as const;
type LeftKey = (typeof LEFT_KEYS)[number];
type RightKey = (typeof RIGHT_KEYS)[number];

// 4 种配色循环，让连线后的卡片有不同色调
const PAIR_COLORS = [
  { border: "border-secondary", bg: "bg-secondary/15", text: "text-secondary-dark" },
  { border: "border-primary", bg: "bg-primary/15", text: "text-primary-dark" },
  { border: "border-warning", bg: "bg-warning/15", text: "text-ink" },
  { border: "border-danger", bg: "bg-danger/15", text: "text-danger-dark" },
];

export function MatchingQuestion({
  question,
  answer,
  phase,
  isCorrect,
  onChange,
}: QuestionRendererProps) {
  const disabled = phase === "checked";
  const options = question.options ?? [];
  const cancelNarrate = useAutoNarrate([question.audio?.question], question.id);
  const left = options.slice(0, 4);
  const right = options.slice(4, 8);

  // The parent owns the answer, including a restored checked question after refresh.
  const parsed = matchingPairs(answer);
  const pairs = Object.fromEntries(LEFT_KEYS.map(key => [key, parsed[key] ?? null])) as Record<LeftKey, RightKey | null>;
  const correctPairs = matchingPairs(question.answer);
  const [activeLeft, setActiveLeft] = useState<LeftKey | null>(null);

  // 题目切换重置
  useEffect(() => {
    setActiveLeft(null);
  }, [question.id]);

  function updatePairs(next: Record<LeftKey, RightKey | null>) {
    onChange(LEFT_KEYS.filter(key => next[key] !== null).map(key => `${key}-${next[key]}`).join(","));
  }

  function pickLeft(k: LeftKey) {
    if (disabled) return;
    cancelNarrate();
    playSfx("tap");
    haptic("light");
    // 朗读当前左项内容
    const idx = LEFT_KEYS.indexOf(k);
    const optAudio = question.audio?.options?.[idx];
    if (optAudio) void playTTS(optAudio);
    // 已配对的左项点击 → 解除配对
    if (pairs[k] !== null) {
      updatePairs({ ...pairs, [k]: null });
      setActiveLeft(null);
      return;
    }
    setActiveLeft(activeLeft === k ? null : k);
  }

  function pickRight(rk: RightKey) {
    if (disabled) return;
    if (activeLeft === null) return;
    cancelNarrate();
    playSfx("tap");
    haptic("medium");
    // 朗读当前右项内容
    const idx = 4 + RIGHT_KEYS.indexOf(rk);
    const optAudio = question.audio?.options?.[idx];
    if (optAudio) void playTTS(optAudio);
    // 如果该右项已被其他左项占用，先腾出来
    const next = { ...pairs };
    for (const key of LEFT_KEYS) if (next[key] === rk) next[key] = null;
    next[activeLeft] = rk;
    updatePairs(next);
    setActiveLeft(null);
  }

  // 给每个 left key 分配一个序号 → 颜色
  const leftPairOrder: Record<LeftKey, number> = { A: -1, B: -1, C: -1, D: -1 };
  let order = 0;
  for (const k of LEFT_KEYS) {
    if (pairs[k] !== null) {
      leftPairOrder[k] = order++;
    }
  }
  function colorFor(k: LeftKey) {
    if (disabled && pairs[k]) return pairs[k] === correctPairs[k]
      ? { border: "border-primary", bg: "bg-primary/15", text: "text-primary-dark" }
      : { border: "border-danger", bg: "bg-danger/15", text: "text-danger-dark" };
    const o = leftPairOrder[k];
    return o >= 0 ? PAIR_COLORS[o % PAIR_COLORS.length] : null;
  }
  function colorForRight(rk: RightKey) {
    const owner = LEFT_KEYS.find(k => pairs[k] === rk);
    return owner ? colorFor(owner) : null;
  }

  return (
    <div className="w-full">
      <div className="flex items-start gap-3 mb-6">
        <div className="text-xl font-bold text-ink leading-relaxed whitespace-pre-wrap flex-1">
          <MathText text={question.question} />
        </div>
        <TTSButton src={question.audio?.question} className="mt-1" label="朗读题目" />
      </div>

      {!disabled && <p className="mb-3 text-sm text-ink-light">先点左边，再点右边；已配对 {Object.values(pairs).filter(Boolean).length}/4</p>}
      <div className="grid grid-cols-2 gap-3">
        {/* 左列 */}
        <div className="min-w-0 flex flex-col gap-2">
          {LEFT_KEYS.map((k, i) => {
            const txt = left[i] ?? "";
            const c = colorFor(k);
            const active = activeLeft === k;
            return (
              <motion.button
                key={k}
                type="button"
                disabled={disabled}
                aria-pressed={active || !!pairs[k]}
                aria-label={`左侧 ${k}：${txt}${pairs[k] ? `，已配对右侧 ${pairs[k]}，点击可取消` : ""}`}
                onClick={() => pickLeft(k)}
                whileTap={!disabled ? { scale: 0.98 } : undefined}
                className={cn(
                  "option-card !px-2 sm:!px-4 text-left flex items-center gap-2 min-w-0",
                  c
                    ? `${c.border} ${c.bg} ${c.text}`
                    : active
                      ? "option-card-selected"
                      : undefined,
                )}
              >
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white border-2 border-current text-xs shrink-0">
                  {k}
                </span>
                <span className="flex-1 min-w-0 break-words">{txt}</span>
                {pairs[k] && <span className="text-xs opacity-70 shrink-0">→{pairs[k]}</span>}
              </motion.button>
            );
          })}
        </div>

        {/* 右列 */}
        <div className="min-w-0 flex flex-col gap-2">
          {RIGHT_KEYS.map((k, i) => {
            const txt = right[i] ?? "";
            const c = colorForRight(k);
            const clickable = activeLeft !== null && !disabled;
            return (
              <motion.button
                key={k}
                type="button"
                disabled={disabled || activeLeft === null}
                aria-label={`右侧 ${k}：${txt}`}
                onClick={() => pickRight(k)}
                whileTap={clickable ? { scale: 0.98 } : undefined}
                className={cn(
                  "option-card !px-2 sm:!px-4 text-left flex items-center gap-2 min-w-0",
                  c
                    ? `${c.border} ${c.bg} ${c.text}`
                    : clickable
                      ? undefined
                      : "text-ink-softer cursor-default hover:border-bg-softer hover:bg-white",
                )}
              >
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white border-2 border-current text-xs shrink-0">
                  {k}
                </span>
                <span className="flex-1 min-w-0 break-words">{txt}</span>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* 错误时显示正确答案 */}
      <AnimatePresence>
        {phase === "checked" && !isCorrect && (
          <motion.div
            initial={{ y: 6, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="mt-4 text-center text-sm text-ink-light"
          >
            正确配对：
            <span className="font-extrabold text-primary-dark">{question.answer}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
