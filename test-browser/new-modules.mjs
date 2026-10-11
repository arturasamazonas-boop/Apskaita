// Browser check of fixed assets, depreciation, year-end closing, SEPA payments and GPM313 pages (opened from the menu).
// Usage: node test-browser/new-modules.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const t = await startTestApp({config: {openAccess: true}});
const acc = await t.client('accountant').login();
const admin = await t.client('admin').login();
await acc.post('/api/journal', {date: '2025-01-15', description: 'Kompiuteris', lines: [{account: '1240', debit: '1200'}, {account: '2710', credit: '1200'}]});
await acc.post('/api/journal', {date: '2025-06-30', description: 'Pardavimas', lines: [{account: '2710', debit: '3000'}, {account: '5001', credit: '3000'}]});
await admin.post('/api/bank/accounts', {iban: 'LT601010012345678901', name: 'Pagrindinė', ledger_account: '2710'});
const r = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'TT', number: '77', issueDate: '2026-10-01', dueDate: '2026-10-05',
  counterparty: {name: 'UAB Tiekėjas', vatCode: 'LT777777716', companyCode: '307777777', iban: 'LT121000011101001000'},
  lines: [{description: 'Paslauga', quantity: '1', unitPrice: '100', taxCode: 'PVM1', accountCode: '6300', lineType: 'expense', vatTreatment: 'deductible'}]});
await acc.post(`/api/proposals/${r.body.proposal.id}/approve`, {contentHash: r.body.proposal.content_hash});
await acc.post('/api/employees', {first_name: 'Jonas', last_name: 'Jonaitis', employment_start: '2025-01-01', base_salary: '2000', iban: 'LT121000011101001000'});
const run = await acc.post('/api/payroll/runs', {period: '2026-09', payment_date: '2026-10-05'});
await acc.post(`/api/payroll/runs/${run.body.id}/approve`);
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
const menu = async (page, top, item) => { await page.click(`.menu-top:text("${top}")`); await page.getByRole('menuitem', {name: item, exact: true}).click(); };
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 900}, acceptDownloads: true});
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  // Fixed asset card → depreciation run → register.
  await menu(page, 'Turtas', 'Nauja turto kortelė');
  await page.waitForSelector('h1:text("Nauja ilgalaikio turto kortelė")');
  await page.getByLabel('Inventorinis Nr.').fill('IT-1');
  await page.getByLabel('Pavadinimas', {exact: true}).fill('Kompiuteris');
  await page.selectOption('select >> nth=0', '1240');
  await page.getByLabel('Įsigijimo (naudojimo pradžios) data').fill('2025-01-15');
  await page.getByLabel('Įsigijimo savikaina, €').fill('1200');
  await page.getByLabel('Naudingo tarnavimo laikas, mėn.').fill('36');
  await page.click('button:text("Sukurti kortelę")');
  await page.waitForSelector('h1:text("IT-1 Kompiuteris")');
  assert.match(await page.textContent('.cards'), /33,33/);
  if (out) await page.screenshot({path: `${out}/asset-card.png`, fullPage: true});
  await menu(page, 'Turtas', 'Nusidėvėjimo skaičiavimas');
  await page.waitForSelector('h1:text("Nusidėvėjimo skaičiavimas")');
  await page.fill('input[type=month]', '2025-02'); await page.dispatchEvent('input[type=month]', 'change');
  await page.click('button:text("Skaičiuoti ir kontuoti 2025-02")');
  await page.waitForSelector('text=Už 2025-02 nusidėvėjimas jau paskaičiuotas.');
  await menu(page, 'Turtas', 'Ilgalaikio turto sąrašas');
  await page.waitForSelector('text=Sutikrinimas su didžiąja knyga');
  if (out) await page.screenshot({path: `${out}/assets.png`, fullPage: true});
  // Year-end closing.
  await page.goto(t.base + '/#/metu-uzdarymas');
  await page.waitForSelector('h1:text("Metų uždarymas")');
  await page.fill('input[type=number]', '2025'); await page.dispatchEvent('input[type=number]', 'change');
  await page.click('button:text("Uždaryti 2025 m.")');
  await page.click('.modal button.btn-primary');
  await page.waitForSelector('text=/Uždaryta įrašu/');
  if (out) await page.screenshot({path: `${out}/year-end.png`, fullPage: true});
  // SEPA payments.
  await menu(page, 'Finansai', 'Mokėjimų ruošimas (SEPA)');
  await page.check('input[aria-label="Mokėti TT 77"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:text("Mokėjimų failas (XML)")')]);
  assert.match(dl.suggestedFilename(), /^mokejimai_invoices_\d{4}-\d{2}-\d{2}\.xml$/);
  if (out) await page.screenshot({path: `${out}/payments.png`, fullPage: true});
  // GPM313.
  await menu(page, 'Atlyginimai', 'GPM313 deklaracija (EDS forma)');
  await page.waitForSelector('h1:text("GPM313 mėnesinė pajamų mokesčio deklaracija")');
  await page.fill('input[type=month]', '2026-10'); await page.dispatchEvent('input[type=month]', 'change');
  await page.waitForFunction(() => [...document.querySelectorAll('.eds-field[data-field="G5"] .eds-ch')].map((e) => e.textContent).join('') === '200000');
  if (out) await page.screenshot({path: `${out}/gpm313.png`, fullPage: true});
  const [g] = await Promise.all([page.waitForEvent('download'), page.click('button:text("EDS failas (.ffdata)")')]);
  assert.equal(g.suggestedFilename(), 'GPM313_2026-10.ffdata');
  assert.deepEqual(errors, []);
  console.log('New modules browser check OK');
} finally { await browser.close(); await t.close(); }
