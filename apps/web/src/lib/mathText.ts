export interface MathTextPart {
  type: "text" | "inline" | "block";
  value: string;
}

/** Repair known JSON escape damage without discarding parts of a command. */
export function normalizeMathText(text: string): string {
  return text
    .replace(/\t(imes|ext|riangle|heta|o)\b/g, (_, command: string) => `\\t${command}`)
    .replace(/\r(ightarrow|ule)\b/g, (_, command: string) => `\\r${command}`)
    .replace(/\n(eq|e)\b/g, (_, command: string) => `\\n${command}`)
    .replace(/\f(rac)\b/g, "\\frac")
    .replace(/\x08(igcirc|igcap|lacksquare|ig)\b/g, (_, command: string) => `\\b${command}`)
    .replace(/\x08div\b|\\bdiv\b/g, "\\div")
    .replace(/\x08dot\b/g, "\\dot")
    .replace(/\x00/g, "\\div")
    .replace(/\x07/g, "\\times")
    .replace(/\\big(?=[\u3400-\u9fff])/g, "");
}

function normalizeFormula(formula: string): string {
  return formula
    .replace(/\\text\{([^{}]*)\}/g, (_, value: string) => `\\text{${value.replace(/(?<!\\)_/g, "\\_")}}`)
    .replace(/(?<!\\)_{2,}/g, value => value.split("").map(() => "\\_").join(""));
}

// Some older fraction options omitted their $ delimiters. Render their known
// commands individually, retaining all surrounding prose and operators.
function appendPlainText(parts: MathTextPart[], text: string) {
  const command = /\\(?:frac|sqrt|text|div|times|bigcirc|bigcap|blacksquare|triangle|dot|rightarrow|to|theta|neq|ne|circ|pi|dots|Box|approx|pm|square|Rightarrow|geq?|leftrightarrow|angle|subset)\b/g;
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = command.exec(text))) {
    if (match.index > offset) parts.push({ type: "text", value: text.slice(offset, match.index) });
    let end = command.lastIndex;
    while (text[end] === "{") {
      let depth = 0;
      let groupEnd = end;
      do {
        if (text[groupEnd] === "{") depth++;
        if (text[groupEnd] === "}") depth--;
        groupEnd++;
      } while (depth && groupEnd < text.length);
      if (depth) break;
      end = groupEnd;
    }
    parts.push({ type: "inline", value: normalizeFormula(text.slice(match.index, end)) });
    command.lastIndex = end;
    offset = end;
  }
  if (offset < text.length) parts.push({ type: "text", value: text.slice(offset) });
}

export function splitMathText(raw: string): MathTextPart[] {
  const text = normalizeMathText(raw);
  const parts: MathTextPart[] = [];
  let offset = 0;
  while (offset < text.length) {
    const next = text.indexOf("$", offset);
    if (next < 0) {
      appendPlainText(parts, text.slice(offset));
      break;
    }
    if (next > offset) appendPlainText(parts, text.slice(offset, next));
    const block = text[next + 1] === "$";
    const size = block ? 2 : 1;
    const end = text.indexOf(block ? "$$" : "$", next + size);
    if (end < 0) {
      appendPlainText(parts, text.slice(next));
      break;
    }
    parts.push({ type: block ? "block" : "inline", value: normalizeFormula(text.slice(next + size, end)) });
    offset = end + size;
  }
  return parts;
}
