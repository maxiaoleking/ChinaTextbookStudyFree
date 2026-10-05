import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RecorderController, type RecorderSnapshot } from "../../apps/web/src/lib/recorder";
import { gradeAnswer } from "../../packages/core/src/grade";
import type { Question } from "../../packages/core/src/types";
import { isAnswerComplete, matchingPairs, wordOrderIndices } from "../../apps/web/src/lib/questionAnswer";
import { playSentenceSequence } from "../../apps/web/src/lib/readingPlayback";
import ts from "typescript";

class FakeAudio extends EventTarget {
  currentTime = 0; duration = 10; paused = true; ended = false; preload = "";
  rejection: Error | null = null;
  private source = "";
  constructor() { super(); audio.push(this); }
  set src(value: string) { this.source = value; this.currentTime = 0; this.ended = false; }
  get src() { return this.source; }
  play() {
    if (this.rejection) return Promise.reject(this.rejection);
    this.paused = false; this.dispatchEvent(new Event("playing")); return Promise.resolve();
  }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event("pause")); } }
  finish() {
    this.currentTime = this.duration; this.ended = true; this.paused = true;
    this.dispatchEvent(new Event("pause")); this.dispatchEvent(new Event("ended"));
  }
}
const audio: FakeAudio[] = [];
const tick = () => new Promise(resolve => setImmediate(resolve));

/** Execute the actual UI event handler with batched-render state, so double clicks share a closure. */
function storyHandler(name: string, dependencies: Record<string, unknown>): () => void {
  const path = "apps/web/src/app/stories/[book]/[story]/StoryReaderClient.tsx";
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found: { handler?: ts.ArrowFunction } = {};
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
      && node.initializer && ts.isArrowFunction(node.initializer)) found.handler = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found.handler, `missing real story handler ${name}`);
  const javascript = ts.transpileModule(`const handler = ${found.handler.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${javascript}\nreturn handler;`)(...Object.values(dependencies));
}

class FakeMediaRecorder {
  state: RecordingState = "inactive"; mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  stopCalls = 0;
  start() { this.state = "recording"; }
  stop() { this.stopCalls++; this.state = "inactive"; }
  finish(data = "recorded-audio") {
    this.ondataavailable?.({ data: new Blob([data]) });
    this.state = "inactive"; this.onstop?.();
  }
}
function recorderSetup(deferred = false) {
  let grant: ((stream: MediaStream) => void) | null = null;
  let requests = 0; let stoppedTracks = 0; let createdUrls = 0;
  const media: FakeMediaRecorder[] = [];
  const states: RecorderSnapshot[] = [];
  const stream = { getTracks: () => [{ stop: () => { stoppedTracks++; } }] } as unknown as MediaStream;
  const controller = new RecorderController(snapshot => states.push(snapshot), {
    getStream: () => {
      requests++;
      return deferred ? new Promise<MediaStream>(resolve => { grant = resolve; }) : Promise.resolve(stream);
    },
    createRecorder: () => { const mr = new FakeMediaRecorder(); media.push(mr); return mr as unknown as MediaRecorder; },
    createUrl: () => `blob:recording-${++createdUrls}`,
  });
  return { controller, media, states, grant: () => grant!(stream),
    requests: () => requests, tracks: () => stoppedTracks, urls: () => createdUrls };
}

