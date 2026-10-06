// STORAGE_BACKEND=postgres (hosts without a persistent disk, e.g. Render free + Neon):
// upload → OCR/extraction → approval → download, write-once blobs, and backup/restore verification.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {startTestApp, FIX, uploadAndProcess, TEST_DB} from './helpers.mjs';
import {verify} from '../scripts/restore.mjs';

let t, acc;
before(async () => { t = await startTestApp({config: {storageBackend: 'postgres'}}); acc = await t.client('accountant').login(); });
after(async () => t.close());

test('files are stored in PostgreSQL, processed and served without a disk', async () => {
  assert.equal(t.app.storage.backend, 'postgres');
  const {proposal: p, upload} = await uploadAndProcess(t, acc, path.join(FIX, 'invoices', 'scanned.pdf'));
  assert.equal(p.data.number, '7781');
  assert.ok(p.data.provenance['sourceTotals.vatByRate.0.amount'].source.bbox, 'OCR provenance works from DB storage');
  const objects = await fs.readdir(path.join(t.storageDir, 'objects')).catch(() => []);
  assert.equal(objects.length, 0, 'nothing written to the storage directory');
  const blobs = (await t.app.pool.query('SELECT count(*) FROM file_blobs')).rows[0].count;
  assert.ok(Number(blobs) >= 2, 'original + preview stored as blobs');
  const doc = (await acc.get(`/api/documents/${upload.documentId}`)).body;
  const orig = doc.files.find((f) => f.role === 'original');
  const {url} = (await acc.post(`/api/files/${orig.id}/link`)).body;
  const res = await acc.get(url, {raw: true});
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), await fs.readFile(path.join(FIX, 'invoices', 'scanned.pdf')));
  await assert.rejects(t.app.pool.query('DELETE FROM file_blobs'), /IMMUTABLE/);
  const v = await verify({databaseUrl: TEST_DB, storageDir: t.storageDir});
  assert.equal(v.ok, true, v.problems.join('; '));
});
