// DEMO DATA ONLY (npm run demo:seed). Fictional company, users with generated passwords, fixture documents,
// bank statement and an explicitly labelled demo store. Never run against a production database.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT} from './config.mjs';
import {createUser} from './auth/auth.mjs';
import {createStorage} from './vault/storage.mjs';
import {uploadFiles} from './vault/upload.mjs';
import {importStatement} from './bank/import.mjs';
import {encryptSecret} from './lib/secrets.mjs';

export async function seedDemo(pool, config) {
  if (config.production && process.env.APSKAITA_ALLOW_DEMO !== 'yes') throw new Error('Demo duomenys produkcinėje aplinkoje neleidžiami.');
  const existing = (await pool.query('SELECT count(*) AS n FROM users')).rows[0].n;
  if (Number(existing) > 0) throw new Error('Duomenų bazėje jau yra naudotojų – demo duomenys įkeliami tik į tuščią bazę.');
  const pw = () => crypto.randomBytes(9).toString('base64url');
  const creds = {admin: pw(), accountant: pw(), readonly: pw()};
  const admin = await createUser(pool, {email: 'admin@demo.lt', name: 'Demo administratorius', role: 'admin', password: creds.admin});
  await createUser(pool, {email: 'buhalteris@demo.lt', name: 'Demo buhalteris', role: 'accountant', password: creds.accountant});
  await createUser(pool, {email: 'skaitytojas@demo.lt', name: 'Demo skaitytojas', role: 'readonly', password: creds.readonly});
  await pool.query(`UPDATE company_settings SET name='UAB Pavyzdinė prekyba (DEMO)', company_code='305555555', vat_code='LT100015555519', vat_registered=true, vat_registered_from='2020-01-01',
    address='Gedimino pr. 1, LT-01103 Vilnius', onboarding_done=true WHERE id=1`);
  await pool.query(`INSERT INTO bank_accounts(iban, name, bank_name, ledger_account) VALUES ('LT977044060000000001','Pagrindinė (DEMO)','Pavyzdžio bankas','2710') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO bank_accounts(iban, name, bank_name, ledger_account) VALUES ('LT037300010000000002','Taupomoji (DEMO)','Pavyzdžio bankas','2711') ON CONFLICT DO NOTHING`);
  const storage = createStorage(config.storageDir, {backend: config.storageBackend, pool});
  const user = {...admin, role: 'admin', active: true};
  const inv = path.join(ROOT, 'fixtures', 'invoices');
  const files = [];
  for (const f of ['digital.pdf', 'docx-invoice.docx', 'scanned.pdf', 'skewed-photo.jpg', 'multipage.pdf', 'proforma.pdf', 'two-invoices.pdf', 'sales.pdf']) files.push({name: f, buffer: await fs.readFile(path.join(inv, f))});
  await uploadFiles({pool, storage, config}, user, files, {workflow: 'invoice'});
  await uploadFiles({pool, storage, config}, user, [{name: 'paslaugu-sutartis.pdf', buffer: await fs.readFile(path.join(ROOT, 'fixtures', 'contract.pdf'))}], {workflow: 'vault',
    meta: {kind: 'contract', title: 'Valymo paslaugų sutartis (DEMO)', reference_number: 'ST-2026-03', start_date: '2026-09-01', end_date: '2027-08-31', contract_value: '12000.00', contract_currency: 'EUR', tags: ['valymas', 'demo']}});
  const [st] = await uploadFiles({pool, storage, config}, user, [{name: 'camt053-october.xml', buffer: await fs.readFile(path.join(ROOT, 'fixtures', 'bank', 'camt053-october.xml'))}], {workflow: 'bank'});
  await importStatement({pool, storage, config}, user, {documentId: st.documentId});
  await pool.query(`INSERT INTO stores(platform, name, base_url, is_demo, invoice_mode, secret_encrypted) VALUES ('saleor','DEMO Saleor parduotuvė','https://demo.invalid',true,'issue_here',$1)`, [encryptSecret(config.secretKey, '{}')]);
  console.log('\nDEMO duomenys įkelti (fiktyvūs). Prisijungimai (išsaugokite – rodomi tik dabar):');
  console.log(`  admin@demo.lt        ${creds.admin}`);
  console.log(`  buhalteris@demo.lt   ${creds.accountant}`);
  console.log(`  skaitytojas@demo.lt  ${creds.readonly}`);
  console.log('Sąskaitos atpažįstamos fone, kai paleistas serveris (npm start). Demo parduotuvę sinchronizuokite skiltyje „Integracijos“.');
  return creds;
}
