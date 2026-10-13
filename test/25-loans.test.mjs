// Palūkanos: interest from the day the money arrived, the "include the repayment day" switch, rate changes, day-count
// bases, reading a loan agreement and the loans API.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {startTestApp, COMPANY} from './helpers.mjs';
import {calcInterest, simpleInterest} from '../src/loans/interest.mjs';
import {parseLoanContract, parseAmount} from '../src/loans/contract-parser.mjs';

let t, acc, ro;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
});
after(async () => { await t?.close(); });

test('interest: from the disbursement day, repayment day included only when asked, exact to the cent', () => {
  // 10 000 € at 5 % for the whole of 2026: 365 days with the last day, 364 without.
  assert.equal(simpleInterest({amount: '10000', from: '2026-01-01', to: '2026-12-31', rate: '5', includeLastDay: true}).interest, '500.00');
  const r = simpleInterest({amount: '10000', from: '2026-01-01', to: '2026-12-31', rate: '5'});
  assert.equal(r.days, 364); assert.equal(r.interest, '498.63');
  // Partial repayment, then a rate change; 10 € of interest already paid.
  const c = calcInterest({events: [{date: '2026-01-10', kind: 'disbursement', amount: '10000'}, {date: '2026-03-01', kind: 'repayment', amount: '4000'},
    {date: '2026-04-01', kind: 'rate_change', rate: '6'}, {date: '2026-02-01', kind: 'interest_payment', amount: '10'}], rate: '5', asOf: '2026-04-30', includeLastDay: true});
  assert.deepEqual(c.periods.map((p) => [p.from, p.to, p.days, p.balance, p.interest]), [
    ['2026-01-10', '2026-03-01', 51, '10000.00', '69.86'], // repayment day still charged on 10 000
    ['2026-03-02', '2026-03-31', 30, '6000.00', '24.66'],
    ['2026-04-01', '2026-04-30', 30, '6000.00', '29.59']]);
  assert.deepEqual([c.interest, c.paid, c.due, c.balance], ['124.11', '10.00', '114.11', '6000.00']);
  // Without the switch the repaid 4 000 stops earning on the repayment day itself.
  const c2 = calcInterest({events: [{date: '2026-01-10', kind: 'disbursement', amount: '10000'}, {date: '2026-03-01', kind: 'repayment', amount: '4000'}], rate: '5', asOf: '2026-03-31'});
  assert.deepEqual(c2.periods.map((p) => [p.from, p.to, p.days]), [['2026-01-10', '2026-02-28', 50], ['2026-03-01', '2026-03-30', 30]]);
  // Fully repaid: nothing after the repayment.
  const c3 = calcInterest({events: [{date: '2026-01-01', kind: 'disbursement', amount: '1000'}, {date: '2026-01-31', kind: 'repayment', amount: '1000'}], rate: '12', asOf: '2026-12-31', includeLastDay: true});
  assert.equal(c3.days, 31); assert.equal(c3.interest, '10.19'); assert.equal(c3.balance, '0.00');
  // No money yet: no interest.
  assert.equal(calcInterest({events: [], rate: '5', asOf: '2026-12-31'}).interest, '0.00');
});

test('interest: day-count bases', () => {
  const a = {amount: '1000', from: '2027-12-15', to: '2028-01-14', rate: '10', includeLastDay: true};
  assert.equal(simpleInterest({...a, basis: 'act365'}).interest, '8.49'); // 31 / 365
  assert.equal(simpleInterest({...a, basis: 'act360'}).interest, '8.61'); // 31 / 360
  assert.equal(simpleInterest({...a, basis: 'actact'}).interest, '8.48'); // 17 / 365 + 14 / 366
  assert.equal(simpleInterest({amount: '1000', from: '2026-01-31', to: '2026-02-28', rate: '12', basis: '30e360'}).days, 28);
  assert.equal(simpleInterest({amount: '1000', from: '2026-01-01', to: '2026-12-31', rate: '12', basis: '30e360', includeLastDay: true}).interest, '120.00'); // a whole year is 360 days in 30E/360
});

test('interest: leap years (366 days) for every basis', () => {
  const y = {amount: '10000', from: '2028-01-01', to: '2028-12-31', rate: '5', includeLastDay: true};
  // 2028 has 366 days: actual/365 charges them all over 365, actual/actual over 366, 30E/360 counts 360.
  assert.deepEqual(['act365', 'act360', 'actact', '30e360'].map((basis) => { const r = simpleInterest({...y, basis}); return [r.days, r.interest]; }),
    [[366, '501.37'], [366, '508.33'], [366, '500.00'], [360, '500.00']]);
  assert.equal(simpleInterest({amount: '10000', from: '2028-02-28', to: '2028-03-01', rate: '5', includeLastDay: true}).days, 3, '29 February counts');
  // Across 1 January: 184 days of 2027 over 365 plus 182 days of 2028 over 366.
  assert.equal(simpleInterest({amount: '10000', from: '2027-07-01', to: '2028-06-30', rate: '5', includeLastDay: true, basis: 'actact'}).interest, '500.69');
});

