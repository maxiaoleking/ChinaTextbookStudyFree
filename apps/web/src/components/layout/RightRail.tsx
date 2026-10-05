"use client";

/**
 * RightRail —— 桌面端右侧 rail（仿 Duolingo web）
 *
 * 顺序：StatsBar HUD / 学习里程碑 / 每日任务
 */

import { StatsBar } from "@/components/StatsBar";
import { useProgressStore } from "@/store/progress";
import { Lightning, Trophy } from "@/components/icons";
import { countCompletedCourses } from "@/lib/courseProgress";
import { localStudyDate } from "@/lib/learningLimit";
import { useProgressTicker } from "@/lib/useProgressTicker";

export function RightRail() {
  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex justify-end">
        <StatsBar compact />
      </div>
      <LearningMilestoneCard />
      <DailyQuestsCard />
    </div>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl border-2 border-bg-softer bg-white p-4"
      style={{ boxShadow: "0 2px 0 0 #e5e5e5" }}
    >
      {children}
    </div>
  );
}

function LearningMilestoneCard() {
  const completed = useProgressStore(s => countCompletedCourses(s.completedLessons));
  const NEED = 10;
  const remaining = Math.max(0, NEED - completed);
  const reached = remaining === 0;
  const pct = Math.min(100, (completed / NEED) * 100);
  return (
    <CardShell>
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl border-2 flex items-center justify-center shrink-0 ${reached ? "bg-primary/10 border-primary/30" : "bg-bg-soft border-bg-softer"}`}>
          <Trophy className={`w-5 h-5 ${reached ? "text-primary-dark" : "text-ink-softer"}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-extrabold text-ink">学习里程碑</div>
          <div className="text-xs text-ink-light mt-0.5">
            {reached ? "已完成 10 节课，继续加油！" : `已完成 ${completed}/10 节课 · 还差 ${remaining} 节`}
          </div>
          <div className="h-2 rounded-full bg-bg-softer overflow-hidden mt-2" role="progressbar" aria-label="完成10节课" aria-valuemin={0} aria-valuemax={10} aria-valuenow={Math.min(completed, NEED)}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    </CardShell>
  );
}

function DailyQuestsCard() {
  const now = useProgressTicker();
  const todayXp = useProgressStore(s => s.todayXp);
  const lastXpDate = useProgressStore(s => s.lastXpDate);
  const displayXp = lastXpDate === localStudyDate(now) ? todayXp : 0;
  const target = 10;
  const pct = Math.min(100, Math.round((displayXp / target) * 100));
  return (
    <CardShell>
      <div className="text-sm font-extrabold text-ink mb-2">每日任务</div>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-warning/20 flex items-center justify-center shrink-0">
          <Lightning className="w-5 h-5 text-warning" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-3 rounded-full bg-bg-softer overflow-hidden">
              <div
                className="h-full bg-warning rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-[10px] font-extrabold text-ink-softer tabular-nums shrink-0">
              {Math.min(displayXp, target)}/{target}
            </div>
          </div>
        </div>
      </div>
    </CardShell>
  );
}
