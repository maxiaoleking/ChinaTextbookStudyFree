"use client";

/**
 * 页面级兜底。此前全站没有任何 error boundary：任一组件抛错都会冒到根，
 * 退化成 Next 默认的 "Application error" 空白页（用户看到的「关卡闪退」），
 * 且不会自动恢复，只能手动刷新。
 */
export default function AppError({ reset }: { reset: () => void }) {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-extrabold text-ink">这一页暂时打不开</h1>
      <p className="text-ink-light max-w-sm">
        已经答过的题都存着，不会丢。点下面的按钮重试一次就好。
      </p>
      <button type="button" className="btn-chunky btn-chunky-primary w-full max-w-xs" onClick={reset}>
        重试
      </button>
      <a href="/" className="btn-chunky btn-chunky-ghost w-full max-w-xs">
        回到首页
      </a>
    </main>
  );
}
