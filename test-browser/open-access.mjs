// Browser check: with OPEN_ACCESS=true the app opens without the login form.
import {chromium} from 'playwright';
import {startTestApp} from '../test/helpers.mjs';

const t = await startTestApp({config: {openAccess: true}});
await t.app.pool.query("UPDATE company_settings SET onboarding_done=true WHERE id=1");
const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath: process.env.PW_CHROMIUM} : {});
try {
  const page = await browser.newPage();
  await page.goto(t.base + '/');
  await page.waitForSelector('.menubar', {timeout: 15000});
  if (await page.$('.login-card')) throw new Error('login form shown');
  if (process.argv[2]) await page.screenshot({path: process.argv[2]});
  await page.context().clearCookies();
  await page.reload();
  await page.waitForSelector('.menubar', {timeout: 15000});
  console.log('open access UI: OK');
} finally { await browser.close(); await t.close(); }
