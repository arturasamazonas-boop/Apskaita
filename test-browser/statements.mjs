// Browser check of the financial statement forms page: form, previous-period entry, PDF download.
// Usage: node test-browser/statements.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const t = await startTestApp({config: {openAccess: true}});
const acc = await t.client('accountant').login();
const post = (date, description, lines) => acc.post('/api/journal', {date, description, lines});
await post('2025-01-10', 'Kapitalas', [{account: '2710', debit: '2500'}, {account: '3011', credit: '2500'}]);
await post('2025-06-30', 'Pardavimas', [{account: '2410', debit: '1210'}, {account: '5001', credit: '1000'}, {account: '4492', credit: '210'}]);
await post('2026-03-01', 'Pardavimas', [{account: '2710', debit: '900'}, {account: '5000', credit: '900'}]);
await post('2026-04-30', 'Nuoma', [{account: '6300', debit: '300'}, {account: '443', credit: '300'}]);
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 900}, acceptDownloads: true});
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  await page.click('.menu-top:text("Ataskaitos")');
  await page.getByRole('menuitem', {name: 'Sutrumpintas balansas (2 priedas)'}).click();
  await page.waitForSelector('.fs-table');
  await page.fill('input[type=date] >> nth=0', '2026-06-30'); await page.dispatchEvent('input[type=date] >> nth=0', 'change');
  await page.waitForFunction(() => document.querySelector('.fs-title')?.textContent.startsWith('2026-06-30'));
  assert.match(await page.textContent('.issue-ok'), /Turtas lygus/);
  if (out) await page.screenshot({path: `${out}/1-balansas.png`, fullPage: true});
  await page.click('button:text("Įvesti praėjusio laikotarpio sumas ranka")');
  await page.fill('input[aria-label="4. Pinigai ir pinigų ekvivalentai praėjęs laikotarpis"]', '5000');
  await page.click('button:text("Išsaugoti praėjusio laikotarpio sumas")');
  await page.waitForSelector('td.fs-manual');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:text("Atsisiųsti PDF")')]);
  assert.match(download.suggestedFilename(), /^balansas-sutrumpintas_2026-06-30\.pdf$/);
  await page.goto(t.base + '/#/finansines/pelno-nuostoliu-trumpa?from=2026-01-01&to=2026-12-31');
  await page.waitForFunction(() => document.querySelector('.fs-title')?.textContent.includes('PELNO'));
  if (out) await page.screenshot({path: `${out}/2-pn-trumpa.png`, fullPage: true});
  console.log('statements UI: OK');
} finally { await browser.close(); await t.close(); console.log('errors:', JSON.stringify(errors)); }
