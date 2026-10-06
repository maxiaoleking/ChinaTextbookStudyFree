"use client";

/**
 * MathText — 把含 $...$ 的字符串拆开，行内 LaTeX 用 KaTeX 渲染。
 *
 * 题目里数学公式都是 $...$ 形式（如 "1分=60秒" 或 "$2+3=5$"），
 * 这个组件负责把普通文本和公式分段渲染。
 */

import dynamic from "next/dynamic";
import { Component, Fragment } from "react";

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

/**
 * KaTeX 渲染坏公式是「抛异常」而不是降级：题目里一个畸形的 $...$（例如题库
 * 里 `\bigcirc` 被写成 JSON 转义 `\b`，实际是退格符）会让整节关卡白屏——
 * 在孩子看来就是「一进去就闪退」。这里把失败兜在单个公式段上，退回原文，
 * 保证题面至少读得懂，数据修好前关卡也还能做。
 */
class SafeMath extends Component<
  { math: string; block: boolean },
  { failed: boolean; last: string }
> {
  state = { failed: false, last: this.props.math };

  static getDerivedStateFromProps(
    props: { math: string },
    state: { failed: boolean; last: string },
  ) {
    // 换题复用同一实例：不重置就会把上一题的失败带到下一题
    if (props.math === state.last) return null;
    return { failed: false, last: props.math };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <span className="font-mono">{this.props.math}</span>;
    const { math, block } = this.props;
    if (block)
      return (
        <span className="block my-2">
          <BlockMath math={math} />
        </span>
      );
    return <InlineMath math={math} />;
  }
}

export function MathText({ text, block = false }: MathTextProps) {
  // 用 $...$ 分段（也支持 $$...$$ 块级）
  const parts: { type: "text" | "inline" | "block"; value: string }[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$") {
      // 查找配对的 $
      const isBlock = text[i + 1] === "$";
      const open = isBlock ? 2 : 1;
      const end = text.indexOf(isBlock ? "$$" : "$", i + open);
      if (end === -1) {
        // 没配对，当普通字符
        parts.push({ type: "text", value: text.slice(i) });
        break;
      }
      parts.push({
        type: isBlock ? "block" : "inline",
        value: text.slice(i + open, end),
      });
      i = end + open;
    } else {
      // 找到下一个 $
      const next = text.indexOf("$", i);
      if (next === -1) {
        parts.push({ type: "text", value: text.slice(i) });
        break;
      }
      parts.push({ type: "text", value: text.slice(i, next) });
      i = next;
    }
  }

  return (
    <span>
      {parts.map((p, idx) => {
        if (p.type === "text") return <Fragment key={idx}>{p.value}</Fragment>;
        return <SafeMath key={idx} math={p.value} block={p.type === "block"} />;
      })}
    </span>
  );
}
