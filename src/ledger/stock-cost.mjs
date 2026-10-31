// Inventory cost by moving average (svertinė vidutinė savikaina, slenkantis vidurkis): every receipt adds its exact
// amount (purchase cost incl. non-deductible VAT) and re-averages what is in stock; every issue (sale, write-off) takes
// its share of the stock value (all of it when the last units go, so nothing is left over); a customer return or a
// corrected sale comes back at what that sale cost; a return to the supplier leaves at its own price; goods bought
// straight into an expense account come in at no value. Goods sold before they were received (negative stock) are
// costed at the last known price and re-priced when the goods arrive.
// With perpetual inventory (cost booked with each sale) reconcileStock keeps each product's inventory account equal to
// this value: a purchase entered later with an earlier date, a sale of goods not yet received, rounding – the
// difference is booked to cost of sales.
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';
import {postEntry} from './ledger.mjs';

const units = (v, s) => toUnits(String(v ?? '0'), s);
const share = (v, part, whole) => (whole === 0n ? 0n : divRound(v * part, whole)); // v × part / whole, same scale as v

/** Cost (2 decimals, as units) of taking `out` (4 decimals) out of a stock state; the shortage at `unit` (4 decimals). */
export function issueCost(st, out, unit) {
  if (st.q >= out && st.q > 0n) return out === st.q ? st.v : share(st.v, out, st.q);
  const avail = st.q > 0n ? st.q : 0n;
  return (avail > 0n ? st.v : 0n) + divRound((out - avail) * (unit ?? 0n), 10n ** 6n);
}

/**
 * Stock position of products on `date` (moves up to and including that date): quantity, value, unit cost, the
 * account the goods are kept in, the cost of each sale (`issues`) and what is still issued per sales invoice group
 * (`sold`, keyed by the original invoice id; credit notes and corrections come back out of it).
 */
