-- Client-only local database (D33, D36): NOT the shop database. It holds what a Client needs to keep
-- selling while the Host is unreachable, and the bills waiting to be sent back.

-- latest snapshot from the Host (prices, recipes, promotions, settings) as JSON
CREATE TABLE kv (
  key         TEXT    PRIMARY KEY,
  value_json  TEXT    NOT NULL CHECK (json_valid(value_json)),
  updated_at  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- bill number blocks reserved by the Host for this device (D27)
CREATE TABLE bill_blocks (
  id          TEXT    PRIMARY KEY,
  period      TEXT    NOT NULL,
  prefix      TEXT    NOT NULL,
  from_no     INTEGER NOT NULL,
  to_no       INTEGER NOT NULL,
  next_no     INTEGER NOT NULL,
  CHECK (to_no >= from_no),
  CHECK (next_no BETWEEN from_no AND to_no + 1)
) STRICT;

-- bills sold offline, waiting for (or already accepted by) the Host
CREATE TABLE outbox (
  id           TEXT    PRIMARY KEY,               -- bill id (= checkout requestId)
  bill_no      TEXT    NOT NULL UNIQUE,
  payload_json TEXT    NOT NULL CHECK (json_valid(payload_json)),
  detail_json  TEXT    NOT NULL CHECK (json_valid(detail_json)),   -- what the POS printed
  total_satang INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'duplicate', 'rejected')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  sent_at      INTEGER
) STRICT;
CREATE INDEX ix_outbox_status ON outbox (status, created_at);
