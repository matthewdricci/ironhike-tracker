CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint     TEXT PRIMARY KEY,
  keys_p256dh  TEXT NOT NULL,
  keys_auth    TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS laps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event         TEXT NOT NULL,
  timestamp_iso TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_laps_event_ts ON laps (event, timestamp_iso);
