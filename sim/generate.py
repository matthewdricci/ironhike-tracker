#!/usr/bin/env python3
"""Generate simulated race data for QA-ing the dashboard before race day.

Each scenario writes <name>-laps.csv and <name>-config.csv to this directory.
Run from repo root or this folder — paths are relative to this script.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
EDT = timezone(timedelta(hours=-4))
START = datetime(2026, 6, 4, 12, 0, 0, tzinfo=EDT)

CONFIG_ROWS = [
    ("key", "value"),
    ("start_iso",            START.isoformat()),
    ("cutoff_iso",           (START + timedelta(hours=72)).isoformat()),
    ("total_laps",           "49"),
    ("elevation_ft_per_lap", "595"),
    ("athlete_name",         "Matt Ricci (SIM)"),
]

def write_csv(path, rows):
    path.write_text("\n".join(",".join(str(c) for c in r) for r in rows) + "\n")

def write_config(name):
    write_csv(HERE / f"{name}-config.csv", CONFIG_ROWS)

SCENARIOS = {}  # populated by laps_csv()

def laps_csv(name, lap_intervals_min, post_last_gap_min=30, notes=None):
    """lap_intervals_min: list of minute-gaps between laps (first gap is from START).
    post_last_gap_min: how long ago the last lap was, relative to simNow.
    notes: optional dict {lap_index_1based: note}
    """
    rows = [("timestamp_iso", "note")]
    t = START
    notes = notes or {}
    for i, gap in enumerate(lap_intervals_min, start=1):
        t = t + timedelta(minutes=gap)
        rows.append((t.isoformat(), notes.get(i, "")))
    write_csv(HERE / f"{name}-laps.csv", rows)
    sim_now = t + timedelta(minutes=post_last_gap_min)
    SCENARIOS[name] = {
        "laps_done": len(lap_intervals_min),
        "last_lap_iso": t.isoformat(),
        "sim_now_iso": sim_now.isoformat(),
    }
    return t

def build(name, blocks, post_last_gap_min=30):
    """Build a scenario from blocks. Each block is either:
        ("lap", N, avg_min)      → N laps, each `avg_min` minutes apart
        ("rest", minutes)         → one extended gap before the next lap
    Note: a 'rest' block prepends extra minutes to the NEXT lap's gap.
    """
    intervals = []
    pending_rest = 0
    for block in blocks:
        if block[0] == "rest":
            pending_rest += block[1]
        elif block[0] == "lap":
            _, n, avg = block
            for _ in range(n):
                intervals.append(avg + pending_rest)
                pending_rest = 0
    write_config(name)
    laps_csv(name, intervals, post_last_gap_min=post_last_gap_min)

def gen():
    # On-pace. 22 laps in ~32h, projects to ~72h (right at cutoff).
    build("ontrack", [
        ("lap", 9, 65),
        ("rest", 300),
        ("lap", 6, 72),
        ("rest", 90),
        ("lap", 7, 72),
    ], post_last_gap_min=30)

    # Lots of rest, slow. 18 laps in ~44h, projected way over cutoff.
    build("behind", [
        ("lap", 7, 110),       # 7 slow laps
        ("rest", 480),          # 8h overslept
        ("lap", 5, 125),
        ("rest", 360),          # 6h nap
        ("lap", 6, 135),       # → 18 laps
    ], post_last_gap_min=20)

    # Crushing it. 32 laps in ~41h, projects to ~63h. +9h buffer.
    build("ahead", [
        ("lap", 9, 55),
        ("rest", 180),
        ("lap", 9, 65),
        ("rest", 120),
        ("lap", 14, 75),       # → 32 laps
    ], post_last_gap_min=40)

    # Currently resting. 14 laps in ~24h, last lap 2h 45m ago.
    build("resting", [
        ("lap", 7, 85),
        ("rest", 300),
        ("lap", 7, 90),        # → 14 laps
    ], post_last_gap_min=165)

    # Victory. 49/49, last lap ~90 min before cutoff.
    build("finished", [
        ("lap", 9, 60),
        ("rest", 240),
        ("lap", 9, 68),
        ("rest", 120),
        ("lap", 10, 72),
        ("rest", 180),
        ("lap", 9, 76),
        ("rest", 120),
        ("lap", 12, 80),       # → 49 laps
    ], post_last_gap_min=90)

    # DNF. 46/49. Last lap well before cutoff; athlete couldn't make the final 3.
    # SimNow is 60 min past cutoff (Sun 1pm).
    build("cutoff-passed", [
        ("lap", 9, 60),
        ("rest", 240),
        ("lap", 9, 68),
        ("rest", 120),
        ("lap", 10, 72),
        ("rest", 180),
        ("lap", 9, 76),
        ("rest", 120),
        ("lap", 9, 80),        # → 46 laps (stop 3 short of the 49 in "finished")
    ])
    cutoff = START + timedelta(hours=72)
    SCENARIOS["cutoff-passed"]["sim_now_iso"] = (cutoff + timedelta(minutes=60)).isoformat()

    # Write the manifest the dashboard reads to know each scenario's simNow.
    import json
    (HERE / "manifest.json").write_text(json.dumps(SCENARIOS, indent=2) + "\n")

if __name__ == "__main__":
    gen()
    for n, info in SCENARIOS.items():
        elapsed_h = (datetime.fromisoformat(info["sim_now_iso"]) - START).total_seconds() / 3600
        print(f"  {n:16s} laps={info['laps_done']:2d}  simNow={info['sim_now_iso']}  ({elapsed_h:.1f}h in)")
