"use client";

import { useEffect, useState } from "react";
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
}: TTSButtonProps) {
  const [playing, setPlaying] = useState(false);
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
    if (!autoPlay || !hasVoice) return;
    void play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, text, autoPlay]);

  useEffect(() => () => {
    if (playing) stopTTS();
  }, [playing]);

  if (!hasVoice) return null;

  async function play(e?: React.MouseEvent) {
    e?.stopPropagation();
    e?.preventDefault();
    setPlaying(true);
    await playTTS(src, { text });
    setPlaying(false);
  }

  const dim = size === "sm" ? "w-7 h-7" : "w-9 h-9";
  const icon = size === "sm" ? "w-4 h-4" : "w-5 h-5";

  return (
    <motion.span
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={play}
      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(); } }}
      whileTap={{ scale: 0.9 }}
      className={cn(
        "inline-flex items-center justify-center rounded-full cursor-pointer",
        "bg-bg-soft text-primary hover:bg-primary/10 transition-colors shrink-0",
        dim,
        playing && "animate-pulse text-primary",
        className,
      )}
    >
      <Volume className={icon} />
    </motion.span>
  );
}
