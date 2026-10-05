"use client";

/**
 * tts.ts — 播放 build-data 注入的预生成 TTS mp3。
 *
 * 设计：
 *   - 单例 HTMLAudioElement，同一时间只有一段 TTS 在播
 *   - 受全局 muted 状态控制
 *   - 简单 LRU 预加载（避免重复 fetch）
 */

import { isMuted } from "./sfx";

let el: HTMLAudioElement | null = null;
let currentSrc: string | null = null;
let finishCurrent: ((result: TTSPlaybackResult) => void) | null = null;

export type TTSPlaybackResult = "ended" | "interrupted" | "error" | "blocked" | "muted" | "missing";

const preloaded = new Map<string, HTMLAudioElement>();
const PRELOAD_MAX = 16;

function playbackSources(src: string): string[] {
  // Persisted mistake questions can still point at the previous Ogg/Opus assets.
  if (/^\/audio\/.+\.opus(?:[?#].*)?$/i.test(src)) {
    return [src.replace(/\.opus(?=[?#]|$)/i, ".mp3"), src];
  }
  return [src];
}

function getEl(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!el) {
    el = new Audio();
    el.preload = "auto";
  }
  return el;
}

export function preloadTTS(src: string | undefined | null) {
  if (!src || typeof window === "undefined") return;
  if (preloaded.has(src)) return;
  const a = new Audio();
  a.preload = "auto";
  const sources = playbackSources(src);
  if (sources.length > 1) {
    a.addEventListener("error", () => { a.src = sources[1]; }, { once: true });
  }
  a.src = sources[0];
  preloaded.set(src, a);
  if (preloaded.size > PRELOAD_MAX) {
    const first = preloaded.keys().next().value as string | undefined;
    if (first) preloaded.delete(first);
  }
}

export function stopTTS(expectedSrc?: string | null) {
  if (expectedSrc && currentSrc !== expectedSrc) return;
  const a = getEl();
  if (!a) return;
  finishCurrent?.("interrupted");
  a.pause();
  a.currentTime = 0;
  currentSrc = null;
}

/** Distinguish a genuine listen from an interruption or unavailable audio. */
export function playTTSResult(src: string | undefined | null): Promise<TTSPlaybackResult> {
  if (!src) return Promise.resolve("missing");
  if (isMuted()) return Promise.resolve("muted");
  const a = getEl();
  if (!a) return Promise.resolve("missing");
  // 同一段再次点击 → 停止
  if (currentSrc === src && !a.paused) {
    stopTTS();
    return Promise.resolve("interrupted");
  }
  // Settle the previous caller before pausing or attaching the new listeners.
  finishCurrent?.("interrupted");
  a.pause();
  currentSrc = src;
  const sources = playbackSources(src);

  return new Promise<TTSPlaybackResult>(resolve => {
    let done = false;
    let attempt = -1;
    let cleanupAttempt = () => {};
    let lastTime = 0;
    let lastAdvance = Date.now();
    const advance = () => {
      if (a.currentTime > lastTime) {
        lastTime = a.currentTime;
        lastAdvance = Date.now();
      }
    };
    const finish = (result: TTSPlaybackResult) => {
      if (done) return;
      done = true;
      clearInterval(watchdog);
      cleanupAttempt();
      if (finishCurrent === finish) {
        finishCurrent = null;
        currentSrc = null;
      }
      if (result === "error" || result === "blocked") a.pause();
      resolve(result);
    };
    const failed = () => {
      if (done) return;
      if (attempt + 1 < sources.length) startAttempt(attempt + 1);
      else finish("error");
    };
    const startAttempt = (index: number) => {
      if (done) return;
      cleanupAttempt();
      attempt = index;
      a.pause();
      a.src = sources[index];
      a.currentTime = 0;
      lastTime = 0;
      lastAdvance = Date.now();
      const isCurrent = () => !done && attempt === index && finishCurrent === finish;
      const playing = () => { if (isCurrent()) lastAdvance = Date.now(); };
      const ended = () => { if (isCurrent() && a.ended) finish("ended"); };
      const paused = () => {
        // Browsers may send pause before ended, or queue a previous source's event.
        if (isCurrent() && a.paused && !a.ended) finish("interrupted");
      };
      const mediaError = () => {
        // Setting src clears MediaError; ignore an error queued by an older source.
        if (isCurrent() && a.error !== null) failed();
      };
      const timeupdate = () => { if (isCurrent()) advance(); };
      const listeners: Array<[string, EventListener]> = [
        ["ended", ended], ["pause", paused], ["error", mediaError],
        ["timeupdate", timeupdate], ["playing", playing],
      ];
      for (const [event, handler] of listeners) a.addEventListener(event, handler);
      cleanupAttempt = () => {
        for (const [event, handler] of listeners) a.removeEventListener(event, handler);
      };
      const rejected = (error: unknown) => {
        if (!isCurrent()) return;
        if ((error as { name?: string } | null)?.name === "NotAllowedError") finish("blocked");
        else failed();
      };
      try { void Promise.resolve(a.play()).catch(rejected); }
      catch (error) { rejected(error); }
    };
    const watchdog = setInterval(() => {
      advance();
      if (Date.now() - lastAdvance > 15000) failed();
    }, 250);
    finishCurrent = finish;
    startAttempt(0);
  });
}

/** Existing narration callers keep the same completion-only API. */
export async function playTTS(src: string | undefined | null): Promise<void> {
  await playTTSResult(src);
}

export function isPlayingTTS(src: string): boolean {
  const a = getEl();
  return !!a && currentSrc === src && !a.paused;
}
