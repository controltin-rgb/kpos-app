-- 0004_stock_counts.sql — count lines keep a snapshot and allow "not counted yet"
--
-- 0001 required counted_qty_milli NOT NULL, so a line could not exist before it was counted, and it
-- stored only one system figure. Approving a count needs both parts of the snapshot taken when the
-- count started:
--   lot_qty_milli    = quantity in lots at snapshot time
--   system_qty_milli = lot_qty_milli − open shortages (what the system believed was on the shelf)
-- On approval lots are adjusted by (counted − lot_qty_milli) and shortages that existed at snapshot
-- time are written off (D16/D22). stock_count_lines is not append-only, so it is rebuilt.

CREATE TABLE stock_count_lines_v2 (
  id                 TEXT    PRIMARY KEY,
  count_id           TEXT    NOT NULL REFERENCES stock_counts(id),
  ingredient_id      TEXT    NOT NULL REFERENCES ingredients(id),
  system_qty_milli   INTEGER NOT NULL,
  lot_qty_milli      INTEGER NOT NULL CHECK (lot_qty_milli >= 0),
  counted_qty_milli  INTEGER CHECK (counted_qty_milli IS NULL OR counted_qty_milli >= 0),
  reason             TEXT,
  counted_at         INTEGER,
  UNIQUE (count_id, ingredient_id)
) STRICT;

INSERT INTO stock_count_lines_v2 (id, count_id, ingredient_id, system_qty_milli, lot_qty_milli, counted_qty_milli, reason)
SELECT id, count_id, ingredient_id, system_qty_milli, max(system_qty_milli, 0), counted_qty_milli, reason FROM stock_count_lines;

DROP TABLE stock_count_lines;
ALTER TABLE stock_count_lines_v2 RENAME TO stock_count_lines;
CREATE INDEX ix_stock_count_lines_count ON stock_count_lines (count_id);
