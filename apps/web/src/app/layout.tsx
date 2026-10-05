import type { Metadata, Viewport } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { BottomNav } from "@/components/BottomNav";
import { ToastProvider } from "@/components/Toast";
import { DailyRewardWatcher } from "@/components/DailyRewardWatcher";
import { AchievementWatcher } from "@/components/AchievementWatcher";
import { IntroAudioUnlock } from "@/components/IntroAudioUnlock";

const nunito = Nunito({
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "小猫头鹰课堂",
  description: "全科免费，人人可学的小学AI学习平台",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={nunito.variable}>
      <body className="min-h-screen bg-bg-soft">
        <ThemeProvider>
          <ToastProvider>
            <DailyRewardWatcher />
            <AchievementWatcher />
            <IntroAudioUnlock />
            {children}
            <BottomNav />
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
