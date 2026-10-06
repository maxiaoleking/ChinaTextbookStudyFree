/**
 * lock-glyphs.ts —— 生成/更新写字科目的字形版本锁
 *
 * 背景（P0-3）：`apps/web/public/writing/glyphs/*.json` 是
 * `scripts/writing/generate_writing_data.py` 从 npm 包 hanzi-writer-data 派生出来的，
 * 而下载缓存 `.cache/` 被 gitignore。换台机器重建、或有人改了 DATA_PKG 版本号，
 * 笔顺数据可能在无人察觉的情况下变化 —— 孩子学到的是「笔顺」，错了比缺了更糟。
 *
 * 锁文件记录：源包（名称/版本/integrity/许可）+ 每个字形文件的 sha256 与笔画数。
 * `npm run validate:data` 会逐字比对，漂移即报错。
 *
 * 用法：
 *   npm run lock:glyphs                    # 联网取当前版本 integrity
 *   npm run lock:glyphs -- --offline        # 保留已有锁里的 source 字段
 *   npm run lock:glyphs -- --check          # 只比对不写文件（等价于校验里的锁检查）
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const WRITING_DIR = path.join(REPO_ROOT, "apps", "web", "public", "writing");
const GLYPH_DIR = path.join(WRITING_DIR, "glyphs");
const LOCK_PATH = path.join(WRITING_DIR, "glyph-lock.json");
const GENERATOR = path.join(REPO_ROOT, "scripts", "writing", "generate_writing_data.py");

export interface GlyphLockFile {
  schema: 1;
  source: {
    name: string;
    version: string;
    registry: string;
    tarball: string;
    integrity: string;
    license: string;
    derived_from: string[];
  };
  derived: {
    generator: string;
    algorithm: "sha256";
    glyphCount: number;
    totalStrokes: number;
    files: Record<string, { sha256: string; strokes: number }>;
  };
}

/** 从 Python 生成器里读 DATA_PKG，保证锁与真正的取数逻辑同源 */
async function readPinnedPackage(): Promise<{ name: string; version: string }> {
  const src = await readFile(GENERATOR, "utf8");
  const m = /^DATA_PKG\s*=\s*["']([^"']+)@([^"']+)["']/m.exec(src);
  if (!m) throw new Error(`无法从 ${path.relative(REPO_ROOT, GENERATOR)} 解析 DATA_PKG`);
  return { name: m[1], version: m[2] };
}

async function fetchDist(name: string, version: string) {
  const out = await new Promise<string>((resolve, reject) => {
    execFile("npm", ["view", `${name}@${version}`, "dist.integrity", "dist.tarball"], { timeout: 30_000 }, (e, stdout, stderr) => {
      if (e) reject(new Error(`${e.message} ${stderr}`.trim()));
      else resolve(stdout);
    });
  });
  const integrity = /sha\d+-[A-Za-z0-9+/=]+/.exec(out)?.[0];
  const tarball = /https:\/\/\S+\.tgz/.exec(out)?.[0];
  if (!integrity || !tarball) throw new Error(`npm view 输出无法解析 integrity/tarball：\n${out}`);
  return { integrity, tarball };
}

async function currentLock(): Promise<GlyphLockFile | null> {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(await readFile(LOCK_PATH, "utf8")) as GlyphLockFile;
  } catch {
    return null;
  }
}

async function buildLock(offline: boolean): Promise<GlyphLockFile> {
  if (!existsSync(GLYPH_DIR)) throw new Error(`字形目录不存在：${GLYPH_DIR}`);
  const files = (await readdir(GLYPH_DIR)).filter(f => f.endsWith(".json"));
  if (files.length === 0) throw new Error("字形目录为空，拒绝生成空锁");

  const entries: GlyphLockFile["derived"]["files"] = {};
  let totalStrokes = 0;
  const broken: string[] = [];
  for (const f of files.sort()) {
    const char = f.replace(/\.json$/, "");
    const buf = await readFile(path.join(GLYPH_DIR, f));
    let parsed: { strokes?: unknown[]; medians?: unknown[] };
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch (e) {
      broken.push(`${char}: JSON 解析失败 ${(e as Error).message}`);
      continue;
    }
    const strokes = Array.isArray(parsed.strokes) ? parsed.strokes.length : 0;
    const medians = Array.isArray(parsed.medians) ? parsed.medians.length : 0;
    if (strokes === 0 || strokes !== medians) {
      broken.push(`${char}: strokes=${strokes} medians=${medians}`);
      continue;
    }
    totalStrokes += strokes;
    entries[char] = { sha256: createHash("sha256").update(buf).digest("hex"), strokes };
  }
  if (broken.length) {
    throw new Error(`字形数据本身有问题，先修再锁：\n  ${broken.join("\n  ")}`);
  }

  const pkg = await readPinnedPackage();
  const prev = await currentLock();
  let integrity = prev?.source.integrity ?? "";
  let tarball = prev?.source.tarball ?? "";
  if (!offline) {
    try {
      const dist = await fetchDist(pkg.name, pkg.version);
      integrity = dist.integrity;
      tarball = dist.tarball;
    } catch (e) {
      console.warn(`⚠️  取 dist 元数据失败（离线？），沿用锁里的旧值：${(e as Error).message}`);
    }
  }
  if (!integrity) throw new Error("source.integrity 为空且无历史值可沿用（去掉 --offline 联网重试）");

  return {
    schema: 1,
    source: {
      name: pkg.name,
      version: pkg.version,
      registry: "https://registry.npmjs.org",
      tarball,
      integrity,
      license: "Arphic Public License",
      derived_from: ["chanind/hanzi-writer-data", "skishore/makemeahanzi", "Arphic Technology AR PL fonts"],
    },
    derived: {
      generator: "scripts/writing/generate_writing_data.py",
      algorithm: "sha256",
      glyphCount: Object.keys(entries).length,
      totalStrokes,
      files: entries,
    },
  };
}

/** 供 validate-data.ts 复用 */
export async function loadLock(): Promise<GlyphLockFile | null> {
  if (!existsSync(LOCK_PATH)) return null;
  return JSON.parse(await readFile(LOCK_PATH, "utf8")) as GlyphLockFile;
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const offline = argv.includes("--offline");
  const lock = await buildLock(offline);

  if (check) {
    const prev = await currentLock();
    const a = JSON.stringify(prev?.derived.files ?? null);
    const b = JSON.stringify(lock.derived.files);
    if (!prev) {
      console.error("✗ 锁文件不存在");
      process.exit(1);
    }
    if (a !== b || prev.source.version !== lock.source.version || prev.source.integrity !== lock.source.integrity) {
      console.error("✗ 字形数据与版本锁不一致（笔顺可能被改动）");
      process.exit(1);
    }
    console.log(`✓ 版本锁一致：${lock.derived.glyphCount} 字 / ${lock.derived.totalStrokes} 笔`);
    return;
  }

  await mkdir(path.dirname(LOCK_PATH), { recursive: true });
  await writeFile(LOCK_PATH, JSON.stringify(lock, null, 2) + "\n", "utf8");
  console.log(
    `✓ 写入 ${path.relative(REPO_ROOT, LOCK_PATH)}：${lock.derived.glyphCount} 字 / ` +
      `${lock.derived.totalStrokes} 笔，源 ${lock.source.name}@${lock.source.version}`,
  );
}

main().catch(e => {
  console.error(String((e as Error).message ?? e));
  process.exit(1);
});
