// Sales invoice PDF (amount in words, issued/received by) and sending it to the buyer by e-mail.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startTestApp} from './helpers.mjs';
import {amountWords} from '../src/lib/words-lt.mjs';

let t, acc, stub, got = [];
before(async () => {
  stub = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push({url: req.url, headers: req.headers, body: JSON.parse(b)}); res.writeHead(200, {'content-type': 'application/json'}); res.end('{"id":"msg-1"}'); }); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t = await startTestApp({config: {emailProvider: 'resend', emailApiKey: 'test-key', emailFrom: 'UAB Pavyzdinė prekyba <saskaitos@pavyzdys.lt>', emailApiUrl: `http://127.0.0.1:${stub.address().port}`}});
  acc = await t.client('accountant').login();
});
after(async () => { await t.close(); stub.close(); });

test('amount in words', () => {
  assert.equal(amountWords('531.19'), 'Penki šimtai trisdešimt vienas euras 19 ct');
  assert.equal(amountWords('2001.10'), 'Du tūkstančiai vienas euras 10 ct');
  assert.equal(amountWords('12.05'), 'Dvylika eurų 05 ct');
  assert.equal(amountWords('-605.00'), 'Minus šeši šimtai penki eurai 00 ct');
});

test('invoice PDF has the amount in words and the issued/received lines; it is sent to the buyer with the PDF attached', async () => {
  const d = await acc.post('/api/manual-invoices', {register: 'sales', issueDate: '2026-10-20', dueDate: '2026-11-03', counterparty: {name: 'UAB Pirkėjas', companyCode: '301111111'}, lines: [{description: 'Paslauga', quantity: '1', unitPrice: '439', taxCode: 'PVM1'}]});
  const p = d.body.proposal;
  const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  await t.drain();
  const inv = (await t.app.pool.query(`SELECT id, document_id FROM invoices WHERE register='sales' ORDER BY id DESC LIMIT 1`)).rows[0];
  const {url} = (await acc.get(`/api/invoices/${inv.id}/pdf-link`)).body;
  const pdf = Buffer.from(await (await acc.raw('GET', url, null, {raw: true})).arrayBuffer());
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inv-')), 'inv.pdf'); fs.writeFileSync(file, pdf);
  const text = execFileSync('pdftotext', ['-layout', file, '-']).toString();
  assert.match(text, /Suma žodžiais: Penki šimtai trisdešimt vienas euras 19 ct/);
  assert.match(text, /Sąskaitą išrašė:/); assert.match(text, /Sąskaitą priėmė:/); assert.match(text, /Buhalterė/);
  // E-mail: draft, validation, sending through the service with the PDF.
  const draft = (await acc.get(`/api/invoices/${inv.id}/email`)).body;
  assert.equal(draft.configured, true);
  assert.match(draft.subject, /Sąskaita faktūra PP/);
  assert.equal((await acc.post(`/api/invoices/${inv.id}/email`, {to: 'ne-adresas', subject: 'x'})).status, 400);
  const s = await acc.post(`/api/invoices/${inv.id}/email`, {to: 'buhalterija@pirkejas.lt', subject: draft.subject, text: draft.text});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const sent = got.at(-1);
  assert.equal(sent.url, '/emails'); assert.equal(sent.headers.authorization, 'Bearer test-key');
  assert.deepEqual(sent.body.to, ['buhalterija@pirkejas.lt']);
  assert.equal(Buffer.from(sent.body.attachments[0].content, 'base64').subarray(0, 4).toString(), '%PDF');
  const again = (await acc.get(`/api/invoices/${inv.id}/email`)).body;
  assert.equal(again.to, 'buhalterija@pirkejas.lt', 'the address is remembered on the buyer');
  assert.equal(again.history[0].status, 'sent');
});

test('a sales invoice issued here: corrected with the same number (new PDF), then annulled; blocked once paid', async () => {
  const sale = async (price) => {
    const d = await acc.post('/api/manual-invoices', {register: 'sales', issueDate: '2026-10-21', counterparty: {name: 'UAB Pirkėjas', companyCode: '301111111'}, lines: [{description: 'Konsultacija', quantity: '1', unitPrice: price, taxCode: 'PVM1'}]});
    const ap = await acc.post(`/api/proposals/${d.body.proposal.id}/approve`, {contentHash: d.body.proposal.content_hash});
    return ap.body;
  };
  const s1 = await sale('100');
  await t.drain();
  const before = (await acc.get(`/api/invoices/${s1.invoiceId}`)).body;
  assert.deepEqual(before.change, {blockers: [], annulled: false});
  // Correct: the price was 120, not 100.
  const c = await acc.post(`/api/invoices/${s1.invoiceId}/correct`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const p = (await acc.get(`/api/proposals/${c.body.proposalId}`)).body;
  assert.equal(p.kind, 'correction');
  const data = {...p.data, lines: p.data.lines.map((l) => ({...l, unitPrice: '120'}))};
  const ed = await acc.put(`/api/proposals/${p.id}`, {contentHash: p.content_hash, data});
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  const ap = await acc.post(`/api/proposals/${ed.body.id}/approve`, {contentHash: ed.body.content_hash});
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.number, before.series + ' ' + before.number, 'same number');
  await t.drain();
  const after = (await acc.get(`/api/invoices/${s1.invoiceId}`)).body;
  assert.equal(after.balance.gross, '145.20');
  const {url} = (await acc.get(`/api/invoices/${s1.invoiceId}/pdf-link`)).body;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inv-')), 'c.pdf');
  fs.writeFileSync(file, Buffer.from(await (await acc.raw('GET', url, null, {raw: true})).arrayBuffer()));
  const text = execFileSync('pdftotext', ['-layout', file, '-']).toString();
  assert.match(text, /Pataisyta/); assert.match(text, /145,20/); assert.doesNotMatch(text, /Atšaukiama/);
  // Annul: everything reversed, the number stays as annulled.
  const an = await acc.post(`/api/invoices/${s1.invoiceId}/annul`, {reason: 'Išrašyta per klaidą'});
  assert.equal(an.status, 200, JSON.stringify(an.body));
  const z = (await acc.get(`/api/invoices/${s1.invoiceId}`)).body;
  assert.equal(z.balance.gross, '0.00'); assert.equal(z.change.annulled, true);
  const list = (await acc.get('/api/invoices?register=sales&limit=50')).body.items;
  assert.equal(list.find((x) => String(x.id) === String(s1.invoiceId)).annulled, true);
  const bal = (await t.app.pool.query(`SELECT sum(l.debit - l.credit) AS v FROM journal_lines l JOIN invoices i ON i.journal_entry_id=l.entry_id WHERE i.id=$1 OR i.related_invoice_id=$1`, [s1.invoiceId])).rows[0].v;
  assert.equal(bal, '0.00');
  // Paid invoices can no longer be changed here.
  const s2 = await sale('50');
  await t.app.pool.query(`INSERT INTO cash_order_series(kind, prefix, next_number, padding) VALUES ('receipt','KPO',1,4) ON CONFLICT DO NOTHING`).catch(() => {});
  const kpo = await acc.post('/api/cash/orders', {kind: 'receipt', purpose: 'invoice', invoiceId: s2.invoiceId, date: '2026-10-22', amount: '10'});
  assert.equal(kpo.status, 200, JSON.stringify(kpo.body));
  const locked = (await acc.get(`/api/invoices/${s2.invoiceId}`)).body.change;
  assert.match(locked.blockers.join(' '), /apmokėta/);
  assert.equal((await acc.post(`/api/invoices/${s2.invoiceId}/annul`, {reason: 'bandymas'})).status, 409);
});
