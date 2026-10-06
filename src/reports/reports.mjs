// Reports. Financial statements derive from posted journal lines only; register/operational
// reports state their source and are reconciled against the ledger where applicable.
import {money} from '../lib/money.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';

const D = (v, def) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : def);
const yearStart = (today) => `${today.slice(0, 4)}-01-01`;

function report(title, definition, columns, rows, extra = {}) {
  return {title, definition, columns, rows, ...extra};
}

export async function trialBalance(db, {from, to, today}) {
  from = D(from, yearStart(today)); to = D(to, today);
  const rows = (await db.query(`SELECT a.code, a.name, a.type,
      coalesce(sum(CASE WHEN e.entry_date < $1 THEN l.debit - l.credit END), 0) AS opening,
      coalesce(sum(CASE WHEN e.entry_date BETWEEN $1 AND $2 THEN l.debit END), 0) AS debit,
      coalesce(sum(CASE WHEN e.entry_date BETWEEN $1 AND $2 THEN l.credit END), 0) AS credit,
      coalesce(sum(CASE WHEN e.entry_date <= $2 THEN l.debit - l.credit END), 0) AS closing
    FROM accounts a JOIN journal_lines l ON l.account_code=a.code JOIN journal_entries e ON e.id=l.entry_id
    GROUP BY a.code, a.name, a.type ORDER BY a.code`, [from, to])).rows;
  const totals = {debit: money.sum(rows.map((r) => r.debit)), credit: money.sum(rows.map((r) => r.credit)), closing: money.sum(rows.map((r) => r.closing))};
  return report('Bandomasis balansas', `Visų užregistruotų didžiosios knygos įrašų apyvartos ${from}–${to}. Pradinis likutis – įrašai iki ${from}; galutinis – iki ${to} imtinai. Debetas teigiamas, kreditas neigiamas.`,
    [['code', 'Sąskaita'], ['name', 'Pavadinimas'], ['opening', 'Pradinis likutis', 'money'], ['debit', 'Debetas', 'money'], ['credit', 'Kreditas', 'money'], ['closing', 'Galutinis likutis', 'money']],
    rows, {filters: {from, to}, totals, balanced: money.eq(totals.debit, totals.credit) && money.isZero(totals.closing), drill: {column: 'code', to: 'ledger'}});
}

