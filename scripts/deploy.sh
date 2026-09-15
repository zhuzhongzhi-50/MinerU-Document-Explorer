#!/usr/bin/env bash
#
# deploy.sh — 本地一键打包源码，用于上传到 Linux 服务器部署。
#
# 说明：
#   - 项目依赖 better-sqlite3 / sqlite-vec / node-llama-cpp 三个原生模块，
#     它们必须在【目标服务器平台】上 npm install 编译，不能跨平台复用。
#   - 因此本脚本只打包"源码"，刻意排除 node_modules、dist、日志、.git。
#   - 服务器上收到包后：npm install && npm run build && qmd serve
#
# 用法（在 Git Bash / WSL / macOS / Linux 终端）：
#   bash scripts/deploy.sh
#
set -euo pipefail

# 定位项目根目录（本脚本位于 <root>/scripts/deploy.sh）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="qmd-deploy-${TS}.tgz"

echo "Project root : $ROOT"
echo "Packaging source (excluding node_modules, dist, logs, .git) ..."

tar -czf "$OUT" \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='.codebuddy' \
  --exclude='*.log' \
  --exclude='serve.out.log' \
  --exclude='serve.err.log' \
  .

SIZE="$(du -h "$OUT" | cut -f1)"
echo ""
echo "Created: $OUT  ($SIZE)"
echo ""
echo "下一步（在服务器上）："
echo "  scp $OUT user@<server>:/opt/"
echo "  ssh user@<server> 'mkdir -p /opt/qmd && tar -xzf qmd-deploy-*.tgz -C /opt/qmd'"
echo "  ssh user@<server> 'cd /opt/qmd && npm install && npm run build && npm run qmd -- serve --host 0.0.0.0 --port 8787'"