export async function stockPositions(db, productIds, date, {roles = {}} = {}) {
  const ids = [...new Set(productIds.map(String))];
  const out = new Map(ids.map((id) => [id, {qty: '0.0000', value: '0.00', unit: null, account: roles.inventory || '204', expensed: false, issues: [], sold: new Map(), movementValue: '0.00', timeline: []}]));
  if (!ids.length) return out;
  // Receipts of a day before its issues; sales invoices in order, a correction's reversed lines before its new ones.
  const rawMoves = (await db.query(`SELECT m.product_id, m.move_date, m.kind, m.quantity, m.value, m.source_type, m.source_id, m.related_id, m.cost, a.type AS account_type FROM stock_moves m
    LEFT JOIN accounts a ON a.code=m.account_code
    WHERE m.product_id = ANY($1::bigint[]) AND m.move_date <= $2
    ORDER BY m.product_id, m.move_date, (m.quantity > 0 AND m.kind <> 'sale') DESC, m.source_type, m.source_id, (m.quantity > 0) DESC`, [ids, date])).rows;
  // A sales document moves each product once, by its net quantity (a correction's reversed and new lines, a line
  // and its return on one invoice), so it is costed the same way as when it was booked.
  const moves = [];
  for (const m of rawMoves) {
    const prev = moves[moves.length - 1];
    if (m.kind === 'sale' && prev && prev.kind === 'sale' && prev.source_type === m.source_type && String(prev.source_id) === String(m.source_id) && String(prev.product_id) === String(m.product_id)) {
      prev.quantity = fromUnits(units(prev.quantity, 4) + units(m.quantity, 4), 4);
      prev.cost = prev.cost === null || prev.cost === undefined || m.cost === null || m.cost === undefined ? null : money.add(prev.cost, m.cost);
    } else moves.push({...m});
  }
  const cards = new Map((await db.query(`SELECT id, purchase_price FROM products WHERE id = ANY($1::bigint[])`, [ids])).rows.map((r) => [String(r.id), r]));
  const state = new Map(ids.map((id) => [id, {q: 0n, v: 0n, avg: null, mv: 0n}])); // q: 4 decimals, v: 2 decimals, avg: 4 decimals
  for (const m of moves) {
    const id = String(m.product_id), st = state.get(id), o = out.get(id);
    const q = units(m.quantity, 4), before = st.v;
    if (q === 0n && m.kind === 'sale') continue;
    const card = cards.get(id)?.purchase_price;
    const lastUnit = st.avg ?? (card !== null && card !== undefined ? units(card, 4) : null);
    const receive = (value) => {
      // Goods arriving while stock is negative (sold before received): the missing units are re-priced at this receipt.
      if (q > 0n && st.q < 0n) st.v = share(value, st.q, q);
      st.v += value; st.q += q;
    };
    if (m.kind === 'purchase') {
      receive(m.account_type === 'expense' ? 0n : units(m.value, 2));
    } else if (q > 0n && m.kind !== 'sale' && m.value !== null && m.value !== undefined) {
      receive(units(m.value, 2)); // opening balance, positive adjustment with a cost
    } else if (q > 0n && m.kind === 'sale') {
      // Customer return / reversed line of a corrected sale: back at what that sale cost.
      const root = String(m.related_id ?? m.source_id);
      const rec = o.sold.get(root);
      const cost = rec && rec.q > 0n ? (q >= rec.q ? rec.v : share(rec.v, q, rec.q)) : divRound(q * (lastUnit ?? 0n), 10n ** 6n);
      receive(cost);
      if (rec) { rec.q -= q; rec.v -= cost; }
      o.issues.push({date: String(m.move_date).slice(0, 10), invoiceId: String(m.source_id), qty: fromUnits(-q, 4), cost: fromUnits(-cost, 2), costed: m.cost !== null && m.cost !== undefined});
    } else {
      // Issue: sale, write-off, negative adjustment.
      const cost = issueCost(st, -q, lastUnit);
      st.v -= cost; st.q += q;
      if (m.kind === 'sale') {
        const root = String(m.related_id ?? m.source_id);
        const rec = o.sold.get(root) || {q: 0n, v: 0n};
        rec.q -= q; rec.v += cost; o.sold.set(root, rec);
        o.issues.push({date: String(m.move_date).slice(0, 10), invoiceId: String(m.source_id), qty: fromUnits(-q, 4), cost: fromUnits(cost, 2), costed: m.cost !== null && m.cost !== undefined});
      }
    }
    if (st.q === 0n) st.v = 0n; // nothing left: nothing left in value either (the difference was part of what was issued)
    if (m.source_type === 'stock_movement') st.mv += st.v - before;
    if (st.q > 0n) st.avg = divRound(st.v * 10n ** 6n, st.q);
    // Value at the end of each day (without stock movements, which have no entries of their own).
    const day = String(m.move_date).slice(0, 10), tl = o.timeline, last = tl[tl.length - 1];
    if (last && last.date === day) last.v = st.v - st.mv; else tl.push({date: day, v: st.v - st.mv});
  }
  // The account goods are kept in: where the latest stocked purchase of the product was booked. A product only ever
  // bought straight into expenses is "expensed" – its sale must not book a cost again.
  const acc = (await db.query(`SELECT DISTINCT ON (l.product_id) l.product_id, l.account_code, a.type FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id JOIN accounts a ON a.code=l.account_code
    WHERE i.register='purchase' AND l.product_id = ANY($1::bigint[]) AND i.issue_date <= $2 ORDER BY l.product_id, (a.type <> 'expense') DESC, i.issue_date DESC, i.id DESC`, [ids, date])).rows;
  for (const id of ids) {
    const st = state.get(id), o = out.get(id);
    o.qty = fromUnits(st.q, 4); o.value = fromUnits(st.v, 2); o.movementValue = fromUnits(st.mv, 2);
    o.unit = st.avg === null ? null : fromUnits(st.avg, 4);
    o.state = st;
    const a = acc.find((x) => String(x.product_id) === id);
    if (a) { o.account = a.account_code; o.expensed = a.type === 'expense'; }
  }
  return out;
}

