// Browser check of the Žinynai menu order, the "Pirkėjai / Tiekėjai" rename, the RAL 6005 header and a user-defined
// product attribute ("Diametras") created from the product card and shown in the product list.
// Usage: node test-browser/product-attributes.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const t = await startTestApp({config: {openAccess: true}});
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 900}});
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  assert.equal(await page.$eval('.topbar', (e) => getComputedStyle(e).backgroundImage.includes('rgb(17, 66, 50)')), true, 'RAL 6005 header');
  await page.click('.menu-top:text("Žinynai")');
  const items = await page.$$eval('.menu-top[aria-expanded="true"] + .menu-list a', (a) => a.map((x) => x.textContent.trim()));
  assert.deepEqual(items.slice(0, 3), ['Prekės / Paslaugos', 'Pirkėjai / Tiekėjai', 'Sąskaitų planas']);
  if (out) await page.screenshot({path: `${out}/zinynai-menu.png`});
  await page.getByRole('menuitem', {name: 'Pirkėjai / Tiekėjai', exact: true}).click();
  await page.waitForSelector('h1:text("Pirkėjai / Tiekėjai")');

  // New product: create the "Diametras" attribute from the card, fill it, save.
  await page.goto(t.base + '/#/prekes/nauja'); await page.waitForSelector('h1:text("Nauja prekės kortelė")');
  await page.fill('#' + await page.$eval('label:text-is("Pavadinimas")', (l) => l.htmlFor), 'Vamzdis PE');
  await page.click('button:text("+ Naujas rodiklis")');
  await page.fill('.modal input >> nth=0', 'Diametras');
  await page.selectOption('.modal select', 'number');
  await page.fill('.modal input >> nth=1', 'mm');
  await page.click('.modal button:text("Sukurti")');
  await page.waitForSelector('label:text("Diametras, mm")');
  await page.fill('input[data-attribute="Diametras"]', '20,5');
  await page.click('button:text("Išsaugoti kortelę")');
  await page.waitForSelector('h1:text("Prekės kortelė: Vamzdis PE")');
  assert.equal(await page.inputValue('input[data-attribute="Diametras"]'), '20.5');
  if (out) await page.screenshot({path: `${out}/product-attribute-card.png`, fullPage: true});
  await page.goto(t.base + '/#/prekes'); await page.waitForSelector('h1:text("Prekės / Paslaugos")');
  await page.waitForSelector('th:text("Diametras, mm")');
  await page.waitForSelector('td:text("20,5")');
  if (out) await page.screenshot({path: `${out}/product-attribute-list.png`, fullPage: true});
  await page.click('.tab:text("Rodikliai")'); await page.waitForSelector('h1:text("Prekių rodikliai")');
  await page.waitForSelector('td:text("Diametras")');
  assert.deepEqual(errors, []);
  console.log('Product attributes browser check OK');
} finally { await browser.close(); await t.close(); }
