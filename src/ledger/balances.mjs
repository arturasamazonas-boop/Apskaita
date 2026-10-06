// Invoice outstanding balances. A group = original invoice + its corrections + linked credit/debit notes.
// Allocation amounts carry the invoice's sign (positive reduces a positive balance).

export async function invoiceBalances(db, {register = null, asOf = null, counterpartyId = null, ids = null, openOnly = false, limit = 500, offset = 0} = {}) {
  const params = [asOf || '9999-12-31'];
  const where = [];
  if (register) { params.push(register); where.push(`r.register = $${params.length}`); }
  if (counterpartyId) { params.push(counterpartyId); where.push(`r.counterparty_id = $${params.length}`); }
  if (ids) { params.push(ids); where.push(`r.id = ANY($${params.length}::bigint[])`); }
  const sql = `
    WITH g AS (
      SELECT i.id, i.gross_total, i.doc_type,
        CASE WHEN i.doc_type IN ('correction','credit_note','debit_note') AND i.related_invoice_id IS NOT NULL THEN i.related_invoice_id ELSE i.id END AS root_id
      FROM invoices i WHERE i.issue_date <= $1
    ), paid AS (
      SELECT g.root_id, sum(a.amount) AS paid, max(e.entry_date) AS last_payment
      FROM allocations a JOIN g ON g.id = a.invoice_id JOIN journal_entries e ON e.id = a.journal_entry_id
      WHERE e.entry_date <= $1 GROUP BY g.root_id
    ), tot AS (
      SELECT root_id, sum(gross_total) AS gross, count(*) FILTER (WHERE doc_type='credit_note') AS credit_notes FROM g GROUP BY root_id
    )
    SELECT r.id, r.register, r.doc_type, r.series, r.number, r.issue_date, r.due_date, r.currency, r.counterparty_id, r.counterparty_snapshot->>'name' AS counterparty_name,
      r.store_id, r.document_id, r.payment_reference, r.order_reference, r.gross_total AS original_gross,
      tot.gross, coalesce(paid.paid, 0) AS paid, tot.gross - coalesce(paid.paid, 0) AS outstanding, paid.last_payment, tot.credit_notes
    FROM tot JOIN invoices r ON r.id = tot.root_id LEFT JOIN paid ON paid.root_id = tot.root_id
    ${where.length || openOnly ? 'WHERE ' + [...where, ...(openOnly ? ['tot.gross - coalesce(paid.paid,0) <> 0'] : [])].join(' AND ') : ''}
    ORDER BY r.issue_date, r.id LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
  const rows = (await db.query(sql, params)).rows;
  return rows.map((x) => ({...x, payment_status: paymentStatus(x)}));
}

export function paymentStatus(x) {
  const g = Number(x.gross), p = Number(x.paid), o = Number(x.outstanding);
  if (g === 0) return x.credit_notes > 0 ? 'credited' : 'zero';
  if (o === 0) return 'paid';
  if (p === 0) return 'unpaid';
  if (Math.sign(o) !== Math.sign(g)) return 'overpaid';
  return 'partial';
}