export async function generalLedger(db, {account, from, to, today, limit = 500, offset = 0}) {
  from = D(from, yearStart(today)); to = D(to, today);
  const acc = (await db.query('SELECT * FROM accounts WHERE code=$1', [account])).rows[0];
  const opening = (await db.query(`SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code=$1 AND e.entry_date < $2`, [account, from])).rows[0].v;
  const rows = (await db.query(`SELECT e.id AS entry_id, e.entry_date, e.description, e.source_type, e.source_id, l.debit, l.credit, l.description AS line_description, c.name AS counterparty,
      i.document_id
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id LEFT JOIN counterparties c ON c.id=l.counterparty_id LEFT JOIN invoices i ON i.journal_entry_id = e.id
    WHERE l.account_code=$1 AND e.entry_date BETWEEN $2 AND $3 ORDER BY e.entry_date, e.id, l.id LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, [account, from, to])).rows;
  let bal = opening;
  for (const r of rows) { bal = money.add(bal, money.sub(r.debit, r.credit)); r.balance = bal; }
  const sums = (await db.query(`SELECT coalesce(sum(l.debit),0) AS d, coalesce(sum(l.credit),0) AS c FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code=$1 AND e.entry_date BETWEEN $2 AND $3`, [account, from, to])).rows[0];
  return report(`Didžioji knyga: ${account} ${acc?.name || ''}`, `Visi užregistruoti įrašai sąskaitoje ${account} ${from}–${to}, su einamuoju likučiu ir nuorodomis į šaltinio dokumentus.`,
    [['entry_date', 'Data', 'date'], ['entry_id', 'Įrašas'], ['description', 'Aprašymas'], ['counterparty', 'Kontrahentas'], ['debit', 'Debetas', 'money'], ['credit', 'Kreditas', 'money'], ['balance', 'Likutis', 'money']],
    rows, {filters: {account, from, to}, opening, totals: {debit: sums.d, credit: sums.c, closing: money.add(opening, money.sub(sums.d, sums.c))}, drill: {column: 'entry_id', to: 'entry'}});
}

/** Cost-of-sales completeness: months with goods sales but no confirmed COGS posting. */
export async function cogsGaps(db, from, to) {
  const r = await db.query(`SELECT DISTINCT to_char(i.issue_date, 'YYYY-MM') AS period FROM invoices i JOIN invoice_lines l ON l.invoice_id=i.id
    WHERE i.register='sales' AND l.line_type='revenue_goods' AND i.issue_date BETWEEN $1 AND $2
      AND NOT EXISTS (SELECT 1 FROM cogs_periods c WHERE c.period = to_char(i.issue_date, 'YYYY-MM')) ORDER BY 1`, [from, to]);
  return r.rows.map((x) => x.period);
}

export async function profitAndLoss(db, {from, to, today}) {
  from = D(from, yearStart(today)); to = D(to, today);
  const rows = (await db.query(`SELECT a.code, a.name, a.type, coalesce(sum(l.credit - l.debit),0) AS amount
    FROM accounts a JOIN journal_lines l ON l.account_code=a.code JOIN journal_entries e ON e.id=l.entry_id
    WHERE a.type IN ('revenue','expense') AND e.entry_date BETWEEN $1 AND $2 GROUP BY a.code, a.name, a.type ORDER BY a.type DESC, a.code`, [from, to])).rows;
  const revenue = money.sum(rows.filter((r) => r.type === 'revenue').map((r) => r.amount));
  const expenses = money.sum(rows.filter((r) => r.type === 'expense').map((r) => r.amount));
  const gaps = await cogsGaps(db, from, to);
  const result = money.add(revenue, expenses);
  return report('Pelno (nuostolių) ataskaita', `Pajamų ir sąnaudų sąskaitų apyvartos iš didžiosios knygos ${from}–${to}. Pajamos teigiamos, sąnaudos neigiamos.`,
    [['code', 'Sąskaita'], ['name', 'Pavadinimas'], ['type', 'Tipas'], ['amount', 'Suma', 'money']], rows,
    {filters: {from, to}, totals: {revenue, expenses, result}, incomplete: gaps.length ? {reason: `Pelnas neišsamus: nepatvirtinta parduotų prekių savikaina už ${gaps.join(', ')}. Savikaina NElaikoma nuliu – registruokite ją (Ataskaitos → Savikaina).`, periods: gaps} : null, drill: {column: 'code', to: 'ledger'}});
}

export async function balanceSheet(db, {asOf, today}) {
  asOf = D(asOf, today);
  const rows = (await db.query(`SELECT a.code, a.name, a.type, coalesce(sum(l.debit - l.credit),0) AS balance
    FROM accounts a JOIN journal_lines l ON l.account_code=a.code JOIN journal_entries e ON e.id=l.entry_id
    WHERE e.entry_date <= $1 GROUP BY a.code, a.name, a.type HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.code`, [asOf])).rows;
  const assets = money.sum(rows.filter((r) => r.type === 'asset').map((r) => r.balance));
  const liabilities = money.neg(money.sum(rows.filter((r) => r.type === 'liability').map((r) => r.balance)));
  const equity = money.neg(money.sum(rows.filter((r) => r.type === 'equity').map((r) => r.balance)));
  const unclosed = money.neg(money.sum(rows.filter((r) => ['revenue', 'expense'].includes(r.type)).map((r) => r.balance)));
  const out = rows.filter((r) => ['asset', 'liability', 'equity'].includes(r.type)).map((r) => ({...r, amount: r.type === 'asset' ? r.balance : money.neg(r.balance)}));
  out.push({code: '', name: 'Nepaskirstytas rezultatas (pajamos − sąnaudos, neuždarytos)', type: 'equity', amount: unclosed});
  const gaps = await cogsGaps(db, `${asOf.slice(0, 4)}-01-01`, asOf);
  return report('Balansas', `Turto, įsipareigojimų ir nuosavybės likučiai ${asOf} dienai iš didžiosios knygos. Neuždarytas pajamų ir sąnaudų rezultatas rodomas nuosavybėje.`,
    [['code', 'Sąskaita'], ['name', 'Pavadinimas'], ['type', 'Grupė'], ['amount', 'Suma', 'money']], out,
    {filters: {asOf}, totals: {assets, liabilities, equity: money.add(equity, unclosed), check: money.sub(assets, money.add(liabilities, money.add(equity, unclosed)))},
      balanced: money.eq(assets, money.add(liabilities, money.add(equity, unclosed))),
      incomplete: gaps.length ? {reason: `Atsargų ir rezultato likučiai neišsamūs: nepatvirtinta savikaina už ${gaps.join(', ')}.`, periods: gaps} : null, drill: {column: 'code', to: 'ledger'}});
}

export async function vatRegister(db, {register = 'sales', from, to, today}) {
  from = D(from, `${today.slice(0, 7)}-01`); to = D(to, today);
  const rows = (await db.query(`SELECT i.id, i.issue_date, i.series, i.number, i.doc_type, i.counterparty_snapshot->>'name' AS counterparty, i.counterparty_snapshot->>'vatCode' AS counterparty_vat,
      v.tax_code, v.rate, v.taxable, v.vat, v.deductible_vat, i.document_id, i.related_invoice_id
    FROM invoices i JOIN invoice_vat_rows v ON v.invoice_id=i.id WHERE i.register=$1 AND i.issue_date BETWEEN $2 AND $3 ORDER BY i.issue_date, i.id, v.tax_code`, [register, from, to])).rows;
  const byCode = {};
  for (const r of rows) { const b = byCode[r.tax_code] ||= {taxable: '0.00', vat: '0.00', deductible: '0.00'}; b.taxable = money.add(b.taxable, r.taxable); b.vat = money.add(b.vat, r.vat); b.deductible = money.add(b.deductible, r.deductible_vat); }
  const vatTotal = money.sum(rows.map((r) => (register === 'purchase' ? r.deductible_vat : r.vat)));
  // Reconciliation with the ledger: VAT account movements from invoice postings in the period.
  const role = register === 'purchase' ? 'vat_input' : 'vat_output';
  const ledger = (await db.query(`SELECT coalesce(sum(CASE WHEN $1='vat_input' THEN l.debit - l.credit ELSE l.credit - l.debit END),0) AS v
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code AND a.system_role=$1
    WHERE e.source_type='invoice' AND e.entry_date BETWEEN $2 AND $3`, [role, from, to])).rows[0].v;
  return report(register === 'purchase' ? 'Pirkimų PVM registras' : 'Pardavimų PVM registras',
    `Užregistruotos sąskaitos pagal išrašymo datą ${from}–${to}, suskirstytos pagal PVM kodą. ${register === 'purchase' ? 'Atskaitomas PVM – tik eilutės, pažymėtos kaip atskaitomos.' : ''} Koregavimai rodomi atskiromis eilutėmis.`,
    [['issue_date', 'Data', 'date'], ['series', 'Serija'], ['number', 'Nr.'], ['doc_type', 'Tipas'], ['counterparty', 'Kontrahentas'], ['counterparty_vat', 'PVM kodas'], ['tax_code', 'PVM kodas (VMI)'], ['rate', 'Tarifas %'], ['taxable', 'Apmokestinama vertė', 'money'], ['vat', 'PVM', 'money'], ...(register === 'purchase' ? [['deductible_vat', 'Atskaitomas PVM', 'money']] : [])],
    rows, {filters: {register, from, to}, totals: {byCode, vat: vatTotal}, reconciliation: {ledger, register: vatTotal, ok: money.eq(ledger, vatTotal), note: `Palyginta su ${register === 'purchase' ? 'gautino' : 'mokėtino'} PVM sąskaitos apyvarta iš sąskaitų įrašų.`}, drill: {column: 'id', to: 'invoice'}});
}

export async function aging(db, {register = 'sales', asOf, today}) {
  asOf = D(asOf, today);
  const rows = (await invoiceBalances(db, {register, asOf, openOnly: true, limit: 5000})).map((r) => {
    const days = r.due_date ? Math.floor((Date.parse(asOf) - Date.parse(r.due_date)) / 86400000) : 0;
    const bucket = days <= 0 ? 'nepradelsta' : days <= 30 ? '1–30 d.' : days <= 60 ? '31–60 d.' : days <= 90 ? '61–90 d.' : '> 90 d.';
    return {...r, days_overdue: Math.max(days, 0), bucket};
  });
  const buckets = {};
  for (const r of rows) buckets[r.bucket] = money.add(buckets[r.bucket] || '0', r.outstanding);
  const total = money.sum(rows.map((r) => r.outstanding));
  const role = register === 'sales' ? 'receivable' : 'payable';
  const ledger = (await db.query(`SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code AND a.system_role=$1 WHERE e.entry_date <= $2`, [role, asOf])).rows[0].v;
  const ledgerSigned = register === 'sales' ? ledger : money.neg(ledger);
  return report(register === 'sales' ? 'Pirkėjų skolos (gautinos sumos)' : 'Skolos tiekėjams (mokėtinos sumos)',
    `Neapmokėti sąskaitų likučiai ${asOf} dienai: sąskaita + koregavimai + kreditinės − patvirtinti mokėjimų paskirstymai. Vėlavimas skaičiuojamas nuo apmokėjimo termino.`,
    [['issue_date', 'Data', 'date'], ['series', 'Serija'], ['number', 'Nr.'], ['counterparty_name', 'Kontrahentas'], ['due_date', 'Terminas', 'date'], ['gross', 'Suma', 'money'], ['paid', 'Apmokėta', 'money'], ['outstanding', 'Likutis', 'money'], ['days_overdue', 'Vėluoja d.'], ['bucket', 'Grupė']],
    rows, {filters: {register, asOf}, totals: {outstanding: total, buckets}, reconciliation: {ledger: ledgerSigned, register: total, ok: money.eq(ledgerSigned, total), note: 'Skirtumas galimas dėl rankinių įrašų skolų sąskaitose arba pradinių likučių be sąskaitų.'}, drill: {column: 'id', to: 'invoice'}});
}

export async function salesReport(db, {from, to, groupBy = 'month', today}) {
  from = D(from, yearStart(today)); to = D(to, today);
  const groups = {
    month: [`to_char(i.issue_date,'YYYY-MM')`, 'Mėnuo'],
    store: [`coalesce((SELECT name FROM stores s WHERE s.id=i.store_id), 'Be parduotuvės')`, 'Parduotuvė'],
    customer: [`i.counterparty_snapshot->>'name'`, 'Pirkėjas'],
    product: [`coalesce(nullif(l.sku,''), l.description)`, 'Prekė / paslauga'],
  };
  const [expr, label] = groups[groupBy] || groups.month;
  const rows = (await db.query(`SELECT ${expr} AS key, count(DISTINCT i.id) AS documents, sum(l.quantity) FILTER (WHERE ${groupBy === 'product' ? 'true' : 'false'}) AS quantity,
      sum(l.net) AS net, sum(l.vat) AS vat, sum(l.gross) AS gross
    FROM invoices i JOIN invoice_lines l ON l.invoice_id=i.id WHERE i.register='sales' AND i.issue_date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [from, to])).rows;
  const net = money.sum(rows.map((r) => r.net));
  const ledger = (await db.query(`SELECT coalesce(sum(l.credit - l.debit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN invoices i ON i.journal_entry_id=e.id AND i.register='sales'
    JOIN accounts a ON a.code=l.account_code AND a.type='revenue' WHERE e.entry_date BETWEEN $1 AND $2`, [from, to])).rows[0].v;
  return report('Pardavimai', `Apskaitiniai pardavimai: užregistruotų pardavimo sąskaitų (įskaitant kreditines ir koregavimus) eilutės pagal išrašymo datą ${from}–${to}. Užsakymai be sąskaitų čia neįtraukiami (žr. operacinius rodiklius).`,
    [['key', label], ['documents', 'Dokumentų'], ...(groupBy === 'product' ? [['quantity', 'Kiekis']] : []), ['net', 'Suma be PVM', 'money'], ['vat', 'PVM', 'money'], ['gross', 'Su PVM', 'money']],
    rows, {filters: {from, to, groupBy}, totals: {net}, reconciliation: {ledger, register: net, ok: money.eq(ledger, net), note: 'Palyginta su pajamų sąskaitų apyvarta iš pardavimo sąskaitų įrašų.'}});
}

