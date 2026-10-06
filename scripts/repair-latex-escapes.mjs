#!/usr/bin/env node
/**
 * 修复 output/**.json 里被 JSON 转义吃掉的反斜杠：生成管线把 LaTeX 宏写成单反斜杠
 * （`\times`），JSON.parse 后变成 制表符+"imes"，KaTeX 要么报错要么静默渲染成「imes」。
 * 本脚本只做机械还原（补回反斜杠），不改动任何题目内容；可用 --dry-run 复核。
 * 用法：node scripts/repair-latex-escapes.mjs [--write] [--verbose]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WRITE = process.argv.includes("--write");
const VERBOSE = process.argv.includes("--verbose");

/** 单反斜杠 + 宏名 → 文件里应有的双反斜杠形式 */
const MACRO_FIX = new Map([
  ["\\times", "\\\\times"],
  ["\\text", "\\\\text"],
  ["\\triangle", "\\\\triangle"],
  ["\\theta", "\\\\theta"],
  ["\\to", "\\\\to"],
  ["\\bdiv", "\\\\div"],
  ["\\bdot", "\\\\dot"],
  ["\\bigcirc", "\\\\bigcirc"],
  ["\\bigcap", "\\\\bigcap"],
  ["\\blacksquare", "\\\\blacksquare"],
  ["\\frac", "\\\\frac"],
  ["\\rightarrow", "\\\\rightarrow"],
  ["\\rule", "\\\\rule"],
  ["\\neq", "\\\\neq"],
  ["\\ne", "\\\\ne"],
]);
/** 转义符本身即全部残留（`\b ` 一类游离退格符），删掉即可 */
const DROP = new Set(["\\b"]);
/** 语义已被核对的个别写法：直接给出文件里应出现的最终形式 */
const LITERAL = new Map([
  ["\\text{ \\b \\b }", "\\\\square"],
  ["$24 \\neq 6 = 4$", "$24 \\\\div 6 = 4$"],
  ["\\big竞", "\\\\square"],
]);
const UNICODE_FIX = new Map([
  ["\\u0000", "\\\\div"],
  ["\\u0007", "\\\\times"],
]);
/** `\n`(换行) / `\r`(回车) 后不接字母时是真换行转义，不能动 */
const KEEP = new Set(["\\n", "\\r", '\\"', "\\/", "\\\\"]);

function repair(raw, file) {
  let out = "";
  const hits = new Map();
  for (const [from, to] of LITERAL) {
    if (!raw.includes(from)) continue;
    const n = raw.split(from).length - 1;
    raw = raw.split(from).join(to);
    hits.set(`literal:${from}`, (hits.get(`literal:${from}`) ?? 0) + n);
  }
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== "\\") {
      out += raw[i++];
      continue;
    }
    const two = raw.slice(i, i + 2);
    const uni = raw.slice(i, i + 6);
    if (UNICODE_FIX.has(uni)) {
      out += UNICODE_FIX.get(uni);
      hits.set(uni, (hits.get(uni) ?? 0) + 1);
      i += 6;
      continue;
    }
    if (two === "\\\\") { out += two; i += 2; continue; }
    if (two === "\\u") { out += uni; i += 6; continue; }
    const run = /^[a-zA-Z]*/.exec(raw.slice(i + 2))[0];
    const key = two + run;
    const fixed = MACRO_FIX.get(key) ?? (run === "" && DROP.has(two) ? "" : null);
    if (fixed !== null) {
      out += fixed;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      i += 2 + run.length;
      continue;
    }
    if (run === "" && KEEP.has(two)) { out += two; i += 2; continue; }
    out += raw[i++];
  }
  const unknown = scanEscapes(out).filter((t) => !LEGAL.has(t.slice(0, 2)));
  if (unknown.length) console.error(`  未识别的转义 ${file}: ${[...new Set(unknown)].join(", ")}`);
  return { out, hits, unknown };
}

/** 按 JSON 转义规则逐个扫描反斜杠，避免把 `\\div` 的第二个反斜杠误判成 `\d` */
function scanEscapes(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\") continue;
    if (text[i + 1] === "\\") { i++; continue; }
    if (text[i + 1] === "u") { i += 5; continue; }
    const run = /^[a-zA-Z]*/.exec(text.slice(i + 2))[0];
    found.push(text.slice(i, i + 2 + run.length));
    i += 1 + run.length;
  }
  return found;
}
const LEGAL = new Set(["\\n", "\\r", '\\"', "\\/"]);

function* jsonFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) yield* jsonFiles(p);
    else if (e.endsWith(".json")) yield p;
  }
}

const tally = new Map();
let changedFiles = 0, totalHits = 0, unparseable = 0, reformat = 0;
const outputRoot = path.join(ROOT, "output");
for (const file of jsonFiles(outputRoot)) {
  const raw = readFileSync(file, "utf8");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { console.error(`跳过无法解析的文件 ${file}`); unparseable++; continue; }
  // 回写必须只动反斜杠：先确认本仓库的序列化形式与文件一致，避免格式化噪声混进 diff
  const canonical = JSON.stringify(parsed, null, 2) + (raw.endsWith("\n") ? "\n" : "");
  if (canonical !== raw) { reformat++; continue; }
  const { out, hits, unknown } = repair(raw, path.relative(ROOT, file));
  if (out === raw) continue;
  if (unknown.length) { console.error(`不动有未知转义的文件 ${file}`); continue; }
  changedFiles++;
  for (const [k, v] of hits) {
    tally.set(k, (tally.get(k) ?? 0) + v);
    totalHits += v;
  }
  if (VERBOSE) console.log(`  ${path.relative(ROOT, file)}: ${[...hits.keys()].join(" ")}`);
  if (WRITE) {
    if (!sameShape(JSON.parse(out), parsed)) {
      console.error(`修复后结构变化，拒写 ${file}`);
      changedFiles--;
      continue;
    }
    writeFileSync(file, out);
  }
}

/** 只允许字符串内容变化：键、顺序、数组长度、非字符串取值必须完全一致 */
function sameShape(a, b) {
  if (typeof a !== typeof b) return false;
  if (typeof a === "string") return true;
  if (a === null || typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameShape(v, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameShape(a[k], b[k]));
}
console.log(`${WRITE ? "已写入" : "待写入（dry-run）"}：文件 ${changedFiles} 个，替换 ${totalHits} 处，无法解析 ${unparseable}，序列化形式不一致 ${reformat}`);
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), JSON.stringify(k));
