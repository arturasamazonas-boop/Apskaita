// Browser check: the "→ Apskaita" bookmarklet on a company page opens the app with the fields filled (VIES stubbed),
// and the paste dialog fills the company settings. Usage: node test-browser/rekvizitai.mjs [screenshot-dir]
import http from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const shot = (p, name) => (out ? p.screenshot({path: `${out}/${name}`}) : null);
const vies = http.createServer((req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({isValid: true, userError: 'VALID', name: 'UAB ENERGITECH', address: 'N/A'})); });
await new Promise((r) => vies.listen(0, '127.0.0.1', r));
const t = await startTestApp({config: {openAccess: true, viesUrl: `http://127.0.0.1:${vies.address().port}`}});
const PAGE = 'Energitech, UAB\nĮmonės kodas\n306988664\nPVM kodas\nLT100017188012\nAdresas\nPanerių g. 51, LT-03160 Vilnius\nMobilus telefonas\n+370 612 34567\nVadovas\nJonas Jonaitis';
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 860}});
  page.on('pageerror', (e) => errors.push(e.message));
  // 1. Bookmarklet: run it on a fake "company page" served locally, it must open the app with the data.
  await page.goto(t.base + '/#/rekvizitai'); await page.waitForSelector('.bookmarklet');
  await shot(page, '1-install.png');
  const href = await page.getAttribute('.bookmarklet', 'href');
  const fake = await browser.newPage();
  await fake.setContent(`<h1>Energitech, UAB</h1><pre>${PAGE}</pre>`);
  const [popup] = await Promise.all([fake.context().waitForEvent('page'), fake.evaluate(decodeURIComponent(href.slice('javascript:'.length)))]);
  await popup.setViewportSize({width: 1366, height: 860});
  await popup.waitForSelector('.vat-result.pos');
  assert.equal(await popup.inputValue('input >> nth=0'), 'UAB „Energitech“');
  assert.ok(!popup.url().includes('d='), 'page text removed from the URL');
  await shot(popup, '2-review.png');
  await popup.click('button:text("Sukurti kontrahentą")'); await popup.waitForSelector('h1:text("Kontrahentai")');
  await popup.getByText('306988664').waitFor();
  // 2. Paste flow in the company settings.
  await popup.goto(t.base + '/#/nustatymai/imone'); await popup.click('button:text("Užpildyti iš rekvizitai.lt")');
  await popup.fill('textarea[aria-label="Įmonės puslapio tekstas"]', PAGE.replace('306988664', '306988665'));
  await shot(popup, '3-paste.png');
  await popup.click('.modal button.btn-primary');
  assert.equal(await popup.inputValue('#' + await popup.getAttribute('label:text("Įmonės kodas") >> xpath=..//input', 'id')), '306988665');
  await shot(popup, '4-settings.png');
  console.log('rekvizitai UI: OK');
} finally { await browser.close(); await t.close(); vies.close(); console.log('errors:', JSON.stringify(errors)); }
