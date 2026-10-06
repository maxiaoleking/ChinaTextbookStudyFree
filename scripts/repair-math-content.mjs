#!/usr/bin/env node
/**
 * 修复生成管线留下的四类题目缺陷（只改数据，可 --dry-run 复核；每类都自带证据）：
 *  1) 除号被写成 `\times` 或 `\text{ (divide) }` —— 按题面自证：换成 ÷ 才等于 answer/讲解里声明的数，
 *     连等式（$A = B = C$）逐段核对，多个改法都能成立时保持原样并报告
 *  2) `$...$` 里的裸下划线（填空占位）KaTeX 渲染报错 —— 转义成 `\_`，孩子看到的仍是下划线
 *  3) 选择题：正确选项重复出现、answer 与选项原文不一致（`and`/`_`/漏写 \frac）
 *  4) PATCHES：讲解残留模型「自我商量」的那些题，逐题核对后给出定稿题面/答案/讲解
 * 用法：node scripts/repair-math-content.mjs [--write] [--verbose]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import katex from "katex";
import { correctChoiceLetter } from "@cstf/core/grade";

const ROOT = path.resolve(import.meta.dirname, "..");
const WRITE = process.argv.includes("--write");
const VERBOSE = process.argv.includes("--verbose");

const stats = {
  files: 0,
  divideMacro: 0,
  flips: 0,
  underscores: 0,
  answers: 0,
  dedupes: 0,
  patched: 0,
  unmatched: [],
  ambiguous: [],
};

const renderable = (span) => {
  try {
    katex.renderToString(span, { throwOnError: true, strict: false });
    return true;
  } catch {
    return false;
  }
};

/** 小学四则：整数/小数、+ - × ÷、括号；除不尽或写法不合算返回 null */
function evaluate(expr) {
  const toks = expr.match(/\d+(?:\.\d+)?|[+\-×÷()]/g);
  if (!toks?.length) return null;
  if (toks.join("") !== expr.replace(/\s+/g, "")) return null;
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const factor = () => {
    const t = next();
    if (/^\d+(\.\d+)?$/.test(t ?? "")) return Number(t);
    if (t === "(") {
      const v = add();
      if (v === null || next() !== ")") return null;
      return v;
    }
    return null;
  };
  const term = () => {
    let acc = factor();
    while (acc !== null && (peek() === "×" || peek() === "÷")) {
      const op = next();
      const rhs = factor();
      if (rhs === null || rhs === 0 || !Number.isFinite(acc / rhs)) return null;
      acc = op === "×" ? acc * rhs : acc / rhs;
    }
    return acc;
  };
  const add = () => {
    let acc = term();
    while (acc !== null && (peek() === "+" || peek() === "-")) {
      const op = next();
      const rhs = term();
      if (rhs === null) return null;
      acc = op === "+" ? acc + rhs : acc - rhs;
    }
    return acc;
  };
  const v = add();
  return pos === toks.length ? v : null;
}

const num = (s) => {
  const m = /^[-+]?\d+(?:\.\d+)?/.exec(String(s ?? "").trim());
  return m ? Number(m[0]) : null;
};
const eqNum = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1e-9;

const value = (s) => evaluate(s.replace(/\\times/g, "×").replace(/\\div/g, "÷"));

/**
 * 只改 `\times`：逐一尝试把哪些改成 `\div` 能算出 want。
 * 原读法已成立则不动；有多个同样成立的改法说明题面自证不了，交给人工。
 */
function flipTo(span, want) {
  if (want === null || want === undefined) return null;
  const idx = [...span.matchAll(/\\times/g)].map((m) => m.index);
  if (!idx.length || idx.length > 4) return null;
  if (eqNum(value(span), want)) return null;
  const hits = [];
  for (let mask = 1; mask < 1 << idx.length; mask++) {
    let s = "",
      p = 0;
    for (let i = 0; i < idx.length; i++) {
      s += span.slice(p, idx[i]) + (mask & (1 << i) ? "\\div" : "\\times");
      p = idx[i] + "\\times".length;
    }
    s += span.slice(p);
    if (eqNum(value(s), want)) hits.push({ mask, s });
  }
  if (!hits.length) return null;
  const bits = (m) => m.toString(2).split("1").length - 1;
  const min = Math.min(...hits.map((h) => bits(h.mask)));
  const best = hits.filter((h) => bits(h.mask) === min);
  if (best.length !== 1) {
    stats.ambiguous.push({ span, want });
    return null;
  }
  return best[0].s;
}

/**
 * 只在「换解除号才成立、原读法不成立」时改写，因此每一次翻转都可由题面自证。
 * 连等式（$A = B = C$）按段处理：每段都得等于最后的数。
 */
