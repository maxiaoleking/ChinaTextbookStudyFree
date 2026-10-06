"use client";

/**
 * useAutoNarrate — 面向低龄的自动朗读 hook。
 *
 * 支持预生成 src 与文本兜底：src 缺失时用 Web Speech 朗读 text
 * （认字科目题干/选项在未合成音频前也能自动出声）。
 */

import { useCallback, useEffect, useRef } from "react";
import { playTTS, stopTTS } from "./tts";
import { useProgressStore } from "@/store/progress";

export type NarrateItem =
  | string
  | null
  | undefined
  | {
      src?: string | null;
      text?: string | null;
    };

interface Opts {
  /** 段间间隔，默认 200ms */
  gapMs?: number;
  /** 首段开始前的延迟，默认 0。仅在需要避开入场动画时才传 >0 值。 */
  startDelayMs?: number;
  /** 每段开始播放时回调，便于父组件做"当前播放项"高亮。idx 是过滤后非空 src 列表的 0 起索引。 */
  onSrcStart?: (idx: number) => void;
  /** 全部播放完毕（或被取消）时回调，可用于清理高亮状态。 */
  onAllDone?: () => void;
}

function normalizeItems(items: NarrateItem[]): Array<{ src?: string | null; text?: string | null }> {
  return items
    .map(item => {
      if (item == null) return null;
      if (typeof item === "string") return { src: item, text: null };
      const hasSrc = typeof item.src === "string" && item.src.length > 0;
      const hasText = typeof item.text === "string" && item.text.trim().length > 0;
      if (!hasSrc && !hasText) return null;
      return { src: item.src, text: item.text };
    })
    .filter(Boolean) as Array<{ src?: string | null; text?: string | null }>;
}

export function useAutoNarrate(
  srcs: NarrateItem[],
  key: string | number,
  opts: Opts = {},
): () => void {
  const { gapMs = 200, startDelayMs = 0, onSrcStart, onAllDone } = opts;
  const autoNarrate = useProgressStore(s => s.autoNarrate);
  const muted = useProgressStore(s => s.muted);

  const srcsRef = useRef(srcs);
  srcsRef.current = srcs;
  const onSrcStartRef = useRef(onSrcStart);
  onSrcStartRef.current = onSrcStart;
  const onAllDoneRef = useRef(onAllDone);
  onAllDoneRef.current = onAllDone;

  const cancelledRef = useRef(false);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stopTTS();
  }, []);

  useEffect(() => {
    if (!autoNarrate || muted) return;
    cancelledRef.current = false;

    const run = async () => {
      if (startDelayMs > 0) {
        await sleep(startDelayMs);
        if (cancelledRef.current) return;
      }

      const list = normalizeItems(srcsRef.current);
      for (let i = 0; i < list.length; i++) {
        if (cancelledRef.current) return;
        onSrcStartRef.current?.(i);
        const item = list[i];
        await playTTS(item.src, { text: item.text });
        if (cancelledRef.current) return;
        if (i < list.length - 1) await sleep(gapMs);
      }
      if (!cancelledRef.current) onAllDoneRef.current?.();
    };

    void run();

    return () => {
      cancelledRef.current = true;
      stopTTS();
      onAllDoneRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, autoNarrate, muted]);

  return cancel;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
