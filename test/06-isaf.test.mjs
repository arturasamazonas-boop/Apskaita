// Scenario 14 (i.SAF): generated files validate against the vendored i.SAF 1.2 XSD; blocking errors are per document.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import {startTestApp, FIX, uploadAndProcess} from './helpers.mjs';
import {XSD_PATH} from '../src/isaf/isaf.mjs';

let t, acc, admin;
before(async () => { t = await startTestApp(); acc = await t.client('accountant').login(); admin = await t.client('admin').login(); });
after(async () => t.close());

async function sale(body) {
  const d = await acc.post('/api/manual-invoices', {register: 'sales', ...body});
  assert.equal(d.body.proposal.blocking, false, JSON.stringify(d.body.proposal.validation.issues));
  return (await acc.post(`/api/proposals/${d.body.proposal.id}/approve`, {contentHash: d.body.proposal.content_hash})).body;
}

test('14b. i.SAF for a month validates against the XSD and matches the VAT registers', async () => {
  const b2b = await sale({issueDate: '2026-09-10', counterparty: {name: 'UAB Klientas & Co <test>', companyCode: '308888888', vatCode: 'LT888888811'}, lines: [{description: 'Prekės', quantity: '3', unitPrice: '10.00', taxCode: 'PVM1'}, {description: 'Knyga', quantity: '1', unitPrice: '20.00', taxCode: 'PVM3'}]});
  await sale({issueDate: '2026-09-12', counterparty: {name: 'Jonas Jonaitis'}, lines: [{description: 'Paslauga', quantity: '1', unitPrice: '50.00', taxCode: 'PVM58'}]});
  const cn = await acc.post(`/api/invoices/${b2b.invoiceId}/credit-note`, {lines: [{lineNo: 1, quantity: '1'}], reason: 'Grąžinimas', issueDate: '2026-09-20'});
  assert.equal((await acc.post(`/api/proposals/${cn.body.proposal.id}/approve`, {contentHash: cn.body.proposal.content_hash})).status, 200);
  const {proposal: p} = await uploadAndProcess(t, acc, path.join(FIX, 'invoices', 'digital.pdf'));
  assert.equal((await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})).status, 200);
  const chk = await acc.get('/api/isaf/check?from=2026-09-01&to=2026-09-30&type=F');
  assert.equal(chk.status, 200, JSON.stringify(chk.body));
  assert.deepEqual(chk.body.errors, []);
  assert.equal(chk.body.xsd.valid, true, chk.body.xsd.messages.join('\n'));
  assert.equal(chk.body.summary.sales.invoices, 3);
  assert.equal(chk.body.summary.purchase.invoices, 1);
  const vatS = (await acc.get('/api/reports/vat-sales?from=2026-09-01&to=2026-09-30')).body;
  assert.equal(chk.body.summary.sales.vat, vatS.totals.vat);
  const dl = await acc.get('/api/isaf/download?from=2026-09-01&to=2026-09-30&type=F', {raw: true});
  assert.equal(dl.status, 200);
  const xml = await dl.text();
  assert.match(xml, /<InvoiceType>KS<\/InvoiceType>/);
  assert.match(xml, /<ReferenceNo>PP000001<\/ReferenceNo>/);
  assert.match(xml, /<VATRegistrationNumber>ND<\/VATRegistrationNumber><RegistrationNumber>ND<\/RegistrationNumber>/);
  assert.match(xml, /UAB Klientas &amp; Co &lt;test&gt;/);
  assert.match(xml, /<TaxCode>PVM58<\/TaxCode><TaxPercentage>12<\/TaxPercentage>/);
  // Independent re-validation of the downloaded file with xmllint.
  const f = path.join(os.tmpdir(), `isaf-test-${process.pid}.xml`);
  await fs.writeFile(f, xml);
  execFileSync('xmllint', ['--noout', '--schema', XSD_PATH, f], {stdio: 'pipe'});
  // Export archived in the vault (not submitted anywhere).
  assert.ok((await acc.get('/api/documents?tag=isaf')).body.items.length === 1);
});

test('14c. blocking errors are identified and prevent export; schema violations are reported', async () => {
  await t.app.pool.query(`UPDATE company_settings SET company_code='' WHERE id=1`);
  const chk = await acc.get('/api/isaf/check?from=2026-09-01&to=2026-09-30&type=S');
  assert.ok(chk.body.errors.some((e) => e.scope === 'company'));
  assert.equal(chk.body.exportable, false);
  assert.equal((await acc.get('/api/isaf/download?from=2026-09-01&to=2026-09-30&type=S', {raw: true})).status, 422);
  await t.app.pool.query(`UPDATE company_settings SET company_code='305555555' WHERE id=1`);
  const {validateXsd} = await import('../src/isaf/isaf.mjs');
  const bad = await validateXsd('<?xml version="1.0"?><iSAFFile xmlns="http://www.vmi.lt/cms/imas/isaf"><Header/></iSAFFile>', os.tmpdir());
  assert.equal(bad.valid, false);
  assert.ok(bad.messages.length);
});
