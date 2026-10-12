// Browser check of exchange rates (fetch from a Lietuvos bankas stub), a USD invoice review showing EUR amounts,
// and the period-end revaluation page.
// Usage: node test-browser/fx.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const xml = (d, r) => `<FxRates><FxRate><Tp>EU</Tp><Dt>${d}</Dt><CcyAmt><Ccy>EUR</Ccy><Amt>1</Amt></CcyAmt><CcyAmt><Ccy>USD</Ccy><Amt>${r}</Amt></CcyAmt></FxRate></FxRates>`;
const stub = http.createServer((req, res) => { const dt = new URL(req.url, 'http://x').searchParams.get('dt') || ''; res.end(dt >= '2026-10-30' ? xml('2026-10-30', '1.0800') : xml('2026-10-01', '1.1298')); });
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const t = await startTestApp({config: {openAccess: true, fxUrl: `http://127.0.0.1:${stub.address().port}/FxRates.asmx`}});
const acc = await t.client('accountant').login();
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 900}});
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  await page.click('.menu-top:text("Finansai")');
  await page.getByRole('menuitem', {name: 'Valiutų kursai', exact: true}).click();
  await page.waitForSelector('h1:text("Valiutų kursai")');
  await page.fill('input[type=date] >> nth=0', '2026-10-01'); await page.fill('input[type=date] >> nth=1', '2026-10-01'); await page.dispatchEvent('input[type=date] >> nth=1', 'change');
  await page.click('button:text("Gauti iš Lietuvos banko")');
  await page.waitForSelector('td:text("1.1298")');
  if (out) await page.screenshot({path: `${out}/fx-rates.png`, fullPage: true});
  // A USD supplier invoice: the review shows the rate and the EUR amounts.
  const r = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'US', number: '1', issueDate: '2026-10-01', currency: 'USD', counterparty: {name: 'Cloud Inc.', country: 'US'},
    lines: [{description: 'Hosting', quantity: '1', unitPrice: '1000', taxCode: 'PVM1', accountCode: '6300', lineType: 'expense', vatTreatment: 'deductible'}]});
  await page.goto(`${t.base}/#/deze/${r.body.documentId}`);
  await page.waitForSelector('text=/Apskaitoje eurais pagal kursą 1.1298 USD = 1 EUR/');
  assert.match(await page.textContent("body"), /1\s070,98/);
  if (out) await page.screenshot({path: `${out}/fx-invoice.png`, fullPage: true});
  const p = r.body.proposal;
  assert.equal((await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})).status, 200);
  // Revaluation at 2026-10-30 (rate 1.08).
  await page.goto(t.base + '/#/valiutos/perkainojimas');
  await page.fill('input[type=date]', '2026-10-30'); await page.dispatchEvent('input[type=date]', 'change');
  await page.waitForSelector('text=/Skola tiekėjui: US 1/');
  if (out) await page.screenshot({path: `${out}/fx-revaluation.png`, fullPage: true});
  await page.click('button:text("Perkainoti 2026-10-30 datai")');
  await page.click('.modal button.btn-primary');
  await page.waitForSelector('text=/datai perkainojimas jau užregistruotas/');
  assert.deepEqual(errors, []);
  console.log('FX browser check OK');
} finally { await browser.close(); await t.close(); stub.close(); }
