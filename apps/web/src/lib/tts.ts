"use client";

/**
 * tts.ts — 朗读链路（本地真人音频优先）
 *
 * 候选顺序（前一个放不出来才退到下一个）：
 *   1. build-data 注入的本地文件：拼音选项 → /audio/pinyin/{key}.mp3（真人音节），
 *      题干 / 解析 → /audio/xx/<sha1>.mp3（按可朗读改写文本合成，含同音字替换）
 *   2. 本地拼音镜像兜底：组件没带 src 时按音节名拼路径
 *   3. Panda Polly 在线：仅当 localStorage `csf-online-polly` === "1" 才启用
 *   4. Web Speech 兜底：例字 + 声调名（拼音）/ 原文（汉字）
 *
 * 在线加强默认关闭 —— 本地镜像已覆盖全部音节与题库文本，第三方站点只做可选加强。
 */

import { isMuted } from "./sfx";
import {
  isOnlinePollyEnabled,
  isPinyinText,
  localPinyinAudioSrc,
  onlinePollySrc,
  pinyinToSpeakable,
  setOnlinePollyEnabled,
} from "./pinyinSpeak";

export { isOnlinePollyEnabled, setOnlinePollyEnabled };

let el: HTMLAudioElement | null = null;
let currentSrc: string | null = null;
let finishCurrent: ((result: TTSPlaybackResult) => void) | null = null;

export type TTSPlaybackResult = "ended" | "interrupted" | "error" | "blocked" | "muted" | "missing";

const preloaded = new Map<string, HTMLAudioElement>();
const PRELOAD_MAX = 24;

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

/**
 * 拼音选项（tiān）→ 系统 TTS 兜底文案（例字 + 声调）。
 * 在线/本地 Polly 成功时不会走到这里。
 */
export function toSpeakable(text: string): string {
  const t = (text || "").trim();
  if (!t) return t;
  if (isPinyinText(t)) return pinyinToSpeakable(t);
  return t.replace(/[「」『』]/g, "").trim();
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
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  a.pause();
  a.currentTime = 0;
  currentSrc = null;
}

function pickZhVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const pref = [
    /Tingting/i,
    /Mei-?jia|Meijia/i,
    /zh[-_]CN/i,
    /Chinese.*China|China.*Chinese/i,
    /zh[-_]TW/i,
    /Chinese/i,
  ];
  for (const re of pref) {
    const v = voices.find(v => re.test(`${v.name} ${v.lang}`));
    if (v) return v;
  }
  return null;
}

/** Web Speech 兜底朗读；无 API / 静音时直接 resolve */
export function playSpeech(text: string): Promise<void> {
  if (!text || typeof window === "undefined") return Promise.resolve();
  if (isMuted()) return Promise.resolve();
  if (!("speechSynthesis" in window)) return Promise.resolve();

  const speakable = isPinyinText(text) ? pinyinToSpeakable(text) : toSpeakable(text);
  if (!speakable) return Promise.resolve();

  window.speechSynthesis.cancel();

  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(speakable);
    const voice = pickZhVoice();
    if (voice) u.voice = voice;
    u.lang = voice?.lang || "zh-CN";
    u.rate = 0.88;
    u.pitch = 1.05;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    try {
      window.speechSynthesis.speak(u);
    } catch {
      finish();
      return;
    }
    const maxMs = Math.min(20000, 2000 + speakable.length * 180);
    window.setTimeout(finish, maxMs);
  });
}

export interface PlayTTSOptions {
  /** 朗读原文（拼音/汉字）；在线加强与系统兜底都用它 */
  text?: string | null;
}

/** 构造候选音频 URL 列表：本地文件在前，在线加强（默认关）在后 */
export function buildTTSCandidates(
  src: string | undefined | null,
  text: string | undefined | null,
): string[] {
  const t = (text || "").trim();
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (u && !out.includes(u)) out.push(u);
  };

  push(src); // build-data 注入的本地文件：真人音节镜像 / 可朗读改写音频
  if (t && isPinyinText(t)) push(localPinyinAudioSrc(t));
  if (t && isOnlinePollyEnabled()) push(onlinePollySrc(t));
  return out;
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

/**
 * 朗读：预生成 src → 本地拼音镜像 → 在线加强（默认关）逐个试播，
 * 全部试播失败才退回系统 Web Speech；muted / interrupted / blocked 直接收尾。
 */
export async function playTTS(
  src: string | undefined | null,
  opts?: PlayTTSOptions | string | null,
): Promise<void> {
  const rawText = (typeof opts === "string" ? opts : opts?.text || "").trim();

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }

  for (const cand of buildTTSCandidates(src, rawText)) {
    const result = await playTTSResult(cand);
    if (result !== "error" && result !== "missing") return;
  }

  if (rawText) await playSpeech(rawText);
}

export function isPlayingTTS(src: string): boolean {
  const a = getEl();
  return !!a && currentSrc === src && !a.paused;
}

// 预热 voices（Chrome 异步加载）
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
  };
}
