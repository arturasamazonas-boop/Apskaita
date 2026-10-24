// Director's view: management profit and loss by month, key figures and a short cash forecast.
// All amounts come from the ledger (P&L, cash, VAT) or from invoice balances (receivables, payables, forecast).
import {NOT_CLOSING} from '../ledger/closing.mjs';
import {money} from '../lib/money.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';
import {roleAccounts} from '../ledger/ledger.mjs';

const MONTHS = ['Sau', 'Vas', 'Kov', 'Bal', 'Geg', 'Bir', 'Lie', 'Rgp', 'Rgs', 'Spa', 'Lap', 'Grd'];
const lt = (v) => money.norm(v).replace('.', ',');
const pct = (a, b) => (Number(b) ? Math.round((Number(a) / Number(b)) * 1000) / 10 : null);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// Management lines by account prefix (Lithuanian chart: 50 sales, 60 cost of sales, 62–63 operating costs, ...).
// Sign: income positive, costs negative.
const GROUPS = [
  ['revenue', 'Pardavimo pajamos', /^50/],
  ['cogs', 'Pardavimo savikaina', /^60/],
  ['opex', 'Veiklos sąnaudos (pardavimo, bendrosios ir administracinės)', /^6[23]/],
  ['other_op', 'Kita veikla (grynasis rezultatas)', /^(5[14]|6[14])/],
  ['finance', 'Finansinė veikla (grynasis rezultatas)', /^(5[5-9]|6[5-8])/],
  ['tax', 'Pelno mokestis', /^69/],
];
const DEPRECIATION = /nusidėvėj|amortizac/i;

/** Management P&L: one column per month of the year, with gross margin, EBITDA and net result. */
export async function managementPL(db, {year, today}) {
  year = /^\d{4}$/.test(String(year || '')) ? Number(year) : Number(today.slice(0, 4));
  const rows = (await db.query(`SELECT a.code, a.name, extract(month FROM e.entry_date)::int AS m, sum(l.credit - l.debit) AS amount
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code
    WHERE a.type IN ('revenue','expense') AND e.entry_date BETWEEN $1 AND $2 AND ${NOT_CLOSING}
    GROUP BY a.code, a.name, m`, [`${year}-01-01`, `${year}-12-31`])).rows;
  const empty = () => Array(12).fill('0.00');
  const g = Object.fromEntries(GROUPS.map(([k]) => [k, empty()]));
  const dep = empty();
  for (const r of rows) {
    const grp = GROUPS.find(([, , re]) => re.test(r.code));
    const k = grp ? grp[0] : (r.code.startsWith('5') ? 'other_op' : 'opex');
    g[k][r.m - 1] = money.add(g[k][r.m - 1], r.amount);
    if (r.code.startsWith('6') && DEPRECIATION.test(r.name)) dep[r.m - 1] = money.add(dep[r.m - 1], r.amount);
  }
  const col = (f) => Array.from({length: 12}, (_, i) => f(i));
  const gross = col((i) => money.add(g.revenue[i], g.cogs[i]));
  const ebit = col((i) => money.add(money.add(gross[i], g.opex[i]), g.other_op[i]));
  const ebitda = col((i) => money.sub(ebit[i], dep[i]));
  const pbt = col((i) => money.add(ebit[i], g.finance[i]));
  const net = col((i) => money.add(pbt[i], g.tax[i]));
  const margin = col((i) => pct(gross[i], g.revenue[i]));
  const line = (key, label, values, extra = {}) => {
    const r = {key, label, ...extra};
    values.forEach((v, i) => { r[`m${i + 1}`] = v; });
    r.total = values.every((v) => v === null) ? null : typeof values[0] === 'number' || values[0] === null ? null : money.sum(values);
    return r;
  };
  const sum = (a) => money.sum(a);
  const out = [
    line('revenue', 'Pardavimo pajamos', g.revenue, {strong: true}),
    line('cogs', 'Pardavimo savikaina', g.cogs),
    line('gross', 'Bendrasis pelnas', gross, {strong: true}),
    {...line('margin', 'Bendroji marža, %', margin), total: pct(sum(gross), sum(g.revenue))},
    line('opex', 'Veiklos sąnaudos', g.opex),
    line('other_op', 'Kita veikla', g.other_op),
    line('ebitda', 'EBITDA (prieš nusidėvėjimą)', ebitda, {strong: true}),
    line('dep', 'Nusidėvėjimas ir amortizacija', dep),
    line('ebit', 'Veiklos pelnas (EBIT)', ebit, {strong: true}),
    line('finance', 'Finansinė veikla', g.finance),
    line('pbt', 'Pelnas prieš apmokestinimą', pbt),
    line('tax', 'Pelno mokestis', g.tax),
    line('net', 'Grynasis pelnas (nuostoliai)', net, {strong: true}),
  ];
  const lastMonth = Number(year) === Number(today.slice(0, 4)) ? Number(today.slice(5, 7)) : 12;
  return {title: `Valdymo pelno (nuostolių) ataskaita ${year} m.`,
    definition: `Pajamos ir sąnaudos iš didžiosios knygos pagal mėnesius (be metų uždarymo įrašų). Pajamos teigiamos, sąnaudos neigiamos. Grupės pagal sąskaitų plano klases: 50 pajamos, 60 savikaina, 62–63 veiklos sąnaudos, 69 pelno mokestis; nusidėvėjimas – sąnaudų sąskaitos, kurių pavadinime yra „nusidėvėjimas“ ar „amortizacija“.`,
    columns: [['label', 'Rodiklis'], ...MONTHS.slice(0, lastMonth).map((m, i) => [`m${i + 1}`, m, 'money']), ['total', 'Iš viso', 'money']],
    rows: out, filters: {year}};
}

