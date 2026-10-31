// Cost of sales for a month from stock movements: quantity sold × weighted average cost of the goods received up to
// the month end (purchases, opening balances and positive adjustments with a cost). A proposal only: the accountant
// reviews it and posts it (D 6000 / K 204) through the existing cost-of-sales entry.
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';
import {roleAccounts} from '../ledger/ledger.mjs';
import {stockPositions} from '../ledger/stock-cost.mjs';

export async function cogsProposal(db, {period}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) throw Object.assign(new Error('Netinkamas mėnuo.'), {status: 400});
  const from = `${period}-01`;
  const to = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const roles = await roleAccounts(db);
  // Sales lines not yet costed (with the sale or by an earlier monthly entry), per product.
  const sold = (await db.query(`SELECT p.id, p.sku, p.name, p.unit, p.kind, p.purchase_price, sum(l.quantity) AS qty, array_agg(DISTINCT i.id::text) AS invoices
    FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id JOIN products p ON p.id=l.product_id
    WHERE i.register='sales' AND l.cogs_amount IS NULL AND i.issue_date BETWEEN $1 AND $2 AND p.kind='goods' AND p.track_stock
    GROUP BY p.id ORDER BY p.sku, p.name`, [from, to])).rows; // a sale and its return in one month still count (at their own costs)
  const pos = await stockPositions(db, sold.map((r) => r.id), to, {roles});
  const issues = [];
  const out = [];
  for (const r of sold) {
    const p = pos.get(String(r.id));
    if (p.expensed) { issues.push({level: 'info', message: `${r.sku || r.name}: pirkimai nurašomi tiesiai į sąnaudas (${p.account}) – savikaina antrą kartą neskaičiuojama.`}); continue; }
    // Each sale at the moving average of its moment.
    const mine = p.issues.filter((x) => !x.costed && x.date >= from && x.date <= to && r.invoices.includes(x.invoiceId)); // lines costed with the sale are already booked
    const amount = money.sum(mine.map((x) => x.cost));
    const qty = String(r.qty);
    const unitCost = money.isZero(qty) ? null : fromUnits(divRound(toUnits(amount, 2) * 10n ** 6n, toUnits(qty, 4)), 4);
    const hadCost = p.unit !== null || (await db.query(`SELECT 1 FROM stock_moves WHERE product_id=$1 AND move_date <= $2 AND quantity > 0 AND unit_price IS NOT NULL LIMIT 1`, [r.id, to])).rowCount;
    const source = hadCost ? 'average' : r.purchase_price !== null && r.purchase_price !== undefined ? 'card' : 'none';
    if (source === 'card') issues.push({level: 'warning', message: `${r.sku || r.name}: nėra pirkimų su kaina – naudota kortelės pirkimo kaina.`});
    if (source === 'none') { issues.push({level: 'error', message: `${r.sku || r.name}: nežinoma savikaina (nėra pirkimų ir kortelės pirkimo kainos) – suma neįtraukta.`}); out.push({productId: r.id, sku: r.sku, name: r.name, unit: r.unit, quantity: qty, unitCost: null, source, amount: null, account: p.account}); continue; }
    if (money.sign(p.qty) < 0) issues.push({level: 'warning', message: `${r.sku || r.name}: likutis ${period} pabaigoje neigiamas (${Number(p.qty)}) – trūksta pirkimo ar pradinio likučio.`});
    out.push({productId: r.id, sku: r.sku, name: r.name, unit: r.unit, quantity: qty, unitCost, source, amount, account: p.account});
  }
  // Goods sold without a product card cannot be costed from stock.
  const auto = (await db.query(`SELECT count(*) AS n, coalesce(sum(l.cogs_amount),0) AS v FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
    WHERE i.register='sales' AND l.cogs_amount IS NOT NULL AND i.issue_date BETWEEN $1 AND $2`, [from, to])).rows[0];
  if (Number(auto.n)) issues.push({level: 'info', message: `${auto.n} pardavimo eilučių savikaina (${money.norm(auto.v)} EUR) jau užregistruota kartu su sąskaitomis – čia neįtraukta.`});
  const loose = (await db.query(`SELECT count(*) AS n, coalesce(sum(l.net),0) AS net FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
    WHERE i.register='sales' AND l.line_type='revenue_goods' AND l.product_id IS NULL AND l.net > 0 AND i.issue_date BETWEEN $1 AND $2`, [from, to])).rows[0];
  if (Number(loose.n)) issues.push({level: 'warning', message: `${loose.n} prekių pardavimo eilučių (${money.norm(loose.net)} EUR be PVM) be prekės kortelės – jų savikaina neapskaičiuota; pridėkite ranka.`});
  const total = money.sum(out.filter((x) => x.amount !== null).map((x) => x.amount));
  const posted = (await db.query(`SELECT c.journal_entry_id FROM cogs_periods c WHERE c.period=$1 AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=c.journal_entry_id)`, [period])).rows[0];
  // Entry lines ready to post: D cost of sales / K the accounts the goods are kept in.
  const credits = new Map();
  for (const r of out) if (r.amount !== null && !money.isZero(r.amount)) credits.set(r.account, money.add(credits.get(r.account) || '0', r.amount));
  // A month with more returns than sales: the cost comes back (D inventory / K cost of sales).
  const cogsLine = money.sign(total) >= 0 ? {account: roles.cogs || '6000', debit: total} : {account: roles.cogs || '6000', credit: money.abs(total)};
  const lines = money.isZero(total) ? [] : [cogsLine, ...[...credits].filter(([, v]) => !money.isZero(v)).map(([account, v]) => (money.sign(v) > 0 ? {account, credit: v} : {account, debit: money.abs(v)}))];
  if (posted) {
    // Already posted: a purchase or sale entered later changes the cost – say by how much.
    const was = (await db.query(`SELECT coalesce(sum(debit - credit),0) AS v FROM journal_lines WHERE entry_id=$1 AND account_code=$2`, [posted.journal_entry_id, roles.cogs || '6000'])).rows[0].v;
    if (!money.isZero(money.sub(total, was))) issues.push({level: 'warning', message: `Užregistruota ${money.norm(was)} EUR, o dabar apskaičiuota ${money.norm(total)} EUR (vėliau įvesti ar pataisyti dokumentai). Skirtumą ${money.norm(money.sub(total, was))} EUR užregistruokite rankiniu įrašu (D 6000 / K atsargos arba atvirkščiai) arba atšaukite mėnesio įrašą ir užregistruokite iš naujo.`});
  }
  return {period, date: to, rows: out, total, issues, posted: posted ? posted.journal_entry_id : null, lines,
    accounts: {debit: roles.cogs || '6000', credit: [...credits.keys()][0] || roles.inventory || '204'},
    method: 'Slenkanti svertinė vidutinė savikaina: kiekvienas pirkimas perskaičiuoja likučio vidutinę kainą, pardavimas nurašomas tos dienos vidurkiu (neatskaitomas PVM įskaičiuojamas).'};
}
