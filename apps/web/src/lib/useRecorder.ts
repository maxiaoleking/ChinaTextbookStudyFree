"use client";

/**
 * useRecorder — 轻量麦克风录音 hook。
 *
 * - 用原生 MediaRecorder，不接 ASR、不上传
 * - 每次 stop() 返回一个 blob URL，交给组件去 new Audio(url) 回放
 * - 刷新页面即丢（不落磁盘），因此不涉及隐私持久化
 *
 * 用法：
 *   const rec = useRecorder();
 *   await rec.start();
 *   const url = await rec.stop(); // blob URL
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RecorderController, type RecorderSnapshot } from "./recorder";
export type { RecorderState } from "./recorder";

export function useRecorder() {
  const [snapshot, setSnapshot] = useState<RecorderSnapshot>({ state: "idle", error: null });
  const controllerRef = useRef<RecorderController | null>(null);
  const getController = useCallback(() => {
    if (!controllerRef.current) controllerRef.current = new RecorderController(setSnapshot);
    return controllerRef.current;
  }, []);
  useEffect(() => () => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
  }, []);
  const start = useCallback(() => getController().start(), [getController]);
  const stop = useCallback(() => controllerRef.current?.stop() ?? Promise.resolve(null), []);
  return { ...snapshot, start, stop };
}
