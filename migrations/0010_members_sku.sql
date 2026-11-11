-- Member profile details and auto-generated product codes (D46, D47).

-- Member contact details (PDPA: stored with the same consent as phone/name, erased with them).
ALTER TABLE members ADD COLUMN birth_date TEXT CHECK (birth_date IS NULL OR birth_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');
ALTER TABLE members ADD COLUMN email      TEXT CHECK (email IS NULL OR length(email) <= 120);
ALTER TABLE members ADD COLUMN line_id    TEXT CHECK (line_id IS NULL OR length(line_id) <= 60);
ALTER TABLE members ADD COLUMN phone2     TEXT CHECK (phone2 IS NULL OR length(phone2) <= 20);
ALTER TABLE members ADD COLUMN note       TEXT CHECK (note IS NULL OR length(note) <= 500);

-- SKU = <category prefix>-<running number>, e.g. COF-0001; categories without a prefix use "P".
ALTER TABLE categories ADD COLUMN sku_prefix TEXT CHECK (sku_prefix IS NULL OR (length(sku_prefix) BETWEEN 1 AND 6 AND sku_prefix NOT GLOB '*[^A-Z0-9]*'));
CREATE INDEX ix_products_sku ON products (branch_id, sku) WHERE sku IS NOT NULL;