function repairSpanCalc(span, isStem, target) {
  const parts = span.split("=");
  if (parts.length < 2) {
    if (!isStem) return null;
    const fixed = flipTo(span.trim(), target);
    return fixed === null ? null : `$${fixed}$`;
  }
  const last = parts[parts.length - 1].trim();
  let want;
  if (/^\?\s*$/.test(last)) want = isStem ? target : null;
  else if (/^[-+]?\d+(?:\.\d+)?\s*$/.test(last)) want = Number(last.match(/[-+]?\d+(?:\.\d+)?/)[0]);
  else if (isStem) want = target;
  else return null;
  if (want === null || want === undefined) return null;

  let changed = 0;
  const next = parts.map((p, i) => {
    if (i === parts.length - 1) return p;
    const fixed = flipTo(p.trim(), want);
    if (fixed === null) return p;
    changed++;
    // 段与段之间的空格沿用原样，不要把 `$ 720 ...` 这种多余空格写进题面
    return /^\s*/.exec(p)[0] + fixed + /\s*$/.exec(p)[0];
  });
  if (!changed) return null;
  stats.flips += changed;
  return `$${next.join("=")}$`;
}

function repairCalculation(q) {
  const target = num(q.answer);
  q.question = String(q.question).replace(/\$([^$]+)\$/g, (all, span) => repairSpanCalc(span, true, target) ?? all);
  if (typeof q.explanation === "string") {
    q.explanation = q.explanation.replace(/\$([^$]+)\$/g, (all, span) => repairSpanCalc(span, false, target) ?? all);
  }
}

/** 遍历文档里的每个字符串：还原 (divide) 写法、转义渲染不过来的下划线 */
function repairStrings(node) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = repairStrings(node[i]);
    return node;
  }
  if (typeof node !== "string") {
    if (node && typeof node === "object") for (const k of Object.keys(node)) node[k] = repairStrings(node[k]);
    return node;
  }
  let text = node.replace(/\\text\{\s*\(divide\)\s*\}/g, "\\div");
  if (text !== node) stats.divideMacro++;
  text = text.replace(/\$([^$]+)\$/g, (all, span) => {
    if (renderable(span) || !/([^\\]|^)_/.test(span)) return all;
    const fixed = span.replace(/(?<!\\)_/g, "\\_");
    if (!renderable(fixed)) return all;
    stats.underscores++;
    return `$${fixed}$`;
  });
  return text;
}

const norm = (s) =>
  String(s)
    .replace(/^\s*[A-Da-d][.、)::]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

/** answer 与某个选项只差连接词/占位符时，改写成该选项原文 */
function alignAnswer(q) {
  if (q.type !== "choice" || !Array.isArray(q.options) || correctChoiceLetter(q) !== null) return;
  const key = (s) => norm(s).replace(/_\s*/g, "").replace(/\s*and\s*/g, "和").replace(/\s+/g, "");
  const want = key(q.answer);
  const hit = q.options.filter((o) => key(o) === want);
  if (hit.length !== 1) {
    if (correctChoiceLetter(q) === null) stats.unmatched.push(q);
    return;
  }
  if (VERBOSE) console.log(`  answer 对齐选项 q${q.id}: ${JSON.stringify(q.answer)} -> ${JSON.stringify(hit[0])}`);
  q.answer = hit[0];
  stats.answers++;
}

/** 正确选项重复出现＝两个满分答案，删掉多余那一份（不新增内容） */
function dedupeCorrectOption(q) {
  if (q.type !== "choice" || !Array.isArray(q.options) || q.options.length < 2) return;
  const letter = correctChoiceLetter(q);
  if (!letter) return;
  const correct = norm(q.options[letter.charCodeAt(0) - 65]);
  const keep = [];
  let removed = 0;
  for (const o of q.options) {
    if (removed === 0 && norm(o) === correct && keep.some((x) => norm(x) === correct)) {
      removed++;
      continue;
    }
    keep.push(o);
  }
  if (!removed || keep.length < 2) return;
  if (VERBOSE) console.log(`  去掉重复正确项 q${q.id}: ${JSON.stringify(q.options)} -> ${JSON.stringify(keep)}`);
  q.options = keep;
  q.answer = keep.find((o) => norm(o) === correct) ?? q.answer;
  stats.dedupes += removed;
}

