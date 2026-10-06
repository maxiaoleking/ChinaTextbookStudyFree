/**
 * verify-build-artifacts.ts —— 构建产物完整性检查（P0-4「打 tag 时跑」那一半）
 *
 * 为什么门禁绿灯还不够：validate-data 校验的是**内容源**，而 build-data 对
 * 「parseStem 认不出的文件名」「缺题库的单元」只 warn 后跳过 —— 少产出一整本
 * 教材、或者某节课 questions 是空数组，源侧校验完全看不出来，孩子打开就是白屏。
 * 这个脚本用同一套 bookId 规则从内容源推出**应该产出什么**，再和
 * `apps/web/public/data/` 里**实际有什么**逐本对账。
 *
 * bookId 规则与 validate-data.ts 保持一致（math 不带学科前缀）。万一哪天漂了，
 * 本脚本会以「源侧独有 / 产物侧独有」的形式响亮报错，不会静默放过。
 *
 * 用法：先 `npm run build:data`，再
 *   npx tsx scripts/verify-build-artifacts.ts
 * 退出码：任何一项对不上 → 1。
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const OUTPUT_ROOT = path.join(REPO_ROOT, "output");
const DATA_ROOT = path.join(REPO_ROOT, "apps", "web", "public", "data");
const BOOKS_ROOT = path.join(DATA_ROOT, "books");

const GRADES = "一二三四五六";
const ALWAYS_REQUIRED_FIELDS = ["id", "type", "question"] as const;

type Problem = { check: string; detail: string };
const problems: Problem[] = [];
function fail(check: string, detail: string) {
  problems.push({ check, detail });
}

/** 与 validate-data.ts 同一条规则：从 outline 文件名推 bookId */
function bookIdFromStem(subject: string, stem: string): string | null {
  const m = /([一二三四五六])年级(上|下)册/.exec(stem);
  if (!m) return null;
  const grade = GRADES.indexOf(m[1]) + 1;
  const semester = m[2] === "上" ? "up" : "down";
  return subject === "math" ? `g${grade}${semester}` : `${subject}-g${grade}${semester}`;
}

async function readJson(file: string, label: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    fail("artifact_parse_error", `${label}: ${(e as Error).message}`);
    return null;
  }
}

/** 内容源侧：期望产出哪些书 */
async function expectedBooks(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await readdir(OUTPUT_ROOT, { withFileTypes: true });
  for (const dir of entries.filter((d) => d.isDirectory())) {
    const subject = dir.name;
    const outlineDir = path.join(OUTPUT_ROOT, subject, "outlines");
    if (!existsSync(outlineDir)) continue;
    for (const f of (await readdir(outlineDir)).filter((x) => x.endsWith(".json"))) {
      const id = bookIdFromStem(subject, f.replace(/\.json$/, ""));
      if (id) out.set(id, `output/${subject}/outlines/${f}`);
    }
  }
  return out;
}

async function checkBook(id: string, booksDir: string) {
  const bookDir = path.join(booksDir, id);

  const outline = await readJson(path.join(bookDir, "outline.json"), `books/${id}/outline.json`);
  if (outline && !Array.isArray(outline.units)) fail("outline_no_units", `${id}: outline.json 没有 units 数组`);
  if (outline && Array.isArray(outline.units) && outline.units.length === 0) {
    fail("outline_no_units", `${id}: units 为空数组`);
  }

  const lessonDir = path.join(bookDir, "lessons");
  if (!existsSync(lessonDir)) {
    fail("lessons_dir_missing", `${id}: 没有 lessons/ 目录，这本书无可学的课`);
    return null;
  }
  const files = (await readdir(lessonDir)).filter((f) => f.endsWith(".json"));
  if (!files.length) fail("book_has_no_lessons", `${id}: lessons/ 是空的`);

  let kp = 0;
  let exam = 0;
  for (const f of files) {
    const rel = `books/${id}/lessons/${f}`;
    if (f.endsWith("-exam.json")) exam++;
    else kp++;

    const lesson = await readJson(path.join(lessonDir, f), rel);
    if (!lesson) continue;
    if (lesson.bookId !== id) fail("lesson_wrong_book", `${rel} 里 bookId="${lesson.bookId}"，这本书会被别的教材覆盖`);
    if (!String(lesson.title ?? "").trim()) fail("lesson_missing_title", rel);

    const questions = lesson.questions;
    if (!Array.isArray(questions)) {
      fail("lesson_no_questions_array", `${rel} 缺 questions 数组`);
      continue;
    }
    if (questions.length === 0) fail("lesson_empty", `${rel} 一道题都没有，前端会渲染空卡片`);
    for (const [i, q] of questions.entries()) {
      if (!q || typeof q !== "object") {
        fail("question_not_object", `${rel} q${i + 1} 不是对象`);
        continue;
      }
      const missing: string[] = ALWAYS_REQUIRED_FIELDS.filter((k) => q[k] === undefined || q[k] === null || q[k] === "");
      // 写字题由笔顺判分，答案落在 writing.char；其余题型必须有非空 answer（与源侧契约一致）
      if (q.type === "writing") {
        if (String(q.writing?.char ?? "") === "") missing.push("writing.char");
      } else if (q.answer === undefined || q.answer === null || String(q.answer).trim() === "") {
        missing.push("answer");
      }
      if (missing.length) fail("question_missing_field", `${rel} q${i + 1}(${q.type ?? "?"}) 缺 ${missing.join("/")}`);
    }
  }
  return { kp, exam };
}

