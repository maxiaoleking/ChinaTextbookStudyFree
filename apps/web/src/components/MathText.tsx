"use client";

/**
 * MathText — 把含 $...$ 的字符串拆开，行内 LaTeX 用 KaTeX 渲染。
 *
 * 题目里数学公式都是 $...$ 形式（如 "1分=60秒" 或 "$2+3=5$"），
 * 这个组件负责把普通文本和公式分段渲染。
 */

import dynamic from "next/dynamic";
import { Fragment } from "react";
import { splitMathText } from "@/lib/mathText";

// react-katex + katex 的体积较大 (~100KB+)，改为按需加载，
// 让 LessonRunner 初次渲染时不阻塞在 KaTeX chunk 上。
// 首屏先显示原始 LaTeX 字符串（等公式 chunk 到位后自动替换为渲染结果）。
const InlineMath = dynamic(
  () => import("react-katex").then(m => ({ default: m.InlineMath })),
  {
    ssr: false,
    loading: () => <span className="opacity-60">…</span>,
  },
);
const BlockMath = dynamic(
  () => import("react-katex").then(m => ({ default: m.BlockMath })),
  {
    ssr: false,
    loading: () => <span className="block my-2 opacity-60">…</span>,
  },
);

interface MathTextProps {
  text: string;
  block?: boolean;
}

export function MathText({ text, block = false }: MathTextProps) {
  const parts = splitMathText(text);

  return (
    <span className="min-w-0 max-w-full break-words">
      {parts.map((p, idx) => {
        if (p.type === "text") return <Fragment key={idx}>{p.value}</Fragment>;
        if (p.type === "block")
          return (
            <span key={idx} className="block my-2 max-w-full overflow-x-auto">
              <BlockMath math={p.value} renderError={() => <span>{p.value}</span>} />
            </span>
          );
        return (
          <span key={idx} className="inline-block max-w-full overflow-x-auto align-middle">
            <InlineMath math={p.value} renderError={() => <span>{p.value}</span>} />
          </span>
        );
      })}
    </span>
  );
}
