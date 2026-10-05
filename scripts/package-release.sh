#!/usr/bin/env bash
# Build complete, downloader-compatible assets without deleting previous builds.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$ROOT_DIR/scripts/package-release.py" "$@"
