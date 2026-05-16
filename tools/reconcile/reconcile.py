#!/usr/bin/env python3
"""
Reconcile the local iCloud backup file against the Worker D1 state.

For each timestamp in the local backup that lacks a server counterpart within
TOLERANCE_SECONDS, POST /lap with push=false to replay it. Silent unless
action was taken — when rows are replayed, sends a single summary push.

Secret is pulled from macOS Keychain (item name: ironhike-notify-secret).
Add it once with:
  security add-generic-password -s ironhike-notify-secret -a "$USER" -w '<SECRET>'

Usage:
  reconcile.py --event ironhike \\
               --since 2026-06-04T12:00:00-04:00 \\
               --backup "/Users/matthewricci/Library/Mobile Documents/com~apple~CloudDocs/Automations/IronHike-backup.txt"
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
import urllib.request

WORKER = "https://ironhike-push.beyond-the-hudson-918.workers.dev"
TOLERANCE_SECONDS = 5


def parse_iso(s: str):
    s = s.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.datetime.fromisoformat(s)
    except ValueError:
        return None


def get_secret() -> str:
    # Prefer env var (useful for ad-hoc runs); fall back to Keychain.
    env = os.environ.get("NOTIFY_SECRET")
    if env:
        return env.strip()
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "ironhike-notify-secret", "-w"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        sys.stderr.write(
            "Secret not found. Set NOTIFY_SECRET env var or run:\n"
            "  security add-generic-password -s ironhike-notify-secret -a \"$USER\" -w '<SECRET>'\n"
        )
        sys.exit(2)
    return result.stdout.strip()


USER_AGENT = "ironhike-reconcile/1.0"


def fetch_server_laps(event: str):
    req = urllib.request.Request(f"{WORKER}/laps?event={event}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    out = []
    for row in data.get("laps", []):
        ts = parse_iso(row.get("timestamp_iso", ""))
        if ts:
            out.append(ts)
    return out


def post_lap(event: str, ts_iso: str, secret: str):
    req = urllib.request.Request(
        f"{WORKER}/lap",
        data=json.dumps({"event": event, "timestamp_iso": ts_iso, "push": False}).encode(),
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def push_summary(secret: str, event: str, replayed_count: int):
    req = urllib.request.Request(
        f"{WORKER}/notify",
        data=json.dumps({
            "title": "Reconcile",
            "body": f"{event}: replayed {replayed_count} missing tap(s) from local backup",
            "url": f"https://matthewdricci.github.io/{event}-tracker/",
        }).encode(),
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", required=True, help="Event name (ironhike, murph, ...)")
    ap.add_argument("--since", required=True, help="ISO timestamp; ignore backup entries before this")
    ap.add_argument("--backup", required=True, help="Path to iCloud-synced backup file")
    ap.add_argument("--dry-run", action="store_true", help="Report what would be replayed; don't POST")
    args = ap.parse_args()

    secret = get_secret()

    since = parse_iso(args.since)
    if since is None:
        sys.stderr.write(f"Could not parse --since: {args.since!r}\n")
        sys.exit(2)

    # Read local backup
    try:
        with open(args.backup) as f:
            local_ts = []
            for line in f:
                ts = parse_iso(line)
                if ts:
                    local_ts.append(ts)
    except FileNotFoundError:
        local_ts = []

    local_ts = [t for t in local_ts if t >= since]
    local_ts.sort()

    server_ts = fetch_server_laps(args.event)

    missing = []
    for lt in local_ts:
        if not any(abs((lt - st).total_seconds()) <= TOLERANCE_SECONDS for st in server_ts):
            missing.append(lt)

    stamp = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    print(f"[{stamp}] event={args.event} since={args.since} local_in_window={len(local_ts)} server={len(server_ts)} missing={len(missing)}")

    if not missing:
        return

    if args.dry_run:
        for m in missing:
            print(f"  WOULD REPLAY: {m.isoformat()}")
        return

    replayed = 0
    for m in missing:
        try:
            r = post_lap(args.event, m.isoformat(), secret)
            replayed += 1
            print(f"  REPLAYED: {m.isoformat()} → id={r.get('lap', {}).get('id')}")
        except Exception as e:
            print(f"  REPLAY FAILED for {m.isoformat()}: {e}")

    if replayed:
        push_summary(secret, args.event, replayed)
        print(f"  pushed summary notification")


if __name__ == "__main__":
    main()