test('reading a loan agreement: amount, annual rate (not the penalty rate), basis, dates, parties and direction', () => {
  assert.deepEqual(['10 000,00', '10.000,00', '10,000.50', '25 000', '8.000'].map(parseAmount), ['10000.00', '10000.00', '10000.50', '25000.00', '8000.00']);
  const co = {name: COMPANY.name, company_code: COMPANY.company_code};
  const lt = parseLoanContract(`PASKOLOS SUTARTIS Nr. P-2026/07\nVilnius, 2026 m. kovo 15 d.\nUAB „Finansų partneris“, įmonės kodas 304111222, toliau – Paskolos davėjas, ir ${COMPANY.name.replace('UAB ', 'UAB „')}“, įmonės kodas ${COMPANY.company_code}, toliau – Paskolos gavėjas, sudarė šią sutartį.
1. Paskolos davėjas suteikia Paskolos gavėjui 25 000,00 EUR (dvidešimt penkių tūkstančių eurų) paskolą.
2. Už naudojimąsi paskola mokamos 6,5 % metinės palūkanos, skaičiuojamos už faktinį dienų skaičių, metus laikant 360 dienų.
3. Paskola turi būti grąžinta ne vėliau kaip iki 2027-03-31.
4. Pavėlavus mokėti, skaičiuojami 0,05 % delspinigiai už kiekvieną dieną.`, co);
  assert.deepEqual(lt.fields, {principal: '25000.00', currency: 'EUR', rate: '6.5', basis: 'act360', contractDate: '2026-03-15', maturityDate: '2027-03-31', contractNo: 'P-2026/07',
    direction: 'received', counterpartyName: 'UAB „Finansų partneris“', counterpartyCode: '304111222'});
  assert.match(lt.evidence.rate, /6,5 % metinės palūkanos/);
  const lent = parseLoanContract(`Paskolos sutartis\n2026-05-02\nPaskolos davėjas: ${COMPANY.name}, kodas ${COMPANY.company_code}\nPaskolos gavėjas: MB „Statybų ratas“, kodas 305999888\nPaskolos suma – 8.000 Eur. Palūkanos – 4 proc. per metus (365 dienų metai). Grąžinimo terminas 2026.12.31.`, co);
  assert.equal(lent.fields.direction, 'granted'); assert.equal(lent.fields.counterpartyCode, '305999888'); assert.equal(lent.fields.principal, '8000.00'); assert.equal(lent.fields.rate, '4'); assert.equal(lent.fields.maturityDate, '2026-12-31');
  const en = parseLoanContract(`LOAN AGREEMENT No. LA-15 dated 2026-02-01. Lender: UAB „Baltic Trade“ 302222333. Borrower: ${COMPANY.name} ${COMPANY.company_code}. Loan amount EUR 12,500.00. Interest 3M EURIBOR + 2.5 % per annum, Actual/365. Repay not later than 2028-02-01.`, co);
  assert.deepEqual([en.fields.direction, en.fields.principal, en.fields.rate, en.fields.rateVariable, en.fields.basis, en.fields.maturityDate], ['received', '12500.00', '2.5', true, 'act365', '2028-02-01']);
  assert.ok(en.warnings.some((w) => /Kintamos|kintamos/.test(w)));
});

async function docx(paragraphs) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({type: 'nodebuffer'});
}

