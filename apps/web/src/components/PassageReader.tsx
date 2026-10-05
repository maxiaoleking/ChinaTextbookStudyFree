"use client";

/**
 * PassageReader — 课文听读 / 跟读组件。
 *
 * 三种模式：
 *   1. 听读：顺序播放每句 mp3，当前播放句高亮
 *   2. 单句：点每句前的小喇叭播这一句
 *   3. 跟读：对每句先播原音、再录音、走完全文后可逐句回放（原音 vs 我的）
 *
 * 复用 `lib/tts.ts` 的单例 audio + mute 状态，避免两段同时播。
 * 录音用原生 MediaRecorder（`useRecorder`），不上传、刷新即丢。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, Play, Pause, Mic, Square, RotateCcw } from "lucide-react";
import { Volume, Lightning } from "@/components/icons";
import { InnerHeader } from "@/components/InnerHeader";
import { playTTSResult, preloadTTS, stopTTS } from "@/lib/tts";
import { useRecorder } from "@/lib/useRecorder";
import { playSentenceSequence } from "@/lib/readingPlayback";
import { useLearningTime } from "@/lib/useLearningTime";
import { MuteToggle, useSyncMute } from "@/components/MuteToggle";
import { useProgressStore } from "@/store/progress";
import { playSfx } from "@/lib/sfx";
import { haptic } from "@/lib/haptic";
import { cn } from "@/lib/cn";
import type { Passage } from "@/types";

/** 课文听读完成奖励：在 localStorage 里记一个集合避免重复发 */
const PASSAGE_REWARDS_KEY = "csf-passage-rewards-v1";
type RewardKind = "listen" | "followup";
function hasPassageReward(passageId: string, kind: RewardKind): boolean {
  if (useProgressStore.getState().completedLessons[`passage-${passageId}-${kind}`]) return true;
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(PASSAGE_REWARDS_KEY);
    const obj = raw ? (JSON.parse(raw) as Record<string, RewardKind[]>) : {};
    return (obj[passageId] ?? []).includes(kind);
  } catch {
    return false;
  }
}
function markPassageReward(passageId: string, kind: RewardKind): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(PASSAGE_REWARDS_KEY);
    const obj = raw ? (JSON.parse(raw) as Record<string, RewardKind[]>) : {};
    const list = obj[passageId] ?? [];
    if (!list.includes(kind)) {
      obj[passageId] = [...list, kind];
      window.localStorage.setItem(PASSAGE_REWARDS_KEY, JSON.stringify(obj));
    }
  } catch {
    // 静默
  }
}

const XP_LISTEN = 5;
const XP_FOLLOWUP = 10;

interface Props {
  passage: Passage;
  backHref: string;
}

type Mode = "idle" | "playing" | "followup";