/**
 * Perpetual inventory: keep each product's booked inventory value (stocked purchases − costs booked with sales +
 * earlier adjustments; stock movements have no entries and are left out) equal to its stock value at the end of every
 * day from `date` on – a purchase entered later with an earlier date re-prices the sales after it, each on its own
 * day. Differences from before `date` are booked on `date`. The difference goes to cost of sales.
 * Only for products whose every sale carries its cost (a month costed by a monthly entry is reconciled there).
 */
export async function reconcileStock(db, productIds, {date, roles, userId, invoiceId, label}) {
  if (!roles.cogs || !roles.inventory || !productIds.length) return [];
  const ids = (await db.query(`SELECT p.id FROM products p WHERE p.id = ANY($1::bigint[]) AND p.kind='goods' AND p.track_stock
    AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE l.product_id=p.id AND i.register='sales' AND l.cogs_amount IS NULL)`, [[...new Set(productIds.map(String))]])).rows.map((r) => String(r.id));
  if (!ids.length) return [];
  const pos = await stockPositions(db, ids, '9999-12-31', {roles});
  const done = [];
  for (const id of ids) {
    const p = pos.get(id);
    if (p.expensed) continue;
    // Booked change of the inventory value per day.
    const rows = (await db.query(`SELECT d, sum(v) AS v FROM (
        SELECT m.move_date AS d, coalesce(sum(m.value) FILTER (WHERE m.kind='purchase' AND coalesce(a.type,'') <> 'expense'),0) - coalesce(sum(m.cost) FILTER (WHERE m.kind='sale'),0) AS v
          FROM stock_moves m LEFT JOIN accounts a ON a.code=m.account_code WHERE m.product_id=$1 GROUP BY m.move_date
        UNION ALL SELECT adj_date, sum(amount) FROM stock_cost_adjustments WHERE product_id=$1 GROUP BY adj_date) x GROUP BY d ORDER BY d`, [id])).rows;
    const bookedOn = new Map(rows.map((r) => [String(r.d instanceof Date ? r.d.toISOString() : r.d).slice(0, 10), toUnits(String(r.v), 2)]));
    const valueOn = new Map(p.timeline.map((x) => [x.date, x.v]));
    const days = [...new Set([...bookedOn.keys(), ...valueOn.keys()])].sort();
    let booked = 0n, value = 0n, posted = 0n, n = 0;
    for (const d of days) {
      booked += bookedOn.get(d) || 0n;
      if (valueOn.has(d)) value = valueOn.get(d);
      if (d < date) continue;
      const diff = value - (booked + posted);
      if (diff === 0n) continue;
      const at = d, amt = fromUnits(diff < 0n ? -diff : diff, 2), up = diff > 0n;
      const e = await postEntry(db, {date: at, description: `Atsargų savikainos patikslinimas – ${label}`.slice(0, 250), sourceType: 'stock_cost', sourceId: invoiceId, idempotencyKey: `stockadj:${invoiceId}:${id}:${at}`, userId,
        lines: [{account: p.account, debit: up ? amt : '0', credit: up ? '0' : amt, description: label}, {account: roles.cogs, debit: up ? '0' : amt, credit: up ? amt : '0', description: label}]});
      await db.query(`INSERT INTO stock_cost_adjustments(product_id, adj_date, account_code, amount, journal_entry_id, invoice_id) VALUES ($1,$2,$3,$4,$5,$6)`, [id, at, p.account, fromUnits(diff, 2), e.id, invoiceId]);
      posted += diff; n++;
      done.push({productId: id, date: at, amount: fromUnits(diff, 2)});
    }
  }
  return done;
}
