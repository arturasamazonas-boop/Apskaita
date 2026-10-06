// Scenario 12 and integration robustness. FIXTURE TESTS ONLY: Saleor is a local mock GraphQL/JWKS server;
// OpenCart runs the real extension PHP code under `php -S` with stubbed engine/DB. No live store is contacted.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFileSync} from 'node:child_process';
import {startTestApp, FIX} from './helpers.mjs';
import {ROOT} from '../src/config.mjs';

let t, acc, admin, saleorSrv, saleorUrl, ocProc, ocUrl, saleorStore, ocStore;
const saleorOrders = JSON.parse(await fs.readFile(path.join(FIX, 'stores', 'saleor-orders.json'), 'utf8'));
let saleorState = structuredClone(saleorOrders);
let fail429 = 0, gqlCalls = 0;
const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'test-key-1', use: 'sig', alg: 'RS256'};
const OC_KEY = 'oc-test-key-0123456789abcdef0123456789abcdef';
let hasPhp = true;
try { execFileSync('php', ['-v']); } catch { hasPhp = false; }

function startSaleorMock() {
  return new Promise((resolve) => {
    saleorSrv = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      if (req.url === '/.well-known/jwks.json') { res.end(JSON.stringify({keys: [jwk]})); return; }
      if (req.url !== '/graphql/' || req.headers.authorization !== 'Bearer saleor-app-token') { res.writeHead(401); res.end('{}'); return; }
      gqlCalls++;
      if (fail429 > 0) { fail429--; res.writeHead(429, {'retry-after': '1'}); res.end('{}'); return; }
      const {query, variables} = JSON.parse(Buffer.concat(chunks).toString());
      if (query.includes('order(id:')) { res.end(JSON.stringify({data: {order: saleorState.find((o) => o.id === variables.id) || null}})); return; }
      const since = variables.since || '1970-01-01T00:00:00Z';
      const list = saleorState.filter((o) => o.updatedAt >= since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const start = variables.after ? Number(Buffer.from(variables.after, 'base64').toString()) : 0;
      const page = list.slice(start, start + variables.first);
      const end = start + page.length;
      res.end(JSON.stringify({data: {orders: {pageInfo: {hasNextPage: end < list.length, endCursor: Buffer.from(String(end)).toString('base64')}, edges: page.map((node) => ({node}))}}}));
    });
    saleorSrv.listen(0, '127.0.0.1', () => { saleorUrl = `http://127.0.0.1:${saleorSrv.address().port}`; resolve(); });
  });
}

async function startOpenCart() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  ocProc = spawn('php', ['-S', `127.0.0.1:${port}`, path.join(ROOT, 'test/php/oc-harness.php')], {
    env: {...process.env, OC_FIXTURE: path.join(FIX, 'stores', 'opencart-orders.json'), OC_KEY, OC_EXT: path.join(ROOT, 'integrations/opencart/apskaita_export')}, stdio: 'ignore'});
  ocUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(ocUrl + '/index.php'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}

function signSaleor(raw) {
  const header = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'test-key-1', b64: false, crit: ['b64']})).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.concat([Buffer.from(header + '.'), Buffer.from(raw)]), privateKey).toString('base64url');
  return `${header}..${sig}`;
}
async function webhook(order, {event = 'order_updated', badSig = false} = {}) {
  const raw = JSON.stringify({order});
  return fetch(`${t.base}/api/webhooks/saleor/${saleorStore.id}`, {method: 'POST', body: raw,
    headers: {'content-type': 'application/json', 'saleor-event': event, 'saleor-api-url': `${saleorUrl}/graphql/`, 'saleor-signature': badSig ? signSaleor(raw + 'x') : signSaleor(raw)}});
}
async function orders(storeId) { return (await acc.get(`/api/orders?store=${storeId}`)).body.items; }
async function sync(storeId, kind = 'initial') {
  const r = await acc.post(`/api/stores/${storeId}/sync`, {kind});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (let i = 0; i < 5; i++) { await t.drain(); await t.app.pool.query(`UPDATE jobs SET run_at=now() WHERE status='queued'`); }
}

