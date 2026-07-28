-- ============================================================
-- 0001 — access tiers
--
-- Brings a database created before invite codes existed up to the shape
-- in schema.sql. New deployments do not need this: schema.sql already
-- contains everything below.
--
-- Run once against each database that predates the feature:
--
--   npm run db:migrate           (local)
--   npm run db:migrate:remote    (production)
--
-- RUN ONCE is not a style note. SQLite has no `ADD COLUMN IF NOT EXISTS`,
-- so the ALTER below fails loudly on a second run with "duplicate column
-- name: access_code". That error means the migration already applied and
-- nothing is wrong — the CREATE TABLE and CREATE INDEX either side of it
-- are both idempotent.
-- ============================================================

ALTER TABLE detectives ADD COLUMN access_code TEXT COLLATE NOCASE;

CREATE TABLE IF NOT EXISTS invite_codes (
  code         TEXT    PRIMARY KEY COLLATE NOCASE,
  label        TEXT    NOT NULL DEFAULT '',
  cap_usd      REAL    NOT NULL,
  spent_usd    REAL    NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_detectives_access_code
  ON detectives (access_code);
