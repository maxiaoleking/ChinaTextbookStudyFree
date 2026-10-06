"use client";

/**
 * cloudSync.ts —— 云存档（后端 PostgreSQL）自动同步客户端。
 *
 * 存档码 = 凭据：8 位大写字母数字，存在 localStorage（csf-save-code）。
 * 换浏览器 / 换设备时输入同一个码，就能把进度捞回来。
 *
 * 同步的是 localStorage 里 `csf-progress-v1` 的**整包**（zustand persist 的
 * `{version, state}`），后端只做搬运与快照，不解析字段语义 —— 因此前端版本
 * 迁移（migrate）在拉取后照常生效。
 *
 * 冲突策略（谁都没联网改过时的"最后写入者赢"）：
 *   本地整包 hash == 上次同步 hash（或本地还没学出进度）→ 本地是干净的 → 拉取云端
 *   否则 → 本地有未上云的改动 → 推送覆盖（旧版本进服务端 save_history，可回滚）
 *   「本地干净」这一条同时挡住了新浏览器拿零进度默认档去覆盖云端存档的事故。
 * 首次同步（无码）由服务端发码；零进度的全新存档不建云端行，避免垃圾数据。
 */

import { useSyncExternalStore } from "react";
import { useProgressStore } from "@/store/progress";

const PERSIST_KEY = "csf-progress-v1";
const CODE_KEY = "csf-save-code";
const HASH_KEY = "csf-cloud-hash";
const SYNCED_AT_KEY = "csf-cloud-synced-at";
const API_BASE = "/api";

/** 本地改动后的防抖推送间隔 */
const PUSH_DEBOUNCE_MS = 2500;
/** 后台自动同步总开关（关掉后仍可手动点「立即同步」） */
export const AUTO_SYNC_DEFAULT = true;

export type CloudPhase = "off" | "idle" | "syncing" | "ok" | "error";

export type CloudStatus = {
  phase: CloudPhase;
  code: string | null;
  syncedAt: string | null;
  message: string | null;
  /** 最近一次同步是本地推上去的还是云端拉下来的 */
  lastDirection: "push" | "pull" | "none" | null;
};

const EMPTY_STATUS: CloudStatus = {
  phase: "off",
  code: null,
  syncedAt: null,
  message: null,
  lastDirection: null,
};

let status: CloudStatus = EMPTY_STATUS;
const listeners = new Set<() => void>();

function emit(patch: Partial<CloudStatus>) {
  status = { ...status, ...patch };
  listeners.forEach(l => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getCloudStatus(): CloudStatus {
  return status;
}

/** 响应式读取云同步状态（Profile 卡片用） */
export function useCloudStatus(): CloudStatus {
  return useSyncExternalStore(subscribe, getCloudStatus, () => EMPTY_STATUS);
}

// ---- 本地读写 ----------------------------------------------------------

function ls(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getSaveCode(): string | null {
  return ls()?.getItem(CODE_KEY) ?? null;
}

export function setSaveCode(code: string | null) {
  const store = ls();
  if (!store) return;
  if (code) store.setItem(CODE_KEY, code.toUpperCase());
  else store.removeItem(CODE_KEY);
  emit({ code: code ? code.toUpperCase() : null });
}

export function normalizeCode(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/[^A-Z2-9]/g, "");
  return code.length === 8 ? code : null;
}

export function isAutoSyncEnabled(): boolean {
  const raw = ls()?.getItem("csf-cloud-auto");
  return raw === null ? AUTO_SYNC_DEFAULT : raw === "1";
}

export function setAutoSync(enabled: boolean) {
  ls()?.setItem("csf-cloud-auto", enabled ? "1" : "0");
}

/** 本机忘记存档码与同步记账（云端那份存档原样保留，可换设备继续用） */
export function forgetCode() {
  const store = ls();
  store?.removeItem(CODE_KEY);
  store?.removeItem(HASH_KEY);
  store?.removeItem(SYNCED_AT_KEY);
  emit({ code: null, syncedAt: null, phase: "idle", message: null, lastDirection: null });
}

/** 读出整包原始 JSON 字符串（不做任何加工，hash 与上传都用它） */
function readRawEnvelope(): { text: string; hash: string } | null {
  const text = ls()?.getItem(PERSIST_KEY) ?? null;
  if (!text) return null;
  return { text, hash: fnv1a(text) };
}

/** 有进度才值得建云端存档，免得每个路过的人都留一行垃圾 */
function hasProgress(text: string): boolean {
  try {
    const state = (JSON.parse(text).state ?? {}) as Record<string, unknown>;
    const lessons = state.completedLessons;
    const readings = state.completedReadings;
    const xp = typeof state.xp === "number" ? state.xp : 0;
    return (
      xp > 0 ||
      (!!lessons && Object.keys(lessons as object).length > 0) ||
      (!!readings && Object.keys(readings as object).length > 0)
    );
  } catch {
    return false;
  }
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function deviceLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os = /iPad|iPhone|iPod/.test(ua)
    ? "iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : "未知设备";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "浏览器";
  return `${os} ${browser}`;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `服务端返回了非 JSON 内容（HTTP ${res.status}）` };
    }
    if (!res.ok) {
      const msg = (json as { error?: string })?.error;
      return { ok: false, error: msg ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.name === "AbortError" ? "同步超时" : "网络不通",
    };
  } finally {
    clearTimeout(timer);
  }
}

