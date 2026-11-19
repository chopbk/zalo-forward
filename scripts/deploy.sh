#!/usr/bin/env bash
# Deploy trên server: pull + install + build + restart PM2
# Usage (trên VPS):
#   bash scripts/deploy.sh
#   npm run deploy
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME="${PM2_APP_NAME:-zalo-forward}"
BRANCH="${DEPLOY_BRANCH:-main}"

echo "==> cwd: $ROOT"
echo "==> app: $APP_NAME  branch: $BRANCH"

if [ -d .git ]; then
  echo "==> git fetch/pull"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
  git log -1 --oneline
else
  echo "WARN: không phải git repo — bỏ qua pull"
fi

echo "==> npm install"
npm install

echo "==> build (tsc)"
npx tsc -p tsconfig.json

if ! grep -q tgbind dist/bot/commands.js 2>/dev/null; then
  echo "ERROR: dist thiếu tgbind — build có vẻ sai"
  exit 1
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "==> pm2 restart $APP_NAME"
  pm2 restart "$APP_NAME" --update-env
  sleep 2
  pm2 describe "$APP_NAME" | sed -n '1,16p' || true
  echo "==> recent log"
  tail -n 15 "$HOME/.pm2/logs/${APP_NAME}-out.log" 2>/dev/null || true
else
  echo "WARN: không có pm2 — chỉ build xong. Chạy thủ công: npm start"
fi

echo "==> deploy OK"