before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  admin = await t.client('admin').login();
  await startSaleorMock();
  if (hasPhp) await startOpenCart();
  saleorStore = (await admin.post('/api/stores', {platform: 'saleor', name: 'Saleor parduotuvė', base_url: saleorUrl, apiToken: 'saleor-app-token', invoice_mode: 'issue_here', config: {requestsPerSecond: 50}})).body;
  assert.ok(saleorStore.id, JSON.stringify(saleorStore));
  assert.equal(saleorStore.secret_encrypted, undefined, 'secret never returned');
  if (hasPhp) ocStore = (await admin.post('/api/stores', {platform: 'opencart', name: 'OpenCart parduotuvė', base_url: ocUrl, apiKey: OC_KEY, invoice_mode: 'import_external', config: {requestsPerSecond: 50}})).body;
});
after(async () => { saleorSrv?.close(); ocProc?.kill(); await t.close(); });

test('12a. imports: equal order numbers from different stores stay distinct; repeated imports add nothing', async () => {
  await sync(saleorStore.id);
  const s = await orders(saleorStore.id);
  assert.equal(s.length, 4);
  const by = Object.fromEntries(s.map((o) => [o.order_number, o]));
  assert.equal(by['1001'].state, 'proposed');
  assert.equal(by['1002'].state, 'waiting_status');
  assert.equal(by['1003'].state, 'proposed');
  assert.equal(by['1004'].state, 'needs_review');
  assert.match(by['1004'].state_note, /USD/);
  if (hasPhp) {
    await sync(ocStore.id);
    const o = await orders(ocStore.id);
    assert.equal(o.length, 2);
    const oc1001 = o.find((x) => x.order_number === '1001');
    assert.equal(oc1001.state, 'proposed', oc1001.state_note);
  }
  // Second full import: nothing new, no new proposal versions.
  const versionsBefore = (await t.app.pool.query('SELECT count(*) FROM proposals')).rows[0].count;
  await sync(saleorStore.id, 'reconcile');
  if (hasPhp) await sync(ocStore.id, 'reconcile');
  assert.equal((await t.app.pool.query('SELECT count(*) FROM external_orders')).rows[0].count, hasPhp ? '6' : '4');
  assert.equal((await t.app.pool.query('SELECT count(*) FROM proposals')).rows[0].count, versionsBefore);
  const runs = (await acc.get(`/api/stores/${saleorStore.id}/runs`)).body;
  assert.equal(runs[0].unchanged, 4);
  // Approve Saleor 1001 (issued here) and OpenCart 1001 (external invoice number) – both exist separately.
  const p1 = (await acc.get(`/api/proposals/${by['1001'].proposal_id}`)).body;
  assert.equal(p1.blocking, false, JSON.stringify(p1.validation.issues));
  assert.deepEqual([p1.validation.computed.net, p1.validation.computed.vat, p1.validation.computed.gross], ['25.00', '5.25', '30.25']);
  const a1 = await acc.post(`/api/proposals/${p1.id}/approve`, {contentHash: p1.content_hash});
  assert.equal(a1.status, 200, JSON.stringify(a1.body));
  if (hasPhp) {
    const oc1001 = (await orders(ocStore.id)).find((x) => x.order_number === '1001');
    const p2 = (await acc.get(`/api/proposals/${oc1001.proposal_id}`)).body;
    assert.equal(p2.blocking, false, JSON.stringify(p2.validation.issues));
    assert.equal(p2.data.number, 'OC-2026-15');
    assert.equal(p2.validation.computed.gross, '63.16');
    assert.ok(p2.data.lines.some((l) => /Nuolaida/.test(l.description)));
    const a2 = await acc.post(`/api/proposals/${p2.id}/approve`, {contentHash: p2.content_hash});
    assert.equal(a2.status, 200, JSON.stringify(a2.body));
    assert.equal(a2.body.number, 'OC-2026-15');
  }
  // A re-sync after posting never issues a second invoice.
  await sync(saleorStore.id, 'reconcile');
  assert.equal((await t.app.pool.query(`SELECT count(*) FROM invoices i JOIN external_orders o ON o.id=i.external_order_id WHERE o.order_number='1001'`)).rows[0].count, hasPhp ? '2' : '1');
  // Switching invoice mode after posting requires explicit confirmation.
  assert.equal((await admin.put(`/api/stores/${saleorStore.id}`, {invoice_mode: 'import_external'})).status, 409);
});

