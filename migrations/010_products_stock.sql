-- Product card fields and stock quantities.
-- Quantities come from posted invoice lines linked to a product (purchases +, sales −, credit notes reverse)
-- plus manual stock movements (opening balance, inventory count adjustment, write-off). Stock movements
-- are quantity records only; inventory value in the ledger is still posted through purchases and COGS.

ALTER TABLE products
  ADD COLUMN barcode text NOT NULL DEFAULT '',
  ADD COLUMN group_name text NOT NULL DEFAULT '',
  ADD COLUMN manufacturer text NOT NULL DEFAULT '',
  ADD COLUMN supplier_id bigint REFERENCES counterparties(id),
  ADD COLUMN supplier_sku text NOT NULL DEFAULT '',
  ADD COLUMN origin_country text NOT NULL DEFAULT '',
  ADD COLUMN cn_code text NOT NULL DEFAULT '',
  ADD COLUMN weight_kg numeric(12,3),
  ADD COLUMN purchase_price numeric(18,4),
  ADD COLUMN min_stock numeric(18,4),
  ADD COLUMN location text NOT NULL DEFAULT '',
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN notes text NOT NULL DEFAULT '',
  ADD COLUMN track_stock boolean NOT NULL DEFAULT true,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE products SET track_stock = (kind = 'goods');
CREATE INDEX products_barcode_idx ON products(barcode) WHERE barcode <> '';
CREATE INDEX products_group_idx ON products(group_name);

CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products(id),
  movement_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening','adjustment','writeoff')),
  quantity numeric(18,4) NOT NULL CHECK (quantity <> 0),
  unit_cost numeric(18,4),
  note text NOT NULL DEFAULT '',
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'writeoff' OR quantity < 0)
);
CREATE INDEX stock_movements_product_idx ON stock_movements(product_id, movement_date);
-- Movements are corrected with a new adjustment, never edited.
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE VIEW stock_moves AS
  SELECT l.product_id, i.issue_date AS move_date,
         CASE WHEN i.register='purchase' THEN 'purchase' ELSE 'sale' END AS kind,
         CASE WHEN i.register='purchase' THEN l.quantity ELSE -l.quantity END AS quantity,
         CASE WHEN l.quantity <> 0 THEN round(l.net / l.quantity, 4) END AS unit_price,
         'invoice'::text AS source_type, i.id AS source_id,
         trim(i.series || ' ' || i.number) || CASE WHEN i.doc_type='credit_note' THEN ' (kreditinė)' ELSE '' END AS reference,
         l.description AS note
    FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
   WHERE l.product_id IS NOT NULL
  UNION ALL
  SELECT m.product_id, m.movement_date, m.kind, m.quantity, m.unit_cost, 'stock_movement', m.id, '', m.note
    FROM stock_movements m;
