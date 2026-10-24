// Browser check of the director's view, the month-close checklist, global search and bulk bank approval.
// Usage: node test-browser/time-savers.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const t = await startTestApp({config: {openAccess: true}});
const acc = await t.client('accountant').login();
const admin = await t.client('admin').login();
const year = new Date().getFullYear();
await acc.post('/api/journal', {date: `${year}-01-20`, description: 'Pardavimai', lines: [{account: '2410', debit: '1210'}, {account: '5000', credit: '1000'}, {account: '4492', credit: '210'}]});
await acc.post('/api/journal', {date: `${year}-01-31`, description: 'Savikaina', lines: [{account: '6000', debit: '700'}, {account: '204', credit: '700'}]});
const s = await acc.post('/api/manual-invoices', {register: 'sales', issueDate: `${year}-01-10`, dueDate: `${year}-01-20`, counterparty: {name: 'UAB Pirkėjas', companyCode: '301111111'}, lines: [{description: 'Gaminys', quantity: '2', unitPrice: '250', taxCode: 'PVM1'}]});
await acc.post(`/api/proposals/${s.body.proposal.id}/approve`, {contentHash: s.body.proposal.content_hash});
const account = (await admin.post('/api/bank/accounts', {iban: 'LT977044060000000001', name: 'Pagrindinė', ledger_account: '2710'})).body;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apskaita-b-'));
fs.writeFileSync(path.join(dir, 'israsas.csv'), ['Data;Gavėjas/Mokėtojas;Sąskaita;Paskirtis;Suma;Valiuta', `${year}-01-25;UAB Pirkėjas;LT601010012345678901;Apmokėjimas PP 1;605,00;EUR`].join('\n'));
const up = await acc.upload([path.join(dir, 'israsas.csv')], {workflow: 'bank'});
await acc.post('/api/bank/statements/import', {documentId: up.body.results[0].documentId, bankAccountId: account.id, opening: '0', closing: '605'});

const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 900}, acceptDownloads: true});
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  // Director's view from the toolbar.
  await page.click('.toolbar a:text("Vadovo suvestinė")');
  await page.waitForSelector('h1:text("Vadovo suvestinė")');
  await page.waitForSelector('.chart svg rect');
  assert.equal(await page.locator('.cards .stat').count(), 8);
  assert.match(await page.textContent('section:has(h2:text("Pelnas (nuostoliai) pagal mėnesius"))'), /Bendroji marža/);
  assert.equal(await page.locator('section:has(h2:text("Pinigų srautų prognozė")) tbody tr').count(), 8);
  const [x] = await Promise.all([page.waitForEvent('download'), page.click('button:text("Atsisiųsti XLSX")')]);
  assert.match(x.suggestedFilename(), /valdymo-pn-\d{4}\.xlsx/);
  if (out) await page.screenshot({path: `${out}/vadovas.png`, fullPage: true});
  // Month-close checklist from the menu.
  await page.click('.menu-top:text("Servisas")');
  await page.getByRole('menuitem', {name: 'Mėnesio uždarymas (kontrolinis sąrašas)'}).click();
  await page.waitForSelector('h1:text("Mėnesio uždarymas")');
  await page.fill('input[type=month]', `${year}-01`); await page.dispatchEvent('input[type=month]', 'change');
  await page.waitForSelector('.checklist li:has-text("PVM už")');
  assert.ok(await page.locator('.check-error').count() >= 1, 'open bank operation is listed');
  if (out) await page.screenshot({path: `${out}/menesio-uzdarymas.png`, fullPage: true});
  // Global search: Ctrl+K, type, Enter opens the result.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Pirkėjas');
  await page.waitForSelector('.gsearch-item');
  if (out) await page.screenshot({path: `${out}/paieska.png`});
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !/menesio-uzdarymas/.test(location.hash));
  // Bank: select ready proposals and approve them together.
  await page.goto(t.base + '/#/bankas'); await page.waitForSelector('h1:text("Bankas ir mokėjimai")');
  await page.click('button:text("Pasiūlyti iš naujo")');
  await page.waitForSelector('.toast');
  await page.click('button:text("Pažymėti visus paruoštus")');
  await page.waitForSelector('button:text("Patvirtinti pažymėtus (1)")');
  await page.click('button:text("Patvirtinti pažymėtus (1)")');
  await page.waitForSelector('.toast:has-text("Patvirtinta: 1")');
  const st = (await t.app.pool.query('SELECT status FROM bank_transactions')).rows.map((r) => r.status);
  assert.deepEqual(st, ['approved']);
  assert.deepEqual(errors, []);
  console.log('Time-savers browser check OK');
} finally { await browser.close(); await t.close(); }
