-- Phase 4a: backup verification, off-site copies and retention (Implement.md §6.10, D25).
-- backup_runs is an operational log, not a ledger: rows are updated when a file is pruned.

ALTER TABLE backup_runs ADD COLUMN sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64);
ALTER TABLE backup_runs ADD COLUMN schema_version INTEGER;            -- PRAGMA user_version inside the file
ALTER TABLE backup_runs ADD COLUMN audit_seq INTEGER;                 -- audit chain head inside the file
ALTER TABLE backup_runs ADD COLUMN audit_hash TEXT CHECK (audit_hash IS NULL OR length(audit_hash) = 64);
ALTER TABLE backup_runs ADD COLUMN verified_at INTEGER;               -- integrity_check + audit chain passed
ALTER TABLE backup_runs ADD COLUMN offsite_path TEXT;                 -- copy in the off-site folder (USB/NAS/sync)
ALTER TABLE backup_runs ADD COLUMN offsite_error TEXT;
ALTER TABLE backup_runs ADD COLUMN deleted_at INTEGER;                -- file removed by retention

CREATE INDEX ix_backup_runs_started ON backup_runs (started_at);
