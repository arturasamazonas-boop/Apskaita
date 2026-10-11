// Browser check of the FR0600 page (form as in VMI EDS): values in the form cells, editing a field, field 36, downloads.
// Usage: node test-browser/fr0600.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';
const out = process.argv[2];
const t = await startTestApp({config: {openAccess: true}});
const acc = await t.client('accountant').login();
const mk = async (body) => { const r = await acc.post('/api/manual-invoices', body); const p = r.body.proposal; await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash}); };
await mk({register: 'sales', issueDate: '2026-09-05', counterparty: {name: 'UAB Klientas', companyCode: '300000001', vatCode: 'LT100005748413'}, lines: [{description: 'Prekė', quantity: '10', unitPrice: '100', taxCode: 'PVM1'}]});
await mk({register: 'purchase', series: 'T', number: '9', issueDate: '2026-09-06', counterparty: {name: 'UAB Tiekėjas', vatCode: 'LT777777716', companyCode: '307777777'},
  lines: [{description: 'Prekės', quantity: '1', unitPrice: '400', taxCode: 'PVM1', accountCode: '204', lineType: 'inventory', vatTreatment: 'deductible'}]});
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
const cells = (page, name) => page.$$eval(`.eds-field[data-field="${name}"] .eds-ch`, (els) => els.map((e) => e.textContent).join(''));
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 900}, acceptDownloads: true});
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/apzvalga'); await page.waitForSelector('.menubar');
  await page.click('.menu-top:text("Ataskaitos")');
  await page.getByRole('menuitem', {name: 'PVM deklaracija FR0600 (EDS forma)'}).click();
  await page.waitForSelector('.eds-form img.eds-bg');
  await page.fill('input[type=month]', '2026-09'); await page.dispatchEvent('input[type=month]', 'change');
  await page.waitForFunction(() => document.querySelector('.eds-field[data-field="E11"] .eds-ch'));
  assert.equal(await cells(page, 'E11'), '1000');
  assert.equal(await cells(page, 'E29'), '210');
  assert.equal(await cells(page, 'E35'), '84');
  assert.equal(await cells(page, 'E36'), '126');
  assert.equal(await cells(page, 'B_ML_DataNuo'), '20260901');
  assert.equal(await page.textContent('.eds-check[data-field="B_Pirmine"]'), 'X');
  assert.ok(await page.evaluate(() => document.querySelector('.eds-bg').naturalWidth > 1000), 'form background loaded');
  // Cells sit inside the form's boxes: E11 last character is right-aligned within the field.
  const [fb, cb] = await page.evaluate(() => [document.querySelector('.eds-field[data-field="E11"]').getBoundingClientRect().right, [...document.querySelectorAll('.eds-field[data-field="E11"] .eds-ch')].pop().getBoundingClientRect().right]);
  assert.ok(fb - cb < 8, `E11 right edge ${fb} vs ${cb}`);
  if (out) await page.screenshot({path: `${out}/fr0600-1.png`, fullPage: true});
  // Type into field 32 (not filled by the program): 36 recalculated.
  await page.click('.eds-field[data-field="E32"]');
  await page.fill('.eds-field[data-field="E32"] .eds-input', '20'); await page.press('.eds-field[data-field="E32"] .eds-input', 'Enter');
  await page.dispatchEvent('.eds-field[data-field="E32"] .eds-input', 'change');
  await page.waitForFunction(() => [...document.querySelectorAll('.eds-field[data-field="E36"] .eds-ch')].map((e) => e.textContent).join('') === '146');
  await page.click('.eds-check[data-field="B_Patikslinta"]');
  assert.equal(await page.textContent('.eds-check[data-field="B_Pirmine"]'), '');
  if (out) await page.screenshot({path: `${out}/fr0600-2.png`, fullPage: true});
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:text("EDS failas (.ffdata)")')]);
  assert.equal(dl.suggestedFilename(), 'FR0600_2026-09-01_2026-09-30_patikslinta.ffdata');
  const xml = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
  for (const s of ['<Field Name="E32">20</Field>', '<Field Name="E36">146</Field>', '<Field Name="E8">B_Patikslinta</Field>', '<Field Name="B_Pirmine"></Field>']) assert.ok(xml.includes(s), s);
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.click('button:text("PDF")')]);
  assert.match(pdf.suggestedFilename(), /^FR0600_2026-09-01_2026-09-30_patikslinta\.pdf$/);
  // i.SAF: registers previewed from the generated XML.
  await page.goto(t.base + '/#/ataskaitos/isaf');
  await page.fill('input[type=date] >> nth=0', '2026-09-01'); await page.fill('input[type=date] >> nth=1', '2026-09-30');
  await page.click('button:text("Tikrinti")');
  await page.waitForSelector('.isaf-view');
  const sales = await page.$$eval('.isaf-view section:nth-of-type(2) tbody tr td', (tds) => tds.map((x) => x.textContent));
  assert.ok(sales.includes('LT100005748413') && sales.includes('UAB Klientas') && sales.includes('PVM1') && sales.includes('21'), sales.join('|'));
  const purchase = await page.textContent('.isaf-view section:nth-of-type(3) tfoot');
  assert.match(purchase, /Iš viso: 1 SF/);
  if (out) await page.screenshot({path: `${out}/isaf.png`, fullPage: true});
  const m = await browser.newPage({viewport: {width: 390, height: 800}});
  await m.goto(t.base + '/#/fr0600?month=2026-09'); await m.waitForSelector('.eds-field[data-field="E11"] .eds-ch');
  assert.equal(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  if (out) await m.screenshot({path: `${out}/fr0600-mobile.png`, fullPage: true});
  assert.deepEqual(errors, []);
  console.log('FR0600 browser check OK');
} finally { await browser.close(); await t.close(); }
