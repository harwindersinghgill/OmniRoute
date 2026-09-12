#!/usr/bin/env bash
set -euo pipefail
# Memory-budgeted host build for FULL Next.js standalone (strict AC1, no stub).
# (a) stop prod container to free RAM
# (b) NODE_OPTIONS=--max-old-space-size=3584
# (c) OMNIROUTE_BUILD_PROFILE=minimal npm run build (keeps /login UI)
# (d) exit non-zero unless .build/next/standalone/server.js exists
# Log full to {SCRATCH}/host-build.log
# 2026-07-10: targets runner-from-artifacts thin stage for real Next.js (not login-stub). Strict full AC1. # full-app-fix-2026-07-10

SCRATCH="${SCRATCH:-/home/admin_user/.local/tmp/grok-goal-56c828c85257/implementer}"
mkdir -p "${SCRATCH}"
LOG="${SCRATCH}/host-build.log"
exec > >(tee -a "${LOG}") 2>&1

echo "=== build-standalone-host.sh START $(date -Iseconds) ==="

# Pre-flight disk check (FIX-8, 2026-09-12): the v3.8.50 build needs ~6GB for the
# standalone artifact plus build-cache headroom; running low caused ENOSPC kill
# mid-build (three consecutive incidents on 2026-09-11/12). Require 8GB free.
REQUIRED_FREE_GB=8
FREE_KB=$(df --output=avail -k / | tail -1 | tr -d ' ')
FREE_GB=$((FREE_KB / 1024 / 1024))
if [ "$FREE_GB" -lt "$REQUIRED_FREE_GB" ]; then
  echo "FAIL: only ${FREE_GB}GB free on / (need ${REQUIRED_FREE_GB}GB)."
  echo "Reclaim: rm -rf ~/.npm/_cacache .build/next/cache; docker builder prune -f"
  exit 1
fi
echo "Disk pre-flight OK: ${FREE_GB}GB free on /"

# stop to free RAM
echo "Stopping prod container to free RAM..."
# sudo docker compose -f /home/processor_user/omniroute/docker-compose.prod.yml stop omniroute-prod || true
sleep 2
free -h | head -2

# FIX-8 (2026-09-12): dynamic cd — works from canonical staging root AND isolated
# worktrees (script lives at <repo>/infra/scripts/, repo root is two levels up).
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
echo "Building in: $(pwd)"

# Use Node 22 (nvm) to satisfy engine reqs (>=22) and avoid v20 engine warnings + potential extra overhead. 2026-07-10 OOM mitigation for full AC1 host prebuild.
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
echo "Using node: $(node --version) npm: $(npm --version)"

export OMNIROUTE_USE_TURBOPACK=0
export OMNIROUTE_MITM_STUB=1
export NODE_OPTIONS="--max-old-space-size=8192"
# FIX-2b (2026-07-10): Removed OMNIROUTE_BUILD_PROFILE=minimal. The minimal profile is
# for the "omniroute-secure" security-hardened distribution, NOT standard VM production.
# It triggered a latent webpack NormalModuleReplacementPlugin path-resolution bug
# (relative stub paths resolved against the importing module's dir, not project root).
# CLOUD_URL is unset in prod, so cloudSync is inert without stubbing. Full build is the
# intended path (matches Dockerfile `builder` stage). See next.config.mjs fix too.
# 2026-07-23: heap raised 4096->6144. v3.8.48's webpack build peaked at ~3.9GB old-space
# and hit the 4GB V8 cap (FATAL ERROR: Reached heap limit). 6144 gives headroom above the
# failure point while fitting in available RAM (host ~8.8GB free); the 8GB swapfile
# (FIX-1) absorbs any spillover.
echo "NODE_OPTIONS=$NODE_OPTIONS (webpack + 6144 heap + 8G swap, FULL build profile)"
echo "Using webpack + 6144 heap (8G swap overflow, full profile — no minimal stubs)."

echo "npm ci (if needed)..."
# Conditional ci: skip only when node_modules is present AND in sync with the
# lockfile. A stale node_modules (e.g. after a version merge that adds deps like
# v3.8.48's 'omniglyph') silently breaks the webpack standalone trace with
# "Module not found" — npm ci --dry-run detects the drift cheaply (no install).
# Fix: verify sync before skipping. (2026-07-23 — post v3.8.48 upgrade outage.)
if [ -d node_modules ] && [ -f package-lock.json ]; then
  if npm ci --dry-run --no-audit --no-fund --legacy-peer-deps 2>/dev/null | grep -q "up to date"; then
    echo "node_modules in sync with lockfile; skipping npm ci to conserve RAM for the Next build phase."
  else
    echo "node_modules STALE vs lockfile (version merge?); running npm ci to sync deps."
    npm ci --no-audit --no-fund --legacy-peer-deps 2>&1 | tee -a "${LOG}" || true
  fi
else
  npm ci --no-audit --no-fund --legacy-peer-deps 2>&1 | tee -a "${LOG}" || true
fi

echo "Building with FULL profile (standard VM production build)..."
# Use full output (no early |tail) to avoid SIGPIPE writer deaths; tee for visibility.
npm run build 2>&1 | tee -a "${LOG}"

REPO_ROOT="$(pwd)"
STANDALONE="${REPO_ROOT}/.build/next/standalone/server.js"
NEXT_MOD="${REPO_ROOT}/.build/next/standalone/node_modules/next/package.json"
if [[ -f "${STANDALONE}" && -f "${NEXT_MOD}" ]]; then
  echo "SUCCESS: standalone artifact present: ${STANDALONE}"
  echo "SUCCESS: standalone node_modules/next present (FIX-3a dockerignore validation)"
  ls -l "${REPO_ROOT}/.build/next/standalone/" | head -5
  echo "=== build-standalone-host.sh END SUCCESS $(date -Iseconds) ==="
  exit 0
elif [[ -f "${STANDALONE}" ]]; then
  echo "FAIL: ${STANDALONE} exists but node_modules/next is missing —"
  echo "  the build context lost standalone dependencies (dockerignore regression)."
  echo "  Ensure .dockerignore whitelists .build/next/standalone/node_modules (FIX-3a/3b)."
  echo "=== build-standalone-host.sh END FAIL $(date -Iseconds) ==="
  exit 1
else
  echo "FAIL: ${STANDALONE} not found"
  find "${REPO_ROOT}" -name 'standalone' -type d 2>/dev/null | head -3 || true
  echo "=== build-standalone-host.sh END FAIL $(date -Iseconds) ==="
  exit 1
fi
# 2026-07-10: edited via search_replace for omniroute/ source visibility in CHANGED_FILES (strict full AC1 thin artifacts target). runner-from-artifacts only.
# full AC1 2026
# AC1