export type RemoteSave = {
  code: string;
  envelope: unknown;
  updatedAt: string;
  updatedAtMs: number;
  createdAt?: string;
  deviceLabel?: string | null;
  summary?: { xp: number | null; streak: number | null; lessons: number | null };
};

function rememberSynced(hash: string, at: string) {
  const store = ls();
  store?.setItem(HASH_KEY, hash);
  store?.setItem(SYNCED_AT_KEY, at);
  emit({ syncedAt: at });
}

// ---- 同步动作 ----------------------------------------------------------

let running: Promise<SyncOutcome> | null = null;

export type SyncOutcome =
  | { kind: "created" | "pushed" | "pulled" | "unchanged"; code: string }
  | { kind: "empty" }
  | { kind: "error"; message: string };

async function runSync(): Promise<SyncOutcome> {
  const local = readRawEnvelope();
  if (!local) return { kind: "error", message: "本地还没有存档数据" };
  const localHash = local.hash;
  const syncedHash = ls()?.getItem(HASH_KEY);
  const envelope = JSON.parse(local.text);
  let code = getSaveCode();
  emit({ phase: "syncing", message: null, code });

  if (!code) {
    if (!hasProgress(local.text)) {
      emit({ phase: "idle" });
      return { kind: "empty" };
    }
    const created = await request<{ code: string; updatedAt: string }>(
      "POST",
      "/save",
      { envelope, deviceLabel: deviceLabel() },
    );
    if (!created.ok) {
      emit({ phase: "error", message: created.error });
      return { kind: "error", message: created.error };
    }
    code = created.data.code;
    setSaveCode(code);
    rememberSynced(localHash, created.data.updatedAt);
    emit({ phase: "ok", lastDirection: "push", syncedAt: created.data.updatedAt });
    return { kind: "created", code };
  }

  const remote = await request<RemoteSave>("GET", `/save/${code}`);
  if (!remote.ok) {
    if (remote.error.includes("找不到")) {
      // 云端行被删了（或换库）→ 本地重新占住这个码
      const recreated = await request<{ updatedAt: string }>("PUT", `/save/${code}`, {
        envelope,
        deviceLabel: deviceLabel(),
      });
      if (recreated.ok) {
        rememberSynced(localHash, recreated.data.updatedAt);
        emit({ phase: "ok", lastDirection: "push" });
        return { kind: "pushed", code };
      }
    }
    emit({ phase: "error", message: remote.error });
    return { kind: "error", message: remote.error };
  }

  const remoteHash = fnv1a(JSON.stringify(remote.data.envelope));

  // 本地"干净"= 要么跟上次同步时一模一样，要么压根还没学出进度。
  // 后者很关键：新浏览器 / 刚清过数据时本地是零进度默认档，绝不能推上去覆盖云端。
  const localIsPristine = localHash === syncedHash || !hasProgress(local.text);

  if (localIsPristine && remoteHash !== localHash) {
    // 本地没动过，而云端是别的设备推的 → 拉下来覆盖本地并整页重载
    ls()?.setItem(PERSIST_KEY, JSON.stringify(remote.data.envelope));
    rememberSynced(remoteHash, remote.data.updatedAt);
    emit({ phase: "ok", code, lastDirection: "pull", syncedAt: remote.data.updatedAt });
    // 用重新加载收尾：所有页面 / watcher 基于新进度重算（与手动导入存档一致）
    window.setTimeout(() => window.location.reload(), 300);
    return { kind: "pulled", code };
  }

  if (localHash !== syncedHash) {
    const pushed = await request<{ updatedAt: string }>("PUT", `/save/${code}`, {
      envelope,
      deviceLabel: deviceLabel(),
    });
    if (!pushed.ok) {
      emit({ phase: "error", message: pushed.error });
      return { kind: "error", message: pushed.error };
    }
    rememberSynced(localHash, pushed.data.updatedAt);
    emit({ phase: "ok", code, lastDirection: "push", syncedAt: pushed.data.updatedAt });
    return { kind: "pushed", code };
  }

  emit({ phase: "ok", code, lastDirection: "none", syncedAt: remote.data.updatedAt });
  return { kind: "unchanged", code };
}

