#!/usr/bin/env bash
# /usr/local/sbin/omniroute-promote.sh
# Promote OmniRoute staging → production. Must run as root.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root (e.g. sudo /usr/local/sbin/omniroute-promote.sh)" >&2
  exit 1
fi

STAGING="/home/admin_user/omniroute"
PROD="/home/processor_user/omniroute"
BACKUP_TAG="omniroute_pre_sync_$(date +%Y%m%d_%H%M%S)"

[[ -d "${STAGING}" ]] || { echo "ERROR: staging missing: ${STAGING}" >&2; exit 1; }

mkdir -p "${PROD}/backups"
if [[ -d "${PROD}" && "$(ls -A "${PROD}" 2>/dev/null)" ]]; then
  tar -czf "${PROD}/backups/${BACKUP_TAG}.tar.gz" -C /home/processor_user omniroute
  echo "Backup: ${PROD}/backups/${BACKUP_TAG}.tar.gz"
fi

mkdir -p "${PROD}"
rsync -av --delete \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='data/' \
  --exclude='node_modules/' \
  --exclude='.git/' \
  "${STAGING}/" "${PROD}/"

# Hard gate: require host-built standalone artifact (no stub fallback)
# 2026-07-10: enforces full Next.js (runner-from-artifacts) per strict AC1. # full-app-2026-07-10
if [[ ! -f "${PROD}/.build/next/standalone/server.js" ]]; then
  echo "ERROR: no .build/next/standalone/server.js in prod after sync. Run host build first." >&2
  exit 1
fi

# FIX-8 gate (2026-09-12): standalone node_modules must survive the sync AND the
# build context. server.js without deps crashes at boot ("Cannot find module
# 'next'") — the exact FIX-3a/3b regression that broke the v3.8.50 deploy.
if [[ ! -f "${PROD}/.build/next/standalone/node_modules/next/package.json" ]]; then
  echo "ERROR: .build/next/standalone/node_modules/next missing in prod —" >&2
  echo "  promote rsync excludes stripped standalone deps. Fix excludes and re-run." >&2
  exit 1
fi
if grep -qE '^\*\*/node_modules' "${PROD}/.dockerignore" 2>/dev/null; then
  echo "ERROR: .dockerignore contains bare **/node_modules which strips" >&2
  echo "  .build/next/standalone/node_modules from the docker build context." >&2
  echo "  Apply FIX-3b whitelist (!.build/next/standalone/node_modules) first." >&2
  exit 1
fi
echo "Standalone artifact + deps + dockerignore gates OK."

chown -R processor_user:processor_user "${PROD}"
# Preserve production .env if present
if [[ -f "${PROD}/.env" ]]; then
  chmod 600 "${PROD}/.env"
  chown processor_user:processor_user "${PROD}/.env"
fi

systemctl daemon-reload
systemctl restart omniroute.service
systemctl --no-pager --full status omniroute.service
echo "Promote complete."
# full AC1
