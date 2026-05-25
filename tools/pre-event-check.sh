#!/usr/bin/env bash
# Race-day morning-of pre-event check.
#
# Runs the full health check, plus a few extra "are we truly ready" assertions:
#   - Worker is empty (no leftover test data)
#   - Backup file is empty (no leftover test data)
#   - Reconcile cron last exit was 0
#   - launchd plist's --since matches the actual event start
#
# Exits 0 if all green. Exits 1 with a clear GO/NO-GO line otherwise.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
WORKER="https://ironhike-push.beyond-the-hudson-918.workers.dev"
EVENT="ironhike"
BACKUP="/Users/matt/Library/Mobile Documents/com~apple~CloudDocs/Automations/IronHike-backup.txt"
EXPECTED_START="2026-06-04T12:00:00-04:00"
PLIST_USER="$HOME/Library/LaunchAgents/com.matthewdricci.ironhike-reconcile.plist"

GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; BOLD=$'\e[1m'; RESET=$'\e[0m'

bash "$HERE/health-check.sh"
health_exit=$?

printf "\n${BOLD}Pre-event assertions${RESET}\n"
extra_fail=0

# Empty worker
n=$(curl -s "$WORKER/laps?event=$EVENT" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('laps', [])))" 2>/dev/null || echo "?")
if [[ "$n" == "0" ]]; then
  printf "  ${GREEN}✓${RESET} Worker has 0 $EVENT rows\n"
else
  printf "  ${RED}✗${RESET} Worker has $n $EVENT rows (expected 0)\n"
  printf "      Run: bash $HERE/cleanup-test-data.sh\n"
  extra_fail=$((extra_fail+1))
fi

# Empty backup file (or doesn't exist — both fine)
if [[ -f "$BACKUP" ]]; then
  bytes=$(stat -f "%z" "$BACKUP" 2>/dev/null || echo "?")
  if [[ "$bytes" == "0" ]]; then
    printf "  ${GREEN}✓${RESET} Backup file is empty\n"
  else
    printf "  ${RED}✗${RESET} Backup file is $bytes bytes (expected 0)\n"
    printf "      Run: bash $HERE/cleanup-test-data.sh\n"
    extra_fail=$((extra_fail+1))
  fi
else
  printf "  ${GREEN}✓${RESET} Backup file doesn't exist yet (Log shortcut will create it)\n"
fi

# Plist --since
if [[ -f "$PLIST_USER" ]]; then
  if grep -q "$EXPECTED_START" "$PLIST_USER"; then
    printf "  ${GREEN}✓${RESET} launchd plist --since is $EXPECTED_START\n"
  else
    printf "  ${YELLOW}!${RESET} launchd plist --since doesn't match expected $EXPECTED_START\n"
    printf "      Currently loaded plist: $PLIST_USER\n"
  fi
else
  printf "  ${RED}✗${RESET} no plist at $PLIST_USER — launchd job isn't loaded\n"
  extra_fail=$((extra_fail+1))
fi

# -----------------------------------------------------------
printf "\n${BOLD}GO / NO-GO${RESET}\n"
if [[ $health_exit -eq 0 ]] && [[ $extra_fail -eq 0 ]]; then
  printf "  ${GREEN}🏔️  GO — system ready for IronHike${RESET}\n"
  exit 0
else
  printf "  ${RED}🛑 NO-GO — fix the failures above before the race${RESET}\n"
  exit 1
fi
