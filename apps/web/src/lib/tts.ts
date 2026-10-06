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
let speechUtter: SpeechSynthesisUtterance | null = null;

const preloaded = new Map<string, HTMLAudioElement>();
const PRELOAD_MAX = 24;

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
  a.src = src;
  preloaded.set(src, a);
  if (preloaded.size > PRELOAD_MAX) {
    const first = preloaded.keys().next().value as string | undefined;
    if (first) preloaded.delete(first);
  }
}

export function stopTTS() {
  const a = getEl();
  if (a) {
    a.pause();
    a.currentTime = 0;
    currentSrc = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    speechUtter = null;
  }
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
    speechUtter = u;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      speechUtter = null;
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

function tryPlaySrc(src: string): Promise<boolean> {
  const a = getEl();
  if (!a) return Promise.resolve(false);

  return new Promise(resolve => {
    let settled = false;
    const ok = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      a.removeEventListener("playing", onPlaying);
      a.removeEventListener("error", onError);
    };
    const onPlaying = () => ok();
    const onError = () => fail();

    a.pause();
    a.currentTime = 0;
    a.src = src;
    a.addEventListener("playing", onPlaying);
    a.addEventListener("error", onError);
    // 150ms 内无 playing 且无 error → 也继续等 play() promise
    a.play().then(() => {
      // play resolved：若仍在加载，playing 事件会随后触发
      // 用超时兜底：已开始播或 ended 短音频都算成功
      window.setTimeout(() => {
        if (!settled && !a.paused && a.currentTime >= 0) ok();
        else if (!settled && a.error) fail();
        else if (!settled && a.paused && !a.error) {
          // 可能短音频已结束
          if (a.ended || a.duration > 0) ok();
        }
      }, 80);
    }).catch(() => fail());

    window.setTimeout(() => fail(), 4000);
  });
}

function playViaElement(src: string): Promise<void> {
  const a = getEl();
  if (!a) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      a.removeEventListener("ended", finish);
      a.removeEventListener("pause", finish);
      a.removeEventListener("error", finish);
      resolve();
    };
    a.addEventListener("ended", finish);
    a.addEventListener("pause", finish);
    a.addEventListener("error", finish);
    a.play().catch(finish);
  });
}

/**
 * 朗读：在线 Polly → 本地拼音镜像 → 预生成 src → Web Speech。
 */
export async function playTTS(
  src: string | undefined | null,
  opts?: PlayTTSOptions | string | null,
): Promise<void> {
  const text = typeof opts === "string" ? opts : opts?.text;
  if (isMuted()) return Promise.resolve();

  const rawText = (text || "").trim();
  const candidates = buildTTSCandidates(src, rawText);

  // 再次点击同一源 → 停止
  const a = getEl();
  if (a && currentSrc && !a.paused && candidates[0] === currentSrc) {
    a.pause();
    a.currentTime = 0;
    currentSrc = null;
    return Promise.resolve();
  }

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    speechUtter = null;
  }

  for (const cand of candidates) {
    if (isMuted()) return Promise.resolve();
    const playable = await tryPlaySrc(cand);
    if (playable) {
      currentSrc = cand;
      await playViaElement(cand);
      currentSrc = null;
      return;
    }
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
