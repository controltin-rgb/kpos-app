-- 0005_promotions.sql — itemised bill discounts, member consent and lifetime points

-- One row per discount applied to a bill: automatic promotions (several may combine, D21), coupons,
-- manual discounts (pos:discount, audited) and point redemptions. bills.discount_satang = SUM(amount).
CREATE TABLE bill_discounts (
  id             TEXT    PRIMARY KEY,
  bill_id        TEXT    NOT NULL REFERENCES bills(id),
  kind           TEXT    NOT NULL CHECK (kind IN ('promotion', 'coupon', 'manual', 'points')),
  promotion_id   TEXT    REFERENCES promotions(id),
  coupon_id      TEXT    REFERENCES coupons(id),
  description    TEXT    NOT NULL,                 -- snapshot shown on receipts / reports
  amount_satang  INTEGER NOT NULL CHECK (amount_satang > 0),
  points         INTEGER,                          -- points redeemed (kind = 'points')
  approved_by    TEXT    REFERENCES users(id),     -- manual discount above the cashier's limit
  created_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_bill_discounts_bill ON bill_discounts (bill_id);
CREATE INDEX ix_bill_discounts_promotion ON bill_discounts (promotion_id) WHERE promotion_id IS NOT NULL;

-- PDPA: members are stored only with consent (docs/design/Promo.dc.html)
ALTER TABLE members ADD COLUMN consent_at INTEGER;
-- cache of points ever earned (net of reversals); drives the member tier
ALTER TABLE members ADD COLUMN lifetime_points INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0);
