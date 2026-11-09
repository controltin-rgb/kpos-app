-- Standard bar-screen workflow (D49): paid bill → NEW → PREPARING → READY → served.

-- "Paid = done at once" (D40) is switched off for every shop; it can still be switched on in Settings.
UPDATE settings SET value_json = 'false', rev = rev + 1 WHERE key = 'kds.complete_on_pay' AND value_json <> 'false';

-- per-drink check-off while preparing
ALTER TABLE kds_tickets ADD COLUMN item_done_at INTEGER;
-- set only when the bar bumps a READY ticket (not for "done at payment"), so the last served bill can be recalled
ALTER TABLE kds_tickets ADD COLUMN bumped_at INTEGER;
CREATE INDEX ix_kds_tickets_bumped ON kds_tickets (branch_id, station, bumped_at) WHERE bumped_at IS NOT NULL;
