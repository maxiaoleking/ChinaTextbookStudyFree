export type RecorderState = "idle" | "requesting" | "recording" | "error";
export interface RecorderSnapshot { state: RecorderState; error: string | null }

interface RecorderDependencies {
  getStream: () => Promise<MediaStream>;
  createRecorder: (stream: MediaStream) => MediaRecorder;
  createUrl: (blob: Blob) => string;
}

/** Own the permission request and recorder independently of React renders. */
export class RecorderController {
  private disposed = false;
  private generation = 0;
  private media: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private pendingStart: Promise<boolean> | null = null;
  private pendingStop: Promise<string | null> | null = null;
  private resolveStop: ((url: string | null) => void) | null = null;

  constructor(
    private onChange: (snapshot: RecorderSnapshot) => void,
    private dependencies: RecorderDependencies = {
      getStream: () => {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          return Promise.reject(new Error("当前浏览器不支持录音"));
        }
        return navigator.mediaDevices.getUserMedia({ audio: true });
      },
      createRecorder: stream => {
        if (typeof MediaRecorder === "undefined") throw new Error("当前浏览器不支持录音");
        return new MediaRecorder(stream);
      },
      createUrl: blob => URL.createObjectURL(blob),
    },
  ) {}

  private emit(state: RecorderState, error: string | null = null) {
    if (!this.disposed) this.onChange({ state, error });
  }

  private release() {
    if (this.media) {
      this.media.ondataavailable = null;
      this.media.onstop = null;
      this.media.onerror = null;
      if (this.media.state !== "inactive") {
        try { this.media.stop(); } catch { /* Tracks below are still released. */ }
      }
    }
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.media = null;
    this.chunks = [];
  }

  private finish(error?: string) {
    const blob = new Blob(this.chunks, { type: this.media?.mimeType || "audio/webm" });
    const failure = error ?? (!this.resolveStop ? "录音意外结束，请重试" : blob.size === 0 ? "没有录到声音，请重试" : null);
    let url: string | null = null;
    if (!failure && !this.disposed) {
      try { url = this.dependencies.createUrl(blob); } catch { error = "无法保存录音，请重试"; }
    }
    this.release();
    const resolve = this.resolveStop;
    this.resolveStop = null;
    this.pendingStop = null;
    this.emit(failure || error ? "error" : "idle", error ?? failure);
    resolve?.(url);
  }

  start(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.media) return Promise.resolve(this.media.state === "recording");
    if (this.pendingStart) return this.pendingStart;
    const generation = ++this.generation;
    this.emit("requesting");
    const pending = this.dependencies.getStream().then(stream => {
      if (this.disposed || generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        return false;
      }
      this.stream = stream;
      const media = this.dependencies.createRecorder(stream);
      this.media = media;
      this.chunks = [];
      media.ondataavailable = event => {
        if (this.media === media && event.data?.size > 0) this.chunks.push(event.data);
      };
      media.onstop = () => { if (this.media === media) this.finish(); };
      media.onerror = () => { if (this.media === media) this.finish("录音中断，请重试"); };
      media.start();
      this.emit("recording");
      return true;
    }).catch(error => {
      if (!this.disposed && generation === this.generation) {
        this.release();
        const name = error?.name;
        const message = name === "NotAllowedError" ? "请允许麦克风权限后重试"
          : name === "NotFoundError" ? "没有找到可用的麦克风"
          : error instanceof Error ? error.message : String(error);
        this.emit("error", message);
      }
      return false;
    }).finally(() => {
      if (this.pendingStart === pending) this.pendingStart = null;
    });
    this.pendingStart = pending;
    return pending;
  }

  stop(): Promise<string | null> {
    if (this.pendingStop) return this.pendingStop;
    if (!this.media || this.media.state === "inactive") {
      // Cancel a permission request too: a late permission grant must not start recording.
      const wasRequesting = !!this.pendingStart;
      this.generation++;
      this.pendingStart = null;
      if (wasRequesting) this.emit("idle");
      return Promise.resolve(null);
    }
    const media = this.media;
    this.pendingStop = new Promise(resolve => { this.resolveStop = resolve; });
    const pending = this.pendingStop;
    try { media.stop(); } catch { this.finish("录音中断，请重试"); }
    return pending;
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.pendingStart = null;
    this.release();
    this.resolveStop?.(null);
    this.resolveStop = null;
    this.pendingStop = null;
  }
}