test('webhooks: authenticity required; duplicates ignored; out-of-order delivery cannot roll back state', async () => {
  const o = saleorState.find((x) => x.number === '1002');
  assert.equal((await webhook(o, {badSig: true})).status, 401);
  // Order becomes fulfilled → webhook (fetches the current state from the API).
  saleorState = saleorState.map((x) => (x.number === '1002' ? {...x, status: 'FULFILLED', updatedAt: '2026-09-26T09:00:00Z', fulfillments: [{created: '2026-09-26T08:00:00Z'}]} : x));
  const fresh = saleorState.find((x) => x.number === '1002');
  const r1 = await webhook(fresh);
  assert.equal(r1.status, 200);
  const r2 = await webhook(fresh);
  assert.equal((await r2.json()).duplicate, true);
  await t.drain();
  assert.equal((await orders(saleorStore.id)).find((x) => x.order_number === '1002').state, 'proposed');
  // A delayed, older event arrives later: ignored as stale (API currently unavailable for this id → payload used).
  const old = {...o, id: o.id, status: 'UNCONFIRMED', updatedAt: '2026-09-21T10:04:00Z'};
  const savedState = saleorState;
  saleorState = saleorState.filter((x) => x.number !== '1002');
  await webhook(old, {event: 'order_created'});
  await t.drain();
  saleorState = savedState;
  const row = (await t.app.pool.query(`SELECT state, external_status FROM external_orders WHERE store_id=$1 AND order_number='1002'`, [saleorStore.id])).rows[0];
  assert.deepEqual([row.state, row.external_status], ['proposed', 'FULFILLED']);
  assert.ok((await t.app.pool.query(`SELECT 1 FROM external_order_versions WHERE source LIKE '%:stale'`)).rowCount);
});

test('12b. a refund after posting creates a linked credit-note proposal; the posted invoice never changes', async () => {
  const before = (await t.app.pool.query(`SELECT i.* FROM invoices i JOIN external_orders o ON o.id=i.external_order_id WHERE o.store_id=$1 AND o.order_number='1001'`, [saleorStore.id])).rows[0];
  saleorState = saleorState.map((x) => (x.number === '1001' ? {...x, updatedAt: '2026-09-28T10:00:00Z', grantedRefunds: [{id: 'R3JhbnRlZFJlZnVuZDox', createdAt: '2026-09-28T10:00:00Z', status: 'SUCCESS', shippingCostsIncluded: false, amount: {amount: 12.1, currency: 'EUR'}, lines: [{quantity: 1, orderLine: {id: 'T3JkZXJMaW5lOjE=', productSku: 'MUG-1', productName: 'Keramikinis puodelis'}}]}]} : x));
  await webhook(saleorState.find((x) => x.number === '1001'), {event: 'order_refunded'});
  await t.drain();
  const ord = (await orders(saleorStore.id)).find((x) => x.order_number === '1001');
  assert.equal(ord.state, 'needs_review');
  const refund = (await t.app.pool.query(`SELECT * FROM external_refunds WHERE store_id=$1`, [saleorStore.id])).rows[0];
  const p = (await acc.get(`/api/proposals/${refund.proposal_id}`)).body;
  assert.equal(p.data.docType, 'credit_note');
  assert.equal(p.data.relatedInvoiceId, String(before.id));
  assert.equal(p.validation.computed.gross, '-12.10');
  assert.equal(p.blocking, false, JSON.stringify(p.validation.issues));
  const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const after = (await t.app.pool.query('SELECT * FROM invoices WHERE id=$1', [before.id])).rows[0];
  assert.equal(after.gross_total, before.gross_total);
  const inv = (await acc.get(`/api/invoices/${before.id}`)).body;
  assert.equal(inv.balance.gross, '18.15');
  // The same refund delivered again creates nothing new.
  await webhook({...saleorState.find((x) => x.number === '1001'), updatedAt: '2026-09-28T10:00:01Z'});
  await t.drain();
  assert.equal((await t.app.pool.query(`SELECT count(*) FROM external_refunds`)).rows[0].count, '1');
  // A non-refund change after posting is flagged, not applied.
  saleorState = saleorState.map((x) => (x.number === '1001' ? {...x, updatedAt: '2026-09-29T10:00:00Z', lines: x.lines.map((l) => ({...l, quantity: 3}))} : x));
  await webhook(saleorState.find((x) => x.number === '1001'));
  await t.drain();
  assert.equal((await orders(saleorStore.id)).find((x) => x.order_number === '1001').state, 'changed_after_post');
  assert.equal((await t.app.pool.query('SELECT gross_total FROM invoices WHERE id=$1', [before.id])).rows[0].gross_total, before.gross_total);
});

