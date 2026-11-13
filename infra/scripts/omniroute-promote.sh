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
BACKUP_CREATED=0
if [[ -d "${PROD}" && "$(ls -A "${PROD}" 2>/dev/null)" ]]; then
  # The archive contains omniroute/.env. umask 077 makes it 600 at creation; the chmod
  # covers an inherited umask override. Without this, any local user can read every
  # provider key out of the tarball (the parent dirs are 755).
  # Exclude backups/ from the archive itself: the tarball is written inside that
  # directory, so archiving it makes tar read the file it is still growing
  # ("file changed as we read it") and the run aborts after writing gigabytes.
  ( umask 077; tar -czf "${PROD}/backups/${BACKUP_TAG}.tar.gz" --exclude='omniroute/backups' --exclude='omniroute/.build/next/cache' -C /home/processor_user omniroute )
  chmod 600 "${PROD}/backups/${BACKUP_TAG}.tar.gz"
  BACKUP_CREATED=1
  echo "Backup: ${PROD}/backups/${BACKUP_TAG}.tar.gz"
  # `backups/` is excluded from the rsync below, so archives now accumulate: keep 5.
  ls -1t "${PROD}"/backups/omniroute_pre_sync_*.tar.gz 2>/dev/null | tail -n +3 | xargs -r rm -f
fi

mkdir -p "${PROD}"
# `--exclude` also protects the destination from `--delete`, so every excluded path
# survives the mirror. `backups/` must be listed or the tarball taken above is deleted
# by this very command; `node_modules/` stays UNANCHORED on purpose — anchoring it
# ('/node_modules/') would drop that protection and strip standalone deps.
rsync -av --delete \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='data/' \
  --exclude='.build/next/cache/' \
  --exclude='node_modules/' \
  --exclude='.git/' \
  --exclude='backups/' \
  "${STAGING}/" "${PROD}/"

# Assert THIS run's rollback artifact outlived the mirror. A bare
# `omniroute_pre_sync_*.tar.gz` glob would match a stale tarball from an earlier
# promote and pass even when this run's backup was deleted.
if [[ "${BACKUP_CREATED}" -eq 0 ]]; then
  echo "First promote into an empty prod tree: no rollback archive to verify."
elif [[ -f "${PROD}/backups/${BACKUP_TAG}.tar.gz" ]]; then
  echo "Pre-sync backup survived the rsync."
else
  echo "ERROR: ${BACKUP_TAG}.tar.gz missing after rsync — check the backups/ exclude." >&2
  exit 1
fi

# A lingering REDIS_URL would point at a sidecar this compose no longer defines, and the
# rate limiter fails OPEN on a dead Redis — silently disabling 429s. Values are never printed.
if [[ -f "${PROD}/.env" ]] && /usr/bin/grep -qE '^(REDIS_URL|QUOTA_STORE_REDIS_URL)=' "${PROD}/.env"; then
  echo "ERROR: ${PROD}/.env still sets REDIS_URL/QUOTA_STORE_REDIS_URL but the redis sidecar was retired." >&2
  echo "  Remove it before promoting, or rate limiting will fail open." >&2
  exit 1
fi

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

echo "Building omniroute:prod image (runner-from-artifacts)..."
docker compose -f "${PROD}/docker-compose.prod.yml" build omniroute-prod

systemctl daemon-reload
systemctl restart omniroute.service
systemctl --no-pager --full status omniroute.service
echo "Promote complete."
# full AC1
