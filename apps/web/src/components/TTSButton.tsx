"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Volume } from "@/components/icons";
import { cn } from "@/lib/cn";
import { playTTS, preloadTTS, stopTTS } from "@/lib/tts";
import { isPinyinText, isOnlinePollyEnabled, localPinyinAudioSrc, onlinePollySrc } from "@/lib/pinyinSpeak";

interface TTSButtonProps {
  src?: string | null;
  /** 无预生成音频时的朗读原文（Web Speech 兜底） */
  text?: string | null;
  /** 进入视图时自动预加载 */
  preload?: boolean;
  /** 进入视图时自动播放一次（每次 src/text 变化触发） */
  autoPlay?: boolean;
  size?: "sm" | "md";
  className?: string;
  label?: string;
  disabled?: boolean;
  /** Let lesson introductions own playback until the first full listen finishes. */
  onPlay?: () => void;
}

/**
 * 点击播放预生成 TTS；无 src 时若有 text 则用系统语音兜底。
 */
export function TTSButton({
  src,
  text,
  preload = true,
  autoPlay = false,
  size = "md",
  className,
  label = "朗读",
  disabled = false,
  onPlay,
}: TTSButtonProps) {
  const [playing, setPlaying] = useState(false);
  const generationRef = useRef(0);
  const playingSourceRef = useRef<string | null>(null);
  const pinyinSrc = text && isPinyinText(text) ? localPinyinAudioSrc(text) : null;
  const pollySrc = text && isOnlinePollyEnabled() ? onlinePollySrc(text) : null;
  const hasVoice = Boolean(src || pollySrc || pinyinSrc || (text && text.trim()));

  useEffect(() => {
    if (!preload) return;
    if (pollySrc) preloadTTS(pollySrc);
    if (pinyinSrc) preloadTTS(pinyinSrc);
    if (src) preloadTTS(src);
  }, [src, pinyinSrc, pollySrc, preload]);

  useEffect(() => {
    setPlaying(false);
    return () => {
      generationRef.current++;
      const expected = src ?? pinyinSrc ?? pollySrc;
      if (expected && playingSourceRef.current === expected) {
        stopTTS(expected);
        playingSourceRef.current = null;
      }
    };
  }, [src, pinyinSrc, pollySrc]);

  useEffect(() => {
    if (!autoPlay || !hasVoice) return;
    void play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, text, autoPlay]);

  if (!hasVoice) return null;

  async function play(e?: React.MouseEvent) {
    e?.stopPropagation();
    e?.preventDefault();
    if (disabled) return;
    if (onPlay) { onPlay(); return; }
    if (!hasVoice) return;
    const generation = ++generationRef.current;
    playingSourceRef.current = src ?? pinyinSrc ?? pollySrc ?? null;
    setPlaying(true);
    await playTTS(src, { text });
    if (generation === generationRef.current) {
      playingSourceRef.current = null;
      setPlaying(false);
    }
  }

  const dim = "w-11 h-11";
  const icon = size === "sm" ? "w-4 h-4" : "w-5 h-5";

  return (
    <motion.span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-disabled={disabled}
      onClick={play}
      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(); } }}
      whileTap={{ scale: 0.9 }}
      className={cn(
        "inline-flex items-center justify-center rounded-full cursor-pointer",
        "bg-bg-soft text-primary hover:bg-primary/10 transition-colors shrink-0",
        dim,
        playing && "animate-pulse text-primary",
        disabled && "opacity-40 !cursor-default",
        className,
      )}
    >
      <Volume className={icon} />
    </motion.span>
  );
}
