"use client";

/**
 * CloudSyncWatcher —— 云存档自动同步的挂载点（挂在 layout 里，全局只有一份）。
 *
 * 组件本身不渲染任何东西：真实逻辑在 lib/cloudSync.ts 的 startCloudSync()，
 * 这里只负责「客户端挂载后启动 / 卸载时收尾」。放在 layout 而不是某个页面里，
 * 是为了让所有路由（含答题页、阅读器）都持续上云。
 */

import { useEffect } from "react";
import { startCloudSync } from "@/lib/cloudSync";

export function CloudSyncWatcher() {
  useEffect(() => startCloudSync(), []);
  return null;
}
