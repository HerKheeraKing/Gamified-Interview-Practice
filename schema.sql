-- ============================================================
-- The Interview Case Files — D1 schema
--
-- Two tables, one job each:
--   detectives  - who you are
--   case_log    - what you've done
--
-- Passwordless today: password_hash / password_salt stay NULL and
-- the Worker treats a NULL hash as "no credential required". Adding
-- passwords later is a data change, not a schema migration — every
-- column the credential flow needs already exists.
-- ============================================================

CREATE TABLE IF NOT EXISTS detectives (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  created_at    TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL
);

-- Sessions are separated from detectives so a future password flow can
-- revoke a single device without touching the account row.
CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT    PRIMARY KEY,
  detective_id INTEGER NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_detective
  ON sessions (detective_id);

-- entry_uid is generated client-side. It makes the sync push idempotent:
-- the same entry can be re-sent any number of times (offline retries,
-- two tabs, a device that synced then went away) without duplicating.
CREATE TABLE IF NOT EXISTS case_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  detective_id   INTEGER NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  entry_uid      TEXT    NOT NULL,
  case_id        INTEGER NOT NULL,
  question_short TEXT    NOT NULL,
  date_label     TEXT    NOT NULL,
  logged_at      TEXT    NOT NULL,
  raw_score      INTEGER NOT NULL,
  bonus          INTEGER NOT NULL,
  xp             INTEGER NOT NULL,
  UNIQUE (detective_id, entry_uid)
);

CREATE INDEX IF NOT EXISTS idx_case_log_detective
  ON case_log (detective_id, logged_at);
