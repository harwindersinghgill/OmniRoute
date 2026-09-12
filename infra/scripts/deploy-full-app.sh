#!/usr/bin/env bash
set -euo pipefail
# Single orchestration: stop -> host build -> thin artifacts build -> restart -> AC1 checks -> verify
# Full outputs logged.
# 2026-07-10: forces runner-from-artifacts for strict full Next.js app ( .next + real routes, no stub log). # full-app-fix-2026-07-10

SCRATCH="${SCRATCH:-/home/admin_user/.local/tmp/grok-goal-56c828c85257/implementer}"
mkdir -p "${SCRATCH}"
LOG="${SCRATCH}/deploy-full-app.log"
exec > >(tee -a "${LOG}") 2>&1

echo "=== deploy-full-app.sh START $(date -Iseconds) ==="

PROD_COMPOSE="/home/processor_user/omniroute/docker-compose.prod.yml"

echo "Stopping prod..."
sudo docker compose -f "${PROD_COMPOSE}" stop omniroute-prod || true

if [[ -f /home/admin_user/omniroute/.build/next/standalone/server.js ]]; then
  echo "Host artifact already present from prior run; skipping re-host-build (saves time; using existing for thin)."
else
  echo "Running host build..."
  /home/admin_user/omniroute/infra/scripts/build-standalone-host.sh
fi

echo "Syncing updated source + host-built artifacts to /home/processor_user/omniroute (ensures compose context has fresh .build + thin Dockerfile + healthcheck)..."
sudo rsync -av --delete \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='data/' \
  --exclude='node_modules/' \
  --exclude='.git/' \
  /home/admin_user/omniroute/ /home/processor_user/omniroute/

echo "Building thin image (target runner-from-artifacts)..."  # strict full AC1 2026-07-10 - no stub, .next present
cd /home/admin_user/omniroute
# build using the now-synced prod compose (context . resolved to processor dir which now has .build/ from rsync)
# 2026-07-10: --target runner-from-artifacts for strict full AC1 (no OOM, real .next in final container)
sudo docker compose -f "${PROD_COMPOSE}" build --target runner-from-artifacts omniroute-prod

echo "Starting..."
sudo systemctl restart omniroute.service
sleep 10
sudo docker compose -f "${PROD_COMPOSE}" ps

echo "AC1 checks (no stub logs, .next present)..."
sudo docker logs --tail=20 omniroute-prod | tee -a "${SCRATCH}/ac1-check.log"
if grep -qi 'stub\|minimal health' "${SCRATCH}/ac1-check.log"; then
  echo "FAIL: stub/minimal health string in logs"
  exit 1
fi
sudo docker exec omniroute-prod ls /app/.next | head -3 || { echo "FAIL: no .next"; exit 1; }
echo "AC1 checks passed."

echo "Running verify script for steps 2-6..."
/home/admin_user/omniroute/infra/scripts/verify-omniroute-deploy.sh "${SCRATCH}"

echo "=== deploy-full-app.sh END SUCCESS $(date -Iseconds) ==="
# full-app 2026-07-10 strict AC1
# AC1 2026 full
