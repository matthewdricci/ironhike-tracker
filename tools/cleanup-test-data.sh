#!/usr/bin/env bash
# Wipe all ironhike rows from the Worker D1 + empty the iCloud backup file.
# Use this AFTER dry-run testing to start race day with a clean slate.
#
# Requires NOTIFY_SECRET from Keychain.

set -u

WORKER="https://ironhike-push.beyond-the-hudson-918.workers.dev"
EVENT="ironhike"
BACKUP="/Users/matt/Library/Mobile Documents/com~apple~CloudDocs/Automations/IronHike-backup.txt"

GREEN=$'\e[32m'; RED=$'\e[31m'; BOLD=$'\e[1m'; RESET=$'\e[0m'

SECRET=$(security find-generic-password -s ironhike-notify-secret -w 2>/dev/null)
if [[ -z "$SECRET" ]]; then
  printf "${RED}NOTIFY_SECRET not in Keychain.${RESET} Add it with:\n"
  printf "  security add-generic-password -s ironhike-notify-secret -a \"\$USER\" -w '<SECRET>'\n"
  exit 1
fi

printf "${BOLD}Cleanup IronHike test data${RESET}\n\n"

# --- Worker D1 ---
ids=$(curl -s "$WORKER/laps?event=$EVENT" \
  | python3 -c "import json,sys; print(' '.join(str(l['id']) for l in json.load(sys.stdin).get('laps', [])))")

if [[ -z "$ids" ]]; then
  printf "  Worker: already empty\n"
else
  count=0
  for id in $ids; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WORKER/lap/delete" \
      -H "Authorization: Bearer $SECRET" \
      -H "Content-Type: application/json" \
      -d "{\"id\":$id}")
    if [[ "$code" == "200" ]]; then
      count=$((count+1))
    else
      printf "  ${RED}failed to delete id=$id (HTTP $code)${RESET}\n"
    fi
  done
  printf "  Worker: deleted ${GREEN}%d${RESET} row(s)\n" "$count"
fi

# --- iCloud backup file ---
if [[ -f "$BACKUP" ]]; then
  : > "$BACKUP"
  printf "  Backup file: ${GREEN}truncated${RESET} ($BACKUP)\n"
else
  printf "  Backup file: doesn't exist yet (will be created on first Log tap)\n"
fi

# --- Verify ---
printf "\n${BOLD}Verify${RESET}\n"
final=$(curl -s "$WORKER/laps?event=$EVENT")
printf "  Worker: %s\n" "$final"
if [[ -f "$BACKUP" ]]; then
  size=$(stat -f "%z" "$BACKUP" 2>/dev/null || echo "?")
  printf "  Backup file size: %s bytes\n" "$size"
fi
