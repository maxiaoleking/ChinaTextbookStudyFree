export type IntroPlaybackStatus = "ready" | "loading" | "playing" | "done" | "error";
export interface IntroPlaybackSnapshot {
  status: IntroPlaybackStatus;
  segment: number;
  progress: number | null;
  remainingSeconds: number | null;
}

/** A lesson introduction is complete only after every track emits ended. */
export class IntroNarrationPlayer {
  private audio: HTMLAudioElement;
  private metadata: HTMLAudioElement[];
  private durations: number[];
  private disposeMetadata: Array<() => void> = [];
  private finishTrack: ((completed: boolean) => void) | null = null;
  private generation = 0;
  private disposed = false;
  private segment = 0;
  private status: IntroPlaybackStatus = "ready";

  constructor(
    private sources: string[],
    private onChange: (snapshot: IntroPlaybackSnapshot) => void,
    createAudio: () => HTMLAudioElement = () => new Audio(),
    private stallTimeoutMs = 15000,
    playbackAudio?: HTMLAudioElement,
  ) {
    this.audio = playbackAudio ?? createAudio();
    this.durations = sources.map(() => 0);
    this.metadata = sources.map((src, i) => {
      const audio = createAudio();
      audio.preload = "metadata";
      const update = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          this.durations[i] = audio.duration;
          this.emit();
        }
      };
      audio.addEventListener("loadedmetadata", update);
      audio.addEventListener("durationchange", update);
      this.disposeMetadata.push(() => {
        audio.removeEventListener("loadedmetadata", update);
        audio.removeEventListener("durationchange", update);
      });
      audio.src = src;
      return audio;
    });
  }

  private emit() {
    if (this.disposed) return;
    const known = this.durations.length > 0 && this.durations.every(n => n > 0);
    const total = this.durations.reduce((a, b) => a + b, 0);
    const elapsed = this.durations.slice(0, this.segment).reduce((a, b) => a + b, 0)
      + Math.min(this.audio.currentTime || 0, this.durations[this.segment] || 0);
    this.onChange({
      status: this.status,
      segment: this.segment,
      progress: this.status === "done" ? 1 : known ? Math.min(1, elapsed / total) : null,
      remainingSeconds: this.status === "done" ? 0 : known ? Math.ceil(Math.max(0, total - elapsed)) : null,
    });
  }

  cancel() {
    this.generation++;
    this.finishTrack?.(false);
    this.audio.pause();
  }

  async start() {
    if (this.disposed) return;
    this.cancel();
    const generation = this.generation;
    this.segment = 0;
    this.status = "loading";
    this.emit();
    for (let i = 0; i < this.sources.length; i++) {
      if (this.disposed || generation !== this.generation) return;
      this.segment = i;
      const completed = await this.playTrack(this.sources[i]);
      if (this.disposed || generation !== this.generation) return;
      if (!completed) return;
    }
    this.status = "done";
    this.emit();
  }

  private playTrack(src: string): Promise<boolean> {
    const audio = this.audio;
    this.status = "loading";
    return new Promise(resolve => {
      let settled = false;
      let lastTime = 0;
      let lastAdvance = Date.now();
      const emitTime = () => {
        if (audio.currentTime > lastTime) {
          lastTime = audio.currentTime;
          lastAdvance = Date.now();
        }
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          this.durations[this.segment] = audio.duration;
        }
        this.emit();
      };
      const playing = () => { this.status = "playing"; lastAdvance = Date.now(); emitTime(); };
      const waiting = () => { this.status = "loading"; emitTime(); };
      const finish = (completed: boolean, failure?: "blocked" | "error") => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        for (const [event, handler] of listeners) audio.removeEventListener(event, handler);
        this.finishTrack = null;
        if (failure) {
          this.status = failure === "blocked" ? "ready" : "error";
          audio.pause();
          this.emit();
        }
        resolve(completed);
      };
      const ended = () => finish(true);
      const failed = () => finish(false, "error");
      // An interruption never counts as having listened to the whole page.
      const paused = () => { if (!audio.ended) finish(false, "blocked"); };
      const listeners: Array<[string, EventListener]> = [
        ["timeupdate", emitTime], ["loadedmetadata", emitTime], ["durationchange", emitTime],
        ["playing", playing], ["waiting", waiting], ["stalled", waiting],
        ["ended", ended], ["error", failed], ["pause", paused],
      ];
      for (const [event, handler] of listeners) audio.addEventListener(event, handler);
      const watchdog = setInterval(() => {
        emitTime();
        if (Date.now() - lastAdvance > this.stallTimeoutMs) failed();
      }, 250);
      this.finishTrack = completed => finish(completed);
      audio.src = src;
      audio.currentTime = 0;
      this.emit();
      // Call play synchronously so the explicit Play button preserves its user gesture.
      try {
        void audio.play().catch(error => {
          if (!settled) finish(false, error?.name === "NotAllowedError" ? "blocked" : "error");
        });
      } catch (error) {
        finish(false, (error as { name?: string } | null)?.name === "NotAllowedError" ? "blocked" : "error");
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    for (const removeListeners of this.disposeMetadata) removeListeners();
    for (const audio of [this.audio, ...this.metadata]) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }
}
