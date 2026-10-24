// Cost of sales for a month from stock movements: quantity sold × weighted average cost of the goods received up to
// the month end (purchases, opening balances and positive adjustments with a cost). A proposal only: the accountant
// reviews it and posts it (D 6000 / K 204) through the existing cost-of-sales entry.
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';
import {roleAccounts} from '../ledger/ledger.mjs';

export async function cogsProposal(db, {period}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) throw Object.assign(new Error('Netinkamas mėnuo.'), {status: 400});
  const from = `${period}-01`;
  const to = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const roles = await roleAccounts(db);
  const rows = (await db.query(`WITH sold AS (
      SELECT product_id, -sum(quantity) AS qty FROM stock_moves WHERE kind='sale' AND move_date BETWEEN $1 AND $2 GROUP BY product_id),
    cost AS (
      SELECT product_id, sum(quantity * unit_price) FILTER (WHERE quantity > 0 AND kind IN ('purchase','opening','adjustment') AND unit_price IS NOT NULL) AS value,
        sum(quantity) FILTER (WHERE quantity > 0 AND kind IN ('purchase','opening','adjustment') AND unit_price IS NOT NULL) AS qty_in,
        sum(quantity) AS stock_end
      FROM stock_moves WHERE move_date <= $2 GROUP BY product_id)
    SELECT p.id, p.sku, p.name, p.unit, p.kind, p.purchase_price, s.qty, c.value, c.qty_in, c.stock_end
    FROM sold s JOIN products p ON p.id=s.product_id LEFT JOIN cost c ON c.product_id=s.product_id
    WHERE s.qty <> 0 ORDER BY p.sku, p.name`, [from, to])).rows;
  const issues = [];
  const out = [];
  for (const r of rows) {
    if (r.kind === 'service') continue;
    let unitCost = null, source = 'none';
    if (r.qty_in && Number(r.qty_in) > 0) { unitCost = fromUnits(divRound(toUnits(r.value, 4) * 10000n, toUnits(r.qty_in, 4)), 4); source = 'average'; }
    else if (r.purchase_price !== null && r.purchase_price !== undefined) { unitCost = money.norm(r.purchase_price); source = 'card'; }
    const qty = String(r.qty);
    const amount = unitCost === null ? null : fromUnits(divRound(toUnits(qty, 4) * toUnits(unitCost, 4), 10n ** 6n), 2);
    if (source === 'card') issues.push({level: 'warning', message: `${r.sku || r.name}: nėra pirkimų su kaina – naudota kortelės pirkimo kaina ${unitCost}.`});
    if (source === 'none') issues.push({level: 'error', message: `${r.sku || r.name}: nežinoma savikaina (nėra pirkimų ir kortelės pirkimo kainos) – suma neįtraukta.`});
    if (r.stock_end !== null && Number(r.stock_end) < 0) issues.push({level: 'warning', message: `${r.sku || r.name}: likutis ${period} pabaigoje neigiamas (${Number(r.stock_end)}) – trūksta pirkimo ar pradinio likučio.`});
    out.push({productId: r.id, sku: r.sku, name: r.name, unit: r.unit, quantity: qty, unitCost, source, amount});
  }
  // Goods sold without a product card cannot be costed from stock.
  const loose = (await db.query(`SELECT count(*) AS n, coalesce(sum(l.net),0) AS net FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
    WHERE i.register='sales' AND l.line_type='revenue_goods' AND l.product_id IS NULL AND i.issue_date BETWEEN $1 AND $2`, [from, to])).rows[0];
  if (Number(loose.n)) issues.push({level: 'warning', message: `${loose.n} prekių pardavimo eilučių (${money.norm(loose.net)} EUR be PVM) be prekės kortelės – jų savikaina neapskaičiuota; pridėkite ranka.`});
  const total = money.sum(out.filter((x) => x.amount !== null).map((x) => x.amount));
  const posted = (await db.query(`SELECT c.journal_entry_id FROM cogs_periods c WHERE c.period=$1 AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=c.journal_entry_id)`, [period])).rows[0];
  return {period, date: to, rows: out, total, issues, posted: posted ? posted.journal_entry_id : null,
    accounts: {debit: roles.cogs || '6000', credit: roles.inventory || '204'},
    method: 'Svertinė vidutinė savikaina: gautų prekių (pirkimų, pradinių likučių, teigiamų koregavimų) vertė / kiekis iki mėnesio pabaigos.'};
}
