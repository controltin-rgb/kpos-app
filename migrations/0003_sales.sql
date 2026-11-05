-- 0003_sales.sql — branch letter codes (D14) and stock shortages (D16)

-- D14: branch code = letter by the order branches were recorded (A, B, C …); bill numbers start with it.
-- Two steps so the UNIQUE (company_id, code) constraint never sees a transient duplicate.
UPDATE branches SET code = '~' || id;
UPDATE branches SET code = (
  SELECT char(64 + x.rn)
  FROM (SELECT id, row_number() OVER (PARTITION BY company_id ORDER BY created_at, id) AS rn FROM branches) AS x
  WHERE x.id = branches.id
);

-- D16: quantity a sale needed but no lot could supply ("สต็อกค้างตัด").
-- Settled later from the next lot received (stock_ledger rows with reason 'sale',
-- ref_type 'stock_shortage', ref_id = this id) or written off by an approved stock count (phase 3).
CREATE TABLE stock_shortages (
  id             TEXT    PRIMARY KEY,
  branch_id      TEXT    NOT NULL REFERENCES branches(id),
  ingredient_id  TEXT    NOT NULL REFERENCES ingredients(id),
  qty_milli      INTEGER NOT NULL CHECK (qty_milli > 0),
  settled_milli  INTEGER NOT NULL DEFAULT 0 CHECK (settled_milli >= 0),
  status         TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled', 'written_off')),
  ref_type       TEXT    NOT NULL,                -- bill_item | waste_record
  ref_id         TEXT    NOT NULL,
  created_by     TEXT    REFERENCES users(id),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (settled_milli <= qty_milli),
  CHECK (status <> 'settled' OR settled_milli = qty_milli)
) STRICT;
CREATE INDEX ix_stock_shortages_open ON stock_shortages (ingredient_id, created_at) WHERE status = 'open';
CREATE INDEX ix_stock_shortages_ref ON stock_shortages (ref_type, ref_id);