async function main() {
  if (!existsSync(OUTPUT_ROOT)) {
    console.error(`✗ 找不到内容源目录 ${path.relative(REPO_ROOT, OUTPUT_ROOT)}/`);
    process.exit(1);
  }
  if (!existsSync(DATA_ROOT)) {
    console.error("✗ 找不到 apps/web/public/data/，请先跑 npm run build:data");
    process.exit(1);
  }

  const index = await readJson(path.join(DATA_ROOT, "index.json"), "index.json");
  if (!index) return finish();
  if (!Array.isArray(index.books)) {
    fail("index_no_books", "index.json 里没有 books 数组");
    return finish();
  }

  // 1) 内容源 ↔ 产物：书目集合必须完全一致（少一本就是整本教材静默消失）
  const expected = await expectedBooks();
  const indexBookIds = new Set<string>(index.books.map((b: any) => String(b.id)));
  for (const [id, src] of expected) {
    if (!indexBookIds.has(id)) fail("book_missing_in_index", `${id}（源 ${src}）没进 index.json，学科页看不见这本教材`);
  }
  for (const id of indexBookIds) {
    if (!expected.has(id)) fail("book_not_in_source", `index.json 里的 ${id} 在 output/ 找不到对应 outline（脏产物？）`);
  }

  // 2) index.books ↔ 磁盘目录：元数据说有、磁盘没有 = 点进去 404
  const booksDir = path.join(DATA_ROOT, "books");
  const diskBooks = existsSync(booksDir)
    ? (await readdir(booksDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  if (!existsSync(booksDir)) fail("books_dir_missing", "apps/web/public/data/books/ 不存在");
  const diskSet = new Set(diskBooks);
  for (const id of indexBookIds) {
    if (!diskSet.has(id)) fail("book_dir_missing", `index 声明了 ${id}，但 books/${id}/ 不存在`);
  }
  for (const id of diskSet) {
    if (!indexBookIds.has(id)) fail("book_dir_orphan", `books/${id}/ 存在但 index.json 未登记`);
  }

  let totalKp = 0;
  let totalExam = 0;
  for (const id of diskBooks) {
    const counts = await checkBook(id, booksDir);
    if (!counts) continue;
    totalKp += counts.kp;
    totalExam += counts.exam;

    // 3) index 元数据 ↔ 磁盘：lessonsCount 只数知识点课，单元挑战另计
    const meta = index.books.find((b: any) => b.id === id);
    if (meta && meta.lessonsCount !== counts.kp) {
      fail("lessons_count_mismatch", `${id}: index.lessonsCount=${meta.lessonsCount}，磁盘 kp 课=${counts.kp}（exam ${counts.exam} 不计入）`);
    }
  }

  if (typeof index.totalLessons === "number" && index.totalLessons !== totalKp) {
    fail("total_lessons_mismatch", `index.totalLessons=${index.totalLessons}，磁盘 kp 课=${totalKp}`);
  }

  console.log(
    `产物对账：教材 ${diskBooks.length} 本｜知识点课 ${totalKp} 节｜单元挑战 ${totalExam} 节｜index 记题目 ${index.totalQuestions} 道`,
  );
  finish();
}

function finish() {
  if (!problems.length) {
    console.log("✓ 构建产物完整（书目、课时、题目字段与 index 元数据全部对上）");
    return;
  }
  const byKind = new Map<string, number>();
  for (const p of problems) byKind.set(p.check, (byKind.get(p.check) ?? 0) + 1);
  console.error(`\n✗ 构建产物有 ${problems.length} 处不一致：`);
  for (const p of problems.slice(0, 40)) console.error(`  · [${p.check}] ${p.detail}`);
  if (problems.length > 40) console.error(`  …另有 ${problems.length - 40} 条`);
  console.error("分类统计:", JSON.stringify(Object.fromEntries(byKind)));
  process.exit(1);
}

main();
