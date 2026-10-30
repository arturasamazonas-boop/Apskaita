-- Stock value follows the ledger: returns go back at the cost booked on the line (invoice_lines.cogs_amount), and the
-- account a purchase was booked to tells whether the goods were stocked or expensed straight away.
CREATE OR REPLACE VIEW stock_moves AS
  SELECT l.product_id, i.issue_date AS move_date,
         CASE WHEN i.register='purchase' THEN 'purchase' ELSE 'sale' END AS kind,
         CASE WHEN i.register='purchase' THEN l.quantity ELSE -l.quantity END AS quantity,
         CASE WHEN l.quantity <> 0 THEN round((l.net + CASE WHEN i.register='purchase' AND l.vat_treatment='non_deductible' THEN l.vat ELSE 0 END) / l.quantity, 4) END AS unit_price,
         'invoice'::text AS source_type, i.id AS source_id,
         trim(i.series || ' ' || i.number) || CASE WHEN i.doc_type='credit_note' THEN ' (kreditinė)' ELSE '' END AS reference,
         l.description AS note,
         l.cogs_amount AS cost, l.account_code
    FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
   WHERE l.product_id IS NOT NULL
  UNION ALL
  SELECT m.product_id, m.movement_date, m.kind, m.quantity, m.unit_cost, 'stock_movement', m.id, '', m.note, NULL::numeric, NULL::text
    FROM stock_movements m;

-- A correction that changes only what is printed on a sales invoice (due date, notes, line wording) has nothing to
-- post: it is kept as a correction with zero amounts and no journal entry.
ALTER TABLE invoices ALTER COLUMN journal_entry_id DROP NOT NULL;
ALTER TABLE invoices ADD CONSTRAINT invoices_entry_required CHECK (journal_entry_id IS NOT NULL OR (doc_type='correction' AND net_total=0 AND vat_total=0 AND gross_total=0));
