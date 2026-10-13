// Browser check of Palūkanos: from the menu, upload a loan agreement (DOCX), review the terms read from it, set the
// day the money arrived, save; interest to a date with and without the repayment day; the manual calculator.
// Usage: node test-browser/loans.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {chromium} from 'playwright';
import {startTestApp, COMPANY} from '../test/helpers.mjs';
const out = process.argv[2];
const t = await startTestApp({config: {openAccess: true}});
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
const tmp = await fs.mkdtemp(path.join(process.cwd(), 'var', 'loans-'));
try {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  const paras = ['PASKOLOS SUTARTIS Nr. P-2026/07', 'Vilnius, 2026 m. kovo 15 d.', `UAB „Finansų partneris“, įmonės kodas 304111222, toliau – Paskolos davėjas, ir UAB „Pavyzdinė prekyba“, įmonės kodas ${COMPANY.company_code}, toliau – Paskolos gavėjas, sudarė šią sutartį.`,
    '1. Paskolos davėjas suteikia Paskolos gavėjui 25 000,00 EUR paskolą.', '2. Už naudojimąsi paskola mokamos 6 % metinės palūkanos, metus laikant 365 dienų.', '3. Paskola grąžinama iki 2027-03-31.', '4. Pavėlavus mokėti – 0,05 % delspinigiai už dieną.'];
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  const file = path.join(tmp, 'paskolos-sutartis.docx');
  await fs.writeFile(file, await zip.generateAsync({type: 'nodebuffer'}));

  const page = await browser.newPage({viewport: {width: 1366, height: 900}});
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  await page.click('.menu-top:text("Finansai")');
  await page.getByRole('menuitem', {name: 'Palūkanos', exact: true}).click();
  await page.waitForSelector('h1:text("Palūkanos")');
  await page.setInputFiles('input[type=file]', file);
  await page.waitForSelector('h1:text("Paskolos sutarties sąlygos")');
  const val = async (label) => page.inputValue('#' + await page.$eval(`label:text-is("${label}")`, (l) => l.htmlFor));
  assert.equal(await val('Palūkanos, % per metus'), '6');
  assert.equal(await val('Grąžinti iki'), '2027-03-31');
  assert.equal(await val('Sutarties Nr.'), 'P-2026/07');
  assert.equal(await page.$eval('select >> nth=0', (s) => s.value), 'received');
  assert.match(await page.textContent('body'), /Sutartyje: „…[^"]*6 % metinės palūkanos/);
  if (out) await page.screenshot({path: `${out}/loan-review.png`, fullPage: true});
  await page.fill('#' + await page.$eval('label:text-is("Pinigų gavimo diena")', (l) => l.htmlFor), '2026-03-20');
  await page.click('button:text("Išsaugoti paskolą")');
  await page.waitForSelector('h1:text-matches("Gauta paskola Nr. P-2026/07")');
  await page.fill('input[type=date]', '2026-09-30'); await page.dispatchEvent('input[type=date]', 'change');
  await page.waitForSelector('text=Palūkanos iki 2026-09-30');
  await page.waitForFunction(() => /797,26/.test(document.body.textContent));
  await page.check('label:has-text("Įskaičiuoti grąžinimo") input');
  await page.waitForFunction(() => /801,37/.test(document.body.textContent));
  if (out) await page.screenshot({path: `${out}/loan-card.png`, fullPage: true});
  // List and the manual calculator.
  await page.click('a:text("← Palūkanos")'); await page.waitForSelector('h1:text("Palūkanos")');
  await page.waitForSelector('a:text("P-2026/07 (2026-03-15)")');
  const calc = page.locator('section:has(h2:text("Skaičiavimas ranka"))');
  await calc.locator('input >> nth=0').fill('10 000,00');
  await calc.locator('input[type=date] >> nth=0').fill('2026-01-01');
  await calc.locator('input[type=date] >> nth=1').fill('2026-12-31');
  await calc.locator('input >> nth=3').fill('5');
  await calc.locator('input[type=checkbox]').check();
  await calc.locator('button:text("Skaičiuoti")').click();
  await page.waitForSelector('.calc-result:has-text("365 d.")');
  assert.match(await page.textContent('.calc-result'), /500,00/);
  if (out) await page.screenshot({path: `${out}/loans-list.png`, fullPage: true});
  assert.deepEqual(errors, []);
  console.log('Loans browser check OK');
} finally { await browser.close(); await t.close(); await fs.rm(tmp, {recursive: true, force: true}); }
