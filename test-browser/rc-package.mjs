// Browser check of the annual set for Registrų centras: opened from the menu, size cards, forms, checks, copy-ready amounts, PDF download.
// Usage: node test-browser/rc-package.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const t = await startTestApp({config: {openAccess: true}});
const acc = await t.client('accountant').login();
const post = (date, description, lines) => acc.post('/api/journal', {date, description, lines});
await post('2025-01-10', 'Kapitalas', [{account: '2710', debit: '2500'}, {account: '3011', credit: '2500'}]);
await post('2025-06-30', 'Pardavimas', [{account: '2410', debit: '1210'}, {account: '5001', credit: '1000'}, {account: '4492', credit: '210'}]);
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 900}, acceptDownloads: true});
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  await page.click('.menu-top:text("Ataskaitos")');
  await page.getByRole('menuitem', {name: 'Metinis rinkinys Registrų centrui'}).click();
  await page.fill('input[type=number]', '2025'); await page.dispatchEvent('input[type=number]', 'change');
  await page.waitForFunction(() => document.querySelector('.rc-table') && document.body.textContent.includes('Labai maža įmonė'));
  assert.equal(await page.$$eval('.rc-forms input:checked', (x) => x.length), 2);
  assert.ok((await page.$$eval('.rc-copy', (x) => x.map((e) => e.textContent))).includes('3710'));
  if (out) await page.screenshot({path: `${out}/rc-1.png`, fullPage: true});
  await page.selectOption('select >> nth=0', 'vidutine');
  await page.waitForFunction(() => document.querySelectorAll('.rc-forms input:checked').length === 4);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:text("Rinkinio PDF")')]);
  assert.equal(dl.suggestedFilename(), 'FA_rinkinys_2025.pdf');
  assert.deepEqual(errors, []);
  console.log('RC package browser check OK');
} finally { await browser.close(); await t.close(); }
