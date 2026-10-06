// Browser smoke test (Chromium via Playwright): real UI against a real server and the test database.
// Run: npm run test:browser. Screenshots → var/screenshots (or SCREENSHOT_DIR).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {startTestApp, FIX} from '../test/helpers.mjs';
import {ROOT} from '../src/config.mjs';

const shots = process.env.SCREENSHOT_DIR || path.join(ROOT, 'var', 'screenshots');
await fs.mkdir(shots, {recursive: true});
const t = await startTestApp();
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
const results = [];
const step = async (name, fn) => { const t0 = Date.now(); await fn(); results.push(`✓ ${name} (${Date.now() - t0} ms)`); };
try {
  // Seed via API: bank account + statement, so bank pages have data.
  const admin = await t.client('admin').login();
  await admin.post('/api/bank/accounts', {iban: 'LT977044060000000001', name: 'Pagrindinė', ledger_account: '2710'});
  const ctx = await browser.newContext({viewport: {width: 1440, height: 900}, locale: 'lt-LT'});
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await step('login form and dashboard', async () => {
    await page.goto(t.base + '/');
    await page.getByLabel('El. paštas').fill('buhaltere@test.lt');
    await page.getByLabel('Slaptažodis').fill('test-slaptazodis-123');
    await page.getByRole('button', {name: 'Prisijungti'}).click();
    await page.getByRole('heading', {name: 'Apžvalga'}).waitFor();
    await page.getByText('Laukia peržiūros').waitFor();
    await page.screenshot({path: path.join(shots, '01-apzvalga.png')});
  });

  await step('drag & drop area uploads invoices; processing finishes; review queue', async () => {
    await page.getByRole('link', {name: 'Dokumentų dėžutė', exact: true}).click();
    await page.locator('#inbox-files').setInputFiles([path.join(FIX, 'invoices', 'digital.pdf'), path.join(FIX, 'invoices', 'scanned.pdf')]);
    await page.getByText('įkelta, atpažįstama').first().waitFor();
    await t.drain();
    await page.reload();
    await page.getByRole('link', {name: /Biuro tiekimas/}).waitFor({timeout: 15000});
    await page.screenshot({path: path.join(shots, '02-deze.png')});
  });

  await step('review shows original with highlighted source and approves a ready invoice', async () => {
    await page.getByRole('link', {name: /Biuro tiekimas/}).click();
    await page.getByRole('heading', {name: 'Eilutės'}).waitFor();
    await page.locator('.page img').first().waitFor();
    await page.locator('[data-path="number"] input[type="text"]').focus();
    await page.locator('.hl-box').waitFor();
    await page.screenshot({path: path.join(shots, '03-perziura.png'), fullPage: false});
    await page.getByRole('button', {name: 'Patvirtinti', exact: true}).click();
    await page.getByText(/Patvirtinta ir užregistruota/).waitFor();
  });

  await step('unclear scanned VAT is flagged; correction is saved as new version and recalculated', async () => {
    await page.goto(t.base + '/#/deze');
    await page.getByRole('link', {name: /Švarus biuras/}).click();
    await page.getByText(/PVM suma neįskaitoma/).first().waitFor();
    const approve = page.getByRole('button', {name: 'Patvirtinti', exact: true});
    assert.equal(await approve.isDisabled(), true, 'approval disabled while blocking');
    await page.screenshot({path: path.join(shots, '04-neaiskus-pvm.png')});
    await page.locator('[data-path="sourceTotals.vatByRate.0.amount"] input[type="text"]').fill('42.00');
    await page.locator('[data-path="sourceTotals.vat"] input[type="text"]').fill('42.00');
    await page.getByRole('button', {name: 'Išsaugoti pakeitimus'}).click();
    await page.getByText(/Išsaugota nauja versija/).waitFor();
    await page.getByText('Versija 2').waitFor();
  });

  await step('manual sales invoice form → draft → approve with series number', async () => {
    await page.goto(t.base + '/#/pardavimai/nauja');
    await page.getByLabel('Pavadinimas').first().fill('UAB Testinis pirkėjas');
    await page.getByLabel('Aprašymas').fill('Konsultacija');
    await page.getByLabel('Kaina').fill('100');
    await page.getByRole('button', {name: 'Sukurti juodraštį peržiūrai'}).click();
    await page.getByRole('heading', {name: 'Eilutės'}).waitFor();
    await page.getByRole('button', {name: 'Patvirtinti', exact: true}).click();
    await page.getByText(/PP 000001/).waitFor();
    await page.getByRole('heading', {name: 'Dokumentų dėžutė'}).waitFor();
  });

  await step('bank import with preview and approval of a match', async () => {
    await page.goto(t.base + '/#/bankas/importas');
    await page.getByRole('heading', {name: 'Išrašo failas'}).waitFor();
    await page.locator('section input[type=file]').setInputFiles(path.join(FIX, 'bank', 'camt053-october.xml'));
    await page.getByRole('button', {name: 'Įkelti ir peržiūrėti'}).click();
    await page.getByText(/Pradinis likutis \+ įplaukos/).waitFor();
    await page.screenshot({path: path.join(shots, '05-banko-importas.png')});
    await page.getByRole('button', {name: 'Importuoti'}).click();
    await page.getByText(/Importuota: naujų 4/).waitFor();
    await page.goto(t.base + '/#/bankas');
    await page.getByText('Komisinis mokestis').click();
    await page.getByRole('heading', {name: 'Siūlomas suderinimas'}).waitFor();
    await page.screenshot({path: path.join(shots, '06-banko-operacija.png')});
    await page.getByRole('button', {name: 'Patvirtinti', exact: true}).click();
    await page.getByText('Patvirtinti paskirstymai').waitFor();
  });

  await step('reports: trial balance, P&L, drill-down, VAT register reconciliation, i.SAF check', async () => {
    await page.goto(t.base + '/#/ataskaitos/bandomasis');
    await page.getByRole('button', {name: 'Rodyti'}).click();
    await page.getByRole('link', {name: '6308'}).waitFor();
    await page.screenshot({path: path.join(shots, '07-bandomasis-balansas.png')});
    await page.getByRole('link', {name: '6308'}).click();
    await page.getByRole('heading', {name: 'Didžioji knyga'}).waitFor();
    await page.getByText(/Biuro tiekimas/).first().waitFor();
    await page.goto(t.base + '/#/ataskaitos/pelnas');
    await page.getByRole('button', {name: 'Rodyti'}).click();
    await page.getByText(/Pajamos/).first().waitFor();
    await page.goto(t.base + '/#/ataskaitos/pvm-pirkimai');
    await page.getByRole('button', {name: 'Rodyti'}).click();
    await page.getByText(/Sutikrinta su didžiąja knyga/).waitFor();
    await page.goto(t.base + '/#/ataskaitos/isaf');
    await page.getByRole('button', {name: 'Tikrinti'}).click();
    await page.getByText(/atitinka i.SAF 1.2 XSD/).waitFor();
    await page.screenshot({path: path.join(shots, '08-isaf.png')});
  });

  await step('vault, contacts, integrations and settings pages render', async () => {
    for (const [hash, heading] of [['dokumentai', 'Dokumentai'], ['kontaktai', 'Kontaktai ir prekės'], ['integracijos', 'Integracijos'], ['nustatymai/taisykles', 'Klasifikavimo taisyklės'], ['pirkimai', 'Pirkimai'], ['pardavimai/uzsakymai', 'Pardavimai']]) {
      await page.goto(`${t.base}/#/${hash}`);
      await page.getByRole('heading', {name: heading}).first().waitFor();
    }
    await page.screenshot({path: path.join(shots, '09-integracijos.png')});
  });

  await step('mobile layout: navigation menu toggles, no horizontal overflow on lists', async () => {
    const m = await browser.newContext({viewport: {width: 390, height: 844}, storageState: await ctx.storageState()});
    const mp = await m.newPage();
    mp.on('pageerror', (e) => errors.push(`mobile pageerror: ${e.message}`));
    await mp.goto(t.base + '/#/deze');
    await mp.getByRole('button', {name: '☰ Meniu'}).click();
    await mp.getByRole('link', {name: 'Bankas ir mokėjimai', exact: true}).click();
    await mp.getByRole('heading', {name: 'Bankas ir mokėjimai'}).waitFor();
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
    await mp.screenshot({path: path.join(shots, '10-mobilus.png')});
    await m.close();
  });

  await step('read-only user sees no approve/upload controls', async () => {
    const r = await browser.newContext({viewport: {width: 1280, height: 800}});
    const rp = await r.newPage();
    await rp.goto(t.base + '/');
    await rp.getByLabel('El. paštas').fill('skaitytojas@test.lt');
    await rp.getByLabel('Slaptažodis').fill('test-slaptazodis-123');
    await rp.getByRole('button', {name: 'Prisijungti'}).click();
    await rp.getByRole('heading', {name: 'Apžvalga'}).waitFor();
    await rp.goto(t.base + '/#/deze');
    await rp.getByRole('heading', {name: 'Dokumentų dėžutė'}).waitFor();
    assert.equal(await rp.locator('.dropzone').count(), 0);
    await r.close();
  });

  assert.deepEqual(errors.filter((e) => !/401|Failed to load resource/.test(e)), []);
  console.log(results.join('\n'));
  console.log(`Browser smoke test passed. Screenshots: ${shots}`);
} catch (e) {
  console.log(results.join('\n'));
  console.error('FAILED:', e.message, '\nBrowser errors:', errors);
  for (const p of browser.contexts().flatMap((c) => c.pages())) await p.screenshot({path: path.join(shots, `failure-${Date.now()}.png`)}).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await t.close();
}
