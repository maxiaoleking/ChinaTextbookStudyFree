"use client";

import { useEffect } from "react";
import { useProgressStore } from "@/store/progress";
import { primeIntroAudio } from "@/lib/introAudio";

export function IntroAudioUnlock() {
  useEffect(() => {
    const prepare = (event: Event) => {
      const { autoNarrate, muted } = useProgressStore.getState();
      if (event.isTrusted && autoNarrate && !muted) primeIntroAudio();
    };
    document.addEventListener("click", prepare, true);
    return () => document.removeEventListener("click", prepare, true);
  }, []);
  return null;
}