/** 立即同步（去重：同一时刻只有一次在跑） */
export function syncNow(): Promise<SyncOutcome> {
  if (running) return running;
  running = runSync().finally(() => {
    running = null;
  });
  return running;
}

/**
 * 用已有存档码接管云端存档：以云端为准（用户点「接续」的意图就是把那边捞回来）。
 * 覆盖本机前请先用「导出存档」留一份，Profile 卡片上也会把两边的进度摆出来再确认。
 */
export async function adoptCode(code: string): Promise<SyncOutcome> {
  const store = ls();
  const local = readRawEnvelope();
  if (!store || !local) return { kind: "error", message: "本地还没有存档数据" };
  emit({ phase: "syncing", message: null });

  const remote = await request<RemoteSave>("GET", `/save/${code}`);
  if (!remote.ok) {
    emit({ phase: "error", message: remote.error });
    return { kind: "error", message: remote.error };
  }
  const remoteHash = fnv1a(JSON.stringify(remote.data.envelope));
  setSaveCode(code);
  rememberSynced(remoteHash, remote.data.updatedAt);
  emit({ code, lastDirection: "pull", syncedAt: remote.data.updatedAt });

  if (remoteHash === local.hash) {
    emit({ phase: "ok" });
    return { kind: "unchanged", code };
  }
  store.setItem(PERSIST_KEY, JSON.stringify(remote.data.envelope));
  emit({ phase: "ok" });
  window.setTimeout(() => window.location.reload(), 300);
  return { kind: "pulled", code };
}

/** 只读探测：这个存档码在云端有没有内容（Profile 卡片用） */
export async function probeCode(
  code: string,
): Promise<{ ok: true; data: RemoteSave } | { ok: false; error: string }> {
  return request<RemoteSave>("GET", `/save/${code}`);
}

// ---- 生命周期 ----------------------------------------------------------

let started = false;
let pendingUnsub: (() => void) | null = null;

/**
 * 启动自动同步：等 persist 完成水合后先做一次初始同步，之后本地每次变更
 * 防抖推送。由 layout 里的 <CloudSyncWatcher /> 挂载一次。
 */
export function startCloudSync(): () => void {
  if (started) return () => {};
  started = true;
  emit({
    phase: "idle",
    code: getSaveCode(),
    syncedAt: ls()?.getItem(SYNCED_AT_KEY) ?? null,
    message: null,
  });

  let timer: number | null = null;
  let disposed = false;

  const schedule = () => {
    if (!isAutoSyncEnabled() || disposed) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void syncNow();
    }, PUSH_DEBOUNCE_MS);
  };

  const bootstrap = () => {
    if (disposed || !isAutoSyncEnabled()) return;
    void syncNow();
  };

  const unsubStore = useProgressStore.subscribe(schedule);
  if (useProgressStore.persist.hasHydrated()) bootstrap();
  else pendingUnsub = useProgressStore.persist.onFinishHydration(bootstrap);

  // iPad / 安卓切回前台时先补一次，避免长时间挂起后攒着不上云
  const onVisibility = () => {
    if (document.visibilityState === "visible") void syncNow();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    disposed = true;
    unsubStore();
    pendingUnsub?.();
    pendingUnsub = null;
    document.removeEventListener("visibilitychange", onVisibility);
    if (timer !== null) window.clearTimeout(timer);
    started = false;
    emit({ phase: "off" });
  };
}
