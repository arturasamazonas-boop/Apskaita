// Inventory cost by moving average (svertinė vidutinė savikaina, slenkantis vidurkis): every receipt with a cost
// re-averages what is in stock; every issue (sale, write-off) takes stock out at the current average. So the value
// left equals the inventory account once everything is sold, and sales are costed at what the goods cost.
// Purchase cost includes non-deductible VAT (stock_moves.unit_price, migration 026).
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';

const units = (v, s) => toUnits(String(v ?? '0'), s);

/**
 * Stock position of products on `date` (moves up to and including that date): quantity, value, unit cost and the
 * account the goods are kept in. `before` (an invoice id) leaves that invoice's own lines out.
 */
export async function stockPositions(db, productIds, date, {roles = {}, before = null} = {}) {
  const ids = [...new Set(productIds.map(String))];
  const out = new Map(ids.map((id) => [id, {qty: '0.0000', value: '0.00', unit: null, account: roles.inventory || '204', expensed: false, issues: []}]));
  if (!ids.length) return out;
  const moves = (await db.query(`SELECT product_id, move_date, kind, quantity, unit_price, source_type, source_id FROM stock_moves
    WHERE product_id = ANY($1::bigint[]) AND move_date <= $2 AND NOT (source_type='invoice' AND source_id = $3::bigint)
    ORDER BY product_id, move_date, (quantity > 0) DESC, source_id`, [ids, date, before || 0])).rows;
  const cards = new Map((await db.query(`SELECT id, purchase_price FROM products WHERE id = ANY($1::bigint[])`, [ids])).rows.map((r) => [String(r.id), r]));
  const state = new Map(ids.map((id) => [id, {q: 0n, v: 0n, avg: null}])); // q: 4 decimals, v: 2 decimals, avg: 4 decimals
  for (const m of moves) {
    const st = state.get(String(m.product_id));
    const q = units(m.quantity, 4);
    if (q > 0n && m.unit_price !== null && m.unit_price !== undefined && ['purchase', 'opening', 'adjustment'].includes(m.kind)) {
      st.v += divRound(q * units(m.unit_price, 4), 10n ** 6n); st.q += q;
    } else {
      // Issue (or a receipt without a cost, e.g. a sales return): at the current average.
      const avg = st.q > 0n ? divRound(st.v * 10n ** 6n, st.q) : (st.avg ?? units(cards.get(String(m.product_id))?.purchase_price ?? '0', 4));
      const delta = divRound(q * avg, 10n ** 6n);
      st.v += delta; st.q += q;
      // Cost of each sale at the average of its moment (used by the monthly cost-of-sales calculation).
      if (m.kind === 'sale') out.get(String(m.product_id)).issues.push({date: String(m.move_date).slice(0, 10), invoiceId: String(m.source_id), qty: fromUnits(-q, 4), cost: fromUnits(-delta, 2)});
      if (st.q <= 0n) { st.v = st.q === 0n ? 0n : st.v; }
    }
    if (st.q > 0n) st.avg = divRound(st.v * 10n ** 6n, st.q);
  }
  // The account goods are kept in: where the latest purchase of the product was booked (an expense account means
  // purchases are expensed straight away – then the sale must not book a cost again).
  const acc = (await db.query(`SELECT DISTINCT ON (l.product_id) l.product_id, l.account_code, a.type FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id JOIN accounts a ON a.code=l.account_code
    WHERE i.register='purchase' AND l.product_id = ANY($1::bigint[]) AND i.issue_date <= $2 ORDER BY l.product_id, i.issue_date DESC, i.id DESC`, [ids, date])).rows;
  for (const id of ids) {
    const st = state.get(id), o = out.get(id);
    o.qty = fromUnits(st.q, 4); o.value = fromUnits(st.v, 2);
    o.unit = st.avg === null ? null : fromUnits(st.avg, 4);
    const a = acc.find((x) => String(x.product_id) === id);
    if (a) { o.account = a.account_code; o.expensed = a.type === 'expense'; }
  }
  return out;
}
