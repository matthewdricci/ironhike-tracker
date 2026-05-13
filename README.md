# IronHike 2026 Lap Tracker

One-off live dashboard for Matt Ricci's IronHike Spring 2026 Everest attempt — Mohawk Mountain Ski Area, Cornwall, CT, June 4–7, 2026 (49 laps, 29,155 ft).

## How it works

```
[iPhone Shortcut tap] → [Google Sheet row] → [published CSV] → [this static page]
```

- **Logging:** an Apple Shortcut on Matt's iPhone appends a row (timestamp) to the `laps` tab of a Google Sheet.
- **Backend:** none. The Sheet is published-to-web as CSV and fetched client-side every 60s.
- **Erase a mis-tap:** open Google Sheets iOS app, delete the row.
- **Dashboard:** static HTML/JS/CSS, hosted on GitHub Pages. Auto-refreshes.

## Setup (one time)

1. Create a Google Sheet `IronHike 2026 — Laps` with two tabs (see `Sheet schema.md` in the vault notes).
2. Publish both tabs to web as CSV. Copy the two URLs.
3. Edit `app.js` and replace `REPLACE_WITH_LAPS_CSV_URL` and `REPLACE_WITH_CONFIG_CSV_URL`.
4. Push to a new GitHub repo `ironhike-tracker`, enable Pages from `main` branch root.
5. Build the Apple Shortcut following the vault notes — it appends `[now_iso, ""]` to the `laps` tab.

## Stats shown

- Laps done / 49 + elevation climbed
- Elapsed time / time to cutoff
- **Budget**: lap interval you must hit from here to finish on time
- **Actual**: cumulative pace including all rest
- **Projected buffer** (or deficit) vs. cutoff
- Time since last summit + Active/Resting status (45-min threshold)
- Chart: cumulative laps vs. required-pace diagonal

## Stack

Plain HTML/CSS/JS. Chart.js via CDN. No build step.