/** 题面与讲解互相矛盾、且讲解自己已给出更正版的那一题 */
const PATCHES = [
  {
    file: "output/math/quizzes/义务教育教科书 · 数学三年级上册_unit5.json",
    list: "exam",
    id: 11,
    question: "红圆片 6 个，蓝圆片个数是红圆片的 5 倍。如果蓝圆片拿走 12 个，剩下的蓝圆片是红圆片的几倍？",
    explanation:
      "蓝圆片共有 $6 \\times 5 = 30$ 个。拿走 12 个后剩下 $30 - 12 = 18$ 个。$18 \\div 6 = 3$，所以剩下的蓝圆片是红圆片的 3 倍。验算：$3 \\times 6 = 18$，$18 + 12 = 30$ ✓。",
    answer: "3 倍",
  },
  {
    file: "output/math/quizzes/义务教育教科书·数学五年级下册_unit6.json",
    list: "exam",
    id: 12,
    answer: "(\\frac{7}{10} + \\frac{3}{10}) - \\frac{1}{3}",
  },
  // ---- 讲解被生成模型的「自我商量」污染：题面/答案以最后核对的那一步为准 ----
  {
    file: "output/math/quizzes/义务教育教科书·数学二年级下册_unit3.json",
    list: "exam",
    id: 22,
    explanation: "$81 \\div 9 = 9$。用口诀「九九八十一」想：$9 \\times 9 = 81$ ✓。",
  },
  {
    // 两个正方体并排贴桌面：12 个面里，贴桌 2 个、中间贴合 2 个，露出 8 个（原答案 9 是模型自己算错的）
    file: "output/math/quizzes/义务教育教科书·数学四年级下册_unit2.json",
    list: "unit_test",
    id: 19,
    answer: "8",
    explanation:
      "两个小正方体一共有 $6 \\times 2 = 12$ 个面。贴着桌面的 2 个面和中间互相贴合的 2 个面都露不出来，$12 - 2 - 2 = 8$ 个。验算：上面 2 个、前面 2 个、后面 2 个、左面 1 个、右面 1 个，$2+2+2+1+1=8$ ✓。",
  },
  {
    // 题面写 $50+0$ 与「上下两层各 50」矛盾，讲解自己收在 $50 \\times 2 = 100$
    file: "output/math/quizzes/义务教育教科书·数学四年级下册_unit2.json",
    list: "exam",
    id: 23,
    question:
      "有 100 个小正方体，先横着排 50 个，再在上面重叠排 50 个。从前面看一共可以看到多少个正方形？ $50 + 50 = ?$",
    answer: "100",
    explanation:
      "从前面看是两行，每行 50 个正方形：$50 + 50 = 100$。验算：$100 \\div 2 = 50$ ✓。",
  },
  {
    // 原答案 0：两块磁铁相吸说明靠近的两端是 N、S 两种极性
    file: "output/science/quizzes/义务教育教科书·科学二年级下册_unit1.json",
    list: "unit_test",
    id: 20,
    answer: "2",
    explanation:
      "磁铁有 N 极和 S 极两种极性，异名磁极互相吸引。两块磁铁互相吸引，说明靠近的两端分属 2 种极性。验算：若是同一种极性会互相排斥，与题意不符 ✓。",
  },
  {
    file: "output/science/quizzes/义务教育教科书·科学四年级上册_unit1.json",
    list: "unit_test",
    id: 19,
    explanation:
      "琴弦越粗，振动越慢，单位时间内振动的次数越少。1 号弦最细、频率最高，6 号弦最粗，所以振动次数比 1 号弦少，填 1。",
  },
  {
    // 题干问「写成小数」，答案应是被改写的那个小数本身
    file: "output/math/quizzes/义务教育教科书·数学三年级下册_unit7.json",
    list: "exam",
    id: 19,
    question: "3 米 5 分米写成小数是 3.5 米，那么 8 米 2 分米写成小数是 ___ 米。",
    answer: "8.2",
    explanation:
      "1 分米写成米是 0.1 米，2 分米就是 0.2 米，所以 8 米 2 分米 = 8.2 米。验算：8.2 米 = 8 米 + 0.2 米 = 8 米 2 分米 ✓。",
  },
  {
    file: "output/math/quizzes/义务教育教科书·数学一年级下册_unit1.json",
    list: "exam",
    id: 21,
    explanation:
      "一套七巧板有 5 个三角形、1 个正方形、1 个平行四边形，$5 + 1 + 1 = 7$，一共 7 块。拼成大正方形时 7 块都要用上。",
  },
  {
    // 圆柱有无数条高，数字键盘的「0」是错的；改派为文字填空后按课本口径作答
    file: "output/math/quizzes/义务教育教科书·数学六年级下册_unit3.json",
    list: "unit_test",
    id: 21,
    answer: "无数",
    explanation:
      "圆柱两个底面之间的距离叫做高，在两个底面之间任意画一条垂直线段都是它的高，所以圆柱有无数条高。验算：圆锥只有 1 条高，圆柱的底面是圆，可以取无数条 ✓。",
  },
  {
    // $9.999 \\times 9.999 = 99.980001$，整数部分是 99（原答案 9998）
    file: "output/math/quizzes/义务教育教科书 · 数学五年级上册_unit3.json",
    list: "unit_test",
    id: 21,
    answer: "99",
    explanation:
      "$9.999 \\times 9.999 = 99.980001$，小数点左边的整数部分是 99。验算：$9.99 \\times 9.99 = 99.8001$ 的整数部分也是 99，规律一致 ✓。",
  },
  {
    file: "output/math/quizzes/义务教育教科书 · 数学五年级上册_unit8.json",
    list: "exam",
    id: 18,
    explanation:
      "平行四边形底边 8 厘米上的高一定短于斜边 5 厘米，所以 6 厘米只能是底边 5 厘米上的高。面积 $5 \\times 6 = 30$ 平方厘米。验算：$30 \\div 5 = 6$ ✓。",
  },
  {
    file: "output/math/quizzes/义务教育教科书·数学三年级下册_unit7.json",
    list: "exam",
    id: 13,
    explanation:
      "一位小数要求小数点后只有一位，3、0、5 都要用上，所以整数部分是两位数、十分位是一位。0 不能做整数部分的最高位，能组成的最小两位整数是 30，十分位放 5，得 30.5。选项 3.05、0.35 是两位小数，3.5 没有用到 0，都不合题意。",
  },
  // ---- 第二批：讲解残留 + 选项/答案本身对不上的题 ----
  {
    // 右侧拼音是 木马/瀑布/喇叭/地毯，左侧却写着「词典」，四个配对里三个对不上
    file: "output/chinese/quizzes/义务教育教科书·语文一年级上册_unit3.json",
    list: "unit_test",
    id: 19,
    options: ["喇叭", "地毯", "瀑布", "木马", "mù mǎ", "pù bù", "lǎ ba", "dì tǎn"],
    answer: "A-3,B-4,C-2,D-1",
    explanation: "先拼读拼音再找词语：喇叭-lǎ ba，地毯-dì tǎn，瀑布-pù bù，木马-mù mǎ。",
  },
  {
    // 「寓」的部首是宀，选项里没有；换成门字框的「问」，并讲清问/闷的部首差别
    file: "output/chinese/quizzes/义务教育教科书·语文二年级下册_unit5.json",
    list: "exam",
    id: 20,
    options: ["突", "厨", "问", "闷", "心字底", "门字框", "厂字头", "穴字头"],
    answer: "A-4,B-3,C-2,D-1",
    explanation:
      "突的上边是穴字头，厨的左上角是厂字头，问的外边是门字框；闷的下边是「心」，部首是心字底。",
  },
  {
    // 240 秒 = 4 分，可原选项里没有等号，答案写成了「内」
    file: "output/math/quizzes/义务教育教科书 · 数学三年级上册_unit1.json",
    list: "exam",
    id: 7,
    options: [">", "<", "=", "无法确定"],
    answer: "=",
    explanation:
      "1 分 = 60 秒，4 分就是 $4 \\times 60 = 240$ 秒，所以 240 秒 = 4 分。验算：$240 \\div 60 = 4$ ✓。",
  },
  {
    // 与 899 相邻的是 898 和 900，和是 1798；原 answer 却填了 1800
    file: "output/math/quizzes/义务教育教科书 · 数学三年级上册_unit4.json",
    list: "exam",
    id: 17,
    answer: "1798",
    explanation:
      "与 899 相邻的两个自然数是 898 和 900，和为 $898 + 900 = 1798$。验算：$1798 \\div 2 = 899$，正好是中间那个数 ✓。",
  },
  {
    // 左圈 8 人、重叠 4 人，不含重叠就是 8 - 4 = 4
    file: "output/math/quizzes/义务教育教科书 · 数学三年级上册_unit9.json",
    list: "unit_test",
    id: 15,
    answer: "4",
    explanation:
      "左圈的 8 人里有 4 人同时也在右圈（重叠部分），不含重叠部分的是 $8 - 4 = 4$ 人。验算：$4 + 4 = 8$，正好是左圈总人数 ✓。",
  },
  {
    file: "output/math/quizzes/义务教育教科书 · 数学六年级上册_unit9.json",
    list: "exam",
    id: 20,
    question: "一个比的前项是 20，比值是 4，后项是 ___。",
    answer: "5",
    explanation:
      "比值 = 前项 ÷ 后项，所以后项 = 前项 ÷ 比值 = $20 \\div 4 = 5$。验算：$20 \\div 5 = 4$，比值正是 4 ✓。",
  },
  {
    file: "output/math/quizzes/义务教育教科书·数学一年级下册_unit3.json",
    list: "exam",
    id: 15,
    answer: "吃掉的多",
    explanation:
      "吃掉的：$3 + 4 = 7$（块）。剩下的：$10 - 7 = 3$（块）。$3 < 7$，所以吃掉的多。验算：$7 + 3 = 10$ 块 ✓。",
  },
  {
    // 四个选项没有一个是 12 元，把 B 换成真正「不用找零」的那种付法
    file: "output/math/quizzes/义务教育教科书·数学一年级下册_unit5.json",
    list: "unit_test",
    id: 16,
    options: ["一张10元和一张5元", "一张10元和两张1元", "一张10元和一张1元", "两张10元"],
    answer: "一张10元和两张1元",
    explanation:
      "不用找零要正好凑成 12 元：一张 10 元加两张 1 元是 $10 + 1 + 1 = 12$ 元。其余三项分别是 $10+5=15$、$10+1=11$、$10+10=20$ 元，都不等于 12 ✓。",
  },
  {
    file: "output/math/quizzes/义务教育教科书·数学四年级下册_unit2.json",
    list: "exam",
    id: 21,
    question:
      "把 16 个小正方体平均分成 2 堆，每堆摆成一个大正方体。这两个大正方体从上面看共有 ___ 个小正方形。",
    answer: "8",
    explanation:
      "每堆 $16 \\div 2 = 8$ 个小正方体，正好摆成棱长为 2 的大正方体。每个大正方体从上面看到 $2 \\times 2 = 4$ 个小正方形，两堆共 $4 + 4 = 8$ 个。验算：$8 \\div 2 = 4$ ✓。",
  },
  {
    // 43.7 + 12.5 + 7.5 = 63.7，讲解里「必须填整数」是错的，小数答案本来就能填
    file: "output/math/quizzes/义务教育教科书·数学四年级下册_unit6.json",
    list: "unit_test",
    id: 23,
    answer: "63.7",
    explanation:
      "先把能凑整的两个数加起来：$12.5 + 7.5 = 20$，所以 $43.7 + 20 = 63.7$。验算：$63.7 - 20 = 43.7$ ✓。",
  },
];

function* jsonFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) yield* jsonFiles(p);
    else if (e.endsWith(".json")) yield p;
  }
}

for (const file of jsonFiles(path.join(ROOT, "output"))) {
  const raw = readFileSync(file, "utf8");
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    console.error(`跳过无法解析的文件 ${file}`);
    continue;
  }
  const rel = path.relative(ROOT, file);
  repairStrings(doc);
  for (const list of [doc.unit_test, doc.exam]) {
    for (const q of list?.questions ?? []) {
      if (q.type === "calculation") repairCalculation(q);
      alignAnswer(q);
      dedupeCorrectOption(q);
    }
  }
  for (const p of PATCHES) {
    if (rel !== p.file) continue;
    const q = (doc[p.list]?.questions ?? []).find((x) => x.id === p.id);
    if (!q) {
      console.error(`补丁找不到题目 ${rel} ${p.list} q${p.id}`);
      continue;
    }
    for (const k of ["question", "options", "answer", "explanation"]) if (p[k] !== undefined) q[k] = p[k];
    stats.patched++;
  }
  const out = JSON.stringify(doc, null, 2) + (raw.endsWith("\n") ? "\n" : "");
  if (out === raw) continue;
  stats.files++;
  if (WRITE) writeFileSync(file, out);
}
console.log(
  `${WRITE ? "已写入" : "待写入（dry-run）"}：文件 ${stats.files}｜(divide)→\\div ${stats.divideMacro}` +
    `｜运算符翻转 ${stats.flips}｜下划线转义 ${stats.underscores}｜answer 对齐 ${stats.answers}` +
    `｜去重复正确项 ${stats.dedupes}｜定点补丁 ${stats.patched}`,
);
if (stats.unmatched.length) {
  console.log(`仍有 ${stats.unmatched.length} 题 answer 对不上选项：`);
  for (const q of stats.unmatched.slice(0, 10)) console.log("  q" + q.id, JSON.stringify(q.answer), JSON.stringify(q.options));
}
if (stats.ambiguous.length) {
  console.log(`有 ${stats.ambiguous.length} 处翻转无法由题面唯一自证，保持原样：`);
  for (const a of stats.ambiguous.slice(0, 10)) console.log("  ", JSON.stringify(a.span), "want", a.want);
}
