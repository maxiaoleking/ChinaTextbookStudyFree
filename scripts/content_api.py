"""Small OpenRouter client with explicit models, safe errors, and local usage logs."""
from __future__ import annotations

import json
import os
import http.client
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "data/content-revision/usage.jsonl"
LOCK = threading.Lock()


def key():
    value = os.environ.get("OPENROUTER_API_KEY")
    if not value and (ROOT / ".env").exists():
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith("OPENROUTER_API_KEY="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not value:
        raise RuntimeError("请在项目 .env 配置 OPENROUTER_API_KEY")
    return value


def record(data):
    with LOCK:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as f:
            f.write(json.dumps({"time": time.time(), **data}, ensure_ascii=False) + "\n")


def request(endpoint, payload, timeout=240):
    req = urllib.request.Request("https://openrouter.ai/api/v1/" + endpoint,
        data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + key(),
        "Content-Type": "application/json", "X-OpenRouter-Title": "ChinaStudyFree Content Revision"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body, headers = r.read(), dict(r.headers)
            return body, headers
        except urllib.error.HTTPError as e:
            error = e.read().decode(errors="replace")[:600].replace(key(), "[REDACTED]")
            if e.code in (429, 502, 503, 504) and attempt < 2:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f"OpenRouter {endpoint} HTTP {e.code}: {error}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.RemoteDisconnected) as e:
            if attempt < 2:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f"OpenRouter transport failed ({type(e).__name__}); rerun to resume") from None


def chat(model, prompt, schema=None, **extra):
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}], **extra}
    if schema:
        payload["response_format"] = {"type": "json_schema", "json_schema": {
            "name": "content", "strict": True, "schema": schema}}
    body, _ = request("chat/completions", payload)
    data = json.loads(body)
    record({"model": model, "id": data.get("id"), "usage": data.get("usage", {})})
    if data.get("error"):
        raise RuntimeError(str(data["error"])[:500])
    choice = data["choices"][0]
    if choice.get("finish_reason") == "length":
        raise RuntimeError("模型输出被截断；未保存为合格内容")
    return choice["message"]


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