async function main() {
  Object.assign(globalThis, { window: {}, Audio: FakeAudio });
  const { playTTSResult, playTTS, stopTTS } = await import("../../apps/web/src/lib/tts");
  const { setMuted } = await import("../../apps/web/src/lib/sfx");
  assert.equal(await playTTSResult(undefined), "missing");
  setMuted(true); assert.equal(await playTTSResult("lecture"), "muted"); setMuted(false);

  const genuine = playTTSResult("lecture");
  audio[0].finish(); assert.equal(await genuine, "ended", "natural pause preceding ended is successful");
  const interrupted = playTTSResult("lecture"); stopTTS();
  assert.equal(await interrupted, "interrupted");
  const old = playTTSResult("old"); const current = playTTSResult("new");
  assert.equal(await old, "interrupted");
  assert.equal(audio[0].src, "new");
  audio[0].dispatchEvent(new Event("pause")); // Queued old event while new audio is playing.
  audio[0].finish(); assert.equal(await current, "ended");
  const retained = playTTSResult("current-speaker"); stopTTS("previous-speaker");
  assert.equal(audio[0].paused, false, "an old speaker cleanup must not stop the new one");
  audio[0].finish(); assert.equal(await retained, "ended");
  const same = playTTSResult("repeat");
  assert.equal(await playTTSResult("repeat"), "interrupted"); assert.equal(await same, "interrupted");
  const failed = playTTSResult("broken"); audio[0].dispatchEvent(new Event("error"));
  assert.equal(await failed, "error");
  audio[0].rejection = Object.assign(new Error("gesture required"), { name: "NotAllowedError" });
  assert.equal(await playTTSResult("blocked"), "blocked");
  audio[0].rejection = new Error("network failure"); assert.equal(await playTTSResult("network"), "error");
  audio[0].rejection = null;
  const compatibility = playTTS("legacy"); audio[0].finish();
  assert.equal(await compatibility, undefined, "legacy API retains Promise<void>");

  const positions: number[] = [];
  const partialReading = playSentenceSequence([{ audio: "first" }, {}, { audio: "last" }], {
    isCurrent: () => true, onSentence: index => positions.push(index),
  });
  audio[0].finish(); await tick(); assert.equal(audio[0].src, "last");
  audio[0].finish(); assert.deepEqual(await partialReading, { completed: true });
  assert.deepEqual(positions, [0, 2], "intentional blanks do not prevent finishing existing narration");
  assert.deepEqual(await playSentenceSequence([{}, {}], { isCurrent: () => true }), { completed: false });
  const brokenReading = playSentenceSequence([{ audio: "broken" }, { audio: "must-not-play" }], { isCurrent: () => true });
  audio[0].dispatchEvent(new Event("error"));
  assert.deepEqual(await brokenReading, { completed: false, failure: "error" });
  assert.equal(audio[0].src, "broken");
  let active = true;
  const stoppedReading = playSentenceSequence([{ audio: "cancelled" }, { audio: "old-next" }], { isCurrent: () => active });
  active = false; stopTTS(); const replacement = playSentenceSequence([{ audio: "replacement" }], { isCurrent: () => true });
  assert.deepEqual(await stoppedReading, { completed: false });
  assert.equal(audio[0].src, "replacement", "a cancelled sequence must not start its next sentence");
  audio[0].finish(); assert.deepEqual(await replacement, { completed: true });
  let gapActive = true;
  const finalGap = playSentenceSequence([{ audio: "final-before-gap" }], {
    isCurrent: () => gapActive, gapMs: 200, wait: async () => { gapActive = false; },
  });
  audio[0].finish(); assert.deepEqual(await finalGap, { completed: false }, "stopping during the last gap does not award XP");

  const successful = recorderSetup();
  assert.equal(await successful.controller.start(), true);
  const one = successful.controller.stop(); const two = successful.controller.stop();
  assert.equal(one, two, "concurrent stop shares one promise rather than dropping a resolver");
  assert.equal(successful.media[0].stopCalls, 1);
  successful.media[0].finish();
  assert.equal(await one, "blob:recording-1"); assert.equal(await two, "blob:recording-1");
  assert.equal(successful.tracks(), 1); assert.equal(successful.states.at(-1)?.state, "idle");
  successful.controller.dispose();

  const empty = recorderSetup(); await empty.controller.start();
  const emptyStop = empty.controller.stop(); empty.media[0].finish("");
  assert.equal(await emptyStop, null); assert.equal(empty.urls(), 0);
  assert.equal(empty.states.at(-1)?.state, "error", "empty recordings cannot qualify for completion");
  empty.controller.dispose();

  const late = recorderSetup(true);
  const requestOne = late.controller.start(); const requestTwo = late.controller.start();
  assert.equal(requestOne, requestTwo); assert.equal(late.requests(), 1);
  late.controller.dispose(); const eventCount = late.states.length; late.grant();
  assert.equal(await requestOne, false); assert.equal(await requestTwo, false);
  assert.equal(late.media.length, 0); assert.equal(late.tracks(), 1);
  assert.equal(late.states.length, eventCount, "late permission cannot update an unmounted hook");

  const cancelled = recorderSetup(true); const requested = cancelled.controller.start();
  assert.equal(await cancelled.controller.stop(), null); cancelled.grant();
  assert.equal(await requested, false); assert.equal(cancelled.media.length, 0); assert.equal(cancelled.tracks(), 1);
  cancelled.controller.dispose();

  const lostDevice = recorderSetup(); await lostDevice.controller.start();
  lostDevice.media[0].onerror?.(); assert.equal(lostDevice.tracks(), 1);
  assert.equal(lostDevice.states.at(-1)?.state, "error");
  assert.equal(await lostDevice.controller.stop(), null);
  assert.equal(lostDevice.states.at(-1)?.state, "error", "stop does not hide the recorder failure");
  lostDevice.controller.dispose();

  const unexpectedStop = recorderSetup(); await unexpectedStop.controller.start();
  unexpectedStop.media[0].finish();
  assert.equal(unexpectedStop.states.at(-1)?.state, "error");
  assert.equal(unexpectedStop.urls(), 0, "an unsolicited recorder stop must not leak an unclaimed blob URL");
  assert.equal(unexpectedStop.tracks(), 1); unexpectedStop.controller.dispose();

  const navigating = recorderSetup(); await navigating.controller.start();
  const pendingStop = navigating.controller.stop(); navigating.controller.dispose();
  assert.equal(await pendingStop, null); assert.equal(navigating.tracks(), 1);

  const denialStates: RecorderSnapshot[] = [];
  let deny = true;
  const retryRecorder = new FakeMediaRecorder();
  const retryController = new RecorderController(state => denialStates.push(state), {
    getStream: async () => {
      if (deny) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      return { getTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    },
    createRecorder: () => retryRecorder as unknown as MediaRecorder,
    createUrl: () => "blob:retry",
  });
  assert.equal(await retryController.start(), false);
  assert.match(denialStates.at(-1)?.error ?? "", /允许麦克风/);
  deny = false; assert.equal(await retryController.start(), true);
  const retryStop = retryController.stop(); retryRecorder.finish(); assert.equal(await retryStop, "blob:retry");
  retryController.dispose();

  let releasedUnsupported = 0;
  const unsupported = new RecorderController(() => {}, {
    getStream: async () => ({ getTracks: () => [{ stop: () => { releasedUnsupported++; } }] }) as unknown as MediaStream,
    createRecorder: () => { throw new Error("unsupported recorder"); }, createUrl: () => "unexpected",
  });
  assert.equal(await unsupported.start(), false); assert.equal(releasedUnsupported, 1); unsupported.dispose();

  let choiceCount = 0; let storyChoiceCount = 0; let completeTaskCount = 0;
  const bookRoot = "apps/web/public/data/books";
  for (const book of readdirSync(bookRoot)) {
    const lessonRoot = join(bookRoot, book, "lessons");
    for (const file of readdirSync(lessonRoot)) {
      if (!file.endsWith(".json")) continue;
      const lesson = JSON.parse(readFileSync(join(lessonRoot, file), "utf8"));
      for (const q of lesson.questions as Question[]) {
        if (q.type === "matching" || q.type === "word_order") {
          assert.equal(isAnswerComplete(q, q.answer), true, `${book}/${file}/${q.id} correct task must be completable`);
          completeTaskCount++;
        }
        if (q.type !== "choice") continue;
        const correct = q.options.map((_, i) => String.fromCharCode(65 + i)).filter(letter => gradeAnswer(q, letter));
        assert.equal(correct.length, 1, `${book}/${file}/${q.id} needs one correct option`);
        choiceCount++;
      }
    }
    const storyFile = join(bookRoot, book, "stories.json");
    if (existsSync(storyFile)) {
      const stories = JSON.parse(readFileSync(storyFile, "utf8")).stories;
      for (const story of stories) for (const q of story.questions as Question[]) {
        if (q.type !== "choice") continue;
        const correct = q.options.map((_, i) => String.fromCharCode(65 + i)).filter(letter => gradeAnswer(q, letter));
        assert.equal(correct.length, 1, `${book}/${story.id}/${q.id} story needs one correct option`);
        storyChoiceCount++;
      }
    }
  }
  const english: Question = { id: 11, type: "choice", score: 5, difficulty: 2, knowledge_point: "", question: "It's ___",
    options: ["a apple", "an bear", "a bear", "an pig"], answer: "a bear", explanation: "" };
  assert.equal(gradeAnswer(english, "C"), true); assert.equal(gradeAnswer(english, "A"), false);
  const matching = { ...english, type: "matching" as const, options: ["one", "two", "three", "four", "1", "2", "3", "4"], answer: "A-1,B-2,C-3,D-4" };
  assert.equal(isAnswerComplete(matching, "A-1"), false);
  assert.equal(isAnswerComplete(matching, "A-1,B-2,C-3,D-4"), true);
  assert.equal(isAnswerComplete(matching, "A-1,B-1,C-3,D-4"), false);
  assert.equal(isAnswerComplete(matching, "A-1,A-2,C-3,D-4"), false);
  assert.equal(isAnswerComplete(matching, "A-1,B-2,C-3,D-5"), false);
  const ordering = { ...english, type: "word_order" as const, options: ["I", "like", "my", "my", "cat"], answer: "I,like,my,my,cat" };
  assert.equal(isAnswerComplete(ordering, "I"), false);
  assert.equal(isAnswerComplete(ordering, "I,like,my,cat"), false);
  assert.equal(isAnswerComplete(ordering, "I,like,my,my,cat"), true);
  assert.equal(isAnswerComplete(ordering, "I,like,my,my,dog"), false);
  assert.deepEqual(matchingPairs("D-4, A-1， B-2,C-3"), { D: "4", A: "1", B: "2", C: "3" });
  assert.deepEqual(wordOrderIndices(ordering.options, "I,like,my,my,cat"), [0, 1, 2, 3, 4]);
  assert.deepEqual(wordOrderIndices(ordering.options, "my,I,my"), [2, 0, 3]);

  const checkedQuestionRef = { current: null as number | null };
  let batchedCorrectCount = 0;
  const checkAnswer = storyHandler("checkAnswer", {
    qPhase: "answering", checkedQuestionRef, qIdx: 0, currentQuestion: english, currentQ: english,
    answer: "C", isAnswerComplete, gradeAnswer, toQuestion: (question: Question) => question,
    setIsCorrect() {}, setQPhase() {}, setCorrectCount: (update: (count: number) => number) => { batchedCorrectCount = update(batchedCorrectCount); },
    playSfx() {}, haptic() {},
  });
  checkAnswer(); checkAnswer();
  assert.equal(batchedCorrectCount, 1, "two checks before a React render must score only once");
  const continuedQuestionRef = { current: null as number | null };
  let advances = 0;
  const nextQuestion = storyHandler("nextQuestion", {
    qPhase: "checked", checkedQuestionRef, continuedQuestionRef, qIdx: 0,
    story: { questions: [{}, {}] }, setQIdx: () => { advances++; }, setAnswer() {}, setQPhase() {}, setIsCorrect() {},
  });
  nextQuestion(); nextQuestion(); assert.equal(advances, 1, "two Continue actions before a render must advance only once");
  const finalContinued = { current: null as number | null };
  let rewards = 0;
  const finalQuestion = storyHandler("nextQuestion", {
    qPhase: "checked", checkedQuestionRef, continuedQuestionRef: finalContinued, qIdx: 0, correctCount: 1,
    story: { id: "fixture", title: "Fixture", questions: [{}] }, hasStoryReward: () => false, markStoryReward() {},
    GOOD_THRESHOLD: .8, XP_STORY_READ: 5, XP_QUIZ_GOOD: 10, recordXp: () => { rewards++; }, setPhase() {}, playSfx() {}, haptic() {},
  });
  finalQuestion(); finalQuestion(); assert.equal(rewards, 1, "the same last-question closure must not issue rewards twice");
  const storySource = readFileSync("apps/web/src/app/stories/[book]/[story]/StoryReaderClient.tsx", "utf8");
  assert.match(storySource, /useLearningTime\(phase !== "result"\)/);
  assert.match(storySource, /setCorrectCount\(0\);\s*checkedQuestionRef.current = null;\s*continuedQuestionRef.current = null;/);
  assert.match(readFileSync("apps/web/src/app/stories/[book]/[story]/page.tsx", "utf8"), /key=\{story.id\}/);
  assert.match(readFileSync("apps/web/src/app/reading/[book]/[passage]/page.tsx", "utf8"), /key=\{passage.id\}/);
  console.log(`PASS: audio/sequence completion and cancellation, recorder permission/retry/cleanup/empty/concurrent stop, real story double-action guards, ${choiceCount} lesson and ${storyChoiceCount} story choice mappings, ${completeTaskCount} complete matching/ordering tasks.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
