-- System menu (About / User manual) and new permissions.
-- The built-in manual ships with the app (src/shared/manual.ts); a row here is a shop's own edit of a
-- built-in page (same slug) or a page the shop added (custom = 1). "Reset to default" deletes the row.

CREATE TABLE manual_pages (
  id          TEXT    PRIMARY KEY,
  slug        TEXT    NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 1 AND 40),
  title       TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body        TEXT    NOT NULL CHECK (length(body) <= 100000),
  sort        INTEGER NOT NULL DEFAULT 0,
  custom      INTEGER NOT NULL DEFAULT 0 CHECK (custom IN (0, 1)),
  hidden      INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT    REFERENCES users(id)
) STRICT;

-- Roles created before this version: everyone may read the manual (new installs get it from the
-- default role definitions). Super Admin / Owner are re-synced by the app at start.
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'manual:view' FROM roles WHERE key IN ('branch_manager', 'head_barista', 'cashier');