/** Key figures, cash forecast for 8 weeks, top customers and debtors. */
export async function directorSummary(db, {today}) {
  const roles = await roleAccounts(db);
  const year = today.slice(0, 4), ytdFrom = `${year}-01-01`;
  const lastYear = String(Number(year) - 1), lyTo = `${lastYear}${today.slice(4)}`;
  const bal = async (re) => (await db.query(`SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code ~ $1 AND e.entry_date <= $2`, [re, today])).rows[0].v;
  // Cash: bank and cash-desk accounts (271, 272), not the transfer clearing account.
  const bankAccounts = (await db.query('SELECT DISTINCT ledger_account FROM bank_accounts')).rows.map((r) => r.ledger_account);
  const cashRe = `^(27[12]${bankAccounts.length ? '|' + bankAccounts.map((c) => c.replace(/\D/g, '')).filter(Boolean).join('|') : ''})`;
  const cash = money.norm(await bal(cashRe));
  const vatPayable = money.neg(money.add(await bal(`^(${roles.vat_output || '4492'}|${roles.vat_input || '2441'})$`), '0'));
  const salesNet = async (from, to) => (await db.query(`SELECT coalesce(sum(net_total),0) AS v FROM invoices WHERE register='sales' AND issue_date BETWEEN $1 AND $2`, [from, to])).rows[0].v;
  const gross90 = async (reg) => (await db.query(`SELECT coalesce(sum(gross_total),0) AS v FROM invoices WHERE register=$1 AND issue_date BETWEEN $2 AND $3`, [reg, addDays(today, -89), today])).rows[0].v;
  const ytd = money.norm(await salesNet(ytdFrom, today)), lytd = money.norm(await salesNet(`${lastYear}-01-01`, lyTo));
  const pl = await managementPL(db, {year, today});
  const totalOf = (k) => pl.rows.find((r) => r.key === k).total;
  const recv = await invoiceBalances(db, {register: 'sales', asOf: today, openOnly: true, limit: 100000});
  const pay = await invoiceBalances(db, {register: 'purchase', asOf: today, openOnly: true, limit: 100000});
  const sumOut = (list) => money.sum(list.map((r) => r.outstanding));
  const overdue = (list) => list.filter((r) => r.due_date && r.due_date < today);
  const recvTotal = sumOut(recv), payTotal = sumOut(pay);
  const s90 = await gross90('sales'), p90 = await gross90('purchase');
  const kpis = [
    {key: 'cash', title: 'Pinigai banke ir kasoje', value: cash, unit: 'EUR', definition: `DK likutis ${today} (sąskaitos ${[...new Set(['271', '272', ...bankAccounts])].join(', ')}).`, link: '#/bankas/saskaitos'},
    {key: 'sales_ytd', title: `Pardavimai ${year} m. (be PVM)`, value: ytd, unit: 'EUR', change: pct(money.sub(ytd, lytd), lytd), definition: `Sausio 1 d. – ${today}. Praėjusiais metais tuo pačiu laikotarpiu ${lt(lytd)} EUR.`, link: `#/ataskaitos/pardavimai?from=${ytdFrom}&to=${today}`},
    {key: 'margin', title: 'Bendroji marža', value: totalOf('margin') === null ? '—' : `${String(totalOf('margin')).replace('.', ',')} %`, definition: `Bendrasis pelnas ${lt(totalOf('gross'))} EUR iš pajamų ${lt(totalOf('revenue'))} EUR (${year} m.).`, link: '#/vadovas'},
    {key: 'net', title: `Grynasis rezultatas ${year} m.`, value: totalOf('net'), unit: 'EUR', definition: 'Iš didžiosios knygos; tikslus tik užregistravus savikainą, nusidėvėjimą ir sukauptas sąnaudas.', link: `#/ataskaitos/pelnas?from=${ytdFrom}&to=${today}`},
    {key: 'receivables', title: 'Pirkėjų skolos', value: recvTotal, unit: 'EUR', definition: `${recv.length} sąsk.; pradelsta ${overdue(recv).length} už ${lt(sumOut(overdue(recv)))} EUR.`, link: `#/ataskaitos/gautinos?asOf=${today}`},
    {key: 'dso', title: 'Apyvartumas (DSO)', value: Number(s90) ? `${Math.round((Number(recvTotal) / Number(s90)) * 90)} d.` : '—', definition: `Kiek dienų vidutiniškai laukiama apmokėjimo: skolos / 90 d. pardavimai su PVM (${lt((s90))} EUR) × 90.`, link: `#/ataskaitos/gautinos?asOf=${today}`},
    {key: 'payables', title: 'Skolos tiekėjams', value: payTotal, unit: 'EUR', definition: `${pay.length} sąsk.; pradelsta ${overdue(pay).length} už ${lt(sumOut(overdue(pay)))} EUR. DPO ${Number(p90) ? Math.round((Number(payTotal) / Number(p90)) * 90) : '—'} d.`, link: `#/ataskaitos/moketinos?asOf=${today}`},
    {key: 'vat', title: 'PVM mokėtinas (įvertis)', value: vatPayable, unit: 'EUR', definition: `Pardavimo ir pirkimo PVM sąskaitų (${roles.vat_output || '4492'}, ${roles.vat_input || '2441'}) likutis ${today}. Teigiamas – mokėti, neigiamas – grąžintinas.`, link: '#/fr0600'},
  ];
  // Cash forecast: open invoices by due date (overdue ones in the first week), 8 weeks from this Monday.
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -dow);
  const weeks = Array.from({length: 8}, (_, i) => ({from: addDays(monday, i * 7), to: addDays(monday, i * 7 + 6), inflow: '0.00', outflow: '0.00', overdueIn: '0.00', overdueOut: '0.00'}));
  const place = (list, key, overdueKey) => {
    let later = '0.00';
    for (const r of list) {
      const due = r.due_date || addDays(String(r.issue_date).slice(0, 10), 30);
      const w = due < weeks[0].from ? weeks[0] : weeks.find((x) => due >= x.from && due <= x.to);
      if (!w) { later = money.add(later, r.outstanding); continue; }
      w[key] = money.add(w[key], r.outstanding);
      if (due < today) w[overdueKey] = money.add(w[overdueKey], r.outstanding);
    }
    return later;
  };
  const laterIn = place(recv, 'inflow', 'overdueIn'), laterOut = place(pay, 'outflow', 'overdueOut');
  let running = cash;
  for (const w of weeks) { w.net = money.sub(w.inflow, w.outflow); running = money.add(running, w.net); w.closing = running; }
  // Top customers this year and the largest debtors.
  const top = (await db.query(`SELECT coalesce(counterparty_snapshot->>'name','—') AS name, counterparty_id, sum(net_total) AS net, count(*) AS n
    FROM invoices WHERE register='sales' AND issue_date BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY sum(net_total) DESC LIMIT 10`, [ytdFrom, today])).rows
    .map((r) => ({...r, net: money.norm(r.net), share: pct(r.net, ytd)}));
  const byDebtor = new Map();
  for (const r of recv) {
    const k = String(r.counterparty_id || r.counterparty_name);
    const d = byDebtor.get(k) || {name: r.counterparty_name, counterparty_id: r.counterparty_id, outstanding: '0.00', overdue: '0.00', oldest: null, n: 0};
    d.outstanding = money.add(d.outstanding, r.outstanding); d.n++;
    if (r.due_date && r.due_date < today) { d.overdue = money.add(d.overdue, r.outstanding); if (!d.oldest || r.due_date < d.oldest) d.oldest = r.due_date; }
    byDebtor.set(k, d);
  }
  const debtors = [...byDebtor.values()].sort((a, b) => money.cmp(b.overdue, a.overdue) || money.cmp(b.outstanding, a.outstanding)).slice(0, 10)
    .map((d) => ({...d, daysLate: d.oldest ? Math.round((Date.parse(today) - Date.parse(d.oldest)) / 86400000) : 0}));
  return {today, year, kpis, forecast: {opening: cash, weeks, laterIn, laterOut,
    note: 'Prognozė pagal neapmokėtų sąskaitų apmokėjimo terminus (be termino – išrašymo data + 30 d.); pradelstos įtrauktos į pirmą savaitę. Neįtraukti atlyginimai, mokesčiai, paskolų grąžinimai ir dar neišrašytos sąskaitos.'},
  topCustomers: top, debtors, pl};
}
