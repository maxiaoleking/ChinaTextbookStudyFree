/** Parse every real displayed formula with KaTeX, including repaired escapes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import katex from "katex";
import { normalizeMathText, splitMathText } from "../../apps/web/src/lib/mathText";

let formulas = 0;
let repaired = 0;
const failures: string[] = [];
function visit(value: unknown, location: string) {
  if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${location}[${i}]`));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => visit(item, `${location}.${key}`));
  else if (typeof value === "string") {
    if (normalizeMathText(value) !== value) repaired++;
    for (const part of splitMathText(value)) {
      if (part.type === "text") continue;
      formulas++;
      try { katex.renderToString(part.value, { throwOnError: true, strict: "ignore" }); }
      catch (err) { failures.push(`${location}: ${JSON.stringify(part.value)} — ${String(err)}`); }
    }
  }
}
const root = path.resolve("apps/web/public/data/books");
for (const book of fs.readdirSync(root)) {
  const lessons = path.join(root, book, "lessons");
  for (const file of fs.readdirSync(lessons)) visit(JSON.parse(fs.readFileSync(path.join(lessons, file), "utf8")), file);
}
assert.equal(normalizeMathText("$0.4\x08dot{8}$"), "$0.4\\dot{8}$");
assert.equal(normalizeMathText("$\x0crac{1}{2}$"), "$\\frac{1}{2}$");
assert.equal(normalizeMathText("Hello\nZoom"), "Hello\nZoom");
assert.equal(splitMathText("\\frac{3}{8} + \\frac{5}{12}").filter(p => p.type === "inline").length, 2);
if (failures.length) console.error(failures.join("\n"));
assert.equal(failures.length, 0, `${failures.length} formula parse errors`);
console.log(`PASS: ${formulas} real formula segments parse with KaTeX; ${repaired} strings repaired without dropping commands.`);
