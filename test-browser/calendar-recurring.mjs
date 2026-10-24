// Browser check of the tax calendar, recurring invoices, the cost-of-sales calculation and vacation pay by VDU.
// Usage: node test-browser/calendar-recurring.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const t = await startTestApp({config: {openAccess: true}});
const acc = await t.client('accountant').login();
const today = new Date().toISOString().slice(0, 10), month = today.slice(0, 7);
const prevMonth = (p) => { const [y, m] = p.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const last = prevMonth(month);
await acc.post('/api/counterparties', {name: 'UAB Nuomininkas', company_code: '303333333', is_customer: true, country: 'LT'});
const prod = (await acc.post('/api/products', {sku: 'VAMZ-1', name: 'Vamzdis', kind: 'goods', unit: 'vnt.', unit_price: '15', purchase_price: '5', track_stock: true})).body;
for (const [register, n, qty, price] of [['purchase', 'P1', '10', '6'], ['sales', '', '3', '15']]) {
  const d = await acc.post('/api/manual-invoices', {register, series: 'T', number: n, issueDate: `${last}-10`, counterparty: {name: register === 'sales' ? 'UAB Pirkėjas' : 'UAB Tiekėjas', companyCode: register === 'sales' ? '301111111' : '302222222', vatCode: register === 'sales' ? '' : 'LT100002222219'},
    lines: [{productId: String(prod.id), quantity: qty, unitPrice: price, taxCode: 'PVM1'}]});
  await acc.post(`/api/proposals/${d.body.proposal.id}/approve`, {contentHash: d.body.proposal.content_hash});
}
const emp = (await acc.post('/api/employees', {first_name: 'Rūta', last_name: 'Rūtaitė', employment_start: '2026-01-01', base_salary: '2000', iban: 'LT121000011101001000'})).body;
const run = (await acc.post('/api/payroll/runs', {period: month, payment_date: today})).body;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 900}});
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  // Tax calendar from the menu: mark the previous month's i.SAF as filed.
  await page.click('.menu-top:text("Ataskaitos")');
  await page.getByRole('menuitem', {name: 'Mokesčių kalendorius ir pateikimai'}).click();
  await page.waitForSelector('h1:text("Mokesčių kalendorius")');
  const isafRow = page.locator('tr', {has: page.locator('a:text("i.SAF registrai")')}).filter({has: page.locator(`td:text-is("${last}")`)});
  await isafRow.locator('button:text("Pateikta")').click();
  await page.getByLabel('Registracijos Nr. / nuoroda').fill('ISAF-777');
  await page.click('.modal button:text("Išsaugoti")');
  await page.waitForSelector(`tr:has-text("ISAF-777")`);
  if (out) await page.screenshot({path: `${out}/mokesciu-kalendorius.png`, fullPage: true});
  // Recurring invoice: template from the Sales tab, drafts created, open the first one.
  await page.click('.menu-top:text("Prekyba")');
  await page.getByRole('menuitem', {name: 'Pasikartojančios sąskaitos'}).click();
  await page.waitForSelector('a.tab.active:text("Pasikartojančios")');
  await page.click('button:text("+ Naujas šablonas")');
  await page.getByLabel('Pavadinimas', {exact: true}).fill('Patalpų nuoma');
  await page.fill('input[placeholder="Ieškoti pirkėjo"]', 'Nuomininkas');
  await page.waitForSelector('option:text("UAB Nuomininkas (303333333)")', {state: 'attached'});
  await page.selectOption('.field:has-text("Pirkėjas") select', {label: 'UAB Nuomininkas (303333333)'});
  await page.getByLabel('Pirmos (kitos) sąskaitos data').fill(`${last}-01`);
  await page.getByLabel('Aprašymas').fill('Patalpų nuoma');
  await page.getByLabel('Kaina').fill('500');
  await page.click('button:text("Išsaugoti")');
  await page.waitForSelector('td:text("Patalpų nuoma")');
  await page.click('button:text("Sukurti suėjusius juodraščius dabar")');
  await page.waitForSelector('.toast:has-text("Sukurta juodraščių")');
  await page.waitForSelector('h2:text-matches("Laukia patvirtinimo \\\\([12]\\\\)")');
  if (out) await page.screenshot({path: `${out}/pasikartojancios.png`, fullPage: true});
  await page.locator('section:has(h2:text-matches("Laukia patvirtinimo")) tbody tr').first().click();
  await page.waitForSelector('h2:text("Eilutės")');
  // Cost of sales calculated from stock movements.
  await page.goto(t.base + '/#/ataskaitos/savikaina'); await page.waitForSelector('h2:text("Parduotų prekių savikaina")');
  await page.fill('input[type=month]', last);
  await page.click('button:text("Apskaičiuoti pagal prekių judėjimą")');
  await page.waitForSelector('h2:text("Apskaičiuota savikaina")');
  assert.equal(await page.inputValue('.field:has-text("Suma (EUR)") input'), '18.00'); // 3 × 6.00
  if (out) await page.screenshot({path: `${out}/savikaina.png`, fullPage: true});
  // Vacation pay by VDU in the payroll sheet.
  await page.goto(t.base + `/#/atlyginimai/${run.id}`); await page.waitForSelector('button:text("VDU")');
  await page.click('button:text("VDU")');
  await page.getByLabel('Kiek atostogų darbo dienų šį mėnesį?').fill('5');
  await page.click('.modal button:text("Gerai")');
  await page.waitForSelector('.toast:has-text("Atostoginiai:")');
  assert.notEqual(await page.inputValue(`[aria-label="Rūta Rūtaitė atostoginiai"]`), '0.00');
  assert.deepEqual(errors, []);
  console.log('Calendar and recurring browser check OK');
} finally { await browser.close(); await t.close(); }
