-- 0002_auth.sql — BetterAuth tables + link to users
--
-- auth_* tables are owned by BetterAuth (session + password storage). Their column names and
-- value formats follow BetterAuth's schema exactly (camelCase, dates stored as ISO-8601 TEXT),
-- which is the one documented exception to D2 (docs/decisions.md D11). Domain code must not
-- read or write these tables directly — go through src/main/auth.
-- Verified against better-auth 1.7 by tests/auth/better-auth-schema.test.ts.

CREATE TABLE auth_user (
  id             TEXT    NOT NULL PRIMARY KEY,
  name           TEXT    NOT NULL,
  email          TEXT    NOT NULL UNIQUE,         -- synthetic: <users.id>@kposs.local
  emailVerified  INTEGER NOT NULL,
  image          TEXT,
  createdAt      TEXT    NOT NULL,
  updatedAt      TEXT    NOT NULL
) STRICT;

CREATE TABLE auth_session (
  id         TEXT NOT NULL PRIMARY KEY,
  expiresAt  TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  ipAddress  TEXT,
  userAgent  TEXT,
  userId     TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE
) STRICT;
CREATE INDEX auth_session_userId_idx ON auth_session (userId);

CREATE TABLE auth_account (
  id                     TEXT NOT NULL PRIMARY KEY,
  accountId              TEXT NOT NULL,
  providerId             TEXT NOT NULL,
  userId                 TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  accessToken            TEXT,
  refreshToken           TEXT,
  idToken                TEXT,
  accessTokenExpiresAt   TEXT,
  refreshTokenExpiresAt  TEXT,
  scope                  TEXT,
  password               TEXT,                    -- BetterAuth scrypt hash
  createdAt              TEXT NOT NULL,
  updatedAt              TEXT NOT NULL
) STRICT;
CREATE INDEX auth_account_userId_idx ON auth_account (userId);

CREATE TABLE auth_verification (
  id          TEXT NOT NULL PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  expiresAt   TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
) STRICT;
CREATE INDEX auth_verification_identifier_idx ON auth_verification (identifier);

-- passwords now live in auth_account (BetterAuth); PIN stays in users.pin_hash
ALTER TABLE users DROP COLUMN password_hash;
ALTER TABLE users ADD COLUMN auth_user_id TEXT REFERENCES auth_user (id);
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
CREATE UNIQUE INDEX ux_users_auth_user ON users (auth_user_id) WHERE auth_user_id IS NOT NULL;