test('loans API: read an uploaded agreement, match the bank receipt, interest to a date, events, manual calculation', async () => {
  const pool = t.app.pool;
  // A bank receipt of the loan money on 2026-03-20 (five days after signing).
  const dummy = (await acc.upload([{name: 'israsas.docx', buffer: await docx(['Išrašas'])}], {workflow: 'vault'})).body.results[0];
  const ba = (await pool.query(`INSERT INTO bank_accounts(iban, name, ledger_account) VALUES ('LT601010012345678901', 'Pagrindinė', '2710') ON CONFLICT (iban) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0];
  const st = (await pool.query(`INSERT INTO bank_statements(bank_account_id, document_id, file_id, format, balance_status) VALUES ($1,$2,$3,'test','ok') RETURNING id`, [ba.id, dummy.documentId, dummy.fileId])).rows[0];
  const tx = (await pool.query(`INSERT INTO bank_transactions(bank_account_id, first_statement_id, dedupe_key, fingerprint, booking_date, amount, currency, counterparty_name, counterparty_code, reference)
    VALUES ($1,$2,'loan-1',repeat('a',64),'2026-03-20',25000,'EUR','UAB Finansų partneris','304111222','Paskola pagal sutartį P-2026/07') RETURNING id`, [ba.id, st.id])).rows[0];

  const file = await docx(['PASKOLOS SUTARTIS Nr. P-2026/07', 'Vilnius, 2026 m. kovo 15 d.',
    `UAB „Finansų partneris“, įmonės kodas 304111222, toliau – Paskolos davėjas, ir UAB „Pavyzdinė prekyba“, įmonės kodas ${COMPANY.company_code}, toliau – Paskolos gavėjas, sudarė šią sutartį.`,
    '1. Paskolos davėjas suteikia Paskolos gavėjui 25 000,00 EUR paskolą.', '2. Palūkanos – 6 % per metus, metus laikant 365 dienų.', '3. Paskola grąžinama iki 2027-03-31.']);
  const fd = new FormData(); fd.append('file', new Blob([file]), 'paskolos-sutartis.docx');
  const p = await acc.post('/api/loans/read-contract', fd);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.fields.direction, p.body.fields.principal, p.body.fields.rate, p.body.fields.basis, p.body.fields.maturityDate], ['received', '25000.00', '6', 'act365', '2027-03-31']);
  assert.equal(p.body.bankMatches[0].id, tx.id, 'the receipt of 25 000 € from the lender is suggested');
  assert.equal((await ro.post('/api/loans/read-contract', fd)).status, 403);

  const l = await acc.post('/api/loans', {direction: 'received', counterparty_name: p.body.fields.counterpartyName, counterparty_code: '304111222', contract_no: p.body.fields.contractNo, contract_date: p.body.fields.contractDate,
    principal: '25 000,00', annual_rate: '6', basis: 'act365', maturity_date: '2027-03-31', document_id: p.body.documentId, extracted: {fields: p.body.fields},
    events: [{kind: 'disbursement', date: '2026-03-20', amount: '25000', bank_transaction_id: p.body.bankMatches[0].id}]});
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.source, 'document');
  // 2026-03-20 … 2026-09-30: 194 days without the last day, 195 with it.
  const a = (await acc.get(`/api/loans/${l.body.id}?asOf=2026-09-30&includeLastDay=false`)).body.calc;
  assert.deepEqual([a.firstDisbursement, a.days, a.interest], ['2026-03-20', 194, '797.26']);
  const b = (await acc.get(`/api/loans/${l.body.id}?asOf=2026-09-30&includeLastDay=true`)).body.calc;
  assert.deepEqual([b.days, b.interest], [195, '801.37']);
  // Repay 5 000 on 2026-06-30 and pay 300 € of interest.
  assert.equal((await acc.post(`/api/loans/${l.body.id}/events`, {kind: 'repayment', date: '2026-06-30', amount: '5000'})).status, 200);
  assert.equal((await acc.post(`/api/loans/${l.body.id}/events`, {kind: 'interest_payment', date: '2026-06-30', amount: '300'})).status, 200);
  const c = (await acc.get(`/api/loans/${l.body.id}?asOf=2026-09-30&includeLastDay=true`)).body.calc;
  // 25 000 × 6 % × 103 / 365 (20.03–30.06) + 20 000 × 6 % × 92 / 365 (01.07–30.09)
  assert.deepEqual([c.interest, c.paid, c.due, c.balance], ['725.75', '300.00', '425.75', '20000.00']);
  assert.equal((await acc.post(`/api/loans/${l.body.id}/events`, {kind: 'disbursement', date: '2026-04-01', amount: '1', bank_transaction_id: tx.id})).status, 409, 'a bank transaction is used once');
  const list = (await acc.get('/api/loans?asOf=2026-09-30&includeLastDay=true')).body.items;
  assert.equal(list.length, 1); assert.equal(list[0].calc.due, '425.75');
  assert.deepEqual((await acc.get('/api/loans/candidates')).body, [], 'the agreement is used');

  const m = await acc.post('/api/loans/calc', {amount: '10 000,00', from: '2026-01-01', to: '2026-12-31', rate: '5', includeLastDay: true});
  assert.equal(m.body.interest, '500.00');
  assert.equal((await acc.post('/api/loans/calc', {amount: '100', from: '2026-02-01', to: '2026-01-01', rate: '5'})).status, 400);
  assert.equal((await acc.post('/api/loans', {direction: 'received', principal: '0', annual_rate: '5'})).status, 400);
  assert.equal((await acc.del(`/api/loans/${l.body.id}`)).status, 200);
  assert.equal((await acc.get('/api/loans/candidates')).body.length, 1, 'after deleting the loan the agreement is listed again');
});

test('interest accrual to the ledger: catch-up amounts, received and granted loans, one accrual per date, cancel the latest, bulk', async () => {
  const pool = t.app.pool;
  const mk = async (b) => { const r = await acc.post('/api/loans', {annual_rate: '6', basis: 'act365', include_last_day: true, ...b}); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.id; };
  const recv = await mk({direction: 'received', principal: '25000', contract_no: 'K-1', counterparty_name: 'UAB Bankelis', events: [{kind: 'disbursement', date: '2026-03-20', amount: '25000'}]});
  const lent = await mk({direction: 'granted', principal: '10000', annual_rate: '5', contract_no: 'S-1', counterparty_name: 'MB Draugas', events: [{kind: 'disbursement', date: '2026-01-01', amount: '10000'}]});
  const lines = async (entryId) => (await pool.query('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=$1 ORDER BY debit DESC', [entryId])).rows.map((l) => [l.account_code, l.debit, l.credit]);

  const pv = (await acc.get(`/api/loans/${recv}?asOf=2026-06-30`)).body.accrual;
  assert.deepEqual([pv.interestTotal, pv.booked, pv.amount, pv.debit, pv.credit, pv.from], ['423.29', '0.00', '423.29', '6802', '491', '2026-03-20']); // 25 000 × 6 % × 103 / 365
  assert.equal((await ro.post(`/api/loans/${recv}/accruals`, {asOf: '2026-06-30'})).status, 403);
  const a1 = await acc.post(`/api/loans/${recv}/accruals`, {asOf: '2026-06-30'});
  assert.equal(a1.status, 200, JSON.stringify(a1.body));
  assert.deepEqual(await lines(a1.body.entryId), [['6802', '423.29', '0.00'], ['491', '0.00', '423.29']]);
  assert.equal((await acc.post(`/api/loans/${recv}/accruals`, {asOf: '2026-06-30'})).status, 422, 'already accrued to that date');
  // A repayment of 5 000 on 30.06 (the day itself is charged); the next accrual books only the rest to 30.09.
  await acc.post(`/api/loans/${recv}/events`, {kind: 'repayment', date: '2026-06-30', amount: '5000'});
  const a2 = await acc.post(`/api/loans/${recv}/accruals`, {asOf: '2026-09-30'});
  assert.deepEqual([a2.body.amount, a2.body.from], ['302.46', '2026-07-01']); // 725.75 − 423.29
  // Granted loan: accrued income.
  const g = await acc.post(`/api/loans/${lent}/accruals`, {asOf: '2026-03-31'});
  assert.deepEqual(await lines(g.body.entryId), [['292', '123.29', '0.00'], ['5802', '0.00', '123.29']]); // 10 000 × 5 % × 90 / 365
  // Only the latest accrual can be cancelled; cancelling reverses the entry.
  const list = (await acc.get(`/api/loans/${recv}?asOf=2026-09-30`)).body;
  assert.deepEqual(list.accruals.map((x) => [x.as_of, x.amount]), [['2026-06-30', '423.29'], ['2026-09-30', '302.46']]);
  assert.equal((await acc.post(`/api/loans/${recv}/accruals/${list.accruals[0].id}/cancel`, {reason: 'bandymas'})).status, 409);
  assert.equal((await acc.post(`/api/loans/${recv}/accruals/${list.accruals[1].id}/cancel`, {reason: 'klaidinga data'})).status, 200);
  assert.equal((await acc.get(`/api/loans/${recv}?asOf=2026-09-30`)).body.accrual.booked, '423.29');
  assert.equal((await acc.del(`/api/loans/${recv}`)).status, 409, 'a loan with accruals in the ledger cannot be deleted');
  // Bulk accrual to the year end: one entry per loan, the rest since the last accrual.
  const bulk = await acc.post('/api/loans/accruals', {asOf: '2026-12-31'});
  assert.deepEqual(bulk.body.results.map((x) => [x.label.split(' ')[0], x.status, x.amount]), [['K-1', 'posted', '604.93'], ['S-1', 'posted', '376.71']]); // 500.00 for the year − 123.29
  // 6802 balance = interest to 31.12 on the received loan: 25 000 × 6 % × 103 / 365 + 20 000 × 6 % × 184 / 365.
  const bal = (await pool.query(`SELECT sum(debit - credit) AS s FROM journal_lines WHERE account_code='6802'`)).rows[0].s;
  assert.equal(bal, '1028.22');
  assert.equal((await acc.get(`/api/loans?asOf=2026-12-31&includeLastDay=true`)).body.items.find((x) => x.id === recv).accrued, '1028.22');
});
