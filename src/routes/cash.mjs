// Kasa: cash receipt (KPO) and payment (KIO) orders posted to the cash account, invoice settlement, cash book, PDF.
import PDFDocument from 'pdfkit';
import path from 'node:path';
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {readJson, SECURITY_HEADERS} from '../http.mjs';
import {audit} from '../audit.mjs';
import {ROOT} from '../config.mjs';
import {money} from '../lib/money.mjs';
import {amountInWords} from '../lib/lt-words.mjs';
import {postEntry, reverseEntry, roleAccounts} from '../ledger/ledger.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';
import {todayVilnius} from '../invoices/context.mjs';

const s = (v, n = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const CASH = '272';
// Atsiskaitymų grynaisiais pinigais ribojimo įstatymas: cash settlements above 5 000 € per transaction are not allowed.
const CASH_LIMIT = '5000';
const KIND = {receipt: 'Kasos pajamų orderis', payment: 'Kasos išlaidų orderis'};

async function cashBalance(db, account, date) {
  return money.norm((await db.query(`SELECT coalesce(sum(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code=$1 AND e.entry_date <= $2`, [account, date])).rows[0].b);
}

/** Lowest end-of-day cash balance on `date` and every later day: a payment on `date` must not make any later day negative. */
async function lowestBalanceFrom(db, account, date) {
  const r = (await db.query(`WITH days AS (SELECT e.entry_date AS d, sum(l.debit - l.credit) AS net FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code=$1 GROUP BY 1),
      run AS (SELECT d, sum(net) OVER (ORDER BY d) AS bal FROM days)
    SELECT min(bal) AS m FROM run WHERE d > $2`, [account, date])).rows[0].m;
  const at = await cashBalance(db, account, date);
  return r === null || r === undefined ? at : money.min(at, money.norm(r));
}

async function loadOrder(db, id) {
  const o = (await db.query(`SELECT o.*, a.name AS account_name, c.name AS counterparty_name, c.company_code AS counterparty_code, i.series AS invoice_series, i.number AS invoice_number
    FROM cash_orders o JOIN accounts a ON a.code=o.account_code LEFT JOIN counterparties c ON c.id=o.counterparty_id LEFT JOIN invoices i ON i.id=o.invoice_id WHERE o.id=$1`, [id])).rows[0];
  if (!o) throw new AppError(404, 'not_found', 'Orderis nerastas.');
  return {...o, id: String(o.id), amount: money.norm(o.amount), doc_date: String(o.doc_date instanceof Date ? o.doc_date.toISOString() : o.doc_date).slice(0, 10)};
}

function renderOrderPdf(o, company) {
  const doc = new PDFDocument({size: 'A4', margins: {top: 40, bottom: 30, left: 50, right: 50}, info: {Title: `${KIND[o.kind]} ${o.series} ${o.number}`, Producer: 'Apskaita'}});
  doc.registerFont('r', path.join(ROOT, 'assets/fonts/DejaVuSans.ttf'));
  doc.registerFont('b', path.join(ROOT, 'assets/fonts/DejaVuSans-Bold.ttf'));
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 100;
  const amount = Number(o.amount).toLocaleString('lt-LT', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const who = o.person_name || o.counterparty_name || '';
  const row = (label, value, y) => { doc.font('r').fontSize(9).fillColor('#444').text(label, 50, y, {width: 150}); doc.font('b').fontSize(10).fillColor('#000').text(value || '—', 200, y, {width: W - 150}); doc.moveTo(200, y + 13).lineTo(50 + W, y + 13).lineWidth(0.4).strokeColor('#999').stroke(); };
  const block = (top) => {
    doc.font('b').fontSize(10).fillColor('#000').text(`${company.legal_form && !company.name.startsWith(company.legal_form) ? company.legal_form + ' ' : ''}${company.name}`, 50, top, {width: W});
    doc.font('r').fontSize(8).fillColor('#444').text([company.company_code && `Įmonės kodas ${company.company_code}`, company.vat_code && `PVM mokėtojo kodas ${company.vat_code}`, company.address].filter(Boolean).join(', '), 50, top + 14, {width: W});
    doc.font('b').fontSize(15).fillColor('#000').text(KIND[o.kind].toUpperCase(), 50, top + 40, {width: W, align: 'center'});
    doc.font('r').fontSize(10).text(`Serija ${o.series}   Nr. ${o.number}`, 50, top + 62, {width: W, align: 'center'});
    doc.text(o.doc_date, 50, top + 76, {width: W, align: 'center'});
    let y = top + 104;
    row(o.kind === 'receipt' ? 'Gauta iš' : 'Išmokėta', [who, o.person_code || o.counterparty_code].filter(Boolean).join(', '), y); y += 24;
    row('Pagrindas', o.basis || (o.invoice_number ? `Sąskaita ${o.invoice_series || ''} ${o.invoice_number}` : ''), y); y += 24;
    row('Korespondencinė sąskaita', `${o.account_code} ${o.account_name}`, y); y += 24;
    row('Suma', `${amount} Eur`, y); y += 24;
    row('Suma žodžiais', amountInWords(o.amount), y); y += 24;
    row('Priedai', o.attachment, y); y += 40;
    doc.font('r').fontSize(9).fillColor('#000');
    const sig = o.kind === 'receipt'
      ? [['Kasininkas', ''], ['Pinigus sumokėjo', who]]
      : [['Vadovas', company.manager || ''], ['Vyr. buhalteris', company.accountant_name || ''], ['Kasininkas', ''], ['Pinigus gavau', who]];
    sig.forEach(([t, n], i) => { const x = 50 + (i % 2) * (W / 2), yy = y + Math.floor(i / 2) * 34; doc.text(`${t}`, x, yy); doc.moveTo(x + 95, yy + 10).lineTo(x + W / 2 - 20, yy + 10).lineWidth(0.4).strokeColor('#000').stroke(); doc.fontSize(7).fillColor('#555').text(`(parašas, vardas, pavardė) ${n}`, x + 95, yy + 13); doc.fontSize(9).fillColor('#000'); });
    if (o.status === 'cancelled') doc.font('b').fontSize(40).fillColor('#c00').opacity(0.25).text('ANULIUOTAS', 50, top + 150, {width: W, align: 'center'}).opacity(1).fillColor('#000');
  };
  block(40);
  if (o.kind === 'receipt') {
    // Receipt (kvitas) for the payer, cut off along the dashed line.
    doc.moveTo(50, 430).lineTo(50 + W, 430).dash(4, {space: 3}).lineWidth(0.6).strokeColor('#555').stroke().undash();
    doc.font('r').fontSize(7).fillColor('#555').text('nukirpti', 50, 433, {width: W, align: 'center'});
    doc.font('b').fontSize(12).fillColor('#000').text(`KVITAS prie kasos pajamų orderio ${o.series} Nr. ${o.number}`, 50, 455, {width: W, align: 'center'});
    let y = 485;
    row('Įmonė', company.name, y); y += 24;
    row('Gauta iš', who, y); y += 24;
    row('Pagrindas', o.basis || (o.invoice_number ? `Sąskaita ${o.invoice_series || ''} ${o.invoice_number}` : ''), y); y += 24;
    row('Suma', `${amount} Eur`, y); y += 24;
    row('Suma žodžiais', amountInWords(o.amount), y); y += 24;
    row('Data', o.doc_date, y); y += 40;
    doc.font('r').fontSize(9).text('Kasininkas', 50, y); doc.moveTo(145, y + 10).lineTo(320, y + 10).lineWidth(0.4).strokeColor('#000').stroke(); doc.text('A. V.', 360, y);
  }
  doc.end();
  return done;
}

export function register(r, {pool}) {
  r.get('/api/cash/orders', async ({user, query}) => {
    requireCap(user, 'read');
    const from = isDate(query.from) ? query.from : `${todayVilnius().slice(0, 4)}-01-01`, to = isDate(query.to) ? query.to : todayVilnius();
    return (await pool.query(`SELECT o.id, o.kind, o.series, o.number, o.doc_date, o.purpose, o.amount, o.status, o.account_code, coalesce(nullif(o.person_name,''), c.name) AS who, o.basis
      FROM cash_orders o LEFT JOIN counterparties c ON c.id=o.counterparty_id WHERE o.doc_date BETWEEN $1 AND $2 ${['receipt', 'payment'].includes(query.kind) ? `AND o.kind='${query.kind}'` : ''}
      ORDER BY o.doc_date DESC, o.id DESC LIMIT 1000`, [from, to])).rows;
  });
  r.get('/api/cash/open-invoices', async ({user, query}) => {
    requireCap(user, 'read');
    const register = query.kind === 'payment' ? 'purchase' : 'sales';
    return (await invoiceBalances(pool, {register, openOnly: true, limit: 500})).filter((x) => x.currency === 'EUR' && money.cmp(x.outstanding, '0') > 0)
      .map((x) => ({id: String(x.id), label: `${x.series || ''} ${x.number}`.trim(), counterparty: x.counterparty_name, outstanding: money.norm(x.outstanding), issue_date: x.issue_date}));
  });
  r.get('/api/cash/orders/:id', async ({user, params}) => { requireCap(user, 'read'); return loadOrder(pool, params.id); });
  r.get('/api/cash/orders/:id/pdf', async ({user, params, res}) => {
    requireCap(user, 'read');
    const o = await loadOrder(pool, params.id);
    const company = (await pool.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
    const pdf = await renderOrderPdf(o, company);
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${o.series}${o.number}.pdf"`, 'Cache-Control': 'no-store'});
    res.end(pdf);
  });
  r.post('/api/cash/orders', async ({req, user}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    const kind = b.kind === 'payment' ? 'payment' : 'receipt';
    const purpose = ['invoice', 'advance', 'bank', 'accountable', 'other'].includes(b.purpose) ? b.purpose : null;
    if (!purpose) throw new AppError(400, 'purpose', 'Pasirinkite operacijos rūšį.');
    const date = isDate(b.date) ? b.date : null;
    if (!date) throw new AppError(400, 'date', 'Nurodykite datą.');
    const amount = String(b.amount || '').replace(',', '.').replace(/\s/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || money.isZero(amount)) throw new AppError(400, 'amount', 'Suma turi būti teigiama (eurais ir centais).');
    return tx(pool, async (db) => {
      const roles = await roleAccounts(db);
      const cash = s(b.cashAccount, 8) || CASH;
      if (!(await db.query(`SELECT 1 FROM accounts WHERE code=$1 AND code LIKE '272%' AND active AND postable`, [cash])).rowCount) throw new AppError(400, 'cash_account', 'Kasos sąskaita turi būti 272 grupės detalioji sąskaita.');
      let account, counterpartyId = b.counterpartyId ? String(b.counterpartyId) : null, invoiceId = null, employeeId = null, personName = s(b.personName, 120), personCode = s(b.personCode, 20);
      const warnings = [];
      if (purpose === 'invoice') {
        const inv = (await invoiceBalances(db, {ids: [String(b.invoiceId)]}))[0];
        if (!inv) throw new AppError(400, 'invoice', 'Pasirinkite sąskaitą.');
        if (inv.register !== (kind === 'receipt' ? 'sales' : 'purchase')) throw new AppError(400, 'invoice', kind === 'receipt' ? 'KPO apmokama pardavimo sąskaita.' : 'KIO apmokama pirkimo sąskaita.');
        if (inv.currency !== 'EUR') throw new AppError(422, 'currency', `Sąskaita ${inv.currency} valiuta – apmokėjimą registruokite per banką (kursų skirtumas skaičiuojamas automatiškai).`);
        if (money.cmp(amount, inv.outstanding) > 0) throw new AppError(400, 'amount', `Suma ${amount} viršija sąskaitos likutį ${money.norm(inv.outstanding)}.`);
        account = kind === 'receipt' ? roles.receivable : roles.payable;
        invoiceId = String(inv.id); counterpartyId = inv.counterparty_id ? String(inv.counterparty_id) : null;
        personName ||= inv.counterparty_name || '';
      } else if (purpose === 'advance') {
        account = kind === 'receipt' ? roles.advances_received : roles.advances_paid;
        if (!counterpartyId) throw new AppError(400, 'counterparty', 'Avansui nurodykite kontrahentą.');
      } else if (purpose === 'bank') {
        account = roles.transfer_clearing; // money in transit between the cash desk and the bank (273)
        personName ||= kind === 'receipt' ? 'Paimta iš banko' : 'Įnešta į banką';
      } else if (purpose === 'accountable') {
        const e = (await db.query('SELECT * FROM employees WHERE id=$1', [b.employeeId])).rows[0];
        if (!e) throw new AppError(400, 'employee', 'Pasirinkite atskaitingą asmenį (darbuotoją).');
        account = '2445'; employeeId = String(e.id); personName = `${e.first_name} ${e.last_name}`; personCode ||= '';
      } else {
        account = s(b.accountCode, 8);
        if (!(await db.query('SELECT 1 FROM accounts WHERE code=$1 AND active AND postable', [account])).rowCount) throw new AppError(400, 'account', 'Nurodykite korespondencinę sąskaitą (detaliąją).');
        if (account.startsWith('272')) throw new AppError(400, 'account', 'Korespondencinė sąskaita negali būti kasa.');
      }
      if (!account) throw new AppError(422, 'mapping_missing', 'Nenustatyta korespondencinė sąskaita (Servisas → Kontavimo susiejimai).');
      if (counterpartyId && !(await db.query('SELECT 1 FROM counterparties WHERE id=$1', [counterpartyId])).rowCount) throw new AppError(400, 'counterparty', 'Kontrahentas nerastas.');
      if (!personName && counterpartyId) personName = (await db.query('SELECT name FROM counterparties WHERE id=$1', [counterpartyId])).rows[0].name;
      if (!personName) throw new AppError(400, 'person', kind === 'receipt' ? 'Nurodykite, iš ko gauti pinigai.' : 'Nurodykite, kam išmokėti pinigai.');
      if (kind === 'payment') {
        const bal = await cashBalance(db, cash, date), low = await lowestBalanceFrom(db, cash, date);
        if (money.cmp(amount, bal) > 0) throw new AppError(422, 'cash_negative', `Kasoje ${date} yra ${bal} Eur – negalima išmokėti ${amount} Eur (kasos likutis negali būti neigiamas).`);
        if (money.cmp(amount, low) > 0) throw new AppError(422, 'cash_negative', `Kasoje ${date} yra ${bal} Eur, bet po vėlesnių išmokėjimų likutis nukristų iki ${low} Eur – išmokėjus ${amount} Eur jis taptų neigiamas.`);
      }
      if (['invoice', 'advance'].includes(purpose) && money.cmp(amount, CASH_LIMIT) > 0) warnings.push(`Atsiskaitymai grynaisiais pinigais virš ${CASH_LIMIT} € pagal vieną sandorį ribojami (Atsiskaitymų grynaisiais pinigais ribojimo įstatymas).`);
      const ser = (await db.query('UPDATE cash_order_series SET next_number = next_number + 1 WHERE kind=$1 RETURNING next_number - 1 AS n, padding, prefix', [kind])).rows[0];
      const number = String(ser.n).padStart(ser.padding, '0');
      const o = (await db.query(`INSERT INTO cash_orders(kind, series, number, doc_date, cash_account, purpose, invoice_id, counterparty_id, employee_id, person_name, person_code, account_code, amount, basis, attachment, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [kind, ser.prefix, number, date, cash, purpose, invoiceId, counterpartyId, employeeId, personName, personCode, account, amount, s(b.basis, 300), s(b.attachment, 200), user.id])).rows[0];
      const label = `${ser.prefix} ${number}`;
      const lines = kind === 'receipt'
        ? [{account: cash, debit: amount, description: label}, {account, credit: amount, counterpartyId, description: `${label} ${personName}`.slice(0, 200)}]
        : [{account, debit: amount, counterpartyId, description: `${label} ${personName}`.slice(0, 200)}, {account: cash, credit: amount, description: label}];
      const e = await postEntry(db, {date, description: `${KIND[kind]} ${label}: ${s(b.basis, 200) || personName}`.slice(0, 300), sourceType: 'cash_order', sourceId: o.id, idempotencyKey: `cash-order:${o.id}`, userId: user.id, lines});
      await db.query('UPDATE cash_orders SET journal_entry_id=$2 WHERE id=$1', [o.id, e.id]);
      if (invoiceId) await db.query(`INSERT INTO allocations(cash_order_id, kind, invoice_id, counterparty_id, account_code, amount, journal_entry_id, note, approved_by) VALUES ($1,'invoice',$2,$3,$4,$5,$6,$7,$8)`,
        [o.id, invoiceId, counterpartyId, account, amount, e.id, label, user.id]);
      await audit(db, {userId: user.id, action: 'cash.order', entityType: 'cash_order', entityId: o.id, details: {kind, number: label, amount, purpose, entryId: e.id}});
      return {...(await loadOrder(db, o.id)), warnings};
    });
  });
  r.post('/api/cash/orders/:id/cancel', async ({req, user, params}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    if (s(b.reason).length < 5) throw new AppError(400, 'reason', 'Nurodykite anuliavimo priežastį.');
    return tx(pool, async (db) => {
      const o = (await db.query('SELECT * FROM cash_orders WHERE id=$1 FOR UPDATE', [params.id])).rows[0];
      if (!o) throw new AppError(404, 'not_found', 'Orderis nerastas.');
      if (o.status === 'cancelled') throw new AppError(409, 'cancelled', 'Orderis jau anuliuotas.');
      const date = String(o.doc_date instanceof Date ? o.doc_date.toISOString() : o.doc_date).slice(0, 10);
      if (o.kind === 'receipt') {
        const after = money.sub(await lowestBalanceFrom(db, o.cash_account, date), o.amount);
        if (money.cmp(after, '0') < 0) throw new AppError(422, 'cash_negative', `Anuliavus KPO kasos likutis kurią nors dieną taptų neigiamas (${after} Eur) – pirmiausia anuliuokite vėlesnius KIO.`);
      }
      const rev = await reverseEntry(db, {entryId: o.journal_entry_id, date, reason: `${o.series} ${o.number}: ${s(b.reason, 200)}`, userId: user.id});
      if (o.invoice_id) await db.query(`INSERT INTO allocations(cash_order_id, kind, invoice_id, counterparty_id, account_code, amount, journal_entry_id, note, approved_by) VALUES ($1,'invoice',$2,$3,$4,$5,$6,$7,$8)`,
        [o.id, o.invoice_id, o.counterparty_id, o.account_code, money.neg(o.amount), rev.id, `Anuliuota ${o.series} ${o.number}`, user.id]);
      await db.query(`UPDATE cash_orders SET status='cancelled', cancel_entry_id=$2, cancel_reason=$3 WHERE id=$1`, [o.id, rev.id, s(b.reason, 200)]);
      await audit(db, {userId: user.id, action: 'cash.cancel', entityType: 'cash_order', entityId: o.id, details: {reversal: rev.id, reason: s(b.reason, 200)}});
      return {ok: true};
    });
  });
  // Kasos knyga: every movement of the cash account by day, with the day's opening and closing balance.
  r.get('/api/cash/book', async ({user, query}) => {
    requireCap(user, 'read');
    const from = isDate(query.from) ? query.from : `${todayVilnius().slice(0, 7)}-01`, to = isDate(query.to) ? query.to : todayVilnius();
    const acct = s(query.account, 8) || CASH;
    const opening = await cashBalance(pool, acct, new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10));
    const rows = (await pool.query(`SELECT e.entry_date, e.id AS entry_id, e.description, l.debit, l.credit, o.id AS order_id, o.series, o.number, coalesce(nullif(o.person_name,''), '') AS who, o.account_code AS corr
      FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id LEFT JOIN cash_orders o ON o.journal_entry_id=e.id OR o.cancel_entry_id=e.id
      WHERE l.account_code=$1 AND e.entry_date BETWEEN $2 AND $3 ORDER BY e.entry_date, e.id`, [acct, from, to])).rows;
    let bal = opening;
    const days = [];
    for (const x of rows) {
      const d = String(x.entry_date instanceof Date ? x.entry_date.toISOString() : x.entry_date).slice(0, 10);
      if (!days.length || days.at(-1).date !== d) days.push({date: d, opening: bal, rows: [], receipts: '0.00', payments: '0.00'});
      const day = days.at(-1);
      bal = money.add(bal, money.sub(x.debit, x.credit));
      day.receipts = money.add(day.receipts, x.debit); day.payments = money.add(day.payments, x.credit); day.closing = bal;
      day.rows.push({entryId: String(x.entry_id), orderId: x.order_id ? String(x.order_id) : null, document: x.series ? `${x.series} ${x.number}` : `Įrašas #${x.entry_id}`, who: x.who, description: x.description,
        receipt: money.norm(x.debit), payment: money.norm(x.credit), balance: bal});
    }
    return {account: acct, from, to, opening, closing: bal, days, receipts: money.sum(days.map((d) => d.receipts)), payments: money.sum(days.map((d) => d.payments))};
  });
}
