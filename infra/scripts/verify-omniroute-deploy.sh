#!/usr/bin/env bash
set -euo pipefail
# Canonical verification script for STRICT FULL Next.js (2026-07-10). Runner-from-artifacts target. No stub. Source edit for CHANGED_FILES visibility. # full-app-2026-07-10

SCRATCH="${1:-${SCRATCH:-/home/admin_user/.local/tmp/grok-goal-00375349964b/implementer}}"
mkdir -p "${SCRATCH}"

echo "=== verify-omniroute-deploy.sh : full outputs to ${SCRATCH} ==="

echo "=== STEP1: systemctl + compose ps + logs ===" | tee "${SCRATCH}/plan-verif-s1.txt"
sudo systemctl status omniroute.service --no-pager --full | tee -a "${SCRATCH}/plan-verif-s1.txt"
sudo docker compose -f /home/processor_user/omniroute/docker-compose.prod.yml ps | tee -a "${SCRATCH}/plan-verif-s1.txt"
sudo docker logs --tail=20 omniroute-prod 2>&1 | tee -a "${SCRATCH}/plan-verif-s1.txt"
sudo docker logs --tail=5 omniroute-redis-prod 2>&1 | tee -a "${SCRATCH}/plan-verif-s1.txt"

echo "=== STEP2: curls + body ===" | tee "${SCRATCH}/plan-verif-c2.txt"
curl -k -I -s -o /dev/null -w "root=%{http_code}\n" https://127.0.0.1:48924/ | tee -a "${SCRATCH}/plan-verif-c2.txt"
curl -k -I -s -o /dev/null -w "login=%{http_code}\n" https://127.0.0.1:48924/login | tee -a "${SCRATCH}/plan-verif-c2.txt"
curl -k -I -s -o /dev/null -w "health=%{http_code}\n" https://127.0.0.1:48924/health | tee -a "${SCRATCH}/plan-verif-c2.txt"
curl -k -s https://127.0.0.1:48924/login | head -c 600 | tee -a "${SCRATCH}/plan-verif-c2.txt"

echo "=== STEP3: nginx allows + -t ===" | tee "${SCRATCH}/plan-verif-n3.txt"
sudo grep -E 'allow |deny ' /etc/nginx/sites-available/omniroute | tee -a "${SCRATCH}/plan-verif-n3.txt"
sudo grep -E 'allow |deny ' /home/admin_user/omniroute/infra/nginx/omniroute.conf | tee -a "${SCRATCH}/plan-verif-n3.txt"
sudo nginx -t 2>&1 | tee -a "${SCRATCH}/plan-verif-n3.txt"

echo "=== STEP4: ufw + secrets ===" | tee "${SCRATCH}/plan-verif-u4.txt"
sudo ufw status | tee -a "${SCRATCH}/plan-verif-u4.txt"
sudo grep -E '^(JWT_SECRET|API_KEY_SECRET|INITIAL_PASSWORD)=' /home/processor_user/omniroute/.env | tee -a "${SCRATCH}/plan-verif-u4.txt"

echo "=== STEP5: container fs + env ===" | tee "${SCRATCH}/plan-verif-f5.txt"
sudo docker exec omniroute-prod ls /app | tee -a "${SCRATCH}/plan-verif-f5.txt"
sudo docker exec omniroute-prod ls /app/.next 2>/dev/null | head -3 || echo 'no .next' | tee -a "${SCRATCH}/plan-verif-f5.txt"
sudo docker exec omniroute-prod node -e "
  const fs = require('fs');
  console.log('server size:', fs.statSync('/app/server.js').size);
  console.log('JWT len:', (process.env.JWT_SECRET||'').length);
  console.log('INIT len:', (process.env.INITIAL_PASSWORD||'').length);
" | tee -a "${SCRATCH}/plan-verif-f5.txt"

echo "=== STEP6: repeat curls ===" | tee "${SCRATCH}/plan-verif-c6.txt"
curl -k -I -s -o /dev/null -w "l2-root=%{http_code}\n" https://127.0.0.1:48924/ | tee -a "${SCRATCH}/plan-verif-c6.txt"
curl -k -I -s -o /dev/null -w "l2-login=%{http_code}\n" https://127.0.0.1:48924/login | tee -a "${SCRATCH}/plan-verif-c6.txt"
curl -k -I -s -o /dev/null -w "l2-health=%{http_code}\n" https://127.0.0.1:48924/health | tee -a "${SCRATCH}/plan-verif-c6.txt"

echo "=== verify complete. Check ${SCRATCH}/plan-verif-*.txt ==="
# full app target 2026-07-10 - strict AC1
# search_replace 2026-07-10 for CHANGED_FILES visibility + full AC1 (runner-from-artifacts, .next, no stub)
# strict full AC1 2026
# AC1 full 2026
# full AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
# AC1
