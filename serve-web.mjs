import { createServer, request as httpRequest } from "node:http";
import { createReadStream, openSync, readSync, closeSync, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const WEB = path.resolve(import.meta.dirname, "apps/web");
const OUT = path.join(WEB, "out");
const PUBLIC = path.join(WEB, "public");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

// 这些前缀的文件在两处内容一致，只从 public/ 读，避免 out/ 再占 1.6GB
const PUBLIC_ONLY = ["/audio/", "/story-images/", "/textbook-pages/"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
};

// 音频语料 92% 是 Ogg Opus、8% 实际是 MP3，却统一叫 .opus —— 按魔数判定容器，
// 否则 Safari 拿到 audio/ogg 的 MP3（或反之）会拒绝解码。
const audioTypeCache = new Map();
function audioType(file) {
  if (audioTypeCache.has(file)) return audioTypeCache.get(file);
  let type = "audio/ogg";
  try {
    const fd = openSync(file, "r");
    const b = Buffer.alloc(4);
    readSync(fd, b, 0, 4, 0);
    closeSync(fd);
    const isMp3 = b.slice(0, 3).toString() === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    if (isMp3) type = "audio/mpeg";
  } catch {
    /* 保持默认 */
  }
  audioTypeCache.set(file, type);
  return type;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".opus" || ext === ".ogg") return audioType(file);
  return MIME[ext] ?? "application/octet-stream";
}

async function resolveTarget(rawUrl) {
  const rel = decodeURIComponent(new URL(rawUrl, "http://x").pathname);
  const base = PUBLIC_ONLY.some(p => rel.startsWith(p)) ? PUBLIC : OUT;
  let target = path.resolve(base, "." + rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;

  for (const cand of [target, path.join(target, "index.html"), target + ".html"]) {
    const st = await stat(cand).catch(() => null);
    if (st?.isFile()) return { file: cand, st };
  }
  return null;
}

function log(req, status, extra = "") {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${status}${extra ? " | " + extra : ""}`);
}

// 云存档 API 上游：ctsf-sync 服务只监听它自己的 127.0.0.1:8100，静态站点侧要走
// 那台机器的反向代理把 /api 转过去。不设 CTSF_API_TARGET 就明确回 503，
// 别让它掉进静态文件查找。
const API_TARGET = (process.env.CTSF_API_TARGET || "").replace(/\/$/, "");

function proxyApi(req, res, target) {
  if (!API_TARGET) {
    res.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({
      error: "未配置云存档上游，启动时设 CTSF_API_TARGET=http://<同步服务器地址>:<端口>",
    }));
    log(req, 503, "/api 未配置上游");
    return;
  }
  // 上游（ctsf-sync 服务与 nginx 一样按 /api/... 收请求），前缀原样保留
  const upstream = new URL(target, API_TARGET + "/");
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const proxyReq = httpRequest(
      upstream,
      {
        method: req.method,
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          "x-forwarded-for": req.socket.remoteAddress ?? "",
        },
      },
      proxyRes => {
        res.writeHead(proxyRes.statusCode ?? 502, {
          "content-type": proxyRes.headers["content-type"] ?? "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        log(req, proxyRes.statusCode ?? 502, `/api ${target}`);
        proxyRes.pipe(res);
      },
    );
    proxyReq.setTimeout(20000, () => proxyReq.destroy(new Error("上游超时")));
    proxyReq.on("error", err => {
      res.writeHead(502, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: `云存档服务不可达：${err.message}` }));
      log(req, 502, `/api ${err.message}`);
    });
    proxyReq.end(body);
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    proxyApi(req, res, url.pathname + url.search);
    return;
  }

  // Next 静态导出会在每个路由目录里放一份 index.txt（客户端路由用的 RSC 负载）。
  // 带 ?_rsc= 的是路由预取，必须原样返回，否则软导航会退化成整页刷新；
  // 只有被当文档直接打开（无 _rsc）才弹回真页面，避免显示一屏 flight 文本。
  if (/\/index\.txt$/.test(url.pathname) && !url.searchParams.has("_rsc")) {
    const page = url.pathname.slice(0, -"index.txt".length);
    res.writeHead(302, { location: page, "cache-control": "no-store" });
    res.end();
    log(req, 302, `${url.pathname} -> ${page}`);
    return;
  }

  const found = await resolveTarget(req.url);

  if (!found) {
    const notFound = path.join(OUT, "404.html");
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    if (existsSync(notFound)) createReadStream(notFound).pipe(res);
    else res.end("404");
    log(req, 404);
    return;
  }

  const { file, st } = found;
  const type = contentType(file);
  const cacheable =
    file.startsWith(path.join(OUT, "_next", "static")) || file.startsWith(PUBLIC + path.sep);

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  const start = range?.[1] ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
  const partial = Boolean(range) && start <= end && (start > 0 || end < st.size - 1);

  res.writeHead(partial ? 206 : 200, {
    "content-type": type,
    "content-length": partial ? end - start + 1 : st.size,
    "accept-ranges": "bytes",
    "cache-control": cacheable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(partial ? { "content-range": `bytes ${start}-${end}/${st.size}` } : {}),
  });
  createReadStream(file, partial ? { start, end } : {}).pipe(res);
  log(req, partial ? 206 : 200, path.relative(file.startsWith(PUBLIC) ? PUBLIC : OUT, file) + " " + type);
}).listen(PORT, HOST, () => {
  console.log(`页面产物: ${OUT}`);
  console.log(`媒体目录: ${PUBLIC}`);
  console.log(`监听 http://${HOST}:${PORT}  (局域网设备用本机 IP 访问)`);
});
