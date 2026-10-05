"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Rocket } from "./icons";

export function NarrationNextButton({ locked, progress, isLast, onClick }: {
  locked: boolean;
  progress: number | null;
  isLast: boolean;
  onClick: () => void;
}) {
  const label = isLast ? "开始练习" : "下一步";
  const hintId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const reducedMotion = useReducedMotion();
  const completed = Math.min(1, Math.max(0, progress ?? 0));
  const inset = 2;
  const radius = Math.min(14, Math.max(0, (Math.min(size.width, size.height) - inset * 2) / 2));
  const right = size.width - inset;
  const bottom = size.height - inset;
  // Start at the top centre and trace the button's rounded border clockwise.
  const borderPath = `M ${size.width / 2} ${inset}
    H ${right - radius} A ${radius} ${radius} 0 0 1 ${right} ${inset + radius}
    V ${bottom - radius} A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom}
    H ${inset + radius} A ${radius} ${radius} 0 0 1 ${inset} ${bottom - radius}
    V ${inset + radius} A ${radius} ${radius} 0 0 1 ${inset + radius} ${inset}
    H ${size.width / 2} Z`;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <motion.button
        type="button"
        disabled={locked}
        aria-label={label}
        aria-describedby={locked ? hintId : undefined}
        onClick={onClick}
        whileTap={locked ? undefined : { scale: 0.96 }}
        className={`w-full btn-chunky-primary flex items-center justify-center gap-2 ${locked ? "!cursor-wait !bg-primary/75" : ""}`}
      >
        {isLast && <Rocket className="w-5 h-5" />}
        <span>{label}</span>
        {!locked && (
          <motion.span aria-hidden animate={reducedMotion ? undefined : { x: [0, 6, 0] }}
            transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}>→</motion.span>
        )}
      </motion.button>
      {locked && size.width > 0 && (
        <svg aria-hidden className={`absolute inset-0 overflow-visible pointer-events-none ${progress === null && !reducedMotion ? "animate-pulse" : ""}`}
          width={size.width} height={size.height}>
          <path d={borderPath} fill="none"
            stroke="#DDF4FF" strokeWidth="3" />
          {completed > 0 && <path d={borderPath} fill="none"
            stroke="#1CB0F6" strokeWidth="4" pathLength="100" strokeDasharray="100 100"
            strokeDashoffset={100 * (1 - completed)} strokeLinecap="round"
            style={{ filter: "drop-shadow(0 0 3px #1CB0F6)", transition: reducedMotion ? "none" : "stroke-dashoffset 200ms linear" }} />}
        </svg>
      )}
      {locked && <span id={hintId} className="sr-only">请先听完本页讲解，再继续学习。</span>}
    </div>
  );
}
