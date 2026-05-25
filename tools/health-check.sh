#!/usr/bin/env bash
# IronHike system health check.
#
# Runs a sequence of automated checks against the worker, dashboard, launchd
# cron, and iCloud backup file. Exits 0 if everything looks healthy, 1 otherwise.
# Output is human-readable with PASS/FAIL/WARN lines, intended to be read by
# eyeballs (not parsed).

set -u  # don't `set -e` — we want every check to run regardless of prior failures

WORKER="https://ironhike-push.beyond-the-hudson-918.workers.dev"
EVENT="ironhike"
DASHBOARD="https://matthewdricci.github.io/ironhike-tracker/"
BACKUP="/Users/matt/Library/Mobile Documents/com~apple~CloudDocs/Automations/IronHike-backup.txt"
LAUNCHD_LABEL="com.matthewdricci.ironhike-reconcile"
LAUNCHD_LOG="$HOME/Library/Logs/ironhike-reconcile.log"
RECONCILE_DIR="$HOME/ironhike-tracker/tools/reconcile"

GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; DIM=$'\e[2m'; BOLD=$'\e[1m'; RESET=$'\e[0m'

fail_count=0
warn_count=0
pass_count=0

pass()  { printf "  ${GREEN}✓${RESET} %s\n" "$1"; pass_count=$((pass_count+1)); }
fail()  { printf "  ${RED}✗${RESET} %s\n" "$1"; fail_count=$((fail_count+1)); }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1"; warn_count=$((warn_count+1)); }
info()  { printf "    ${DIM}%s${RESET}\n" "$1"; }
section(){ printf "\n${BOLD}%s${RESET}\n" "$1"; }

# -----------------------------------------------------------
section "Worker (Cloudflare)"

http_code=$(curl -s -o /dev/null -w "%{http_code}" "$WORKER/laps?event=$EVENT")
if [[ "$http_code" == "200" ]]; then
  pass "GET /laps?event=$EVENT → 200"
else
  fail "GET /laps?event=$EVENT → $http_code"
fi

response=$(curl -s "$WORKER/laps?event=$EVENT")
lap_count=$(echo "$response" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('laps', [])))" 2>/dev/null || echo "?")
info "current $EVENT laps in worker: $lap_count"

# -----------------------------------------------------------
section "Dashboard (GitHub Pages)"

http_code=$(curl -s -o /dev/null -w "%{http_code}" "$DASHBOARD")
if [[ "$http_code" == "200" ]]; then
  pass "GET dashboard → 200"
else
  fail "GET dashboard → $http_code"
fi

app_js=$(curl -s "$DASHBOARD/app.js")
if echo "$app_js" | grep -q "ironhike-push.beyond-the-hudson"; then
  pass "app.js references Worker (not Sheets)"
else
  fail "app.js does NOT reference Worker — Pages may be stale"
fi
if echo "$app_js" | grep -q "initWelcome\|welcome-dismissed"; then
  pass "welcome screen code is deployed"
else
  warn "welcome screen code not yet deployed to Pages (push may be in-flight)"
fi
if echo "$app_js" | grep -q "2026-06-04T12:00:00-04:00"; then
  pass "start_iso hardcoded to Jun 4 12pm EDT"
else
  fail "start_iso not as expected"
fi

manifest_code=$(curl -s -o /dev/null -w "%{http_code}" "$DASHBOARD/manifest.json")
icon_code=$(curl -s -o /dev/null -w "%{http_code}" "$DASHBOARD/icon.svg")
if [[ "$manifest_code" == "200" ]]; then pass "manifest.json → 200"; else warn "manifest.json → $manifest_code (Pages may still be building)"; fi
if [[ "$icon_code"     == "200" ]]; then pass "icon.svg → 200";       else warn "icon.svg → $icon_code (Pages may still be building)"; fi

# -----------------------------------------------------------
section "Reconcile cron (launchd)"

launch_line=$(launchctl list | grep "$LAUNCHD_LABEL" || true)
if [[ -n "$launch_line" ]]; then
  pass "launchd job registered"
  info "$launch_line"

  exit_code=$(echo "$launch_line" | awk '{print $2}')
  if [[ "$exit_code" == "0" ]]; then
    pass "last exit code 0"
  else
    fail "last exit code: $exit_code (non-zero — check log)"
  fi
else
  fail "launchd job '$LAUNCHD_LABEL' NOT registered"
fi

if [[ -f "$LAUNCHD_LOG" ]]; then
  pass "log file exists at $LAUNCHD_LOG"
  last_line=$(tail -1 "$LAUNCHD_LOG" 2>/dev/null)
  if echo "$last_line" | grep -q "PermissionError"; then
    fail "most recent log entry is a PermissionError — FDA not granted to python"
    info "$last_line"
  elif echo "$last_line" | grep -q "Traceback"; then
    fail "most recent log entry is a Python traceback"
    info "$last_line"
  elif echo "$last_line" | grep -q "local_in_window="; then
    pass "most recent log entry looks healthy"
    info "$last_line"
  else
    warn "log line doesn't match expected format (cron may be mid-write)"
    info "$last_line"
  fi
else
  warn "no log file yet — cron has never run"
fi

# -----------------------------------------------------------
section "iCloud backup file"

if [[ -f "$BACKUP" ]]; then
  pass "backup file exists"
  bytes=$(stat -f "%z" "$BACKUP" 2>/dev/null || echo "?")
  lines=$(wc -l < "$BACKUP" | tr -d ' ')
  log_count=$(grep -E "^[0-9]{4}-[0-9]{2}-[0-9]{2}T" "$BACKUP" 2>/dev/null | wc -l | tr -d ' ')
  # grep -c exits 1 when there are zero matches, which combined with `|| echo 0`
  # produced "0\n0" output. Pipe through grep -c instead — `wc -l` always exits 0.
  undo_count=$(grep -ci "^UNDO" "$BACKUP" 2>/dev/null; true)
  info "size: ${bytes}B · lines: $lines · log timestamps: $log_count · UNDO markers: $undo_count"

  # Read access test: can a launchd-style python read it?
  if /opt/homebrew/bin/python3 -c "open('$BACKUP').read()" 2>/dev/null; then
    pass "Homebrew python3 can read the backup file"
  else
    fail "Homebrew python3 can NOT read backup file (FDA grant needed)"
  fi
else
  warn "backup file doesn't exist yet — Log shortcut hasn't run, OR iCloud sync lag"
fi

# -----------------------------------------------------------
section "Reconcile script (manual run, no replay)"

if [[ -x "$RECONCILE_DIR/reconcile.py" ]] && [[ -f "$BACKUP" ]]; then
  output=$(/opt/homebrew/bin/python3 "$RECONCILE_DIR/reconcile.py" \
    --event "$EVENT" \
    --since 2026-06-04T12:00:00-04:00 \
    --backup "$BACKUP" \
    --dry-run 2>&1)
  if echo "$output" | grep -q "Traceback"; then
    fail "manual dry-run errored"
    info "$output"
  else
    pass "manual dry-run completed clean"
    info "$(echo "$output" | head -1)"
  fi
else
  info "skipped (script missing or backup file missing)"
fi

# -----------------------------------------------------------
section "Summary"
printf "  ${GREEN}%d passed${RESET}  ${RED}%d failed${RESET}  ${YELLOW}%d warn${RESET}\n\n" "$pass_count" "$fail_count" "$warn_count"

if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi
exit 0
