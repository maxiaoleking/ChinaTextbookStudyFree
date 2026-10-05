import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const path = "apps/web/src/components/TTSButton.tsx";
const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const handlers: { play?: ts.FunctionDeclaration; sourceEffect?: ts.ArrowFunction } = {};
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "play") handlers.play = node;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect") {
    const [callback, dependencies] = node.arguments;
    if (callback && ts.isArrowFunction(callback) && dependencies && ts.isArrayLiteralExpression(dependencies)
      && dependencies.elements.length === 1 && ts.isIdentifier(dependencies.elements[0]) && dependencies.elements[0].text === "src") {
      handlers.sourceEffect = callback;
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(handlers.play); assert.ok(handlers.sourceEffect);
function bind<T>(handler: ts.Node, dependencies: Record<string, unknown>): T {
  const code = ts.transpileModule(`const handler = ${handler.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn handler;`)(...Object.values(dependencies)) as T;
}

class FakeAudio extends EventTarget {
  currentTime = 0; duration = 3; paused = true; ended = false; preload = "";
  private source = "";
  constructor() { super(); audios.push(this); }
  set src(value: string) { this.source = value; this.currentTime = 0; this.ended = false; }
  get src() { return this.source; }
  play() { this.paused = false; this.dispatchEvent(new Event("playing")); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event("pause")); } }
  finish() { this.ended = true; this.paused = true; this.dispatchEvent(new Event("pause")); this.dispatchEvent(new Event("ended")); }
}
const audios: FakeAudio[] = [];
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  Object.assign(globalThis, { window: {}, Audio: FakeAudio });
  const { playTTS, stopTTS } = await import("../../apps/web/src/lib/tts");
  const audio = () => audios[0];
  function createState() {
    return { generationRef: { current: 0 }, playingSourceRef: { current: null as string | null }, playing: false, updates: [] as boolean[] };
  }
  function render(src: string | null | undefined, state = createState(), disabled = false, onPlay?: () => void) {
    const dependencies = { src, state, disabled, onPlay, playTTS, stopTTS,
      generationRef: state.generationRef, playingSourceRef: state.playingSourceRef,
      setPlaying: (playing: boolean) => { state.playing = playing; state.updates.push(playing); },
    };
    const effect = bind<() => () => void>(handlers.sourceEffect!, dependencies);
    const play = bind<(event?: { stopPropagation(): void; preventDefault(): void }) => Promise<void>>(handlers.play!, dependencies);
    const cleanup = effect();
    return { state, play, cleanup };
  }

  const state = createState();
  const oldSource = render("old", state);
  const oldRun = oldSource.play();
  assert.equal(state.playing, true);
  oldSource.cleanup();
  const newSource = render("new", state);
  const newRun = newSource.play();
  await oldRun;
  assert.equal(state.playing, true, "an old source promise must not clear the new playing state");
  assert.equal(state.playingSourceRef.current, "new");
  assert.equal(audio().src, "new"); assert.equal(audio().paused, false);
  audio().finish(); await newRun; assert.equal(state.playing, false); newSource.cleanup();

  const replay = render("replay");
  const first = replay.play(); const second = replay.play(); const latest = replay.play();
  await Promise.all([first, second]);
  assert.equal(replay.state.playing, true, "old replay promises cannot clear a newer replay");
  assert.equal(replay.state.playingSourceRef.current, "replay"); assert.equal(audio().paused, false);
  audio().finish(); await latest; assert.equal(replay.state.playing, false); replay.cleanup();

  const speakerA = render("speaker-a"); const pendingA = speakerA.play();
  const speakerB = render("speaker-b"); const pendingB = speakerB.play();
  speakerA.cleanup(); await pendingA;
  assert.equal(audio().src, "speaker-b"); assert.equal(audio().paused, false, "another source unmount must not stop the current speaker");
  assert.equal(speakerB.state.playing, true);
  const emptySpeaker = render(null); emptySpeaker.cleanup();
  const absentSpeaker = render(undefined); absentSpeaker.cleanup();
  assert.equal(audio().paused, false, "an unplayed empty speaker must not stop another source on unmount");
  const previousUpdates = speakerB.state.updates.length;
  speakerB.cleanup(); await pendingB;
  assert.equal(audio().paused, true, "unmounting the current source stops its audio");
  assert.equal(speakerB.state.updates.length, previousUpdates, "a promise settling after unmount must not update React state");

  let customPlays = 0;
  const custom = render("owned-introduction", createState(), false, () => { customPlays++; });
  await custom.play(); assert.equal(customPlays, 1); assert.equal(custom.state.playing, false); custom.cleanup();
  const disabled = render("disabled", createState(), true, () => { customPlays++; });
  await disabled.play(); assert.equal(customPlays, 1); disabled.cleanup();
  const noSource = render(undefined); await noSource.play(); assert.equal(noSource.state.playing, false); noSource.cleanup();
  stopTTS(); await tick();
  console.log("PASS: actual TTSButton async handlers and cleanup with real shared TTS: source changes, replay races, empty source, unmount ownership, disabled and intro-owned playback.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
