"use client";

// Keep one media element: Safari grants playback permission per element.
let audio: HTMLAudioElement | null = null;
let primed = false;
let priming = false;
const SILENCE = "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

export function getIntroAudio() {
  if (!audio) { audio = new Audio(); audio.preload = "auto"; }
  return audio;
}

/** Called synchronously during the click that opens a course. */
export function primeIntroAudio() {
  const element = getIntroAudio();
  if (primed || priming || (element.getAttribute("src") && element.src !== SILENCE)) return;
  priming = true;
  element.src = SILENCE;
  const finishPriming = () => {
    priming = false;
    // Navigation may already have started the actual lecture.
    if (element.src === SILENCE) { element.pause(); element.currentTime = 0; }
  };
  try {
    void Promise.resolve(element.play()).then(() => { primed = true; }).catch(() => {}).finally(finishPriming);
  } catch {
    finishPriming();
  }
}
