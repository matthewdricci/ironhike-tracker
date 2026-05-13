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

## Simulation mode (QA before race day)

The dashboard supports query params for pre-race testing without touching the real Google Sheet:

- `?sim=NAME` — loads pre-baked CSVs from `sim/` and a matching simulated "now". Available names: `ontrack`, `ahead`, `behind`, `resting`, `finished`, `cutoff-passed`.
- `?simNow=2026-06-06T03:00:00-04:00` — time-travel. Pretends "now" is this moment. Works with real Google Sheet data too.
- Both params can combine: `?sim=ontrack&simNow=2026-06-05T22:00:00-04:00` overrides the scenario's default sim time.

**Scenario menu:** open `/sim/` in the browser for a tappable list of all scenarios.

**Sim banner:** when either param is active, a yellow banner appears at the top of the dashboard.

**Regenerating scenarios:** `python3 sim/generate.py` rebuilds the CSVs and `manifest.json`.

## Local development

GitHub Pages serves over HTTPS, but browsers block `fetch` from `file://` origins. To test locally:

```
cd ironhike-tracker
python3 -m http.server 8000
# then open http://localhost:8000/ or http://localhost:8000/sim/
```

## Push notifications

Self-hosted Web Push via a tiny Cloudflare Worker in `push-worker/`. Pattern ported from `bth-messaging-agent`. The Worker stores subscriptions in D1 and signs/encrypts pushes with VAPID. iPhone Shortcut hits `/notify` with a shared-secret bearer token; Worker fans out to every subscribed device.

See vault notes `Push setup.md` for full details on endpoints, secrets, and maintenance.

## Stack

Plain HTML/CSS/JS. Chart.js via CDN. No build step. Push backend on Cloudflare Workers + D1.
