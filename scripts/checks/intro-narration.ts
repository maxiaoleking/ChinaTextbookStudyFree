import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { IntroNarrationPlayer, type IntroPlaybackSnapshot } from '../../apps/web/src/lib/introNarration';

class FakeAudio extends EventTarget {
  currentTime = 0;
  duration = 0;
  paused = true;
  ended = false;
  preload = '';
  rejection: Error | null = null;
  synchronousRejection: Error | null = null;
  unsupportedSources = new Set<string>();
  voidPlay = false;
  playCalls = 0;
  private source = '';
  set src(value: string) { this.source = value; this.currentTime = 0; this.ended = false; this.duration = 0; }
  get src() { return this.source; }
  getAttribute(name: string) { return name === 'src' ? this.source || null : null; }
  play() {
    this.playCalls++;
    if (this.synchronousRejection) throw this.synchronousRejection;
    if (this.unsupportedSources.has(this.src)) {
      return Promise.reject(Object.assign(new Error('Unsupported media format'), { name: 'NotSupportedError' }));
    }
    if (this.rejection) return Promise.reject(this.rejection);
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
    if (this.voidPlay) return undefined;
    return Promise.resolve();
  }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  load() {}
  removeAttribute() { this.source = ''; }
  metadata(seconds: number) { this.duration = seconds; this.dispatchEvent(new Event('loadedmetadata')); }
  time(seconds: number) { this.currentTime = seconds; this.dispatchEvent(new Event('timeupdate')); }
  finish() {
    this.currentTime = this.duration; this.ended = true; this.paused = true;
    this.dispatchEvent(new Event('pause')); this.dispatchEvent(new Event('ended'));
  }
}
function setup(sources = ['bubble', 'lecture'], timeout = 15000) {
  const audio: FakeAudio[] = [];
  const events: IntroPlaybackSnapshot[] = [];
  const player = new IntroNarrationPlayer(sources, state => events.push(state), () => {
    const fake = new FakeAudio(); audio.push(fake); return fake as unknown as HTMLAudioElement;
  }, timeout);
  return { player, audio, events, last: () => events.at(-1)! };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function loadActualPrimeModule(audio: FakeAudio): { primeIntroAudio: () => void } {
  const source = readFileSync(new URL('../../apps/web/src/lib/introAudio.ts', import.meta.url), 'utf8');
  const exports = {};
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, Audio: class { constructor() { return audio; } } });
  return exports as { primeIntroAudio: () => void };
}
async function synchronousBlockedRegression() {
  const blocked = setup(['lecture']);
  blocked.audio[0].synchronousRejection = Object.assign(new Error('User gesture required'), { name: 'NotAllowedError' });
  try {
    await blocked.player.start();
    assert.equal(blocked.last().status, 'ready', 'synchronous autoplay denial must be retryable just like asynchronous denial');
    assert.ok(!blocked.events.some(event => event.status === 'done'), 'autoplay denial must never complete the introduction');
    blocked.audio[0].synchronousRejection = null;
    const retry = blocked.player.start();
    blocked.audio[0].metadata(2); blocked.audio[0].finish(); await retry;
    assert.equal(blocked.last().status, 'done');
  } finally { blocked.player.dispose(); }
}
async function primeRegression() {
  const audio = new FakeAudio();
  audio.synchronousRejection = Object.assign(new Error('User gesture required'), { name: 'NotAllowedError' });
  const prime = loadActualPrimeModule(audio);
  assert.doesNotThrow(() => prime.primeIntroAudio(), 'opening a course must not leak a synchronous media exception');
  await tick();
  audio.synchronousRejection = null;
  prime.primeIntroAudio(); await tick();
  assert.equal(audio.playCalls, 2, 'a failed prime must not leave priming permanently stuck');
  assert.equal(audio.paused, true);

  const oldMedia = new FakeAudio(); oldMedia.voidPlay = true;
  const legacyPrime = loadActualPrimeModule(oldMedia);
  assert.doesNotThrow(() => legacyPrime.primeIntroAudio(), 'a legacy void play result must not break the click handler');
  await tick();
  assert.equal(oldMedia.paused, true, 'successful silent priming must clean up the temporary silent audio');

  const pending = new FakeAudio();
  let resolvePlay!: () => void;
  pending.play = () => { pending.playCalls++; pending.paused = false; return new Promise<void>(resolve => { resolvePlay = resolve; }); };
  const navigationPrime = loadActualPrimeModule(pending);
  navigationPrime.primeIntroAudio(); pending.src = 'lecture.mp3'; resolvePlay(); await tick();
  assert.equal(pending.src, 'lecture.mp3');
  assert.equal(pending.paused, false, 'late prime completion must not pause a lecture that already replaced silence');
}
async function main() {
  const regressions = await Promise.allSettled([synchronousBlockedRegression(), primeRegression()]);
  const failures = regressions.flatMap((result, index) => result.status === 'rejected' ? [`${index === 0 ? 'synchronous NotAllowed classification' : 'real primer module'}: ${result.reason}`] : []);
  assert.deepEqual(failures, [], failures.join('\n'));

  const t = setup();
  t.audio[1].metadata(10); t.audio[2].metadata(30);
  const running = t.player.start();
  t.audio[0].metadata(10); t.audio[0].time(5);
  assert.equal(t.last().progress, .125); assert.equal(t.last().remainingSeconds, 35);
  assert.ok(!t.events.some(e => e.status === 'done'));
  t.audio[0].finish(); await tick();
  assert.equal(t.audio[0].src, 'lecture');
  assert.ok(!t.events.some(e => e.status === 'done'), 'bubble completion must not unlock the lecture');
  t.audio[0].metadata(30); t.audio[0].time(15);
  assert.equal(t.last().progress, .625); assert.equal(t.last().remainingSeconds, 15);
  // No wall-clock countdown: the progress remains tied to media position.
  t.audio[0].dispatchEvent(new Event('waiting'));
  assert.equal(t.last().progress, .625);
  t.audio[0].finish(); await running;
  assert.equal(t.last().status, 'done'); assert.equal(t.last().progress, 1);
  t.player.dispose();

  const interrupted = setup(['lecture']);
  const cancelled = interrupted.player.start();
  interrupted.audio[0].pause(); await cancelled;
  assert.equal(interrupted.last().status, 'ready');
  assert.ok(!interrupted.events.some(e => e.status === 'done'));
  interrupted.player.dispose();

  const blocked = setup(['lecture']);
  blocked.audio[0].rejection = Object.assign(new Error('User gesture required'), { name: 'NotAllowedError' });
  await blocked.player.start(); assert.equal(blocked.last().status, 'ready');
  blocked.audio[0].rejection = null;
  const retry = blocked.player.start(); blocked.audio[0].metadata(2); blocked.audio[0].finish(); await retry;
  assert.equal(blocked.last().status, 'done'); blocked.player.dispose();

  const failed = setup(['lecture']);
  const errorRun = failed.player.start(); failed.audio[0].dispatchEvent(new Event('error')); await errorRun;
  assert.equal(failed.last().status, 'error'); failed.player.dispose();

  // A fake device refuses Ogg/Opus, then accepts the MP3 source on an explicit retry.
  // This verifies our player lifecycle; it is not a claim about real Safari decoding.
  const mediaSources = ['lecture.opus'];
  const formatRetry = setup(mediaSources);
  formatRetry.audio[0].unsupportedSources.add('lecture.opus');
  await formatRetry.player.start();
  assert.equal(formatRetry.last().status, 'error');
  assert.ok(!formatRetry.events.some(event => event.status === 'done'));
  mediaSources[0] = 'lecture.mp3';
  const mp3Retry = formatRetry.player.start();
  assert.equal(formatRetry.audio[0].src, 'lecture.mp3');
  formatRetry.audio[0].metadata(3); formatRetry.audio[0].finish(); await mp3Retry;
  assert.equal(formatRetry.last().status, 'done'); formatRetry.player.dispose();

  const disposed = setup();
  const disposeRun = disposed.player.start(); disposed.player.dispose(); await disposeRun;
  const count = disposed.events.length;
  disposed.audio[1].metadata(30); disposed.audio[0].finish();
  assert.equal(disposed.events.length, count, 'navigation must ignore late events');

  const stalled = setup(['lecture'], 20);
  await stalled.player.start(); assert.equal(stalled.last().status, 'error'); stalled.player.dispose();

  // Reuse the gesture-authorized element across pages, while old listeners are removed.
  const shared = new FakeAudio();
  const pageEvents: IntroPlaybackSnapshot[] = [];
  const page = (src: string) => new IntroNarrationPlayer([src], state => pageEvents.push(state),
    () => new FakeAudio() as unknown as HTMLAudioElement, 15000, shared as unknown as HTMLAudioElement);
  const first = page('page-one');
  const firstRun = first.start(); shared.metadata(2); shared.finish(); await firstRun;
  first.dispose();
  const second = page('page-two');
  const secondRun = second.start();
  assert.equal(shared.src, 'page-two');
  assert.equal(pageEvents.at(-1)?.status, 'playing');
  shared.metadata(4); shared.time(2);
  assert.equal(pageEvents.at(-1)?.progress, .5);
  shared.finish(); await secondRun; second.dispose();
  console.log('PASS: real-duration progress, multiple tracks, buffering, natural end, interruption, synchronous/asynchronous autoplay denial, primer failure/void/navigation races, simulated format retry, media failure, cleanup and stalled loading.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
