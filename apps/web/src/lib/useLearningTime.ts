"use client";

import { useEffect } from "react";
import { useProgressStore } from "@/store/progress";
import { startLearningTime } from "./learningClock";

export function useLearningTime(enabled = true) {
  useEffect(() => {
    return startLearningTime({
      enabled, document, window,
      // Monotonic elapsed time remains accurate when the system date changes.
      now: () => performance.now(),
      addTime: ms => useProgressStore.getState().addLearningTimeMs(ms),
    });
  }, [enabled]);
}
