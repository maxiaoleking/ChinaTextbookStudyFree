/**
 * validate-data.ts —— 全学科数据校验门禁（发布前必跑）
 *
 * 校验的是**内容源**（`output/<subject>/{outlines,quizzes}`），不是构建产物：
 * `npm run build:data` 会把缺题、答案错位的问题静默跳过（缺题库只 warn、
 * 无法识别的文件名直接跳过），所以必须在源头拦住。
 *
 * 检查层次：
 *   1. 课本级：outline ↔ quiz 配对、bookId 冲突、textbook 一致性
 *   2. 单元级：题量门槛（<23 警告，<20 报错）、exam 成课下限
 *   3. 题级：字段完整性 + 各题型答案自洽（choice 用 @cstf/core 的同一套映射规则）
 *   4. 资源级：音频引用存在性、写字字形存在性 + 版本锁（glyph-lock.json）
 *
 * 用法：
 *   npm run validate:data              # 全量
 *   npm run validate:data -- --json reports/data-validation.json
 *   npm run validate:data -- --no-audio-check   # 媒体未下载时跳过音频存在性
 *
 * 退出码：有 error → 1；只有 warning → 0。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { correctChoiceLetter } from "@cstf/core/grade";
import katex from "katex";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const OUTPUT_ROOT = path.join(REPO_ROOT, "output");
const WEB_PUBLIC = path.join(REPO_ROOT, "apps", "web", "public");
const AUDIO_ROOT = path.join(WEB_PUBLIC, "audio");
const GLYPH_DIR = path.join(WEB_PUBLIC, "writing", "glyphs");
const GLYPH_LOCK = path.join(WEB_PUBLIC, "writing", "glyph-lock.json");

/** 目标下限：低于此值只警告（历史数据里确有 20-22 题的单元，不能让门禁长期红） */
const TARGET_MIN_QUESTIONS = 23;
/** 硬下限：低于此值认为题库被 cleanup 删坏了 */
const HARD_MIN_QUESTIONS = 20;
/** 与 build-data.ts 的 EXAM_MIN_QUESTIONS 对齐：不足则单元挑战课静默不产出 */
const EXAM_MIN_QUESTIONS = 4;

const SUBJECTS = ["chinese", "ela", "english", "math", "renzi", "science", "writing"];

const QUESTION_TYPES = new Set([
  "choice",
  "true_false",
  "fill_blank",
  "fill_blank_text",
  "calculation",
  "matching",
  "word_order",
  "writing",
]);

const TRUE_VALUES = new Set(["对", "正确", "true", "T", "✓", "√", "Y", "yes"]);
const FALSE_VALUES = new Set(["错", "错误", "false", "F", "✗", "×", "N", "no"]);

/** 与 build-data.ts 一致：fill_blank / calculation 走数字键盘 */
const NUMERIC_ANSWER_RE = /^[0-9./-]+$/;

/**
 * 讲解里残留「模型在跟自己商量」的措辞。只查 explanation，
 * 因为题干/选项里「请输入 1 代表男」「抱歉没按时还」这类是正常内容。
 */
const SELF_TALK_RE =
  /此处逻辑|更正为|重新命题|重新读题|题目应问|修正题目|修正题意|修正：|不符口诀|？不对|知识点确认|由于无法|系统限制|新题：|换题：|重新设定|此处应为/;

interface Issue {
  file: string;
  kind: string;
  detail: string;
}

const errors: Issue[] = [];
const warnings: Issue[] = [];
const skip = (file: string, kind: string, detail: string) => warnings.push({ file, kind, detail });
const err = (file: string, kind: string, detail: string) => errors.push({ file, kind, detail });

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/，/g, ",")
    .replace(/。/g, ".")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/：/g, ":");
}

const stripPrefix = (t: string) => t.replace(/^[A-Da-d][.、]\s*/, "");

interface Stat {
  books: number;
  quizFiles: number;
  unitTestQuestions: number;
  examQuestions: number;
  errors: number;
  warnings: number;
}

type AudioChecker = (file: string, ref: string | null | undefined, where: string) => void;

// ============================================================
// 音频引用
// ============================================================

interface AudioProbe {
  check: AudioChecker;
  missing: Array<{ file: string; where: string; ref: string }>;
  refs: number;
}

