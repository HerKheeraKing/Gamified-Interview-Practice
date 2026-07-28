-- ============================================================
-- The Interview Case Files — D1 schema
--
-- Four tables, one job each:
--   detectives    - who you are
--   sessions      - which devices are signed in as you
--   case_log      - what you've done
--   invite_codes  - who may spend money on AI coaching, and how much
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
  last_seen_at  TEXT    NOT NULL,
  -- The invite code this account redeemed, if any. Nullable because the
  -- free tier is the default and needs no row of its own: manual scoring
  -- and Send to Claude cost nothing, so an account with NULL here is a
  -- complete, working account rather than a half-provisioned one.
  --
  -- Not a foreign key on purpose. Deleting a spent code should not cascade
  -- into deleting the detectives who used it; they simply fall back to the
  -- free tier, which is exactly the behaviour a revoked code should have.
  access_code   TEXT    COLLATE NOCASE
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

-- ============================================================
-- Invite codes: the spend cap on AI coaching.
--
-- One row is one budget, not one person. A code handed to three beta
-- testers gives them a shared $0.50, which is the honest shape of the
-- thing being limited — the API bill does not care who typed the answer.
--
-- spent_usd is real money: token counts from each turn priced against
-- Anthropic's published per-model rates, not a request counter. Two
-- turns of the same length cost the same, and a rambling turn costs
-- more than a terse one, because that is what actually gets billed.
--
-- REAL rather than INTEGER cents because cache-read tokens are priced at
-- $0.20/MTok — a single turn can legitimately cost a fraction of a cent,
-- and rounding those to zero would let an unbounded number of them
-- through for free.
-- ============================================================
CREATE TABLE IF NOT EXISTS invite_codes (
  code         TEXT    PRIMARY KEY COLLATE NOCASE,
  label        TEXT    NOT NULL DEFAULT '',
  cap_usd      REAL    NOT NULL,
  spent_usd    REAL    NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0,
  -- Revocation that survives a refund. Setting active = 0 stops a code
  -- immediately without touching spent_usd, so the history of what it
  -- cost stays readable after it is switched off.
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_detectives_access_code
  ON detectives (access_code);
