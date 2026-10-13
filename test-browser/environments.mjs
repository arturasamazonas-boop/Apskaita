// Browser check of the test environments: /ieva/ and /sonata/ open with their badge and separate data.
// Usage: node test-browser/environments.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {chromium} from 'playwright';
import {loadConfig} from '../src/config.mjs';
import {createPool} from '../src/db.mjs';
import {createEnvironments, tenantDatabaseUrl} from '../src/tenants.mjs';
import {TEST_DB} from '../test/helpers.mjs';
const out = process.argv[2];
const names = ['ieva', 'sonata'];
const drop = async () => { const c = new pg.Client({connectionString: TEST_DB}); await c.connect(); for (const n of names) await c.query(`DROP DATABASE IF EXISTS "${new URL(tenantDatabaseUrl(TEST_DB, n, {})).pathname.slice(1)}" WITH (FORCE)`); await c.end(); };
const admin = createPool(TEST_DB); await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await admin.end();
await drop();
const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apskaita-envb-'));
const quiet = {info() {}, warn() {}, error: (...a) => console.error(...a)};
const envs = await createEnvironments({...loadConfig({NODE_ENV: 'test', DATABASE_URL: TEST_DB, STORAGE_DIR: storageDir, OPEN_ACCESS: 'true'}), fxUrl: '', tenants: names}, {log: quiet, env: {}});
// Fresh environments start with the company onboarding; here it is marked done so the product pages open directly.
for (const a of envs.all()) await a.pool.query(`UPDATE company_settings SET name='UAB Testas', onboarding_done=true WHERE id=1`);
const server = http.createServer(envs.handle); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1366, height: 800}});
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/') && !(r.status() === 401 && r.url().endsWith('/api/me'))) errors.push(`${r.status()} ${r.url()}`); });
  for (const [n, product] of [['ieva', 'Ievos prekė'], ['sonata', 'Sonatos prekė']]) {
    await page.goto(`${base}/${n}`); // redirected to /n/
    await page.waitForSelector('.menubar');
    assert.match(await page.textContent('.env-badge'), new RegExp(`Testinė aplinka: ${n[0].toUpperCase()}${n.slice(1)}`));
    await page.goto(`${base}/${n}/#/prekes/nauja`); await page.waitForSelector('h1:text("Nauja prekės kortelė")');
    await page.fill('#' + await page.$eval('label:text-is("Pavadinimas")', (l) => l.htmlFor), product);
    await page.click('button:text("Išsaugoti kortelę")');
    await page.waitForSelector(`h1:text("Prekės kortelė: ${product}")`);
    await page.goto(`${base}/${n}/#/prekes`); await page.waitForSelector(`td:text("${product}")`);
    assert.equal(await page.locator('td:text("Ievos prekė")').count() + await page.locator('td:text("Sonatos prekė")').count(), 1, `only ${n}'s own product`);
    if (out) await page.screenshot({path: `${out}/env-${n}.png`});
  }
  await page.goto(`${base}/`); await page.waitForSelector('.menubar');
  assert.equal(await page.locator('.env-badge').count(), 0, 'the main environment has no badge');
  await page.goto(`${base}/#/prekes`); await page.waitForSelector('h1:text("Prekės / Paslaugos")');
  await page.waitForSelector('text=Prekių nerasta.');
  assert.deepEqual(errors, []);
  console.log('Environments browser check OK');
} finally { await browser.close(); server.close(); await envs.close(); await drop(); await fs.rm(storageDir, {recursive: true, force: true}); }
