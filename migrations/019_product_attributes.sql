-- Prekių rodikliai: user-defined product attributes (e.g. "Diametras", mm). Values are stored on the product,
-- keyed by the attribute id, so renaming an attribute keeps the values.
CREATE TABLE product_attributes (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'number', 'choice')),
  unit text NOT NULL DEFAULT '',
  options text[] NOT NULL DEFAULT '{}',
  sort_order int NOT NULL DEFAULT 0,
  show_in_list boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_attributes_name_uq ON product_attributes(lower(btrim(name)));

ALTER TABLE products ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object');
