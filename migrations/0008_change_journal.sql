-- Phase 4d: point-in-time restore (Implement.md §6.10 Tier B/C, D38).
-- Every row change on the live DB is captured by TEMP triggers (installed by the app at start, so they
-- never end up inside a backup) into change_journal, shipped every 10 s to segment files next to the
-- backups (and the off-site folder), then removed here. A restore = snapshot + replay up to a time.

CREATE TABLE change_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,                -- contiguous: rolled-back inserts give their number back
  at  INTEGER NOT NULL,                                 -- ms; shared by every row written in one synchronous run
  tbl TEXT    NOT NULL,
  op  TEXT    NOT NULL CHECK (op IN ('i', 'u', 'd')),
  k   TEXT,                                             -- JSON primary key of the old row (u, d)
  d   TEXT                                              -- JSON of the new row (i, u)
) STRICT;

-- which journal line ("timeline") this database file belongs to; a new one starts after a restore
-- or a migration, so a timeline always has one schema and one continuous history
CREATE TABLE journal_state (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  timeline       TEXT    NOT NULL,
  schema_version INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  reason         TEXT    NOT NULL
) STRICT;

ALTER TABLE backup_runs ADD COLUMN journal_timeline TEXT;  -- journal_state.timeline inside the file
ALTER TABLE backup_runs ADD COLUMN journal_seq INTEGER;    -- last journal seq already contained in the file
