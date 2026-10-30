// Browser check of PLN204 (EDS form pages, edit → recalculation), SAM (official Sodra form) and cash orders (KPO, cash book).
// Usage: node test-browser/tax-cash.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const t = await startTestApp({config: {openAccess: true}});
const acc = await t.client('accountant').login();
const admin = await t.client('admin').login();
const c = (await admin.get('/api/settings/company')).body;
await admin.put('/api/settings/company', {...c, sodra_code: '1234567'});
await acc.post('/api/journal', {date: '2025-03-01', description: 'Pardavimai', lines: [{account: '2710', debit: '100000'}, {account: '5001', credit: '100000'}]});
await acc.post('/api/journal', {date: '2025-03-02', description: 'Nuoma', lines: [{account: '6300', debit: '40000'}, {account: '2710', credit: '40000'}]});
await acc.post('/api/journal', {date: '2025-03-03', description: 'Reprezentacija', lines: [{account: '6319', debit: '1000'}, {account: '2710', credit: '1000'}]});
await acc.post('/api/employees', {first_name: 'Jonas', last_name: 'Jonaitis', personal_code: '38001010000', sodra_no: 'AB1234567', employment_start: '2025-01-01', base_salary: '2000'});
const run = await acc.post('/api/payroll/runs', {period: '2026-09'});
await acc.post(`/api/payroll/runs/${run.body.id}/approve`);
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
const chars = (page, sel) => page.$$eval(`${sel} .eds-ch`, (els) => els.map((e) => e.textContent).join(''));
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 900}, acceptDownloads: true});
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  // PLN204 from the menu, year 2025.
  await page.click('.menu-top:text("Ataskaitos")');
  await page.getByRole('menuitem', {name: 'PLN204 pelno mokesčio deklaracija (EDS forma)'}).click();
  await page.waitForSelector('h1:text("PLN204 metinė pelno mokesčio deklaracija")');
  await page.fill('input[type=number]', '2025'); await page.dispatchEvent('input[type=number]', 'change');
  await page.waitForFunction(() => document.querySelectorAll('.eds-form').length === 3);
  assert.equal(await chars(page, '.eds-field[data-field="E19"]'), '59000');
  assert.equal(await chars(page, '.eds-field[data-field="E20"]'), '500');
  assert.equal(await chars(page, '.eds-field[data-field="E55A"]'), '3570'); // 59 500 × 6 % (2025)
  // Type tax-loss carry forward 10 000 into field 45: 48 and 55A recalculated by the server.
  await page.click('.eds-field[data-field="E45"]');
  await page.fill('.eds-field[data-field="E45"] .eds-input', '10000'); await page.dispatchEvent('.eds-field[data-field="E45"] .eds-input', 'change');
  await page.waitForFunction(() => [...document.querySelectorAll('.eds-field[data-field="E48"] .eds-ch')].map((e) => e.textContent).join('') === '49500');
  assert.equal(await chars(page, '.eds-field[data-field="E55A"]'), '2970');
  if (out) await page.screenshot({path: `${out}/pln204.png`, fullPage: true});
  const [f1] = await Promise.all([page.waitForEvent('download'), page.click('button:text("EDS failas (.ffdata)")')]);
  assert.equal(f1.suggestedFilename(), 'PLN204_2025.ffdata');
  // SAM.
  await page.click('.menu-top:text("Atlyginimai")');
  await page.getByRole('menuitem', {name: 'SAM pranešimas Sodrai'}).click();
  await page.waitForSelector('h1:text("SAM pranešimas Sodrai")');
  await page.fill('input[type=month]', '2026-09'); await page.dispatchEvent('input[type=month]', 'change');
  await page.waitForFunction(() => document.querySelectorAll('.eds-form').length === 2);
  assert.equal(await chars(page, '.eds-form >> nth=1 >> .eds-field[data-field="PaymentSum_1"]'), '42540');
  if (out) await page.screenshot({path: `${out}/sam.png`, fullPage: true});
  const [f2] = await Promise.all([page.waitForEvent('download'), page.click('button:text("EDAS failas (.ffdata)")')]);
  assert.equal(f2.suggestedFilename(), 'SAM_2026-09.ffdata');
  // Cash: KPO for other income, then the cash book.
  await page.click('.menu-top:text("Finansai")');
  await page.getByRole('menuitem', {name: 'Naujas KPO (pajamos)'}).click();
  await page.waitForSelector('h1:text("Kasos pajamų orderis (KPO)")');
  await page.selectOption('select >> nth=0', 'other');
  await page.selectOption('select >> nth=1', '5001');
  await page.getByLabel('Suma, €').fill('250');
  await page.getByLabel('Gauta iš').fill('Petras Petraitis');
  await page.click('button:text("Registruoti ir kontuoti")');
  await page.waitForSelector('h1:text("KPO 000001")');
  const [f3] = await Promise.all([page.waitForEvent('download'), page.click('button:text("PDF (spausdinti)")')]);
  assert.equal(f3.suggestedFilename(), 'KPO000001.pdf');
  await page.goto(t.base + '/#/kasa/knyga');
  await page.waitForSelector('text=KPO 000001');
  if (out) await page.screenshot({path: `${out}/cash-book.png`, fullPage: true});
  assert.deepEqual(errors, []);
  console.log('Tax and cash browser check OK');
} finally { await browser.close(); await t.close(); }
