import assert from "node:assert/strict";

class FakeAudio extends EventTarget {
  currentTime = 0; duration = 3; paused = true; ended = false; preload = "";
  error: { code: number } | null = null;
  sources: string[] = [];
  playSources: string[] = [];
  deferredPlay = false;
  pending: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private source = "";
  private handlers = new Map<string, Set<EventListenerOrEventListenerObject>>();
  constructor() { super(); audios.push(this); }
  set src(value: string) {
    this.source = value; this.sources.push(value);
    this.currentTime = 0; this.ended = false; this.paused = true; this.error = null;
  }
  get src() { return this.source; }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    super.addEventListener(type, listener, options);
    if (listener) { const set = this.handlers.get(type) ?? new Set(); set.add(listener); this.handlers.set(type, set); }
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    super.removeEventListener(type, listener, options);
    if (listener) this.handlers.get(type)?.delete(listener);
  }
  capture(type: string) {
    const captured = [...(this.handlers.get(type) ?? [])];
    return () => captured.forEach(listener => typeof listener === "function" ? listener(new Event(type)) : listener.handleEvent(new Event(type)));
  }
  play() {
    this.playSources.push(this.src); this.paused = false;
    this.dispatchEvent(new Event("playing"));
    if (this.deferredPlay) return new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }));
    return Promise.resolve();
  }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event("pause")); } }
  fail(code = 4) { this.error = { code }; this.dispatchEvent(new Event("error")); }
  finish() {
    this.ended = true; this.paused = true;
    this.dispatchEvent(new Event("pause")); this.dispatchEvent(new Event("ended"));
  }
}
const audios: FakeAudio[] = [];
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  Object.assign(globalThis, { window: {}, Audio: FakeAudio });
  const { playTTSResult, stopTTS, isPlayingTTS, preloadTTS } = await import("../../apps/web/src/lib/tts");
  try {
    const legacy = "/audio/ab/old-question.opus";
    const preferred = "/audio/ab/old-question.mp3";
    const first = playTTSResult(legacy); const audio = audios[0];
    assert.equal(audio.src, preferred, "persisted local Opus questions should first try their MP3 sibling");
    assert.equal(isPlayingTTS(legacy), true, "speaker identity remains the original caller source");
    assert.equal(isPlayingTTS(preferred), false);
    stopTTS(preferred); assert.equal(audio.paused, false, "physical MP3 path must not replace logical owner identity");
    audio.finish(); assert.equal(await first, "ended");

    const fallback = playTTSResult(legacy);
    audio.fail(2); // Fake missing MP3 / network failure.
    assert.equal(audio.src, legacy, "missing MP3 falls back to the original source for old content");
    assert.equal(isPlayingTTS(legacy), true);
    audio.finish(); assert.equal(await fallback, "ended");

    const bothFailed = playTTSResult(legacy); audio.fail(2); audio.fail(4);
    assert.equal(await bothFailed, "error");
    const direct = playTTSResult(preferred); const callsBeforeError = audio.playSources.length;
    audio.fail(2); assert.equal(await direct, "error");
    assert.equal(audio.playSources.length, callsBeforeError, "new MP3 JSON never adds an unnecessary Opus fallback");

    audio.deferredPlay = true;
    const racedFallback = playTTSResult(legacy);
    const oldAttempt = audio.pending.at(-1)!;
    const oldAttemptError = audio.capture("error"); const oldAttemptEnded = audio.capture("ended");
    audio.fail(2); const fallbackAttempt = audio.pending.at(-1)!;
    oldAttempt.reject(new Error("late MP3 load rejection")); await tick();
    oldAttemptError(); oldAttemptEnded();
    audio.dispatchEvent(new Event("error")); // Queued stale media event with current error cleared.
    audio.dispatchEvent(new Event("ended")); // Current source has not really ended.
    assert.equal(audio.src, legacy); assert.equal(audio.paused, false, "stale preferred-source events cannot finish fallback playback");
    fallbackAttempt.resolve(); audio.finish(); assert.equal(await racedFallback, "ended");

    const stopped = playTTSResult(legacy); const stoppedAttempt = audio.pending.at(-1)!;
    const stoppedError = audio.capture("error");
    stopTTS(legacy); assert.equal(await stopped, "interrupted");
    stoppedAttempt.reject(new Error("late stopped load")); stoppedError(); await tick();
    assert.equal(audio.paused, true, "stop must not restart the old Opus fallback");

    const previous = playTTSResult(legacy); const previousAttempt = audio.pending.at(-1)!;
    const previousError = audio.capture("error"); const previousEnded = audio.capture("ended");
    const replacementSource = "/audio/cd/new-question.mp3";
    const replacement = playTTSResult(replacementSource); const replacementAttempt = audio.pending.at(-1)!;
    assert.equal(await previous, "interrupted");
    previousAttempt.reject(new Error("late old source error")); previousError(); previousEnded(); await tick();
    stopTTS(legacy);
    assert.equal(audio.src, replacementSource); assert.equal(audio.paused, false);
    assert.equal(isPlayingTTS(replacementSource), true, "the replacement remains owned by its caller");
    replacementAttempt.resolve(); audio.finish(); assert.equal(await replacement, "ended");
    audio.deferredPlay = false;

    preloadTTS(legacy); const preloaded = audios.at(-1)!;
    assert.equal(preloaded.src, preferred, "preload follows the same compatible-source priority");
    preloaded.fail(2); assert.equal(preloaded.src, legacy);
    const preloadCount = audios.length; preloadTTS(legacy); assert.equal(audios.length, preloadCount);
    const remote = "https://example.test/audio/old.opus";
    const remoteRun = playTTSResult(remote); assert.equal(audio.src, remote, "only local /audio sources are remapped");
    audio.finish(); assert.equal(await remoteRun, "ended");
    console.log("PASS: actual TTS module prefers legacy MP3 siblings, preserves caller identity, falls back once on missing media, ignores stale events/promises, respects stop/source changes and aligns preload.");
  } finally { stopTTS(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
