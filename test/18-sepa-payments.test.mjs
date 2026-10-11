// SEPA payment files (pain.001.001.03) for open supplier invoices and payroll; validated against the ISO 20022 XSD.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startTestApp} from './helpers.mjs';
import {sepaText} from '../src/bank/sepa.mjs';

const run = promisify(execFile);
let t, acc, ro, bankId, invoiceId;
async function xsdValid(xml) {
  const f = path.join(os.tmpdir(), `pain-${process.pid}-${Date.now()}.xml`);
  await fs.writeFile(f, xml);
  try { await run('xmllint', ['--noout', '--schema', 'vendor/sepa/pain.001.001.03.xsd', f]); return true; } catch (e) { return e.stderr; } finally { await fs.rm(f, {force: true}); }
}
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  const admin = await t.client('admin').login();
  const b = await admin.post('/api/bank/accounts', {iban: 'LT601010012345678901', name: 'Pagrindinė', ledger_account: '2710'});
  assert.equal(b.status, 200, JSON.stringify(b.body));
  bankId = b.body.id;
  const r = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'TT', number: '77', issueDate: '2026-10-01', dueDate: '2026-10-20',
    counterparty: {name: 'UAB Tiekėjas Ąžuolas', vatCode: 'LT777777716', companyCode: '307777777', iban: 'LT12 1000 0111 0100 1000'},
    lines: [{description: 'Paslauga', quantity: '1', unitPrice: '100', taxCode: 'PVM1', accountCode: '6300', lineType: 'expense', vatTreatment: 'deductible'}]});
  const p = r.body.proposal;
  invoiceId = (await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})).body.invoiceId;
});
after(() => t?.close());

test('SEPA text: Lithuanian letters transliterated, invalid characters removed', () => {
  assert.equal(sepaText('UAB „Ąžuolas“ & Co; #1', 70), 'UAB Azuolas Co 1');
});

test('open supplier invoices → pain.001 file valid against the XSD', async () => {
  const list = (await ro.get('/api/payments/payables')).body;
  const inv = list.find((x) => x.id === String(invoiceId));
  assert.ok(inv, JSON.stringify(list));
  assert.deepEqual([inv.outstanding, inv.iban], ['121.00', 'LT121000011101001000']);
  assert.equal((await ro.post('/api/payments/sepa', {bankAccountId: bankId, items: [{id: invoiceId}]})).status, 403);
  const tooMuch = await acc.post('/api/payments/sepa', {bankAccountId: bankId, items: [{id: invoiceId, amount: '500'}]});
  assert.equal(tooMuch.status, 400);
  const badIban = await acc.post('/api/payments/sepa', {bankAccountId: bankId, items: [{id: invoiceId, iban: 'LT00123'}]});
  assert.equal(badIban.status, 422);
  const res = await acc.raw('POST', '/api/payments/sepa', {bankAccountId: bankId, items: [{id: invoiceId, amount: '100,50'}]}, {raw: true});
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.equal(await xsdValid(xml), true);
  assert.match(xml, /<InstdAmt Ccy="EUR">100\.50<\/InstdAmt>/);
  assert.match(xml, /<Nm>UAB Tiekejas Azuolas<\/Nm>/);
  assert.match(xml, /<IBAN>LT121000011101001000<\/IBAN>/);
  assert.match(xml, /<DbtrAcct><Id><IBAN>LT601010012345678901<\/IBAN>/);
  assert.match(xml, /<Ustrd>Saskaita TT 77<\/Ustrd>/);
  assert.match(xml, /<NbOfTxs>1<\/NbOfTxs>/);
});

test('approved payroll sheet → salary payments file (SALA)', async () => {
  const e = await acc.post('/api/employees', {first_name: 'Jonas', last_name: 'Jonaitis', employment_start: '2025-01-01', base_salary: '2000', iban: 'LT12 1000 0111 0100 1000'});
  assert.equal(e.status, 200, JSON.stringify(e.body));
  const runR = await acc.post('/api/payroll/runs', {period: '2026-09'});
  assert.equal(runR.status, 200, JSON.stringify(runR.body));
  assert.equal((await acc.post('/api/payments/sepa', {source: 'payroll', runId: runR.body.id, bankAccountId: bankId})).status, 409);
  assert.equal((await acc.post(`/api/payroll/runs/${runR.body.id}/approve`)).status, 200);
  const res = await acc.raw('POST', '/api/payments/sepa', {source: 'payroll', runId: runR.body.id, bankAccountId: bankId}, {raw: true});
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.equal(await xsdValid(xml), true);
  assert.match(xml, /<CtgyPurp><Cd>SALA<\/Cd><\/CtgyPurp>/);
  assert.match(xml, /<Nm>Jonas Jonaitis<\/Nm>/);
  assert.match(xml, /<Ustrd>Darbo uzmokestis 2026-09<\/Ustrd>/);
});
