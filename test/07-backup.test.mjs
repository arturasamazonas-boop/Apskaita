// Database + file backup and restoration into a fresh database/storage, with integrity verification
// and a restarted application reading restored documents.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import pg from 'pg';
import {startTestApp, FIX, uploadAndProcess, TEST_DB} from './helpers.mjs';
import {backup} from '../scripts/backup.mjs';
import {restore, verify} from '../scripts/restore.mjs';
import {createApp} from '../src/app.mjs';
import {loadConfig} from '../src/config.mjs';

const RESTORE_DB = TEST_DB.replace(/\/[^/]+$/, '/apskaita_restore_test');
let t, acc, tmp;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'apskaita-backup-'));
  const admin = new pg.Client({connectionString: TEST_DB});
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS apskaita_restore_test');
  await admin.query('CREATE DATABASE apskaita_restore_test');
  await admin.end();
});
after(async () => { await t.close(); await fs.rm(tmp, {recursive: true, force: true}); });

test('backup of database and files restores into a fresh environment and verifies', async () => {
  const {proposal: p, upload} = await uploadAndProcess(t, acc, path.join(FIX, 'invoices', 'digital.pdf'));
  assert.equal((await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})).status, 200);
  await acc.upload([path.join(FIX, 'contract.pdf')], {workflow: 'vault', meta: {kind: 'contract', title: 'Sutartis'}});
  await t.drain();
  const b = await backup({databaseUrl: TEST_DB, storageDir: t.storageDir, backupRoot: tmp});
  assert.ok(b.manifest.files.objects >= 3);
  const before = await verify({databaseUrl: TEST_DB, storageDir: t.storageDir});
  assert.equal(before.ok, true, before.problems.join('; '));
  const target = path.join(tmp, 'restored-storage');
  const r = await restore({backupDir: b.dir, databaseUrl: RESTORE_DB, storageDir: target});
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(r.counts, before.counts);
  // Refuses to overwrite a non-empty target.
  await assert.rejects(restore({backupDir: b.dir, databaseUrl: RESTORE_DB, storageDir: target}), /nėra tuščia/);
  // Tampered archive is detected.
  const bad = path.join(tmp, 'tampered'); await fs.cp(b.dir, bad, {recursive: true});
  await fs.appendFile(path.join(bad, 'files.tar.gz'), 'x');
  await assert.rejects(restore({backupDir: bad, databaseUrl: RESTORE_DB, storageDir: path.join(tmp, 'x')}), /kontrolinė suma/);
  // The application runs on the restored copy and serves the original file bytes.
  const app2 = await createApp({...loadConfig({NODE_ENV: 'test', DATABASE_URL: RESTORE_DB, STORAGE_DIR: target})}, {log: {info() {}, warn() {}, error() {}}});
  const f = (await app2.pool.query(`SELECT * FROM stored_files WHERE document_id=$1 AND role='original'`, [upload.documentId])).rows[0];
  const bytes = await app2.storage.read(f.storage_key);
  assert.deepEqual(bytes, await fs.readFile(path.join(FIX, 'invoices', 'digital.pdf')));
  const tb = (await app2.pool.query(`SELECT sum(debit) AS d, sum(credit) AS c FROM journal_lines`)).rows[0];
  assert.equal(tb.d, tb.c);
  await app2.close();
});
