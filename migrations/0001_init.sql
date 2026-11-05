-- 0001_init.sql — KPOSS initial schema
--
-- Conventions (docs/decisions.md):
--   * every table is STRICT
--   * id        TEXT    UUIDv7 primary key
--   * *_at      INTEGER epoch milliseconds (UTC)
--   * *_satang  INTEGER money in satang (1 baht = 100)
--   * *_milli   INTEGER quantity in 1/1000 of the base unit (ml, g, pcs); multipliers too (1.0x = 1000)
--   * *_bp      INTEGER basis points (1% = 100)
--   * master data: created_at, updated_at, deleted_at (soft delete), rev (sync version)
--   * append-only: stock_ledger, cash_ledger, bill_events, audit_log, point_ledger
-- Do not put BEGIN/COMMIT in migration files: the runner wraps the whole batch in one transaction.
-- Never edit this file after release; add 0002_*.sql instead.

-- ===========================================================================
-- Organization, devices, users, permissions
-- ===========================================================================

CREATE TABLE companies (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  tax_id      TEXT,
  address     TEXT,
  phone       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE branches (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL REFERENCES companies(id),
  code          TEXT    NOT NULL,                 -- short code used in document numbers
  name          TEXT    NOT NULL,
  tax_branch_no TEXT,                             -- e.g. '00000' = head office (Revenue Dept. format)
  address       TEXT,
  phone         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  rev           INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, code)
) STRICT;

CREATE TABLE devices (
  id            TEXT    PRIMARY KEY,
  branch_id     TEXT    NOT NULL REFERENCES branches(id),
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('standalone', 'host', 'client')),
  kind          TEXT    NOT NULL DEFAULT 'pos' CHECK (kind IN ('pos', 'kds', 'cfd', 'office')),
  hardware_id   TEXT    NOT NULL,
  token_hash    TEXT,                             -- LAN API token (hash only)
  registered_by TEXT,                             -- users.id (no FK: device may be registered before users exist)
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  UNIQUE (branch_id, hardware_id)
) STRICT;

CREATE TABLE roles (
  id                   TEXT    PRIMARY KEY,
  key                  TEXT    UNIQUE,            -- system roles: super_admin | owner | branch_manager | head_barista | cashier
  name                 TEXT    NOT NULL,
  description          TEXT,
  is_system            INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  rank                 INTEGER NOT NULL DEFAULT 0, -- higher = more senior; a user may only manage roles of lower rank
  max_discount_bp      INTEGER NOT NULL DEFAULT 0 CHECK (max_discount_bp BETWEEN 0 AND 10000),
  max_discount_satang  INTEGER NOT NULL DEFAULT 0 CHECK (max_discount_satang >= 0),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,
  rev                  INTEGER NOT NULL DEFAULT 1,
  CHECK (is_system = 0 OR key IS NOT NULL)
) STRICT;

CREATE TABLE role_permissions (
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL CHECK (permission GLOB '[a-z]*:[a-z]*' OR permission = '*'),
  PRIMARY KEY (role_id, permission)
) STRICT, WITHOUT ROWID;

CREATE TABLE users (
  id                 TEXT    PRIMARY KEY,
  branch_id          TEXT    NOT NULL REFERENCES branches(id),   -- home branch
  role_id            TEXT    NOT NULL REFERENCES roles(id),
  username           TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  display_name       TEXT    NOT NULL,
  email              TEXT    COLLATE NOCASE UNIQUE,
  phone              TEXT,
  password_hash      TEXT,
  pin_hash           TEXT,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until       INTEGER,
  last_login_at      INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  rev                INTEGER NOT NULL DEFAULT 1
) STRICT;

-- extra branches a user may work in (Design-Spec §2: employee_branch_access)
CREATE TABLE user_branch_access (
  user_id     TEXT    NOT NULL REFERENCES users(id),
  branch_id   TEXT    NOT NULL REFERENCES branches(id),
  role_id     TEXT    NOT NULL REFERENCES roles(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, branch_id)
) STRICT, WITHOUT ROWID;

-- branch_id NULL = global setting
CREATE TABLE settings (
  id          TEXT    PRIMARY KEY,
  branch_id   TEXT    REFERENCES branches(id),
  key         TEXT    NOT NULL,
  value_json  TEXT    NOT NULL CHECK (json_valid(value_json)),
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT    REFERENCES users(id),
  rev         INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX ux_settings_scope_key ON settings (ifnull(branch_id, ''), key);

CREATE TABLE licenses (
  id             TEXT    PRIMARY KEY,
  license_id     TEXT    NOT NULL,                 -- id inside the signed .LIC payload
  raw            TEXT    NOT NULL,                 -- full signed file contents
  hardware_id    TEXT    NOT NULL,
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER,
  features_json  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(features_json)),
  installed_at   INTEGER NOT NULL,
  installed_by   TEXT    REFERENCES users(id),
  replaced_at    INTEGER
) STRICT;

-- running numbers per branch and document type (bill, tax_abb, tax_full, po, receipt, count, expense, ...)
CREATE TABLE doc_sequences (
  branch_id   TEXT    NOT NULL REFERENCES branches(id),
  doc_type    TEXT    NOT NULL,
  prefix      TEXT    NOT NULL DEFAULT '',
  next_no     INTEGER NOT NULL DEFAULT 1 CHECK (next_no >= 1),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (branch_id, doc_type)
) STRICT, WITHOUT ROWID;