function makeAudioProbe(audioPresent: boolean): AudioProbe {
  const probe: AudioProbe = { check: () => {}, missing: [], refs: 0 };
  const existsCache = new Map<string, boolean>();

  probe.check = (file, ref, where) => {
    if (ref == null || ref === "") return;
    probe.refs++;
    if (typeof ref !== "string" || !ref.startsWith("/audio/")) {
      err(file, "audio_ref_shape", `${where}: ${JSON.stringify(ref)}`);
      return;
    }
    if (!/\.(mp3|opus)$/.test(ref)) {
      err(file, "audio_ref_ext", `${where}: ${ref}`);
      return;
    }
    if (!audioPresent) return; // 媒体走 Release 分发，未下载时只校验引用格式
    const abs = path.join(WEB_PUBLIC, ref.replace(/^\//, ""));
    let ok = existsCache.get(abs);
    if (ok === undefined) {
      ok = existsSync(abs);
      existsCache.set(abs, ok);
    }
    if (!ok) probe.missing.push({ file, where, ref });
  };
  return probe;
}

function checkAudioField(
  file: string,
  audio: Record<string, unknown> | undefined,
  check: AudioChecker,
) {
  if (!audio) return;
  for (const [slot, val] of Object.entries(audio)) {
    if (Array.isArray(val)) {
      val.forEach((item, i) => check(file, item as string | null, `audio.${slot}[${i}]`));
    } else {
      check(file, val as string | null, `audio.${slot}`);
    }
  }
}

// ============================================================
// 题级校验
// ============================================================

function validateQuestion(
  file: string,
  q: any,
  seenIds: Map<number, string>,
  kpSet: Set<string>,
  glyphChars: Set<string>,
  check: AudioChecker,
): number {
  const label = `q${q?.id ?? "?"}(${q?.type ?? "?"})`;
  const where = (field: string) => `${label} ${field}`;

  if (typeof q.id !== "number" || !Number.isInteger(q.id) || q.id < 1) {
    err(file, "q_bad_id", `${where("id")} = ${JSON.stringify(q.id)}`);
  } else {
    const dup = seenIds.get(q.id);
    if (dup) err(file, "q_duplicate_id", `${label} 与 ${dup} 同 id`);
    else seenIds.set(q.id, label);
  }

  if (!QUESTION_TYPES.has(q.type)) {
    err(file, "q_unknown_type", `${where("type")} = ${JSON.stringify(q.type)}`);
    return 0;
  }
  if (typeof q.question !== "string" || q.question.trim() === "") {
    err(file, "q_empty_stem", label);
  }
  // KaTeX 只认完整宏名；生成管线把 \times 拆成 TAB+imes 时，题干会渲染成乱码
  for (const [field, text] of [
    ["question", q.question],
    ["explanation", q.explanation],
  ] as const) {
    if (typeof text !== "string") continue;
    const bad = latexBroken(text);
    if (bad) err(file, "q_latex_broken", `${label} ${field} ${bad}：${JSON.stringify(text.slice(0, 60))}`);
    for (const span of mathSpans(text)) {
      const why = mathRenderError(span);
      if (why) err(file, "q_math_unrenderable", `${label} ${field} $${span}$ → ${why}`);
    }
  }
  if (typeof q.explanation !== "string" || q.explanation.trim() === "") {
    skip(file, "q_empty_explanation", label);
  } else {
    // 生成模型把「自我纠错」的碎碎念留在了讲解里，孩子读到的是「？不对，重新算」
    const m = SELF_TALK_RE.exec(q.explanation);
    if (m) skip(file, "q_explanation_selftalk", `${label} 讲解残留生成过程「${m[0]}」：${q.explanation.slice(0, 40)}`);
  }
  if (typeof q.knowledge_point !== "string" || q.knowledge_point.trim() === "") {
    // build-data 会 fallback 到「其他」分组，属于静默降级
    skip(file, "q_missing_knowledge_point", label);
  } else {
    kpSet.add(q.knowledge_point);
  }
  if (typeof q.difficulty !== "number" || q.difficulty < 1 || q.difficulty > 5) {
    err(file, "q_bad_difficulty", `${where("difficulty")} = ${JSON.stringify(q.difficulty)}`);
  }
  if (typeof q.score !== "number" || !(q.score > 0)) {
    skip(file, "q_bad_score", `${where("score")} = ${JSON.stringify(q.score)}`);
  }

  const options = Array.isArray(q.options) ? q.options : [];
  switch (q.type) {
    case "choice": {
      if (options.length < 2) {
        err(file, "choice_options_lt_2", `${label} options=${options.length}`);
        break;
      }
      if (options.some(o => typeof o !== "string" || o.trim() === "")) {
        err(file, "choice_empty_option", `${label} options=${JSON.stringify(options)}`);
      }
      // 判重只看**大小写敏感**的正文：英语「Which sentence is written correctly?」
      // 的选项本就靠 I like / i Like 的大小写区分，折叠大小写会误杀整类题。
      const dedupeKey = (t: string) => stripPrefix(String(t)).trim().replace(/\s+/g, " ");
      const norm = options.map(dedupeKey);
      const dupKeys = new Set(norm.filter((v, i) => norm.indexOf(v) !== i));

      // 与前端同一套映射规则：答案文本命中某选项，或是合法位置字母
      const letter = correctChoiceLetter(q as any);
      if (letter === null) {
        err(
          file,
          "choice_answer_unmatched",
          `${label} answer=${JSON.stringify(q.answer)} 既不是选项原文也不是 A-${String.fromCharCode(64 + options.length)}`,
        );
      } else if (/^[A-Da-d][.、]?$/.test(String(q.answer).trim())) {
        skip(file, "choice_answer_is_label", `${label} answer 用位置字母，改内容更安全`);
      } else if (options.length > 4) {
        err(file, "choice_more_than_4", `${label} options=${options.length}，UI 只支持 A-D`);
      }

      if (dupKeys.size) {
        // 正确答案那一项重复 = 屏上有两个都算对的按钮，孩子点哪个都得分 → 硬伤；
        // 只是干扰项重复，答案仍唯一，先降级为警告，等排期重出选项。
        const firstDup = norm.indexOf([...dupKeys][0]);
        const detail = `${label} 「${options[firstDup]}」重复`;
        const correctIdx = letter ? letter.charCodeAt(0) - 65 : -1;
        const correctDup = correctIdx >= 0 && dupKeys.has(dedupeKey(String(options[correctIdx])));
        if (correctDup) err(file, "choice_duplicate_correct_option", detail);
        else skip(file, "choice_duplicate_option", detail);
      }
      break;
    }

    case "true_false": {
      const a = String(q.answer ?? "").trim();
      const known = TRUE_VALUES.has(a) || FALSE_VALUES.has(a) || TRUE_VALUES.has(normalize(a)) || FALSE_VALUES.has(normalize(a));
      if (!known) err(file, "true_false_bad_answer", `${label} answer=${JSON.stringify(q.answer)}`);
      if (options.length) skip(file, "true_false_has_options", `${label} 判断题带选项`);
      break;
    }

    case "fill_blank":
    case "fill_blank_text": {
      const a = String(q.answer ?? "").trim();
      if (a === "") {
        err(file, "fill_blank_empty_answer", label);
        break;
      }
      if (q.type === "fill_blank" && !NUMERIC_ANSWER_RE.test(a)) {
        // 数字键盘打不出汉字答案，build-data 会改派 fill_blank_text；源头就该标对
        skip(file, "fill_blank_non_numeric_answer", `${label} answer=${JSON.stringify(q.answer)} 将被改派为文字输入`);
      }
      if (q.type === "fill_blank_text" && NUMERIC_ANSWER_RE.test(a)) {
        skip(file, "fill_blank_text_numeric_answer", `${label} 纯数字答案建议用 fill_blank 键盘`);
      }
      if (options.length) skip(file, "fill_blank_has_options", `${label} 填空题带选项`);
      break;
    }

    case "calculation": {
      const a = String(q.answer ?? "").trim();
      if (a === "") {
        err(file, "calculation_empty_answer", label);
        break;
      }
      const checked = checkArithmetic(q.question ?? "", a);
      if (checked.status === "mismatch") {
        err(
          file,
          "calculation_answer_wrong",
          `${label} 「${checked.expr}」算得 ${checked.value}，answer=${JSON.stringify(q.answer)}`,
        );
      } else if (checked.status === "negative") {
        err(file, "calculation_negative_result", `${label} 「${checked.expr}」中间/最终结果为负数，超出小学范围`);
      }
      break;
    }

    case "matching": {
      const pairs = String(q.answer ?? "").trim();
      if (options.length < 2 || options.length % 2 !== 0) {
        err(file, "matching_bad_option_count", `${label} options=${options.length}（应为左/右偶数）`);
        break;
      }
      const half = options.length / 2;
      const parsed = pairs.split(/[,，]\s*/).map(s => s.trim()).filter(Boolean);
      const lefts = new Set<string>();
      const rights = new Set<string>();
      let shapeOk = true;
      for (const p of parsed) {
        const m = /^([A-Da-d])[-→>](\d+)$/.exec(p);
        if (!m) {
          shapeOk = false;
          break;
        }
        lefts.add(m[1].toUpperCase());
        rights.add(m[2]);
      }
      if (!shapeOk) {
        err(file, "matching_answer_shape", `${label} answer=${JSON.stringify(q.answer)} 应为 "A-2,B-3,…"`);
        break;
      }
      const expectLeft = options.slice(0, half).map((_, i) => String.fromCharCode(65 + i));
      if (lefts.size !== half || expectLeft.some(l => !lefts.has(l))) {
        err(file, "matching_left_labels", `${label} 左侧应覆盖 ${expectLeft.join("/")}`);
      }
      const expectRight = options.slice(half).map((_, i) => String(i + 1));
      if (rights.size !== half || expectRight.some(r => !rights.has(r))) {
        err(file, "matching_right_indices", `${label} 右侧应覆盖 1..${half}`);
      }
      break;
    }

    case "word_order": {
      const tokens = String(q.answer ?? "").split(/[,，]/).map(s => s.trim()).filter(Boolean);
      if (!tokens.length) {
        err(file, "word_order_empty_answer", label);
        break;
      }
      const a = tokens.map(normalize).sort();
      const b = options.map(o => normalize(stripPrefix(String(o)))).sort();
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
        err(
          file,
          "word_order_tokens_mismatch",
          `${label} 答案词块与选项不一致 answer=${JSON.stringify(q.answer)} options=${JSON.stringify(options)}`,
        );
      }
      break;
    }

    case "writing": {
      const w = q.writing ?? {};
      const char = String(w.char ?? "");
      if (char === "") {
        err(file, "writing_missing_char", label);
        break;
      }
      if (String(w.pinyin ?? "").trim() === "") skip(file, "writing_missing_pinyin", `${label} 「${char}」`);
      if (w.mode !== "trace" && w.mode !== "whole") {
        err(file, "writing_bad_mode", `${label} mode=${JSON.stringify(w.mode)}`);
      }
      const th = Number(w.threshold);
      if (!(th > 0 && th <= 1)) err(file, "writing_bad_threshold", `${label} threshold=${JSON.stringify(w.threshold)}`);
      if (!glyphChars.has(char)) err(file, "writing_glyph_missing", `${label} 「${char}」无字形文件`);
      break;
    }
  }

  checkAudioField(file, q.audio, check);
  return 1;
}

/**
 * 自洽校验小学算式：`$3 + 4 = ?$` / `$20 \times 20 - 15 \times 15$`。
 * 先算乘除再算加减（同级从左到右），否则混合运算会被误判成错题。
 * 返回 ok / mismatch / negative / unknown（无法解析或含非数字语言时 unknown）。
 */
function checkArithmetic(
  question: string,
  answer: string,
): { status: "ok" | "mismatch" | "negative" | "unknown"; expr?: string; value?: number } {
  // 题干里常有「一个平角是 $180$ 度」这类孤立数字片段，只有带等号（其次带运算符）的才是算式
  const spans = [...question.matchAll(/\$([^$]+)\$/g)].map(m => m[1]);
  const hasOp = (s: string) => /[+\-×÷]|\\times|\\div/.test(s);
  const picked = spans.find(s => s.includes("=")) ?? spans.find(hasOp) ?? (spans.length ? null : question);
  if (picked === null) return { status: "unknown", expr: "" };
  const raw = picked
    .replace(/×/g, "×")
    .replace(/÷/g, "÷")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\text\s*\{\s*\(divide\)\s*\}/g, "÷")
    .replace(/\\frac|\\cdot/g, "")
    .replace(/=\s*[?？]\s*$/, "")
    .trim();
  // 含分数 / 汉字单位等无法机械求值的，交给别的规则
  if (!/^[\d.\s+\-×÷()]+$/u.test(raw)) return { status: "unknown", expr: raw };

  const tokens = raw.match(/\d+(?:\.\d+)?|[+\-×÷()]/g);
  if (!tokens || tokens.length === 0) return { status: "unknown", expr: raw };

  let pos = 0;
  let sawNegative = false;
  let unparsable = false;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function factor(): number | null {
    const t = next();
    if (t === undefined) {
      unparsable = true;
      return null;
    }
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t === "(") {
      const v = expr();
      if (next() !== ")") unparsable = true;
      return v;
    }
    unparsable = true;
    return null;
  }

  function term(): number | null {
    let acc = factor();
    while (acc !== null && (peek() === "×" || peek() === "÷")) {
      const op = next();
      const rhs = factor();
      if (rhs === null) return null;
      if (op === "×") acc *= rhs;
      else {
        if (rhs === 0) {
          unparsable = true;
          return null;
        }
        // 整数才要求整除（小学题不出现除不尽）；小数只需能算，浮点误差在下面统一收口
        if (Number.isInteger(acc) && Number.isInteger(rhs) && acc % rhs !== 0) {
          unparsable = true;
          return null;
        }
        acc /= rhs;
      }
    }
    return acc;
  }

  function expr(): number | null {
    let acc = term();
    while (acc !== null && (peek() === "+" || peek() === "-")) {
      const op = next();
      const rhs = term();
      if (rhs === null) return null;
      acc = op === "+" ? acc + rhs : acc - rhs;
      if (acc < 0) sawNegative = true;
    }
    return acc;
  }

  const raw0 = expr();
  if (pos !== tokens.length || raw0 === null || unparsable) return { status: "unknown", expr: raw };
  // 0.1+0.2 一类浮点噪声会伪装成「算错」，按 10 位小数收口
  const value = Math.round(raw0 * 1e10) / 1e10;
  if (sawNegative) return { status: "negative", expr: raw, value };

  const want = answer.replace(/^\+/, "").trim();
  if (String(value) === want) return { status: "ok", expr: raw, value };
  const numWant = Number(want);
  const ok = Number.isFinite(numWant) && numWant === value;
  return { status: ok ? "ok" : "mismatch", expr: raw, value };
}

