-- ============================================================
-- 0002 — session drafts
--
-- Adds the table behind "Save session" on the leave-a-case dialog.
-- New deployments do not need this: schema.sql already contains it.
--
-- Run once against each database that predates the feature:
--
--   npm run db:migrate:drafts           (local)
--   npm run db:migrate:drafts:remote    (production)
--
-- Unlike 0001 this one is safely re-runnable — it is a single
-- CREATE TABLE IF NOT EXISTS and adds no columns to an existing table.
--
-- Nothing here touches case_log. XP, ranks and the streak are computed
-- from that table alone and are unaffected by anything below: a draft
-- is where a conversation got to, not what it scored.
-- ============================================================

CREATE TABLE IF NOT EXISTS session_drafts (
  detective_id INTEGER NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  case_id      INTEGER NOT NULL,
  mode         TEXT    NOT NULL,
  transcript   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (detective_id, case_id)
);
