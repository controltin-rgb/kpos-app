-- Phase 4c-2: Client offline selling (Implement.md §2, D27, D36).

-- bill numbers reserved for a Client belong to one numbering period (D14 reset policy):
-- '' when numbers never reset, else the period key (e.g. '691107' daily, '6911' monthly, '69' yearly)
ALTER TABLE bill_number_blocks ADD COLUMN period TEXT NOT NULL DEFAULT '';
ALTER TABLE bill_number_blocks ADD COLUMN prefix TEXT NOT NULL DEFAULT '';
CREATE INDEX ix_bill_blocks_period ON bill_number_blocks (device_id, period);

-- bills sold on a Client while the Host was down: when the Host received them (NULL = sold online)
ALTER TABLE bills ADD COLUMN synced_at INTEGER;
