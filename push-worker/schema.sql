CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint     TEXT PRIMARY KEY,
  keys_p256dh  TEXT NOT NULL,
  keys_auth    TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
