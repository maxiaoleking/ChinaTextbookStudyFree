"use client";

/**
 * 词语排序题：把打乱的词语按正确顺序点击拼成句子。
 *
 * answer 是逗号连接的正确顺序词语；
 * options 是打乱顺序的同一组词语。
 *
 * 交互：
 *   - 上方"已选区"按点击顺序展示
 *   - 下方词语保持原位置；选过的词保留不可点击的占位
 *   - 点击已选区的词可以撤回
 *   - 全部点完后自动 join 成 string 写入 answer，触发 onChange
 */

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import { MathText } from "@/components/MathText";
import { TTSButton } from "@/components/TTSButton";
import { playSfx } from "@/lib/sfx";
import { haptic } from "@/lib/haptic";
import { playTTS } from "@/lib/tts";
import { useAutoNarrate } from "@/lib/useAutoNarrate";
import { wordOrderIndices } from "@/lib/questionAnswer";
import type { QuestionRendererProps } from "./QuestionRenderer";

export function WordOrderQuestion({
  question,
  answer,
  phase,
  isCorrect,
  onChange,
}: QuestionRendererProps) {
  const disabled = phase === "checked";
  const options = question.options ?? [];
  const cancelNarrate = useAutoNarrate([question.audio?.question], question.id);

  // Preserve clicked identities for repeated words; external/restored answers stay controlled.
  const selectionKey = JSON.stringify([question.id, question.question, options]);
  const [selection, setSelection] = useState(() => ({
    key: selectionKey, answer, indices: wordOrderIndices(options, answer),
  }));
  const picked = useMemo(() => selection.key === selectionKey && selection.answer === answer
    ? selection.indices : wordOrderIndices(options, answer), [selection, selectionKey, options, answer]);

  function updateSelection(indices: number[]) {
    const nextAnswer = indices.map(index => options[index]).join(",");
    setSelection({ key: selectionKey, answer: nextAnswer, indices });
    onChange(nextAnswer);
  }

  /** 播放第 i 个选项的 TTS */
  function playOptionAudio(i: number) {
    const src = question.audio?.options?.[i];
    if (src) playTTS(src);
  }

  function pick(i: number) {
    if (disabled) return;
    if (picked.includes(i)) return;
    cancelNarrate();
    playSfx("tap");
    haptic("light");
    playOptionAudio(i);
    updateSelection([...picked, i]);
  }

  function unpick(i: number) {
    if (disabled) return;
    cancelNarrate();
    playSfx("tap");
    haptic("light");
    playOptionAudio(i);
    updateSelection(picked.filter(index => index !== i));
  }

  // checked 阶段下，把正确序列拆出来供对照展示
  const correctSeq = phase === "checked" ? question.answer.replace(/，/g, ",").split(",").map(s => s.trim()) : [];

  return (
    <div className="w-full">
      <div className="flex items-start gap-3 mb-6">
        <div className="text-xl font-bold text-ink leading-relaxed whitespace-pre-wrap flex-1">
          <MathText text={question.question} />
        </div>
        <TTSButton src={question.audio?.question} className="mt-1" label="朗读题目" />
      </div>

      {/* 已选区 */}
      <div
        className={cn(
          "h-36 sm:h-28 overflow-y-auto rounded-2xl border-2 border-dashed p-3 flex flex-wrap items-start content-start gap-2 mb-4 transition-colors",
          disabled
            ? isCorrect
              ? "border-primary bg-primary/15"
              : "border-danger bg-danger/10"
            : "border-bg-softer bg-bg-soft",
        )}
      >
        <AnimatePresence>
          {picked.length === 0 && !disabled && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-ink-softer text-base self-center"
            >
              点击下方词语按顺序排列
            </motion.span>
          )}
          {picked.map(i => (
            <motion.button
              key={`pick-${i}`}
              type="button"
              layout
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", damping: 18, stiffness: 260 }}
              whileTap={!disabled ? { scale: 0.98 } : undefined}
              onClick={() => unpick(i)}
              disabled={disabled}
              aria-label={`移除词语 ${options[i]}`}
              className="min-h-11 max-w-full px-4 py-2 inline-flex items-center rounded-xl bg-secondary text-white font-extrabold text-base break-words whitespace-normal text-left"
              style={{ boxShadow: "0 3px 0 0 #1899d6" }}
            >
              {options[i]}
            </motion.button>
          ))}
        </AnimatePresence>
      </div>

      {/* 待选区 */}
      <div className="flex flex-wrap gap-2">
        {options.map((_, i) => {
          const selected = picked.includes(i);
          return (
          <motion.button
            key={`opt-${i}`}
            type="button"
            whileTap={!disabled && !selected ? { scale: 0.98 } : undefined}
            onClick={() => pick(i)}
            disabled={disabled || selected}
            aria-label={`${selected ? "已选择" : "选择词语"} ${options[i]}`}
            className={cn("min-h-11 max-w-full px-4 py-2 inline-flex items-center rounded-xl bg-white border-2 border-bg-softer text-ink font-extrabold text-base transition-colors break-words whitespace-normal text-left",
              selected ? "opacity-30 cursor-default" : "hover:border-secondary")}
            style={{ boxShadow: "0 3px 0 0 #e5e5e5" }}
          >
            {options[i]}
          </motion.button>
          );
        })}
      </div>
      {picked.length === options.length && !disabled && <p className="mt-3 text-xs text-ink-softer">已全部选完，请检查</p>}

      {/* 错误时显示正确答案 */}
      {phase === "checked" && !isCorrect && (
        <motion.div
          initial={{ y: 6, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="mt-4 text-center text-sm text-ink-light"
        >
          正确顺序：
          <span className="font-extrabold text-primary-dark">{correctSeq.join(" → ")}</span>
        </motion.div>
      )}
    </div>
  );
}