-- bill numbers pre-allocated to Client devices for offline selling
CREATE TABLE bill_number_blocks (
  id            TEXT    PRIMARY KEY,
  branch_id     TEXT    NOT NULL REFERENCES branches(id),
  device_id     TEXT    NOT NULL REFERENCES devices(id),
  from_no       INTEGER NOT NULL,
  to_no         INTEGER NOT NULL,
  used_to       INTEGER,                           -- last number consumed (NULL = none yet)
  issued_at     INTEGER NOT NULL,
  exhausted_at  INTEGER,
  CHECK (to_no >= from_no),
  CHECK (used_to IS NULL OR used_to BETWEEN from_no AND to_no)
) STRICT;
CREATE INDEX ix_bill_blocks_device ON bill_number_blocks (device_id, exhausted_at);

-- ===========================================================================
-- Catalog
-- ===========================================================================

CREATE TABLE categories (
  id          TEXT    PRIMARY KEY,
  branch_id   TEXT    NOT NULL REFERENCES branches(id),
  name        TEXT    NOT NULL,
  icon        TEXT,
  color       TEXT,
  kds_station TEXT,                                -- KDS routing (bar, kitchen, ...)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE products (
  id           TEXT    PRIMARY KEY,
  branch_id    TEXT    NOT NULL REFERENCES branches(id),
  category_id  TEXT    REFERENCES categories(id),
  sku          TEXT,
  barcode      TEXT,
  name         TEXT    NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'drink' CHECK (kind IN ('drink', 'food', 'retail')),
  vat_type     TEXT    NOT NULL DEFAULT 'vat7' CHECK (vat_type IN ('vat7', 'vat0', 'exempt')),
  image_path   TEXT,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  rev          INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX ux_products_sku ON products (branch_id, sku) WHERE sku IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_products_barcode ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX ix_products_category ON products (category_id);

CREATE TABLE product_sizes (
  id                    TEXT    PRIMARY KEY,
  product_id            TEXT    NOT NULL REFERENCES products(id),
  label                 TEXT    NOT NULL,          -- 16oz, 22oz, ...
  price_satang          INTEGER NOT NULL CHECK (price_satang >= 0),
  size_multiplier_milli INTEGER NOT NULL DEFAULT 1000 CHECK (size_multiplier_milli > 0),
  is_default            INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER,
  rev                   INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX ix_product_sizes_product ON product_sizes (product_id);

CREATE TABLE modifier_groups (
  id          TEXT    PRIMARY KEY,
  branch_id   TEXT    NOT NULL REFERENCES branches(id),
  name        TEXT    NOT NULL,                    -- ความหวาน, Topping, ...
  min_select  INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select  INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  kds_highlight INTEGER NOT NULL DEFAULT 0 CHECK (kds_highlight IN (0, 1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1,
  CHECK (max_select >= min_select)
) STRICT;

CREATE TABLE modifier_options (
  id            TEXT    PRIMARY KEY,
  group_id      TEXT    NOT NULL REFERENCES modifier_groups(id),
  name          TEXT    NOT NULL,
  price_satang  INTEGER NOT NULL DEFAULT 0 CHECK (price_satang >= 0),
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  rev           INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX ix_modifier_options_group ON modifier_options (group_id);

CREATE TABLE product_modifier_groups (
  product_id  TEXT    NOT NULL REFERENCES products(id),
  group_id    TEXT    NOT NULL REFERENCES modifier_groups(id),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id)
) STRICT, WITHOUT ROWID;

-- ===========================================================================
-- Inventory
-- ===========================================================================

CREATE TABLE ingredients (
  id                 TEXT    PRIMARY KEY,
  branch_id          TEXT    NOT NULL REFERENCES branches(id),
  name               TEXT    NOT NULL,
  base_unit          TEXT    NOT NULL CHECK (base_unit IN ('ml', 'g', 'pcs')),
  pack_size_milli    INTEGER NOT NULL DEFAULT 1000 CHECK (pack_size_milli > 0), -- one bottle/pack, for % remaining
  min_qty_milli      INTEGER NOT NULL DEFAULT 0 CHECK (min_qty_milli >= 0),
  has_expiry         INTEGER NOT NULL DEFAULT 0 CHECK (has_expiry IN (0, 1)),   -- 1 → FEFO, 0 → FIFO
  default_size_mode  TEXT    NOT NULL DEFAULT 'scale' CHECK (default_size_mode IN ('scale', 'fixed', 'custom')),
  is_daily_count     INTEGER NOT NULL DEFAULT 0 CHECK (is_daily_count IN (0, 1)),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  rev                INTEGER NOT NULL DEFAULT 1
) STRICT;

-- BOM line of a product
CREATE TABLE recipe_items (
  id             TEXT    PRIMARY KEY,
  product_id     TEXT    NOT NULL REFERENCES products(id),
  ingredient_id  TEXT    NOT NULL REFERENCES ingredients(id),
  qty_milli      INTEGER NOT NULL CHECK (qty_milli > 0),   -- base quantity (multiplier 1.0x)
  size_mode      TEXT    NOT NULL CHECK (size_mode IN ('scale', 'fixed', 'custom')),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  rev            INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX ix_recipe_items_product ON recipe_items (product_id);
CREATE UNIQUE INDEX ux_recipe_items_ingredient ON recipe_items (product_id, ingredient_id) WHERE deleted_at IS NULL;

-- size_mode = 'custom': explicit quantity per size
CREATE TABLE recipe_item_size_qty (
  recipe_item_id  TEXT    NOT NULL REFERENCES recipe_items(id) ON DELETE CASCADE,
  size_id         TEXT    NOT NULL REFERENCES product_sizes(id),
  qty_milli       INTEGER NOT NULL CHECK (qty_milli >= 0),
  PRIMARY KEY (recipe_item_id, size_id)
) STRICT, WITHOUT ROWID;

-- BOM of a modifier option (e.g. Topping ไข่มุก → 30 g pearls)
CREATE TABLE modifier_option_items (
  id             TEXT    PRIMARY KEY,
  option_id      TEXT    NOT NULL REFERENCES modifier_options(id),
  ingredient_id  TEXT    NOT NULL REFERENCES ingredients(id),
  qty_milli      INTEGER NOT NULL CHECK (qty_milli > 0),
  size_mode      TEXT    NOT NULL DEFAULT 'fixed' CHECK (size_mode IN ('scale', 'fixed')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  rev            INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX ix_modifier_option_items_option ON modifier_option_items (option_id);

CREATE TABLE suppliers (
  id          TEXT    PRIMARY KEY,
  branch_id   TEXT    NOT NULL REFERENCES branches(id),
  name        TEXT    NOT NULL,
  phone       TEXT,
  tax_id      TEXT,
  address     TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE purchase_orders (
  id            TEXT    PRIMARY KEY,
  branch_id     TEXT    NOT NULL REFERENCES branches(id),
  po_no         TEXT    NOT NULL,
  supplier_id   TEXT    REFERENCES suppliers(id),
  status        TEXT    NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'ordered', 'partial', 'received', 'cancelled')),
  ordered_at    INTEGER,
  expected_at   INTEGER,
  total_satang  INTEGER NOT NULL DEFAULT 0 CHECK (total_satang >= 0),
  note          TEXT,
  created_by    TEXT    NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  rev           INTEGER NOT NULL DEFAULT 1,
  UNIQUE (branch_id, po_no)
) STRICT;

CREATE TABLE purchase_order_lines (
  id                  TEXT    PRIMARY KEY,
  po_id               TEXT    NOT NULL REFERENCES purchase_orders(id),
  ingredient_id       TEXT    NOT NULL REFERENCES ingredients(id),
  qty_ordered_milli   INTEGER NOT NULL CHECK (qty_ordered_milli > 0),
  qty_received_milli  INTEGER NOT NULL DEFAULT 0 CHECK (qty_received_milli >= 0),
  line_total_satang   INTEGER NOT NULL DEFAULT 0 CHECK (line_total_satang >= 0),
  sort_order          INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX ix_po_lines_po ON purchase_order_lines (po_id);

-- one goods-receiving event (with or without a PO)
CREATE TABLE stock_receipts (
  id           TEXT    PRIMARY KEY,
  branch_id    TEXT    NOT NULL REFERENCES branches(id),
  receipt_no   TEXT    NOT NULL,
  po_id        TEXT    REFERENCES purchase_orders(id),
  supplier_id  TEXT    REFERENCES suppliers(id),
  received_by  TEXT    NOT NULL REFERENCES users(id),
  received_at  INTEGER NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (branch_id, receipt_no)
) STRICT;

CREATE TABLE stock_lots (
  id                   TEXT    PRIMARY KEY,
  branch_id            TEXT    NOT NULL REFERENCES branches(id),
  ingredient_id        TEXT    NOT NULL REFERENCES ingredients(id),
  lot_no               TEXT,
  receipt_id           TEXT    REFERENCES stock_receipts(id),
  po_line_id           TEXT    REFERENCES purchase_order_lines(id),
  source               TEXT    NOT NULL DEFAULT 'receive' CHECK (source IN ('receive', 'count_adjust', 'opening')),
  qty_received_milli   INTEGER NOT NULL CHECK (qty_received_milli > 0),
  -- running balance; must always equal SUM(stock_ledger.delta_qty_milli) for this lot (the receive row included)
  qty_remaining_milli  INTEGER NOT NULL CHECK (qty_remaining_milli >= 0),
  total_cost_satang    INTEGER NOT NULL CHECK (total_cost_satang >= 0), -- D4: cost of the whole lot
  received_at          INTEGER NOT NULL,
  expires_at           INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
) STRICT;
-- FEFO (expires_at) / FIFO (received_at). SQLite sorts NULL first on ASC: pick queries must use NULLS LAST
CREATE INDEX ix_stock_lots_pick ON stock_lots (ingredient_id, expires_at, received_at) WHERE qty_remaining_milli > 0;
CREATE INDEX ix_stock_lots_expiry ON stock_lots (branch_id, expires_at) WHERE qty_remaining_milli > 0 AND expires_at IS NOT NULL;

-- APPEND-ONLY: every stock movement, per lot
CREATE TABLE stock_ledger (
  id               TEXT    PRIMARY KEY,
  branch_id        TEXT    NOT NULL REFERENCES branches(id),
  ingredient_id    TEXT    NOT NULL REFERENCES ingredients(id),
  lot_id           TEXT    NOT NULL REFERENCES stock_lots(id),
  delta_qty_milli  INTEGER NOT NULL CHECK (delta_qty_milli <> 0),
  cost_satang      INTEGER NOT NULL,              -- signed, same sign as delta
  reason           TEXT    NOT NULL CHECK (reason IN (
                     'receive', 'sale', 'void_reversal', 'refund_reversal', 'waste', 'waste_reversal',
                     'count_adjust', 'opening', 'adjust')),
  ref_type         TEXT,                           -- bill_item | waste_record | stock_count | stock_receipt ...
  ref_id           TEXT,
  reverses_id      TEXT    REFERENCES stock_ledger(id),
  user_id          TEXT    REFERENCES users(id),
  device_id        TEXT    REFERENCES devices(id),
  created_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_stock_ledger_ingredient ON stock_ledger (ingredient_id, created_at);
CREATE INDEX ix_stock_ledger_lot ON stock_ledger (lot_id);
CREATE INDEX ix_stock_ledger_ref ON stock_ledger (ref_type, ref_id);
CREATE UNIQUE INDEX ux_stock_ledger_reverses ON stock_ledger (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE stock_counts (
  id             TEXT    PRIMARY KEY,
  branch_id      TEXT    NOT NULL REFERENCES branches(id),
  count_no       TEXT    NOT NULL,
  kind           TEXT    NOT NULL DEFAULT 'full' CHECK (kind IN ('daily', 'full')),
  status         TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  note           TEXT,
  created_by     TEXT    NOT NULL REFERENCES users(id),
  submitted_at   INTEGER,
  decided_by     TEXT    REFERENCES users(id),
  decided_at     INTEGER,
  reject_reason  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (branch_id, count_no),
  CHECK (status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
) STRICT;

CREATE TABLE stock_count_lines (
  id                  TEXT    PRIMARY KEY,
  count_id            TEXT    NOT NULL REFERENCES stock_counts(id),
  ingredient_id       TEXT    NOT NULL REFERENCES ingredients(id),
  system_qty_milli    INTEGER NOT NULL,
  counted_qty_milli   INTEGER NOT NULL CHECK (counted_qty_milli >= 0),
  reason              TEXT,                        -- required by service when counted <> system
  UNIQUE (count_id, ingredient_id)
) STRICT;

-- ===========================================================================
-- Shifts and cash drawer
-- ===========================================================================

CREATE TABLE shifts (
  id                    TEXT    PRIMARY KEY,
  branch_id             TEXT    NOT NULL REFERENCES branches(id),
  device_id             TEXT    REFERENCES devices(id),
  shift_no              TEXT    NOT NULL,
  status                TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by             TEXT    NOT NULL REFERENCES users(id),
  opened_at             INTEGER NOT NULL,
  opening_float_satang  INTEGER NOT NULL CHECK (opening_float_satang >= 0),
  closed_by             TEXT    REFERENCES users(id),
  closed_at             INTEGER,
  expected_cash_satang  INTEGER,
  counted_cash_satang   INTEGER CHECK (counted_cash_satang >= 0),
  over_short_satang     INTEGER,
  note                  TEXT,
  UNIQUE (branch_id, shift_no),
  CHECK (status = 'open' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL
         AND expected_cash_satang IS NOT NULL AND counted_cash_satang IS NOT NULL AND over_short_satang IS NOT NULL)),
  CHECK (over_short_satang IS NULL OR over_short_satang = counted_cash_satang - expected_cash_satang)
) STRICT;
-- at most one open shift per device
CREATE UNIQUE INDEX ux_shifts_open_device ON shifts (device_id) WHERE status = 'open';

-- cash counted at close, per denomination
CREATE TABLE shift_cash_counts (
  shift_id            TEXT    NOT NULL REFERENCES shifts(id),
  denomination_satang INTEGER NOT NULL CHECK (denomination_satang > 0),
  count               INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (shift_id, denomination_satang)
) STRICT, WITHOUT ROWID;

-- APPEND-ONLY: every movement of cash in/out of the drawer
CREATE TABLE cash_ledger (
  id             TEXT    PRIMARY KEY,
  branch_id      TEXT    NOT NULL REFERENCES branches(id),
  shift_id       TEXT    NOT NULL REFERENCES shifts(id),
  kind           TEXT    NOT NULL CHECK (kind IN (
                   'opening_float', 'sale', 'refund', 'void_reversal', 'cash_in', 'cash_out', 'drop', 'expense',
                   'expense_reversal')),
  amount_satang  INTEGER NOT NULL CHECK (amount_satang <> 0), -- signed: + into drawer, − out of drawer
  ref_type       TEXT,
  ref_id         TEXT,
  reverses_id    TEXT    REFERENCES cash_ledger(id),
  note           TEXT,
  user_id        TEXT    NOT NULL REFERENCES users(id),
  device_id      TEXT    REFERENCES devices(id),
  created_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_cash_ledger_shift ON cash_ledger (shift_id, created_at);
CREATE UNIQUE INDEX ux_cash_ledger_reverses ON cash_ledger (reverses_id) WHERE reverses_id IS NOT NULL;

-- ===========================================================================
-- Members and promotions
-- ===========================================================================

CREATE TABLE member_tiers (
  id                       TEXT    PRIMARY KEY,
  branch_id                TEXT    NOT NULL REFERENCES branches(id),
  name                     TEXT    NOT NULL,
  min_points               INTEGER NOT NULL DEFAULT 0 CHECK (min_points >= 0),
  points_multiplier_milli  INTEGER NOT NULL DEFAULT 1000 CHECK (points_multiplier_milli > 0),
  sort_order               INTEGER NOT NULL DEFAULT 0,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  deleted_at               INTEGER,
  rev                      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE members (
  id              TEXT    PRIMARY KEY,
  branch_id       TEXT    NOT NULL REFERENCES branches(id),  -- branch where the member registered
  phone           TEXT    NOT NULL,
  name            TEXT,
  tier_id         TEXT    REFERENCES member_tiers(id),
  points_balance  INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0), -- cache of SUM(point_ledger.delta)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  rev             INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX ux_members_phone ON members (phone) WHERE deleted_at IS NULL;

CREATE TABLE promotions (
  id           TEXT    PRIMARY KEY,
  branch_id    TEXT    NOT NULL REFERENCES branches(id),
  name         TEXT    NOT NULL,
  type         TEXT    NOT NULL CHECK (type IN ('percent', 'amount', 'buy_x_get_y')),
  value        INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0), -- percent → bp, amount → satang, buy_x_get_y → 0
  rules_json   TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(rules_json)), -- products, time windows, min spend, X/Y
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  starts_at    INTEGER,
  ends_at      INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  rev          INTEGER NOT NULL DEFAULT 1,
  CHECK (type <> 'percent' OR value <= 10000),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
) STRICT;

CREATE TABLE coupons (
  id            TEXT    PRIMARY KEY,
  branch_id     TEXT    NOT NULL REFERENCES branches(id),
  promotion_id  TEXT    NOT NULL REFERENCES promotions(id),
  code          TEXT    NOT NULL COLLATE NOCASE,
  max_uses      INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  used_count    INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  rev           INTEGER NOT NULL DEFAULT 1,
  CHECK (max_uses IS NULL OR used_count <= max_uses)
) STRICT;
CREATE UNIQUE INDEX ux_coupons_code ON coupons (branch_id, code) WHERE deleted_at IS NULL;

-- ===========================================================================
-- Sales
-- ===========================================================================

CREATE TABLE bills (
  id                 TEXT    PRIMARY KEY,
  branch_id          TEXT    NOT NULL REFERENCES branches(id),
  bill_no            TEXT    NOT NULL,
  device_id          TEXT    REFERENCES devices(id),
  shift_id           TEXT    NOT NULL REFERENCES shifts(id),
  order_type         TEXT    NOT NULL CHECK (order_type IN ('dine_in', 'takeaway', 'delivery')),
  channel            TEXT    CHECK (channel IN ('grab', 'lineman', 'shopeefood', 'foodpanda', 'other')),
  ext_order_id       TEXT,                         -- delivery platform order id, typed by staff
  status             TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void', 'refunded')),
  vat_mode           TEXT    NOT NULL CHECK (vat_mode IN ('inclusive', 'exclusive', 'none')),
  subtotal_satang    INTEGER NOT NULL DEFAULT 0,
  discount_satang    INTEGER NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
  vat_satang         INTEGER NOT NULL DEFAULT 0 CHECK (vat_satang >= 0),
  total_satang       INTEGER NOT NULL DEFAULT 0 CHECK (total_satang >= 0),
  commission_bp      INTEGER CHECK (commission_bp BETWEEN 0 AND 10000),
  commission_satang  INTEGER CHECK (commission_satang >= 0),
  member_id          TEXT    REFERENCES members(id),
  promotion_id       TEXT    REFERENCES promotions(id),
  coupon_id          TEXT    REFERENCES coupons(id),
  points_earned      INTEGER NOT NULL DEFAULT 0,
  points_redeemed    INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  created_by         TEXT    NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  paid_at            INTEGER,
  voided_at          INTEGER,
  voided_by          TEXT    REFERENCES users(id),
  void_approved_by   TEXT    REFERENCES users(id),
  void_reason        TEXT,
  updated_at         INTEGER NOT NULL,
  rev                INTEGER NOT NULL DEFAULT 1,
  UNIQUE (branch_id, bill_no),
  CHECK ((order_type = 'delivery') = (channel IS NOT NULL)),
  CHECK (status <> 'void' OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (status = 'open' OR status = 'void' OR paid_at IS NOT NULL)
) STRICT;
CREATE INDEX ix_bills_shift ON bills (shift_id);
CREATE INDEX ix_bills_created ON bills (branch_id, created_at);
CREATE INDEX ix_bills_member ON bills (member_id) WHERE member_id IS NOT NULL;

CREATE TABLE bill_items (
  id                  TEXT    PRIMARY KEY,
  bill_id             TEXT    NOT NULL REFERENCES bills(id),
  line_no             INTEGER NOT NULL CHECK (line_no >= 1),
  product_id          TEXT    NOT NULL REFERENCES products(id),
  size_id             TEXT    REFERENCES product_sizes(id),
  product_name        TEXT    NOT NULL,            -- snapshot at time of sale
  size_label          TEXT,
  qty                 INTEGER NOT NULL CHECK (qty > 0),
  unit_price_satang   INTEGER NOT NULL CHECK (unit_price_satang >= 0),   -- size price incl. modifiers
  discount_satang     INTEGER NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
  line_total_satang   INTEGER NOT NULL CHECK (line_total_satang >= 0),
  vat_type            TEXT    NOT NULL CHECK (vat_type IN ('vat7', 'vat0', 'exempt')),
  bom_snapshot_json   TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(bom_snapshot_json)),
  note                TEXT,
  UNIQUE (bill_id, line_no)
) STRICT;

CREATE TABLE bill_item_modifiers (
  id             TEXT    PRIMARY KEY,
  bill_item_id   TEXT    NOT NULL REFERENCES bill_items(id),
  option_id      TEXT    REFERENCES modifier_options(id),
  group_name     TEXT    NOT NULL,                 -- snapshot
  option_name    TEXT    NOT NULL,                 -- snapshot
  price_satang   INTEGER NOT NULL DEFAULT 0 CHECK (price_satang >= 0),
  kds_highlight  INTEGER NOT NULL DEFAULT 0 CHECK (kds_highlight IN (0, 1))
) STRICT;
CREATE INDEX ix_bill_item_modifiers_item ON bill_item_modifiers (bill_item_id);

CREATE TABLE payments (
  id                   TEXT    PRIMARY KEY,
  bill_id              TEXT    NOT NULL REFERENCES bills(id),
  method               TEXT    NOT NULL CHECK (method IN ('cash', 'promptpay', 'card', 'transfer', 'delivery', 'other')),
  amount_satang        INTEGER NOT NULL CHECK (amount_satang > 0),
  tendered_satang      INTEGER CHECK (tendered_satang >= 0),   -- cash given by customer
  change_satang        INTEGER CHECK (change_satang >= 0),
  status               TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  confirmation_source  TEXT    CHECK (confirmation_source IN ('manual', 'api')),
  confirmed_by         TEXT    REFERENCES users(id),
  confirmed_at         INTEGER,
  reference            TEXT,                       -- e.g. last 4 digits, slip ref (never full card numbers)
  created_at           INTEGER NOT NULL,
  CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND confirmation_source IS NOT NULL)),
  CHECK (method <> 'cash' OR tendered_satang IS NULL OR tendered_satang = amount_satang + ifnull(change_satang, 0))
) STRICT;
CREATE INDEX ix_payments_bill ON payments (bill_id);

-- APPEND-ONLY: bill lifecycle
CREATE TABLE bill_events (
  id           TEXT    PRIMARY KEY,
  bill_id      TEXT    NOT NULL REFERENCES bills(id),
  event        TEXT    NOT NULL CHECK (event IN (
                 'created', 'paid', 'void', 'refund', 'reprint', 'tax_invoice', 'synced')),
  user_id      TEXT    NOT NULL REFERENCES users(id),
  approved_by  TEXT    REFERENCES users(id),
  reason       TEXT,
  data_json    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  device_id    TEXT    REFERENCES devices(id),
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_bill_events_bill ON bill_events (bill_id, created_at);

CREATE TABLE tax_invoices (
  id                TEXT    PRIMARY KEY,
  branch_id         TEXT    NOT NULL REFERENCES branches(id),
  bill_id           TEXT    NOT NULL REFERENCES bills(id),
  type              TEXT    NOT NULL CHECK (type IN ('abbreviated', 'full')),
  invoice_no        TEXT    NOT NULL,
  customer_name     TEXT,
  customer_tax_id   TEXT,
  customer_branch   TEXT,
  customer_address  TEXT,
  replaces_id       TEXT    REFERENCES tax_invoices(id),
  issued_by         TEXT    NOT NULL REFERENCES users(id),
  issued_at         INTEGER NOT NULL,
  cancelled_at      INTEGER,
  cancelled_by      TEXT    REFERENCES users(id),
  cancel_reason     TEXT,
  UNIQUE (branch_id, type, invoice_no),
  CHECK (type <> 'full' OR (customer_name IS NOT NULL AND customer_tax_id IS NOT NULL AND customer_address IS NOT NULL))
) STRICT;
CREATE INDEX ix_tax_invoices_bill ON tax_invoices (bill_id);

CREATE TABLE kds_tickets (
  id            TEXT    PRIMARY KEY,
  branch_id     TEXT    NOT NULL REFERENCES branches(id),
  bill_id       TEXT    NOT NULL REFERENCES bills(id),
  bill_item_id  TEXT    NOT NULL REFERENCES bill_items(id),
  station       TEXT,
  status        TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'ready', 'completed', 'cancelled')),
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ready_at      INTEGER,
  completed_at  INTEGER,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_kds_tickets_active ON kds_tickets (branch_id, station, status) WHERE status IN ('new', 'preparing', 'ready');

-- APPEND-ONLY: member points
CREATE TABLE point_ledger (
  id           TEXT    PRIMARY KEY,
  member_id    TEXT    NOT NULL REFERENCES members(id),
  delta        INTEGER NOT NULL CHECK (delta <> 0),
  reason       TEXT    NOT NULL CHECK (reason IN ('earn', 'redeem', 'void_reversal', 'adjust', 'expire')),
  ref_type     TEXT,
  ref_id       TEXT,
  reverses_id  TEXT    REFERENCES point_ledger(id),
  user_id      TEXT    REFERENCES users(id),
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_point_ledger_member ON point_ledger (member_id, created_at);
CREATE UNIQUE INDEX ux_point_ledger_reverses ON point_ledger (reverses_id) WHERE reverses_id IS NOT NULL;

-- ===========================================================================
-- Waste
-- ===========================================================================

CREATE TABLE waste_records (
  id             TEXT    PRIMARY KEY,
  branch_id      TEXT    NOT NULL REFERENCES branches(id),
  waste_no       TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('ingredient', 'drink')),
  ingredient_id  TEXT    REFERENCES ingredients(id),
  lot_id         TEXT    REFERENCES stock_lots(id),   -- when a specific lot was chosen (e.g. near-expiry panel)
  product_id     TEXT    REFERENCES products(id),
  size_id        TEXT    REFERENCES product_sizes(id),
  qty_milli      INTEGER NOT NULL CHECK (qty_milli > 0),  -- ingredient: base unit; drink: cups × 1000
  reason         TEXT    NOT NULL CHECK (reason IN ('expired', 'wrong_made', 'dropped', 'customer_return', 'other')),
  note           TEXT,
  value_satang   INTEGER NOT NULL CHECK (value_satang >= 0),
  shift_id       TEXT    REFERENCES shifts(id),
  created_by     TEXT    NOT NULL REFERENCES users(id),
  created_at     INTEGER NOT NULL,
  voided_at      INTEGER,
  voided_by      TEXT    REFERENCES users(id),
  void_reason    TEXT,
  UNIQUE (branch_id, waste_no),
  CHECK ((kind = 'ingredient' AND ingredient_id IS NOT NULL AND product_id IS NULL)
      OR (kind = 'drink' AND product_id IS NOT NULL AND ingredient_id IS NULL)),
  CHECK (voided_at IS NULL OR (voided_by IS NOT NULL AND void_reason IS NOT NULL))
) STRICT;
CREATE INDEX ix_waste_records_created ON waste_records (branch_id, created_at);

-- ===========================================================================
-- Expenses
-- ===========================================================================

CREATE TABLE expense_categories (
  id          TEXT    PRIMARY KEY,
  branch_id   TEXT    NOT NULL REFERENCES branches(id),
  name        TEXT    NOT NULL,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE expenses (
  id               TEXT    PRIMARY KEY,
  branch_id        TEXT    NOT NULL REFERENCES branches(id),
  expense_no       TEXT    NOT NULL,
  category_id      TEXT    NOT NULL REFERENCES expense_categories(id),
  amount_satang    INTEGER NOT NULL CHECK (amount_satang > 0),     -- total paid
  vat_satang       INTEGER NOT NULL DEFAULT 0 CHECK (vat_satang >= 0),
  source           TEXT    NOT NULL CHECK (source IN ('drawer', 'petty_cash', 'bank')),
  has_tax_invoice  INTEGER NOT NULL DEFAULT 0 CHECK (has_tax_invoice IN (0, 1)),
  vendor           TEXT,
  description      TEXT,
  receipt_path     TEXT,                            -- relative to userData/receipts
  shift_id         TEXT    REFERENCES shifts(id),
  spent_at         INTEGER NOT NULL,
  created_by       TEXT    NOT NULL REFERENCES users(id),
  created_at       INTEGER NOT NULL,
  voided_at        INTEGER,
  voided_by        TEXT    REFERENCES users(id),
  void_reason      TEXT,
  UNIQUE (branch_id, expense_no),
  CHECK (source <> 'drawer' OR shift_id IS NOT NULL),
  CHECK (vat_satang <= amount_satang),
  CHECK (voided_at IS NULL OR (voided_by IS NOT NULL AND void_reason IS NOT NULL))
) STRICT;
CREATE INDEX ix_expenses_spent ON expenses (branch_id, spent_at);
CREATE INDEX ix_expenses_shift ON expenses (shift_id) WHERE shift_id IS NOT NULL;

-- ===========================================================================
-- System: audit, notifications, sync, backups, labels
-- ===========================================================================

-- APPEND-ONLY + hash chain: hash = SHA256(prev_hash || canonical_json(row)), computed in audit service
CREATE TABLE audit_log (
  id           TEXT    PRIMARY KEY,
  seq          INTEGER NOT NULL UNIQUE CHECK (seq >= 1),  -- chain order
  branch_id    TEXT    REFERENCES branches(id),
  user_id      TEXT    REFERENCES users(id),
  device_id    TEXT    REFERENCES devices(id),
  permission   TEXT,                                      -- resource:action used
  action       TEXT    NOT NULL,
  entity       TEXT,
  entity_id    TEXT,
  before_json  TEXT    CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json   TEXT    CHECK (after_json IS NULL OR json_valid(after_json)),
  reason       TEXT,
  risk         TEXT    NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
  created_at   INTEGER NOT NULL,
  prev_hash    TEXT    NOT NULL,                          -- 64 zeros for seq = 1
  hash         TEXT    NOT NULL UNIQUE,
  CHECK (length(prev_hash) = 64 AND length(hash) = 64)
) STRICT;
CREATE INDEX ix_audit_log_entity ON audit_log (entity, entity_id);
CREATE INDEX ix_audit_log_created ON audit_log (created_at);
CREATE INDEX ix_audit_log_user ON audit_log (user_id, created_at);

CREATE TABLE notifications (
  id          TEXT    PRIMARY KEY,
  branch_id   TEXT    NOT NULL REFERENCES branches(id),
  user_id     TEXT    REFERENCES users(id),          -- NULL = everyone with the permission below
  permission  TEXT,
  kind        TEXT    NOT NULL,                      -- low_stock, near_expiry, license_expiring, ...
  severity    TEXT    NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'danger')),
  title       TEXT    NOT NULL,
  body        TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
) STRICT;
CREATE INDEX ix_notifications_unread ON notifications (branch_id, created_at) WHERE read_at IS NULL;

CREATE TABLE notification_rules (
  id           TEXT    PRIMARY KEY,
  branch_id    TEXT    NOT NULL REFERENCES branches(id),
  kind         TEXT    NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  channel      TEXT    NOT NULL DEFAULT 'bell' CHECK (channel IN ('bell', 'email')),
  config_json  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  rev          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (branch_id, kind, channel)
) STRICT;

-- outbox for Client → Host sync (written in the same transaction as the change)
CREATE TABLE sync_queue (
  id               TEXT    PRIMARY KEY,
  device_id        TEXT    NOT NULL,
  entity           TEXT    NOT NULL,
  entity_id        TEXT    NOT NULL,
  op               TEXT    NOT NULL CHECK (op IN ('upsert', 'append')),
  payload_json     TEXT    NOT NULL CHECK (json_valid(payload_json)),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  sent_at          INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_sync_queue_pending ON sync_queue (next_attempt_at) WHERE sent_at IS NULL;

CREATE TABLE backup_runs (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('snapshot', 'manual', 'pre_migrate', 'pre_restore', 'pre_update')),
  path        TEXT    NOT NULL,
  size_bytes  INTEGER,
  ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error       TEXT,
  created_by  TEXT    REFERENCES users(id),
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;

CREATE TABLE label_templates (
  id           TEXT    PRIMARY KEY,
  branch_id    TEXT    NOT NULL REFERENCES branches(id),
  name         TEXT    NOT NULL,
  grid         TEXT    NOT NULL CHECK (grid IN ('2x5', '3x7', '4x10')),
  label_type   TEXT    NOT NULL,
  fields_json  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(fields_json)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  rev          INTEGER NOT NULL DEFAULT 1
) STRICT;

-- ===========================================================================
-- Append-only guards (CLAUDE.md rule 3)
-- ===========================================================================

CREATE TRIGGER trg_stock_ledger_no_update BEFORE UPDATE ON stock_ledger
BEGIN SELECT RAISE(ABORT, 'append-only: stock_ledger'); END;
CREATE TRIGGER trg_stock_ledger_no_delete BEFORE DELETE ON stock_ledger
BEGIN SELECT RAISE(ABORT, 'append-only: stock_ledger'); END;

CREATE TRIGGER trg_cash_ledger_no_update BEFORE UPDATE ON cash_ledger
BEGIN SELECT RAISE(ABORT, 'append-only: cash_ledger'); END;
CREATE TRIGGER trg_cash_ledger_no_delete BEFORE DELETE ON cash_ledger
BEGIN SELECT RAISE(ABORT, 'append-only: cash_ledger'); END;

CREATE TRIGGER trg_bill_events_no_update BEFORE UPDATE ON bill_events
BEGIN SELECT RAISE(ABORT, 'append-only: bill_events'); END;
CREATE TRIGGER trg_bill_events_no_delete BEFORE DELETE ON bill_events
BEGIN SELECT RAISE(ABORT, 'append-only: bill_events'); END;

CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'append-only: audit_log'); END;
CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'append-only: audit_log'); END;

CREATE TRIGGER trg_point_ledger_no_update BEFORE UPDATE ON point_ledger
BEGIN SELECT RAISE(ABORT, 'append-only: point_ledger'); END;
CREATE TRIGGER trg_point_ledger_no_delete BEFORE DELETE ON point_ledger
BEGIN SELECT RAISE(ABORT, 'append-only: point_ledger'); END;

-- a lot's stock ledger must reference a lot of the same ingredient
CREATE TRIGGER trg_stock_ledger_lot_ingredient BEFORE INSERT ON stock_ledger
WHEN (SELECT ingredient_id FROM stock_lots WHERE id = NEW.lot_id) IS NOT NEW.ingredient_id
BEGIN SELECT RAISE(ABORT, 'stock_ledger.ingredient_id does not match lot'); END;

-- audit chain must be contiguous: seq = previous max + 1 and prev_hash = previous hash
CREATE TRIGGER trg_audit_log_chain BEFORE INSERT ON audit_log
WHEN NEW.seq IS NOT ifnull((SELECT max(seq) FROM audit_log), 0) + 1
  OR NEW.prev_hash IS NOT ifnull((SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1), printf('%064d', 0))
BEGIN SELECT RAISE(ABORT, 'audit_log chain broken'); END;
