import { playTTSResult, type TTSPlaybackResult } from "./tts";

interface SentencePlaybackOptions {
  isCurrent: () => boolean;
  onSentence?: (index: number) => void;
  gapMs?: number;
  play?: (source: string) => Promise<TTSPlaybackResult>;
  wait?: (milliseconds: number) => Promise<void>;
}

/** Blank exercises and image-only text are skipped; media failures never count as listened. */
export async function playSentenceSequence(
  sentences: ReadonlyArray<{ audio?: string | null }>,
  { isCurrent, onSentence, gapMs = 0, play = playTTSResult,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }: SentencePlaybackOptions,
): Promise<{ completed: boolean; failure?: TTSPlaybackResult }> {
  let listened = 0;
  for (let index = 0; index < sentences.length; index++) {
    if (!isCurrent()) return { completed: false };
    const source = sentences[index].audio;
    if (!source) continue;
    onSentence?.(index);
    const result = await play(source);
    if (!isCurrent()) return { completed: false };
    if (result !== "ended") return { completed: false, failure: result };
    listened++;
    if (gapMs > 0) await wait(gapMs);
  }
  return { completed: isCurrent() && listened > 0 };
}
