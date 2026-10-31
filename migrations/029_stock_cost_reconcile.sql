-- Stock value from the exact line amounts (no unit-price rounding), returns linked to the sale they return, and the
-- adjustments that keep each product's inventory account in step with its stock movements (perpetual inventory):
-- a purchase entered later with an earlier date, a sale of goods not yet received, rounding.
CREATE OR REPLACE VIEW stock_moves AS
  SELECT l.product_id, i.issue_date AS move_date,
         CASE WHEN i.register='purchase' THEN 'purchase' ELSE 'sale' END AS kind,
         CASE WHEN i.register='purchase' THEN l.quantity ELSE -l.quantity END AS quantity,
         CASE WHEN l.quantity <> 0 THEN round((l.net + CASE WHEN i.register='purchase' AND l.vat_treatment='non_deductible' THEN l.vat ELSE 0 END) / l.quantity, 4) END AS unit_price,
         'invoice'::text AS source_type, i.id AS source_id,
         trim(i.series || ' ' || i.number) || CASE WHEN i.doc_type='credit_note' THEN ' (kreditinė)' ELSE '' END AS reference,
         l.description AS note,
         l.cogs_amount AS cost, l.account_code,
         CASE WHEN i.register='purchase' THEN l.net + CASE WHEN l.vat_treatment='non_deductible' THEN l.vat ELSE 0 END END AS value,
         i.related_invoice_id AS related_id
    FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
   WHERE l.product_id IS NOT NULL
  UNION ALL
  SELECT m.product_id, m.movement_date, m.kind, m.quantity, m.unit_cost, 'stock_movement', m.id, '', m.note, NULL::numeric, NULL::text,
         CASE WHEN m.unit_cost IS NOT NULL THEN round(m.quantity * m.unit_cost, 2) END, NULL::bigint
    FROM stock_movements m;

CREATE TABLE stock_cost_adjustments (
  id bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products(id),
  adj_date date NOT NULL,
  account_code text NOT NULL,
  amount numeric(14,2) NOT NULL,            -- change of the inventory value (+ debit inventory / credit cost of sales)
  journal_entry_id bigint NOT NULL REFERENCES journal_entries(id),
  invoice_id bigint REFERENCES invoices(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_cost_adjustments_product_idx ON stock_cost_adjustments(product_id);
