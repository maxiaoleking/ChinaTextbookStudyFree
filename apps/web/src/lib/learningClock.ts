/** Count foreground study time, stopping after five minutes without interaction. */
export class LearningClock {
  private lastTick: number;
  private lastActivity: number;
  private active = false;
  constructor(private addTime: (ms: number) => void, now: number, private idleMs = 300000) {
    this.lastTick = this.lastActivity = now;
  }
  tick(now: number) {
    now = Math.max(now, this.lastTick);
    const end = Math.min(now, this.lastActivity + this.idleMs);
    const elapsed = Math.max(0, end - this.lastTick);
    if (this.active && elapsed > 0) this.addTime(elapsed);
    this.lastTick = now;
    return now;
  }
  setActive(active: boolean, now: number) {
    now = this.tick(now);
    this.active = active;
    if (active) this.lastActivity = now;
  }
  activity(now: number) { this.lastActivity = this.tick(now); }
}

interface LearningDocument extends EventTarget {
  readonly visibilityState: string;
  hasFocus(): boolean;
}
interface LearningWindow extends EventTarget {
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
}

/** The hook's actual subscription lifecycle, injectable for deterministic tests. */
export function startLearningTime({
  enabled = true, addTime, now, document: learningDocument, window: learningWindow,
}: {
  enabled?: boolean;
  addTime: (ms: number) => void;
  now: () => number;
  document: LearningDocument;
  window: LearningWindow;
}): () => void {
  const clock = new LearningClock(addTime, now());
  const update = () => clock.setActive(
    enabled && learningDocument.visibilityState === "visible" && learningDocument.hasFocus(), now(),
  );
  const activity = () => clock.activity(now());
  update();
  const timer = learningWindow.setInterval(() => clock.tick(now()), 10000);
  learningDocument.addEventListener("visibilitychange", update);
  learningWindow.addEventListener("focus", update);
  learningWindow.addEventListener("blur", update);
  learningDocument.addEventListener("pointerdown", activity, true);
  learningDocument.addEventListener("keydown", activity, true);
  learningDocument.addEventListener("scroll", activity, true);
  return () => {
    clock.setActive(false, now());
    learningWindow.clearInterval(timer);
    learningDocument.removeEventListener("visibilitychange", update);
    learningWindow.removeEventListener("focus", update);
    learningWindow.removeEventListener("blur", update);
    learningDocument.removeEventListener("pointerdown", activity, true);
    learningDocument.removeEventListener("keydown", activity, true);
    learningDocument.removeEventListener("scroll", activity, true);
  };
}