export async function operationalSales(db, {from, to, today}) {
  from = D(from, yearStart(today)); to = D(to, today);
  const rows = (await db.query(`SELECT s.name AS store, s.is_demo, o.currency, count(*) AS orders, count(*) FILTER (WHERE o.state='posted') AS invoiced,
      sum((o.data->>'total_gross')::numeric) AS gross
    FROM external_orders o JOIN stores s ON s.id=o.store_id WHERE (o.data->>'created_at')::date BETWEEN $1 AND $2 GROUP BY 1,2,3 ORDER BY 1`, [from, to])).rows;
  return report('Operaciniai pardavimų rodikliai (užsakymai)', `Parduotuvių užsakymai pagal sukūrimo datą ${from}–${to}, nepriklausomai nuo sąskaitų išrašymo. Tai NE apskaitos duomenys: grąžinimai, atšaukimai ir PVM gali skirtis nuo užregistruotų sąskaitų.`,
    [['store', 'Parduotuvė'], ['currency', 'Valiuta'], ['orders', 'Užsakymų'], ['invoiced', 'Užregistruota sąskaitų'], ['gross', 'Užsakymų suma su PVM', 'money']], rows, {filters: {from, to}});
}

export async function purchasesReport(db, {from, to, groupBy = 'account', today}) {
  from = D(from, yearStart(today)); to = D(to, today);
  const expr = groupBy === 'supplier' ? `i.counterparty_snapshot->>'name'` : `l.account_code || ' ' || a.name`;
  const rows = (await db.query(`SELECT ${expr} AS key, count(DISTINCT i.id) AS documents, sum(l.net) AS net, sum(l.vat) AS vat, sum(CASE WHEN l.vat_treatment='deductible' THEN l.vat ELSE 0 END) AS deductible_vat, sum(l.gross) AS gross
    FROM invoices i JOIN invoice_lines l ON l.invoice_id=i.id JOIN accounts a ON a.code=l.account_code
    WHERE i.register='purchase' AND i.issue_date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [from, to])).rows;
  return report('Pirkimai ir sąnaudos', `Užregistruotų pirkimo sąskaitų eilutės pagal ${groupBy === 'supplier' ? 'tiekėją' : 'sąskaitą (sąnaudos, atsargos, turtas, ateinančių laikotarpių sąnaudos)'} ${from}–${to}.`,
    [['key', groupBy === 'supplier' ? 'Tiekėjas' : 'Sąskaita'], ['documents', 'Dokumentų'], ['net', 'Suma be PVM', 'money'], ['vat', 'PVM', 'money'], ['deductible_vat', 'Atskaitomas PVM', 'money'], ['gross', 'Su PVM', 'money']],
    rows, {filters: {from, to, groupBy}, totals: {net: money.sum(rows.map((r) => r.net))}});
}

export async function paymentsReport(db, {from, to, today}) {
  from = D(from, yearStart(today)); to = D(to, today);
  const rows = (await db.query(`SELECT to_char(e.entry_date,'YYYY-MM') AS month, a.kind,
      sum(CASE WHEN i.register='sales' OR (a.kind IN ('advance','overpayment') AND t.amount > 0) THEN a.amount ELSE 0 END) AS received,
      sum(CASE WHEN i.register='purchase' OR (a.kind IN ('advance','overpayment') AND t.amount < 0) OR a.kind IN ('fee') THEN a.amount ELSE 0 END) AS paid, count(*) AS allocations
    FROM allocations a JOIN journal_entries e ON e.id=a.journal_entry_id LEFT JOIN invoices i ON i.id=a.invoice_id LEFT JOIN bank_transactions t ON t.id=a.transaction_id
    WHERE e.entry_date BETWEEN $1 AND $2 GROUP BY 1,2 ORDER BY 1,2`, [from, to])).rows;
  return report('Mokėjimų suvestinė', `Patvirtinti banko operacijų paskirstymai pagal įrašo datą ${from}–${to}, pagal paskirstymo tipą.`,
    [['month', 'Mėnuo'], ['kind', 'Tipas'], ['received', 'Gauta', 'money'], ['paid', 'Sumokėta', 'money'], ['allocations', 'Paskirstymų']], rows, {filters: {from, to}});
}

export async function dashboard(db, {from, to, today}) {
  from = D(from, `${today.slice(0, 7)}-01`); to = D(to, today);
  const sales = (await db.query(`SELECT coalesce(sum(net_total),0) AS net, coalesce(sum(gross_total),0) AS gross, count(*) AS n FROM invoices WHERE register='sales' AND issue_date BETWEEN $1 AND $2`, [from, to])).rows[0];
  const received = (await db.query(`SELECT coalesce(sum(t.amount),0) AS v, count(*) AS n FROM bank_transactions t WHERE t.amount > 0 AND t.status='approved' AND t.booking_date BETWEEN $1 AND $2`, [from, to])).rows[0];
  const unpaid = await invoiceBalances(db, {register: 'sales', asOf: today, openOnly: true, limit: 10000});
  const unpaidP = await invoiceBalances(db, {register: 'purchase', asOf: today, openOnly: true, limit: 10000});
  const review = (await db.query(`SELECT count(*) FILTER (WHERE processing_status='needs_review') AS needs_review, count(*) FILTER (WHERE processing_status='ready') AS ready,
      count(*) FILTER (WHERE processing_status IN ('uploaded','processing')) AS processing, count(*) FILTER (WHERE processing_status='failed') AS failed FROM documents WHERE workflow='invoice' AND NOT archived`)).rows[0];
  const bank = (await db.query(`SELECT count(*) FILTER (WHERE status IN ('unmatched','proposed','needs_review')) AS unresolved, coalesce(sum(abs(amount)) FILTER (WHERE status IN ('unmatched','proposed','needs_review')),0) AS amount FROM bank_transactions`)).rows[0];
  const stmt = (await db.query(`SELECT count(*) AS n FROM bank_statements WHERE balance_status <> 'ok' AND resolved_at IS NULL`)).rows[0];
  const overdue = unpaid.filter((r) => r.due_date && r.due_date < today);
  return {
    period: {from, to},
    cards: [
      {key: 'sales', title: 'Pardavimai', value: sales.net, unit: 'EUR', definition: `Užregistruotų pardavimo sąskaitų suma be PVM pagal išrašymo datą ${from}–${to} (${sales.n} dok.).`, link: '#/ataskaitos/pardavimai'},
      {key: 'received', title: 'Gauti mokėjimai', value: received.v, unit: 'EUR', definition: `Patvirtintos gaunamos banko operacijos pagal operacijos datą ${from}–${to} (${received.n}).`, link: '#/bankas'},
      {key: 'unpaid', title: 'Neapmokėtos pardavimo sąskaitos', value: money.sum(unpaid.map((r) => r.outstanding)), unit: 'EUR', definition: `${unpaid.length} sąskaitų likutis šiandien (${today}); iš jų vėluoja ${overdue.length} (${money.sum(overdue.map((r) => r.outstanding))} EUR).`, link: '#/ataskaitos/gautinos'},
      {key: 'payables', title: 'Neapmokėti pirkimai', value: money.sum(unpaidP.map((r) => r.outstanding)), unit: 'EUR', definition: `${unpaidP.length} tiekėjų sąskaitų likutis šiandien.`, link: '#/ataskaitos/moketinos'},
      {key: 'review', title: 'Laukia peržiūros', value: String(Number(review.needs_review) + Number(review.ready)), definition: `Dokumentų dėžutėje: ${review.needs_review} reikia peržiūros, ${review.ready} paruošta patvirtinti, ${review.processing} apdorojama, ${review.failed} nepavyko.`, link: '#/deze'},
      {key: 'bank', title: 'Nesuderintos banko operacijos', value: bank.unresolved, definition: `Importuotos, dar nepatvirtintos operacijos (suma ${money.norm(bank.amount)} EUR). Išrašų su likučių neatitikimu: ${stmt.n}.`, link: '#/bankas'},
    ],
  };
}

// ------------------------------------------------------------------ export
export function toCsv(rep) {
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [rep.columns.map((c) => esc(c[1])).join(';')];
  for (const r of rep.rows) lines.push(rep.columns.map((c) => esc(c[2] === 'money' && r[c[0]] !== null && r[c[0]] !== undefined ? String(r[c[0]]).replace('.', ',') : r[c[0]])).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export async function toXlsx(rep) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(rep.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  ws.addRow([rep.title]).font = {bold: true, size: 13};
  ws.addRow([rep.definition]);
  ws.addRow([]);
  ws.addRow(rep.columns.map((c) => c[1])).font = {bold: true};
  for (const r of rep.rows) ws.addRow(rep.columns.map((c) => (c[2] === 'money' && r[c[0]] !== null && r[c[0]] !== undefined ? Number(r[c[0]]) : r[c[0]] ?? '')));
  rep.columns.forEach((c, i) => { if (c[2] === 'money') ws.getColumn(i + 1).numFmt = '#,##0.00'; ws.getColumn(i + 1).width = Math.max(12, c[1].length + 2); });
  if (rep.incomplete) ws.addRow([`DĖMESIO: ${rep.incomplete.reason}`]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
