// Scenario 6 (contracts/vault) and 13 (rejections: unbalanced, locked periods, access, read-only, CSRF, immutability).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {startTestApp, FIX, uploadAndProcess} from './helpers.mjs';

let t, acc, ro, admin;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  admin = await t.client('admin').login();
});
after(async () => t.close());

test('6. contract is searchable by authorized users, keeps versions and never posts its value', async () => {
  const cp = (await acc.post('/api/counterparties', {name: 'UAB Švarus biuras', company_code: '304444444', is_supplier: true})).body;
  const up = await acc.upload([path.join(FIX, 'contract.pdf')], {workflow: 'vault', meta: {kind: 'contract', title: 'Valymo paslaugų sutartis', counterparty_id: cp.id, reference_number: 'ST-2026-03',
    start_date: '2026-09-01', end_date: '2027-08-31', contract_value: '12000.00', contract_currency: 'EUR', tags: ['valymas', 'paslaugos'], confidentiality: 'restricted'}});
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const id = up.body.results[0].documentId;
  await t.drain(); // text indexing job
  const found = await acc.get('/api/documents?q=valymo');
  assert.ok(found.body.items.some((d) => String(d.id) === String(id)), 'found by extracted text');
  assert.ok((await acc.get('/api/documents?q=ST-2026')).body.items.some((d) => String(d.id) === String(id)), 'found by reference');
  assert.ok((await acc.get('/api/documents?tag=valymas')).body.items.length >= 1);
  // Read-only user cannot see, search or download a restricted document.
  assert.equal((await ro.get('/api/documents?q=valymo')).body.items.length, 0);
  assert.equal((await ro.get(`/api/documents/${id}`)).status, 404);
  const doc = (await acc.get(`/api/documents/${id}`)).body;
  const orig = doc.files.find((f) => f.role === 'original');
  assert.equal((await ro.post(`/api/files/${orig.id}/link`)).status, 404);
  const link = (await acc.post(`/api/files/${orig.id}/link`)).body.url;
  const dl = await acc.get(link + '&download=1', {raw: true});
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.equal((await ro.get(link, {raw: true})).status, 404, 'link is not transferable to an unauthorized user');
  assert.equal((await acc.get(`/api/files/${orig.id}/content?t=0.bad`, {raw: true})).status, 403);
  // Lifecycle status from dates, manual override, versions.
  assert.equal(doc.contract_status_effective, doc.start_date <= new Date().toISOString().slice(0, 10) ? 'active' : 'draft');
  const fd = new FormData(); fd.append('note', 'Pasirašyta versija'); fd.append('file', new Blob([await fs.readFile(path.join(FIX, 'contract.pdf'))]), 'contract-signed.pdf');
  // Same content twice is still a new explicit version (originals are immutable).
  const v2 = await acc.raw('POST', `/api/documents/${id}/versions`, fd);
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  assert.equal(v2.body.version, 2);
  const term = await acc.put(`/api/documents/${id}`, {contract_status: 'terminated', notes: 'Nutraukta šalių susitarimu'});
  assert.equal(term.status, 200);
  const doc2 = (await acc.get(`/api/documents/${id}`)).body;
  assert.equal(doc2.contract_status_effective, 'terminated');
  assert.equal(doc2.files.filter((f) => f.role === 'original').length, 2);
  assert.ok(doc2.history.some((h) => h.action === 'document.metadata'));
  assert.ok(doc2.history.some((h) => h.action === 'file.download'));
  // No accounting effect from the contract value.
  assert.equal((await t.app.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count, '0');
  assert.equal((await t.app.pool.query('SELECT count(*) FROM invoices')).rows[0].count, '0');
  // Read-only cannot edit metadata.
  assert.equal((await ro.put(`/api/documents/1`, {notes: 'x'})).status, 403);
});

test('13a. unbalanced postings are rejected by the API and by the database', async () => {
  const r = await acc.post('/api/journal', {date: '2026-09-30', description: 'Bandymas', lines: [{account: '6899', debit: '10'}, {account: '2710', credit: '9.99'}]});
  assert.equal(r.status, 422);
  const c = await t.app.pool.connect();
  try {
    await c.query('BEGIN');
    const e = await c.query(`INSERT INTO journal_entries(entry_date, description, source_type, idempotency_key) VALUES ('2026-09-30','x','manual','raw-1') RETURNING id`);
    await c.query(`INSERT INTO journal_lines(entry_id, account_code, debit) VALUES ($1,'6899',10)`, [e.rows[0].id]);
    await c.query(`INSERT INTO journal_lines(entry_id, account_code, credit) VALUES ($1,'2710',9)`, [e.rows[0].id]);
    await assert.rejects(c.query('COMMIT'), /UNBALANCED/);
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  const ok = await acc.post('/api/journal', {date: '2026-09-30', description: 'Pradiniai likučiai', kind: 'opening', lines: [{account: '2710', debit: '1000'}, {account: '3010', credit: '1000'}]});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await assert.rejects(t.app.pool.query(`UPDATE journal_lines SET debit=5 WHERE entry_id=$1`, [ok.body.id]), /IMMUTABLE/);
  await assert.rejects(t.app.pool.query(`DELETE FROM journal_entries WHERE id=$1`, [ok.body.id]), /IMMUTABLE/);
  await assert.rejects(t.app.pool.query(`DELETE FROM audit_log`), /IMMUTABLE/);
});

test('13b. locked periods apply to API approvals, manual entries, background work and raw inserts', async () => {
  const {proposal: p} = await uploadAndProcess(t, acc, path.join(FIX, 'invoices', 'digital.pdf'));
  assert.equal(p.blocking, false);
  assert.equal((await ro.post('/api/settings/lock-period', {lockedThrough: '2026-09-30'})).status, 403);
  assert.equal((await acc.post('/api/settings/lock-period', {lockedThrough: '2026-09-30'})).status, 200);
  const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
  assert.equal(ap.status, 422);
  assert.ok(ap.body.issues.some((i) => i.code === 'period_locked'));
  const j = await acc.post('/api/journal', {date: '2026-09-15', description: 'Į užrakintą', lines: [{account: '6899', debit: '1'}, {account: '2710', credit: '1'}]});
  assert.equal(j.status, 409);
  await assert.rejects(t.app.pool.query(`INSERT INTO journal_entries(entry_date, description, source_type, idempotency_key) VALUES ('2026-09-01','x','job','job-1')`), /PERIOD_LOCKED/);
  // Background-style posting (service call without HTTP) is equally rejected.
  const {postEntry} = await import('../src/ledger/ledger.mjs');
  const {tx} = await import('../src/db.mjs');
  await assert.rejects(tx(t.app.pool, (db) => postEntry(db, {date: '2026-09-02', description: 'job', sourceType: 'job', idempotencyKey: 'job-2', lines: [{account: '6899', debit: '1'}, {account: '2710', credit: '1'}]})), /Laikotarpis užrakintas/);
  // Unlocking requires admin.
  assert.equal((await acc.post('/api/settings/lock-period', {lockedThrough: null})).status, 403);
  assert.equal((await admin.post('/api/settings/lock-period', {lockedThrough: null, note: 'Klaidingai užrakinta testui'})).status, 200);
});

test('13c. unauthorized access, read-only mutations, CSRF and sessions are rejected', async () => {
  const anon = await fetch(`${t.base}/api/documents`);
  assert.equal(anon.status, 401);
  for (const [m, u, b] of [['POST', '/api/journal', {}], ['POST', '/api/rules', {}], ['POST', '/api/manual-invoices', {}], ['PUT', '/api/settings/company', {}], ['POST', '/api/bank/accounts', {}], ['POST', '/api/users', {}], ['POST', '/api/proposals/1/approve', {}]]) {
    const r = await ro.raw(m, u, b);
    assert.equal(r.status, 403, `${m} ${u} → ${r.status}`);
  }
  const up = await ro.upload([path.join(FIX, 'invoices', 'second.pdf')]);
  assert.equal(up.status, 403);
  assert.equal((await acc.raw('POST', '/api/users', {email: 'x@y.lt', role: 'admin', password: 'xxxxxxxxxxxx'})).status, 403, 'accountant cannot manage users');
  // Missing CSRF token → rejected even with a valid session.
  const bad = await acc.raw('POST', '/api/journal', {}, {headers: {'x-csrf-token': 'wrong'}});
  assert.equal(bad.status, 403);
  // Cross-site origin rejected.
  const cross = await acc.raw('POST', '/api/journal', {}, {headers: {origin: 'https://evil.example'}});
  assert.equal(cross.status, 403);
  // Wrong password lockout after repeated failures.
  for (let i = 0; i < 5; i++) await fetch(`${t.base}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'skaitytojas@test.lt', password: 'neteisingas-' + i})});
  const locked = await fetch(`${t.base}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'skaitytojas@test.lt', password: 'test-slaptazodis-123'})});
  assert.equal(locked.status, 429);
  // Upload validation: unsupported legacy .doc is explained, not processed.
  const doc = await acc.upload([path.join(FIX, 'invoices', 'legacy.doc')]);
  assert.equal(doc.body.results[0].status, 'error');
  assert.match(doc.body.results[0].message, /DOCX arba PDF/);
  const js = await acc.upload([{name: 'evil.pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF')}]);
  assert.equal(js.body.results[0].status, 'error');
  assert.match(js.body.results[0].message, /JavaScript/);
  // Security headers.
  const h = await fetch(`${t.base}/`);
  assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(h.headers.get('x-frame-options'), 'DENY');
});