test('rate limiting (429) is retried by the durable job and the import resumes', async () => {
  saleorState.push({...saleorOrders[0], id: 'T3JkZXI6ZWVl', number: '1005', updatedAt: new Date().toISOString()});
  fail429 = 1;
  const r = await acc.post(`/api/stores/${saleorStore.id}/sync`, {kind: 'incremental'});
  await t.drain();
  const job = (await t.app.pool.query('SELECT * FROM jobs WHERE id=$1', [r.body.id])).rows[0];
  assert.equal(job.status, 'queued');
  assert.match(job.last_error, /429/);
  await t.app.pool.query(`UPDATE jobs SET run_at=now() WHERE id=$1`, [job.id]);
  await t.drain();
  assert.equal((await t.app.pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status, 'done');
  assert.ok((await orders(saleorStore.id)).some((x) => x.order_number === '1005'));
  const stores = (await acc.get('/api/stores')).body;
  assert.equal(stores.find((s) => s.id === saleorStore.id).last_error, null);
});

test('OpenCart extension rejects bad signatures and stale timestamps (real PHP code)', {skip: !hasPhp && 'php not installed'}, async () => {
  const {signOpenCart} = await import('../src/integrations/opencart.mjs');
  const ts = String(Math.floor(Date.now() / 1000));
  const q = 'since=1970-01-01%2000%3A00%3A00&after_id=0&limit=1';
  const url = `${ocUrl}/index.php?route=extension/apskaita_export/other/apskaita_export&${q}`;
  const good = await fetch(url, {headers: {'x-apskaita-timestamp': ts, 'x-apskaita-signature': signOpenCart(OC_KEY, ts, '1970-01-01 00:00:00', '0', '1')}});
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.equal(body.orders.length, 1);
  assert.equal(body.has_more, true);
  const bad = await fetch(url, {headers: {'x-apskaita-timestamp': ts, 'x-apskaita-signature': signOpenCart('wrong-key-wrong-key-wrong-key-123', ts, '1970-01-01 00:00:00', '0', '1')}});
  assert.equal(bad.status, 401);
  const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
  const stale = await fetch(url, {headers: {'x-apskaita-timestamp': oldTs, 'x-apskaita-signature': signOpenCart(OC_KEY, oldTs, '1970-01-01 00:00:00', '0', '1')}});
  assert.equal(stale.status, 401);
});

test('demo connections are explicitly labelled and use committed fixtures', async () => {
  const demo = (await admin.post('/api/stores', {platform: 'saleor', name: 'DEMO Saleor', base_url: 'https://demo.invalid', is_demo: true})).body;
  assert.equal(demo.is_demo, true);
  await sync(demo.id);
  const o = await orders(demo.id);
  assert.equal(o.length, 4);
  assert.ok(o.every((x) => x.is_demo));
  const p = (await acc.get(`/api/proposals/${o.find((x) => x.order_number === '1001').proposal_id}`)).body;
  assert.ok(p.data.extractionNotes.some((n) => /DEMONSTRACINĖ/.test(n)));
  const test1 = await admin.post(`/api/stores/${demo.id}/test`);
  assert.equal(test1.body.demo, true);
});