export function PassageReader({ passage, backHref }: Props) {
  useLearningTime();
  useSyncMute();
  const [mode, setMode] = useState<Mode>("idle");
  const modeRef = useRef<Mode>("idle");
  const updateMode = useCallback((next: Mode) => { modeRef.current = next; setMode(next); }, []);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  /** 跟读模式下每句的学生录音 blob URL */
  const [recordings, setRecordings] = useState<(string | null)[]>(
    () => passage.sentences.map(() => null),
  );
  const generationRef = useRef(0);
  const recordingsRef = useRef(recordings);
  recordingsRef.current = recordings;
  const myAudioRef = useRef<HTMLAudioElement | null>(null);
  const finishSentenceRef = useRef<(() => void) | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState<number | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const rec = useRecorder();
  const muted = useProgressStore(s => s.muted);

  const stopMyRecording = useCallback(() => {
    myAudioRef.current?.pause();
    myAudioRef.current = null;
  }, []);

  useEffect(() => {
    if (!muted || modeRef.current === "idle" && !myAudioRef.current) return;
    generationRef.current++;
    finishSentenceRef.current = null;
    stopTTS();
    stopMyRecording();
    void rec.stop().then(url => { if (url) URL.revokeObjectURL(url); });
    updateMode("idle");
    setCurrentIndex(null);
    setRecordingSeconds(null);
    setAudioError("当前已静音，可以打开声音后重新开始。");
    // Only react to the setting, not recording state changes during a run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted]);

  const resetRecordings = useCallback(() => {
    stopMyRecording();
    recordingsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
    const empty = passage.sentences.map(() => null);
    recordingsRef.current = empty;
    setRecordings(empty);
  }, [passage, stopMyRecording]);

  // XP 奖励集成（接进 progress store 当 XP / gems 算）
  const recordPassageXp = useProgressStore(s => s.recordLessonComplete);
  const [xpToast, setXpToast] = useState<{ amount: number; key: number } | null>(null);

  function grantPassageReward(kind: RewardKind, xp: number) {
    if (hasPassageReward(passage.id, kind)) return;
    markPassageReward(passage.id, kind);
    // 用 recordLessonComplete 走主流：accuracy=1 → 三星 → 自动加 XP + gems + dailyGoal 进度
    // lessonId 用 passage- 前缀，避免和真正的 lesson 冲突
    const previousXp = useProgressStore.getState().xp;
    recordPassageXp(`passage-${passage.id}-${kind}`, passage.title, 1.0, xp);
    setXpToast({ amount: useProgressStore.getState().xp - previousXp, key: Date.now() });
    playSfx("star");
    haptic("success");
  }

  // 课本原页：render_pages.py 已经应用了书级 offset 算出真实 PDF 物理页 pdfPage，
  // pageImages 一般是 [pdfPage-1, pdfPage, pdfPage+1] 按页号升序。默认显示 pdfPage。
  const pageImages = passage.pageImages ?? [];
  const defaultPageIdx = useMemo(() => {
    if (pageImages.length === 0) return 0;
    if (!passage.pdfPage) return Math.floor(pageImages.length / 2);
    for (let i = 0; i < pageImages.length; i++) {
      const m = /p(\d+)\.jpg/.exec(pageImages[i]);
      if (m && parseInt(m[1], 10) === passage.pdfPage) return i;
    }
    return Math.floor(pageImages.length / 2);
  }, [pageImages, passage.pdfPage]);
  const [pageIdx, setPageIdx] = useState(defaultPageIdx);
  useEffect(() => setPageIdx(defaultPageIdx), [defaultPageIdx]);

  // 预加载全部句子音频，减少切换时的停顿
  useEffect(() => {
    for (const s of passage.sentences) {
      if (s.audio) preloadTTS(s.audio);
    }
  }, [passage]);

  // 清理：卸载时停掉一切
  useEffect(() => {
    return () => {
      generationRef.current++;
      stopTTS();
      myAudioRef.current?.pause();
      recordingsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
    };
  }, []);

  const sleep = (ms: number) =>
    new Promise<void>(resolve => setTimeout(resolve, ms));

  const playSingle = useCallback(async (idx: number) => {
    const s = passage.sentences[idx];
    if (!s?.audio) return;
    const generation = ++generationRef.current;
    stopTTS();
    stopMyRecording();
    setAudioError(null);
    updateMode("playing");
    setCurrentIndex(idx);
    const result = await playTTSResult(s.audio);
    if (generation !== generationRef.current) return;
    if (result !== "ended" && result !== "interrupted") {
      setAudioError(result === "muted" ? "当前已静音，请打开声音后再听读。" : "语音暂时无法播放，请重试。");
    }
    setCurrentIndex(null);
    updateMode("idle");
  }, [passage, stopMyRecording, updateMode]);

  const playAll = useCallback(async () => {
    if (modeRef.current === "playing") {
      generationRef.current++;
      stopTTS();
      updateMode("idle");
      setCurrentIndex(null);
      return;
    }
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    stopTTS();
    stopMyRecording();
    setAudioError(null);
    updateMode("playing");
    const result = await playSentenceSequence(passage.sentences, { isCurrent, onSentence: setCurrentIndex, gapMs: 200 });
    if (!isCurrent()) return;
    if (result.failure) setAudioError(result.failure === "muted" ? "当前已静音，请打开声音后再听读。" : "语音暂时无法播放，请重试。");
    setCurrentIndex(null);
    updateMode("idle");
    // 完整听完整篇 → 首次给 XP
    if (result.completed) {
      grantPassageReward("listen", XP_LISTEN);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passage, stopMyRecording, updateMode]);

  // 跟读流程：逐句 → 播原音 → 录音 → 下一句
  const runFollowup = useCallback(async () => {
    if (modeRef.current === "followup") {
      // 中断
      const generation = ++generationRef.current;
      finishSentenceRef.current = null;
      stopTTS();
      const url = await rec.stop();
      if (url) URL.revokeObjectURL(url);
      if (generation !== generationRef.current) return;
      setRecordingSeconds(null);
      updateMode("idle");
      setCurrentIndex(null);
      return;
    }
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    stopTTS();
    resetRecordings();
    setAudioError(null);
    updateMode("followup");
    let completed = passage.sentences.some(sentence => sentence.audio);

    for (let i = 0; i < passage.sentences.length; i++) {
      if (!isCurrent()) break;
      const s = passage.sentences[i];
      if (!s.audio) continue;
      setCurrentIndex(i);

      // 1) 播原音
      const result = await playTTSResult(s.audio);
      if (!isCurrent()) break;
      if (result !== "ended") {
        completed = false;
        setAudioError(result === "muted" ? "当前已静音，请打开声音后再跟读。" : "原音暂时无法播放，请重试。");
        break;
      }
      await sleep(250);
      if (!isCurrent()) break;

      // 2) 给长句足够时间，学生也可以主动完成当前句。
      const started = await rec.start();
      if (!isCurrent()) break;
      if (!started) {
        completed = false;
        break;
      }
      const maxMs = Math.min(60000, Math.max(5000, s.text.length * 320 + 2000));
      const t0 = Date.now();
      let sentenceFinished = false;
      finishSentenceRef.current = () => { sentenceFinished = true; };
      while (Date.now() - t0 < maxMs) {
        if (!isCurrent() || sentenceFinished) break;
        setRecordingSeconds(Math.ceil((maxMs - (Date.now() - t0)) / 1000));
        await sleep(100);
      }
      if (!isCurrent()) break;
      finishSentenceRef.current = null;
      const url = await rec.stop();
      if (!isCurrent()) {
        if (url) URL.revokeObjectURL(url);
        break;
      }
      setRecordingSeconds(null);
      if (url) {
        const next = [...recordingsRef.current];
        next[i] = url;
        recordingsRef.current = next;
        setRecordings(next);
      } else {
        completed = false;
        setAudioError("没有保存到这句录音，请重新跟读。");
        break;
      }
      await sleep(150);
    }

    if (!isCurrent()) return;
    finishSentenceRef.current = null;
    setRecordingSeconds(null);
    setCurrentIndex(null);
    updateMode("idle");
    // 完整完成跟读 → 首次给 XP（更高奖励）
    if (completed) {
      grantPassageReward("followup", XP_FOLLOWUP);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passage, rec, resetRecordings, updateMode]);

  const playMyRecording = useCallback((idx: number) => {
    const url = recordings[idx];
    if (!url) return;
    if (useProgressStore.getState().muted) {
      setAudioError("当前已静音，请打开声音后再听录音。");
      return;
    }
    generationRef.current++;
    stopTTS();
    stopMyRecording();
    setCurrentIndex(null);
    updateMode("idle");
    setAudioError(null);
    const generation = generationRef.current;
    const audio = new Audio(url);
    myAudioRef.current = audio;
    audio.onerror = () => { if (generation === generationRef.current) setAudioError("这段录音暂时无法播放，请重新录音。"); };
    void audio.play().catch(() => { if (generation === generationRef.current) setAudioError("这段录音暂时无法播放，请重试。"); });
  }, [recordings, stopMyRecording, updateMode]);

  const hasAnyAudio = passage.sentences.some(s => s.audio);
  const hasPartialAudio = hasAnyAudio && passage.sentences.some(s => !s.audio);
  const isPoem =
    passage.kind === "poem" ||
    passage.kind === "ancient_poem" ||
    passage.kind === "song";

  return (
    <main className="min-h-screen bg-bg-soft pb-[calc(10rem+env(safe-area-inset-bottom))]">
      <InnerHeader
        backHref={backHref}
        title={passage.title}
        subtitle={passage.author ?? undefined}
        right={<MuteToggle />}
      />

      {passage.readingNote && (
        <p className="max-w-6xl mx-auto px-4 pt-4 text-sm text-text-secondary" role="note">
          {passage.readingNote}
        </p>
      )}

      {/* 桌面双栏：lg+ 时课本原页(左) + 课文正文(右) 并排；移动端顺序堆叠 */}
      <div
        className={cn(
          "max-w-md lg:max-w-6xl mx-auto",
          pageImages.length > 0 && "lg:grid lg:grid-cols-[3fr_2fr] lg:gap-6 lg:items-start",
        )}
      >
      {/* 课本原页 */}
      {pageImages.length > 0 && (
        <div className="px-4 pt-4 lg:pt-5">
          <div className="relative rounded-2xl overflow-hidden bg-white border border-bg-softer shadow-sm">
            <img
              src={pageImages[pageIdx]}
              alt={`${passage.title} - 课本原页`}
              className="w-full h-auto block"
            />
            {pageImages.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label="上一页"
                  disabled={pageIdx === 0}
                  onClick={() => setPageIdx(i => Math.max(0, i - 1))}
                  className={cn(
                    "absolute left-2 top-1/2 -translate-y-1/2",
                    "w-11 h-11 rounded-full bg-white/90 text-ink shadow-md backdrop-blur",
                    "inline-flex items-center justify-center",
                    pageIdx === 0 && "opacity-30 cursor-not-allowed",
                  )}
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  type="button"
                  aria-label="下一页"
                  disabled={pageIdx === pageImages.length - 1}
                  onClick={() =>
                    setPageIdx(i => Math.min(pageImages.length - 1, i + 1))
                  }
                  className={cn(
                    "absolute right-2 top-1/2 -translate-y-1/2",
                    "w-11 h-11 rounded-full bg-white/90 text-ink shadow-md backdrop-blur",
                    "inline-flex items-center justify-center",
                    pageIdx === pageImages.length - 1 && "opacity-30 cursor-not-allowed",
                  )}
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-[10px] px-2 py-0.5 rounded-full">
                  {pageIdx + 1} / {pageImages.length}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 课文正文 */}
      <div className="px-4 pt-5 lg:pt-5">
        {!hasAnyAudio && (
          <div className="mb-4 rounded-xl bg-warning/10 text-ink-light text-xs px-3 py-2">
            本课文的朗读音频还在生成中，暂时只能看文字
          </div>
        )}
        {hasPartialAudio && <div className="mb-4 rounded-xl bg-warning/10 text-ink-light text-xs px-3 py-2">
          带空白或特殊字形的句子请对照课本阅读，听读会播放其余句子。
        </div>}

        <div
          className={cn(
            "rounded-2xl bg-white border border-bg-softer p-4 shadow-sm",
            isPoem && "text-center",
          )}
        >
          {passage.sentences.map((s, i) => {
            const active = currentIndex === i;
            return (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-2 rounded-lg px-2 py-2 my-0.5 transition-colors",
                  active && "bg-primary/10 ring-1 ring-primary/40",
                  isPoem && "justify-center",
                )}
              >
                {!isPoem && (
                  <button
                    type="button"
                    aria-label="朗读这一句"
                    onClick={() => playSingle(i)}
                    disabled={!s.audio || mode !== "idle"}
                    className={cn(
                      "shrink-0 w-11 h-11 inline-flex items-center justify-center rounded-full",
                      "bg-bg-soft text-primary hover:bg-primary/10 transition-colors",
                      (!s.audio || mode !== "idle") && "opacity-40 cursor-not-allowed",
                    )}
                  >
                    <Volume className="w-4 h-4" />
                  </button>
                )}
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words text-lg leading-[2] text-ink",
                    isPoem && "text-center",
                    active && "font-bold text-primary",
                  )}
                >
                  {s.text}
                </span>
              </div>
            );
          })}
        </div>

        {/* 跟读模式：已录音列表，可回放原音 vs 我的 */}
        <AnimatePresence>
          {recordings.some(Boolean) && mode !== "followup" && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-5 rounded-2xl bg-white border border-bg-softer p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-bold text-ink">我的朗读</div>
                <button
                  type="button"
                  onClick={resetRecordings}
                  className="min-h-11 inline-flex items-center gap-1 text-xs text-ink-light hover:text-danger"
                >
                  <RotateCcw className="w-3 h-3" />
                  清空
                </button>
              </div>
              <ul className="space-y-2">
                {passage.sentences.map((s, i) => {
                  const myUrl = recordings[i];
                  return (
                    <li
                      key={i}
                      className="flex items-center gap-2 text-sm text-ink"
                    >
                      <span className="shrink-0 w-5 text-ink-light tabular-nums">
                        {i + 1}.
                      </span>
                      <span className="flex-1 truncate">{s.text}</span>
                      <button
                        type="button"
                        onClick={() => playSingle(i)}
                        disabled={!s.audio}
                        className="min-h-11 min-w-11 shrink-0 text-xs px-2 py-1 rounded-full bg-bg-soft text-primary disabled:opacity-40"
                      >
                        原音
                      </button>
                      <button
                        type="button"
                        onClick={() => playMyRecording(i)}
                        disabled={!myUrl}
                        className="min-h-11 min-w-11 shrink-0 text-xs px-2 py-1 rounded-full bg-secondary/15 text-secondary disabled:opacity-40"
                      >
                        我的
                      </button>
                    </li>
                  );
                })}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      </div>

      {/* 底部操作栏 */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t border-bg-softer shadow-[0_-4px_12px_rgba(0,0,0,0.04)]" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {mode === "followup" && <div className="max-w-md lg:max-w-6xl mx-auto px-4 pt-3 flex items-center justify-between gap-3 text-sm" role="status">
          <span className="font-bold text-ink">
            {rec.state === "requesting" ? "正在等待麦克风权限…"
              : rec.state === "recording" ? `轮到你读了 · ${recordingSeconds ?? 0} 秒`
              : "先听原音，再轮到你读"}
          </span>
          {rec.state === "recording" && <button type="button" onClick={() => finishSentenceRef.current?.()} className="rounded-xl bg-secondary/15 px-4 py-2 font-bold text-secondary-dark shrink-0">录好了</button>}
        </div>}
        <div className="max-w-md lg:max-w-6xl mx-auto px-4 py-3 flex gap-3">
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={playAll}
            disabled={!hasAnyAudio || mode === "followup"}
            className={cn(
              "flex-1 gap-2",
              mode === "playing" ? "btn-chunky-danger" : "btn-chunky-primary",
              (!hasAnyAudio || mode === "followup") && "btn-chunky-disabled",
            )}
          >
            {mode === "playing" ? (
              <>
                <Pause className="w-5 h-5" />
                停止
              </>
            ) : (
              <>
                <Play className="w-5 h-5" />
                听全文
              </>
            )}
          </motion.button>

          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={runFollowup}
            disabled={!hasAnyAudio || mode === "playing"}
            className={cn(
              "flex-1 gap-2",
              mode === "followup" ? "btn-chunky-danger" : "btn-chunky-secondary",
              (!hasAnyAudio || mode === "playing") && "btn-chunky-disabled",
            )}
          >
            {mode === "followup" ? (
              <>
                <Square className="w-5 h-5" />
                结束跟读
              </>
            ) : (
              <>
                <Mic className="w-5 h-5" />
                跟读
              </>
            )}
          </motion.button>
        </div>
        {rec.error && (
          <div className="max-w-md lg:max-w-6xl mx-auto px-4 pb-2 text-xs text-danger">
            麦克风错误：{rec.error}
          </div>
        )}
        {audioError && <div className="max-w-md lg:max-w-6xl mx-auto px-4 pb-2 text-xs text-danger" role="status">{audioError}</div>}
      </div>

      {/* +XP 奖励 toast（首次听完整篇 / 首次跟读全篇） */}
      <AnimatePresence>
        {xpToast && (
          <motion.div
            key={xpToast.key}
            initial={{ opacity: 0, y: 30, scale: 0.6 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ type: "spring", damping: 14, stiffness: 240 }}
            onAnimationComplete={() => {
              setTimeout(() => setXpToast(null), 1600);
            }}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-5 py-3 rounded-2xl text-white font-extrabold"
            style={{
              background: "linear-gradient(135deg, #1CB0F6, #1899D6)",
              boxShadow: "0 5px 0 0 #0d7aa8",
            }}
          >
            <Lightning className="w-5 h-5" />
            +{xpToast.amount} XP
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