/** LaTeX 宏被生成管线拆坏（`\times` → TAB+“imes”）会让前端渲染出乱码 */
function latexBroken(text: string): string | null {
  if (/\t/.test(text)) return "含制表符，\\times 一类宏会被拆坏";
  const orphan = /(^|[^\\\w])(imes|rac|ext)\b/.exec(text);
  return orphan ? `疑似残缺宏「${orphan[2]}」` : null;
}

/** 抽出题干/讲解里的 `$...$` 数学片段 */
function mathSpans(text: string): string[] {
  return [...text.matchAll(/\$([^$]+)\$/g)].map(m => m[1]);
}

/**
 * 用前端同款 KaTeX 试渲染：不报错才算孩子看得见。
 * strict=false 只关掉字号/符号一类的告警，判定仍只看会不会抛错（react-katex 会把抛错渲染成红字）。
 * KaTeX 对 ○□π 这类无度量的字符仍会 console.warn，17k 题会把 CI 日志刷满，这里临时静音。
 */
function mathRenderError(span: string): string | null {
  const warn = console.warn;
  console.warn = () => {};
  try {
    katex.renderToString(span, { throwOnError: true, strict: false });
    return null;
  } catch (e) {
    return String((e as Error).message).replace("KaTeX parse error: ", "").split(" at position")[0];
  } finally {
    console.warn = warn;
  }
}


