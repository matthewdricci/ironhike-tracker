# Reconcile cron

Safety net for IronHike: every 30 minutes, the Mac Mini compares the iCloud-synced backup file (written by the "Log IronHike Lap" Shortcut's iCloud append step) against the Worker's D1 state. Any local timestamps missing from the server within a 5-second tolerance get replayed via `POST /lap` with `push=false` (no spam to subscribers).

**Silent unless action taken.** Every run appends a one-line summary to the log file; a push notification fires ONLY when rows were actually replayed.

No LLM in the loop. Just diff + replay. Deliberate scope choice (see `Post-mortem.md` in the Murph project).

## One-time setup

### 1) Store the NOTIFY_SECRET in macOS Keychain

```bash
security add-generic-password -s ironhike-notify-secret -a "$USER" -w 'njaYaqf7deYgacCkpxlNLM8JtIt_BqucKoowcr730vw'
```

(Rotate? Re-add with the same `-s` name and the new value; `add-generic-password -U` updates in place.)

### 2) Manually test the script first (dry run, no replays)

```bash
python3 /Users/matthewricci/ironhike-tracker/tools/reconcile/reconcile.py \
  --event ironhike \
  --since 2026-06-04T12:00:00-04:00 \
  --backup "/Users/matthewricci/Library/Mobile Documents/com~apple~CloudDocs/Automations/IronHike-backup.txt" \
  --dry-run
```

Expected output before the event:
```
[2026-06-04T...] event=ironhike since=2026-06-04T12:00:00-04:00 local_in_window=0 server=0 missing=0
```

### 3) Install the launchd plist

```bash
cp /Users/matthewricci/ironhike-tracker/tools/reconcile/com.matthewdricci.ironhike-reconcile.plist \
   ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.matthewdricci.ironhike-reconcile.plist
```

Verify it loaded:
```bash
launchctl list | grep ironhike
```

The plist runs at load (immediate verification) and every 30 min thereafter.

### 4) Watch the log

```bash
tail -f ~/Library/Logs/ironhike-reconcile.log
```

You should see one line per run.

## Tearing it down

```bash
launchctl unload ~/Library/LaunchAgents/com.matthewdricci.ironhike-reconcile.plist
rm ~/Library/LaunchAgents/com.matthewdricci.ironhike-reconcile.plist
```

## Adapting for Murph (or any other event)

Change `--event` and `--backup` in the plist. The plist `Label` should also change (one job per event). See the plist for the exact strings.

## Pre-event smoke validation

Tested against the May 16 Murph rehearsal data:
- Backup file: 25 lines (3 pre-workout tests + 22 real)
- D1 after rehearsal: 22 rows
- `--since 2026-05-16T09:00:00-04:00` (filters out the pre-workout tests): **22 local, 22 server, 0 missing** ✓
- `--since 2026-05-16T00:00:00-04:00` (catches them): **25 local, 22 server, 3 missing** detected with `WOULD REPLAY` lines ✓

## Gotchas

- **Cloudflare 403 on Python urllib.** The Worker is behind Cloudflare's bot detection. The script sends `User-Agent: ironhike-reconcile/1.0` to slip through. If Cloudflare ever blocks the UA, change `USER_AGENT` in `reconcile.py`.
- **iCloud sync lag.** The backup file is whatever has synced from the iPhone to the Mac. If the phone is offline for a stretch, the cron can't see the missing rows until iCloud syncs. Trail dead zones are real.
- **Tolerance.** 5 seconds. If the iPhone clock and the Worker clock drift by more than this on the same tap, you'll get false-positive replays (duplicate rows in D1 for the same physical tap). The dashboard's "POSSIBLE DUPLICATE" detector (45s window) would surface this; you'd `/lap/delete` the extra.
- **Plist secret.** The plist itself contains NO secrets — they live in Keychain. Safe to commit.

## Why no inbox-driven LLM variant

That was a separate idea floated alongside this one. Decision: ship reconciliation alone for IronHike. An LLM running unattended with Bash+Edit authority is a different risk profile and shouldn't ride along with a 72-hour race-day deployment. See `2026 IronHike Everest/README.md` for the rationale.