// ============================================================
// 字形版本锁（P0-3）
// ============================================================

interface GlyphLock {
  schema?: number;
  source?: {
    name?: string;
    version?: string;
    integrity?: string;
    tarball?: string;
    license?: string;
  };
  derived?: {
    generator?: string;
    algorithm?: string;
    glyphCount?: number;
    totalStrokes?: number;
    files?: Record<string, { sha256?: string; strokes?: number }>;
  };
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** 生成器里的 DATA_PKG = "hanzi-writer-data@2.0.1" 是取数版本的唯一真源 */
async function readGeneratorPin(): Promise<string | null> {
  const gen = path.join(REPO_ROOT, "scripts", "writing", "generate_writing_data.py");
  if (!existsSync(gen)) return null;
  const m = /^DATA_PKG\s*=\s*["']([^"']+)["']/m.exec(await readFile(gen, "utf8"));
  return m ? m[1] : null;
}

async function validateGlyphLock(): Promise<Set<string>> {
  const chars = new Set<string>();
  if (!existsSync(GLYPH_DIR)) {
    err("apps/web/public/writing/glyphs", "glyph_dir_missing", "写字科目依赖此目录，缺失则笔顺练习全挂");
    return chars;
  }
  const files = (await readdir(GLYPH_DIR)).filter(f => f.endsWith(".json"));
  for (const f of files) chars.add(f.replace(/\.json$/, ""));

  if (!existsSync(GLYPH_LOCK)) {
    err(GLYPH_LOCK, "glyph_lock_missing", "运行 npm run lock:glyphs 生成后提交");
    return chars;
  }
  let lock: GlyphLock;
  try {
    lock = JSON.parse(await readFile(GLYPH_LOCK, "utf8"));
  } catch (e) {
    err(GLYPH_LOCK, "glyph_lock_parse_error", String((e as Error).message));
    return chars;
  }

  const src = lock.source ?? {};
  if (!src.name || !src.version || !src.integrity) {
    err(GLYPH_LOCK, "glyph_lock_incomplete", "source.name / version / integrity 必填");
  }
  const pin = await readGeneratorPin();
  if (pin && src.name && src.version && pin !== `${src.name}@${src.version}`) {
    err(
      GLYPH_LOCK,
      "glyph_source_pin_drift",
      `生成器取 ${pin}，锁记录的是 ${src.name}@${src.version} —— 版本变了必须重新 lock`,
    );
  }

  const lockFiles = lock.derived?.files ?? {};
  const pathByChar = new Map<string, string>();
  for (const f of files) pathByChar.set(f.replace(/\.json$/, ""), path.join(GLYPH_DIR, f));
  const unlocked = new Set(pathByChar.keys());

  let strokeTotal = 0;
  for (const [char, entry] of Object.entries(lockFiles)) {
    const p = pathByChar.get(char);
    if (!p) {
      err(GLYPH_LOCK, "glyph_char_missing", `锁里有「${char}」但 glyphs/ 下没有（被删/换机器未重建）`);
      continue;
    }
    unlocked.delete(char);
    const now = await sha256(p);
    if (now !== entry.sha256) {
      err(GLYPH_LOCK, "glyph_hash_drift", `「${char}」笔顺数据与锁不一致（上游数据或本地改动）`);
    }
    strokeTotal += Number(entry.strokes ?? 0);
  }
  for (const char of unlocked) {
    err(GLYPH_LOCK, "glyph_char_unlocked", `「${char}」不在版本锁里，来源不可追溯`);
  }
  if (lock.derived?.glyphCount !== undefined && lock.derived.glyphCount !== files.length) {
    err(GLYPH_LOCK, "glyph_count_mismatch", `lock=${lock.derived.glyphCount} actual=${files.length}`);
  }
  if (lock.derived?.totalStrokes !== undefined && lock.derived.totalStrokes !== strokeTotal) {
    err(GLYPH_LOCK, "glyph_stroke_total_mismatch", `lock=${lock.derived.totalStrokes} actual=${strokeTotal}`);
  }

  // 结构自检：strokes 与 medians 必须一一对应且与锁记录的笔画数一致
  for (const [char, p] of pathByChar.entries()) {
    try {
      const g = JSON.parse(await readFile(p, "utf8"));
      const s = Array.isArray(g.strokes) ? g.strokes.length : 0;
      const md = Array.isArray(g.medians) ? g.medians.length : 0;
      if (s === 0 || s !== md) {
        err(p, "glyph_strokes_medians_mismatch", `strokes=${s} medians=${md}`);
      } else if (lockFiles[char]?.strokes !== undefined && lockFiles[char]!.strokes !== s) {
        err(p, "glyph_stroke_count_drift", `笔画数 ${s} 与锁记录的 ${lockFiles[char]!.strokes} 不符`);
      }
    } catch (e) {
      err(p, "glyph_parse_error", String((e as Error).message));
    }
  }
  return chars;
}

// ============================================================
// 学科遍历
// ============================================================

const STEM_GRADE_RE = /一年级(上|下)册|二年级(上|下)册|三年级(上|下)册|四年级(上|下)册|五年级(上|下)册|六年级(上|下)册/;

/**
 * 从中英文教材名里解析年级 + 册别：
 *   「三年级上册」 / "PEP Primary English Grade 3 Volume 1" / "Book 5A" / "(3A)"
 * Volume 1 与 A 记为上册，Volume 2 与 B 记为下册（PEP 教材的既有写法）。
 */
function parseGradeSemester(text: string): { grade: number; semester: "up" | "down" } | null {
  const cn = /([一二三四五六])年级\s*(上|下)册/.exec(text);
  if (cn) {
    return { grade: "一二三四五六".indexOf(cn[1]) + 1, semester: cn[2] === "上" ? "up" : "down" };
  }
  // "PEP Primary English Book 6 (Grade 5 Volume 2)" 里 Book 是册序、Grade 才是年级，故 Grade 优先
  const en =
    /grade\s*(\d)(?:\s*\(?([AB])\)?)?/i.exec(text) ??
    /book\s*(\d)(?:\s*([AB]))?/i.exec(text) ??
    /\(?(\d)([AB])\)?/.exec(text);
  if (!en) return null;
  const grade = Number(en[1]);
  if (!Number.isInteger(grade) || grade < 1 || grade > 6) return null;
  const letter =
    en[2] ?? (/volume\s*1\b/i.test(text) ? "A" : /volume\s*2\b/i.test(text) ? "B" : undefined);
  if (!letter) return null;
  return { grade, semester: letter.toUpperCase() === "A" ? "up" : "down" };
}

async function validateSubject(subject: string, check: AudioChecker, glyphChars: Set<string>): Promise<Stat> {
  const dir = path.join(OUTPUT_ROOT, subject);
  const outlineDir = path.join(dir, "outlines");
  const quizDir = path.join(dir, "quizzes");
  const stat: Stat = { books: 0, quizFiles: 0, unitTestQuestions: 0, examQuestions: 0, errors: 0, warnings: 0 };
  const eBefore = errors.length;
  const wBefore = warnings.length;

  if (!existsSync(outlineDir)) {
    skip(dir, "subject_no_outlines", "该学科没有 outlines/，前端不会出书");
    return stat;
  }
  if (!existsSync(quizDir)) {
    err(dir, "subject_no_quizzes", "有 outlines 但没有 quizzes，全部题库会静默缺失");
    return stat;
  }

  const outlineFiles = (await readdir(outlineDir)).filter(f => f.endsWith(".json"));
  const quizFiles = (await readdir(quizDir)).filter(f => f.endsWith(".json"));
  const quizByName = new Set(quizFiles);
  const usedBookIds = new Map<string, string>();
  stat.books = outlineFiles.length;
  stat.quizFiles = quizFiles.length;

  const claimedQuizFiles = new Set<string>();

  for (const outlineFile of outlineFiles) {
    const stem = outlineFile.replace(/\.json$/, "");
    const outlinePath = `output/${subject}/outlines/${outlineFile}`;

    let outline: any;
    try {
      outline = JSON.parse(await readFile(path.join(outlineDir, outlineFile), "utf8"));
    } catch (e) {
      err(outlinePath, "outline_parse_error", String((e as Error).message));
      continue;
    }
    if (!STEM_GRADE_RE.test(stem)) {
      // build-data 的 parseStem 认不出这种文件名 → 整本书静默不产出
      err(outlinePath, "outline_stem_unrecognized", "文件名不含「X年级上/下册」，构建会跳过整本教材");
    }
    const gradeMatch = /([一二三四五六])年级(上|下)册/.exec(stem);
    const stemGrade = gradeMatch
      ? {
          grade: "一二三四五六".indexOf(gradeMatch[1]) + 1,
          semester: gradeMatch[2] === "上" ? ("up" as const) : ("down" as const),
        }
      : null;
    if (stemGrade) {
      const bookId = subject === "math" ? `g${stemGrade.grade}${stemGrade.semester}` : `${subject}-g${stemGrade.grade}${stemGrade.semester}`;
      const prev = usedBookIds.get(bookId);
      if (prev) err(outlinePath, "bookid_conflict", `${bookId} 已被 ${prev} 占用，两本教材会互相覆盖`);
      else usedBookIds.set(bookId, outlineFile);
    }
    if (!Array.isArray(outline.units) || outline.units.length === 0) {
      err(outlinePath, "outline_no_units", "units 为空，前端没有可学的课");
      continue;
    }
    if (typeof outline.textbook !== "string" || !outline.textbook.trim()) {
      err(outlinePath, "outline_missing_textbook", "textbook 字段缺失");
    }
    const unitNumbers = new Set<number>();
    for (const unit of outline.units) {
      if (typeof unit.unit_number !== "number") {
        err(outlinePath, "unit_missing_number", `「${unit.title}」没有 unit_number，无法配对题库`);
        continue;
      }
      if (unitNumbers.has(unit.unit_number)) {
        err(outlinePath, "unit_number_duplicate", `unit_number=${unit.unit_number} 出现两次`);
      }
      unitNumbers.add(unit.unit_number);
      if (!String(unit.title ?? "").trim()) err(outlinePath, "unit_missing_title", `unit ${unit.unit_number}`);
      if (!Array.isArray(unit.knowledge_points) || unit.knowledge_points.length === 0) {
        skip(outlinePath, "unit_no_knowledge_points", `unit ${unit.unit_number}`);
      }

      const quizName = `${stem}_unit${unit.unit_number}.json`;
      const quizPath = path.join(quizDir, quizName);
      const quizRel = `output/${subject}/quizzes/${quizName}`;
      if (!quizByName.has(quizName)) {
        err(outlinePath, "quiz_file_missing", `单元「${unit.title}」缺题库文件 ${quizName}（构建只会 warn 后跳过）`);
        continue;
      }
      claimedQuizFiles.add(quizName);

      let quiz: any;
      try {
        quiz = JSON.parse(await readFile(quizPath, "utf8"));
      } catch (e) {
        err(quizRel, "quiz_parse_error", String((e as Error).message));
        continue;
      }
      // outline.textbook 用中文短名（「三年级上册」），quiz.textbook 各科写法不一
      // （「统编版小学语文三年级上册」/ "PEP Primary English Grade 3 Volume 1"）。
      // 直接比字符串必然误报，改成解析出年级+册别后比对：只在**真的串了书**时报错。
      if (typeof quiz.textbook !== "string" || !quiz.textbook.trim()) {
        err(quizRel, "quiz_missing_textbook", "textbook 字段为空");
      } else if (stemGrade) {
        const qs = parseGradeSemester(quiz.textbook);
        if (qs && (qs.grade !== stemGrade.grade || qs.semester !== stemGrade.semester)) {
          err(
            quizRel,
            "quiz_textbook_mismatch",
            `quiz.textbook="${quiz.textbook}" 解析为 ${qs.grade}年级${qs.semester === "up" ? "上" : "下"}册，与文件名 ${stemGrade.grade}年级${stemGrade.semester === "up" ? "上" : "下"}册 不符`,
          );
        }
      }
      if (unit.title && quiz.unit && quiz.unit !== unit.title) {
        skip(quizRel, "quiz_unit_title_mismatch", `quiz="${quiz.unit}" outline="${unit.title}"`);
      }

      const seenIds = new Map<number, string>();
      const kpSet = new Set<string>();
      const summaryPoints = new Set<string>(
        (Array.isArray(quiz.knowledge_summary) ? quiz.knowledge_summary : []).map((k: any) => k?.point),
      );
      if (!Array.isArray(quiz.knowledge_summary) || quiz.knowledge_summary.length === 0) {
        skip(quizRel, "quiz_no_knowledge_summary", "知识小结为空，课后回顾没有内容");
      }

      const parts: Array<["unit_test" | "exam", number]> = [["unit_test", 0], ["exam", 0]];
      for (const [part] of parts) {
        const block = quiz[part];
        if (!block || !Array.isArray(block.questions)) {
          if (part === "unit_test") err(quizRel, "unit_test_missing", "unit_test.questions 缺失");
          else skip(quizRel, "exam_missing", "无 exam，本单元不出挑战课");
          continue;
        }
        const qs = block.questions;
        if (part === "unit_test") stat.unitTestQuestions += qs.length;
        else stat.examQuestions += qs.length;

        if (part === "unit_test") {
          if (qs.length < HARD_MIN_QUESTIONS) {
            err(quizRel, "unit_test_too_few", `${qs.length} 题 < 硬下限 ${HARD_MIN_QUESTIONS}（cleanup 删坏了？）`);
          } else if (qs.length < TARGET_MIN_QUESTIONS) {
            skip(quizRel, "unit_test_below_target", `${qs.length} 题 < 目标 ${TARGET_MIN_QUESTIONS}`);
          }
        } else if (qs.length < EXAM_MIN_QUESTIONS) {
          skip(quizRel, "exam_too_few", `${qs.length} 题 < ${EXAM_MIN_QUESTIONS}，挑战课不会产出`);
        }

        const ids = new Map<number, string>();
        for (const q of qs) validateQuestion(quizRel, q, ids, kpSet, glyphChars, check);
        for (const v of ids.values()) void v;
      }
      void seenIds;

      for (const kp of kpSet) {
        if (!summaryPoints.has(kp)) {
          skip(quizRel, "knowledge_point_not_summarized", `「${kp}」在知识小结里找不到`);
        }
      }
    }
  }

  for (const quizName of quizFiles) {
    if (claimedQuizFiles.has(quizName)) continue;
    const rel = `output/${subject}/quizzes/${quizName}`;
    const m = /^(.*)_unit(\d+)\.json$/.exec(quizName);
    if (!m) {
      err(rel, "quiz_orphan_name", "文件名不符合 <教材>_unit<N>.json，构建不会读取");
      continue;
    }
    if (!outlineFiles.includes(`${m[1]}.json`)) {
      err(rel, "quiz_orphan_outline", `找不到对应 outline：${m[1]}.json`);
    } else {
      err(rel, "quiz_orphan_unit", `outline 里没有 unit_number=${m[2]}，这套题会上不了线`);
    }
  }

  stat.errors = errors.length - eBefore;
  stat.warnings = warnings.length - wBefore;
  return stat;
}

// ============================================================
// 写字科目：outline 生字表 ↔ glyphs ↔ quiz 三方一致
// ============================================================

async function validateWritingGlyphCoverage(glyphChars: Set<string>) {
  const quizDir = path.join(OUTPUT_ROOT, "writing", "quizzes");
  if (!existsSync(quizDir)) return;
  const rel = "output/writing/quizzes";
  for (const f of (await readdir(quizDir)).filter(x => x.endsWith(".json"))) {
    const quiz = JSON.parse(await readFile(path.join(quizDir, f), "utf8"));
    for (const part of ["unit_test", "exam"] as const) {
      for (const q of quiz[part]?.questions ?? []) {
        const char = String(q?.writing?.char ?? "");
        if (char && !glyphChars.has(char)) {
          err(`${rel}/${f}`, "writing_glyph_missing", `「${char}」笔顺数据缺失（q${q.id}）`);
        }
      }
    }
  }
}

// ============================================================
// main
// ============================================================

async function main() {
  const argv = process.argv.slice(2);
  const jsonIdx = argv.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : undefined;
  const noAudio = argv.includes("--no-audio-check");

  if (!existsSync(OUTPUT_ROOT)) {
    console.error(`✗ 找不到内容源目录 ${path.relative(REPO_ROOT, OUTPUT_ROOT)}/`);
    process.exit(1);
  }
  const present = (await readdir(OUTPUT_ROOT)).filter(d => existsSync(path.join(OUTPUT_ROOT, d, "quizzes")));
  for (const s of present) {
    if (!SUBJECTS.includes(s)) err(`output/${s}`, "subject_not_registered", "前端学科表里没有这个目录");
  }
  for (const s of SUBJECTS) {
    if (!present.includes(s)) err(`output/${s}`, "subject_missing", "学科已注册但没有数据");
  }

  const audioPresent = !noAudio && existsSync(AUDIO_ROOT);
  const audio = makeAudioProbe(audioPresent);
  const glyphChars = await validateGlyphLock();

  const stats = new Map<string, Stat>();
  for (const s of SUBJECTS) {
    if (!present.includes(s)) continue;
    stats.set(s, await validateSubject(s, audio.check, glyphChars));
  }
  await validateWritingGlyphCoverage(glyphChars);

  if (audioPresent && audio.missing.length) {
    for (const m of audio.missing) err(m.file, "audio_file_missing", `${m.where} -> ${m.ref}`);
  } else if (!audioPresent) {
    skip("apps/web/public/audio", "audio_check_skipped", `媒体未下载，${audio.refs} 条引用只校验了路径格式`);
  }

  const totalQ = [...stats.values()].reduce((a, s) => a + s.unitTestQuestions + s.examQuestions, 0);
  const tableHeader = "学科        书  题库  单元题  挑战题  error  warn";
  console.log(tableHeader);
  for (const [s, st] of stats) {
    console.log(
      `${s.padEnd(11)} ${String(st.books).padStart(2)}  ${String(st.quizFiles).padStart(4)}  ` +
        `${String(st.unitTestQuestions).padStart(6)}  ${String(st.examQuestions).padStart(6)}  ` +
        `${String(st.errors).padStart(5)}  ${String(st.warnings).padStart(4)}`,
    );
  }
  console.log(
    `\n音频引用 ${audio.refs} 条（${audioPresent ? "已校验文件存在性" : "跳过存在性"}）｜字形 ${glyphChars.size} 个｜题目合计 ${totalQ}`,
  );

  const byKind = (list: Issue[]) => {
    const out: Record<string, number> = {};
    for (const i of list) out[i.kind] = (out[i.kind] || 0) + 1;
    return out;
  };
  console.log(`\n=== ERROR ${errors.length} ===`);
  console.log(JSON.stringify(byKind(errors), null, 2));
  const shown = new Set<string>();
  for (const e of errors) {
    const key = `${e.kind}|${e.file}`;
    if (shown.has(key)) continue;
    shown.add(key);
    console.log(`· [${e.kind}] ${e.file}: ${e.detail}`);
    if (shown.size >= 40) {
      console.log(`… 其余同类问题见 --json 报告`);
      break;
    }
  }
  console.log(`\n=== WARN ${warnings.length} ===`);
  console.log(JSON.stringify(byKind(warnings), null, 2));
  const warnKinds = new Set<string>();
  for (const w of warnings) {
    if (warnKinds.has(w.kind)) continue;
    warnKinds.add(w.kind);
    console.log(`· [${w.kind}] ${w.file}: ${w.detail}`);
  }

  if (jsonOut) {
    const target = path.isAbsolute(jsonOut) ? jsonOut : path.resolve(process.cwd(), jsonOut);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      JSON.stringify({ generatedAt: new Date().toISOString(), stats: Object.fromEntries(stats), errors, warnings }, null, 2) + "\n",
    );
    console.log(`\n报告已写入 ${path.relative(REPO_ROOT, target)}`);
  }

  if (errors.length) {
    console.log(`\n✗ 数据校验未通过：${errors.length} 个 error`);
    process.exit(1);
  }
  console.log(`\n✓ 数据校验通过（${warnings.length} 个 warning）`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
