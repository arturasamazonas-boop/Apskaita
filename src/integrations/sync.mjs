// Durable, resumable store synchronization and webhook processing.
import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT} from '../config.mjs';
import {tx} from '../db.mjs';
import {audit} from '../audit.mjs';
import {storeSecrets} from '../lib/secrets.mjs';
import {createSaleorAdapter, normalizeSaleorOrder} from './saleor.mjs';
import {createOpenCartAdapter, normalizeOpenCartOrder} from './opencart.mjs';
import {ingestOrder} from './common.mjs';

/** Demo adapter: reads committed fixture files. Used only for stores explicitly marked is_demo. */
function createDemoAdapter(store) {
  const file = path.join(ROOT, 'fixtures', 'stores', store.platform === 'saleor' ? 'saleor-orders.json' : 'opencart-orders.json');
  return {
    platform: store.platform, demo: true,
    async fetchOrdersPage({cursor = null, pageSize = 2}) {
      const all = JSON.parse(await fs.readFile(file, 'utf8'));
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + pageSize);
      const norm = page.map((o) => (store.platform === 'saleor' ? normalizeSaleorOrder(o) : normalizeOpenCartOrder(o)));
      return {orders: norm, nextCursor: String(start + page.length), done: start + page.length >= all.length};
    },
    async fetchOrder() { return null; },
    async verifyWebhook() { return {ok: false, reason: 'Demonstracinė parduotuvė webhookų nepriima.'}; },
    orderFromWebhook() { return null; },
  };
}

export function adapterFor(store, config, opts = {}) {
  if (store.is_demo) return createDemoAdapter(store);
  const secrets = storeSecrets(config, store);
  return store.platform === 'saleor' ? createSaleorAdapter(store, secrets, opts) : createOpenCartAdapter(store, secrets, opts);
}

/** One sync job: fetches pages, ingests each order in its own transaction, persists the cursor after each page. */
export async function runStoreSync({pool, config}, {storeId, kind = 'incremental', runId = null}, opts = {}) {
  const store = (await pool.query('SELECT * FROM stores WHERE id=$1', [storeId])).rows[0];
  if (!store || !store.active) return {skipped: true};
  const adapter = opts.adapter || adapterFor(store, config, opts);
  let run = runId ? (await pool.query('SELECT * FROM sync_runs WHERE id=$1', [runId])).rows[0] : (await pool.query(`SELECT * FROM sync_runs WHERE store_id=$1 AND kind=$2 AND status='running' ORDER BY id DESC LIMIT 1`, [store.id, kind])).rows[0];
  // Saleor: relay cursor is per run (query args fixed by `since`); OpenCart/demo: keyset cursor continues from the store.
  const keyset = store.platform === 'opencart' || adapter.demo;
  if (!run) run = (await pool.query(`INSERT INTO sync_runs(store_id, kind, cursor) VALUES ($1,$2,$3) RETURNING *`, [store.id, kind, keyset && kind === 'incremental' ? store.sync_cursor : null])).rows[0];
  const since = store.platform === 'saleor' && kind === 'incremental' && store.last_sync_at ? new Date(new Date(store.last_sync_at).getTime() - 10 * 60000).toISOString() : '1970-01-01T00:00:00Z';
  let cursor = run.cursor;
  const counts = {fetched: run.fetched, created: run.created, updated: run.updated, unchanged: run.unchanged, errors: run.errors};
  try {
    for (let pages = 0; pages < (opts.maxPages || 1000); pages++) {
      const page = await adapter.fetchOrdersPage({cursor, since, pageSize: opts.pageSize});
      for (const order of page.orders) {
        counts.fetched++;
        try {
          const r = await tx(pool, (db) => ingestOrder(db, store, order, `${kind}${adapter.demo ? ':demo' : ''}`));
          if (r.result === 'created') counts.created++; else if (r.result === 'updated') counts.updated++; else if (r.result === 'invalid') counts.errors++; else counts.unchanged++;
        } catch (e) { counts.errors++; await pool.query('UPDATE sync_runs SET last_error=$2 WHERE id=$1', [run.id, `Užsakymas ${order.number}: ${e.message}`.slice(0, 500)]); }
      }
      cursor = page.nextCursor;
      await pool.query(`UPDATE sync_runs SET cursor=$2, fetched=$3, created=$4, updated=$5, unchanged=$6, errors=$7 WHERE id=$1`, [run.id, cursor, counts.fetched, counts.created, counts.updated, counts.unchanged, counts.errors]);
      if (keyset && kind !== 'reconcile') await pool.query('UPDATE stores SET sync_cursor=$2 WHERE id=$1', [store.id, cursor]);
      if (page.done) break;
    }
    await pool.query(`UPDATE sync_runs SET status='done', finished_at=now() WHERE id=$1`, [run.id]);
    await pool.query(`UPDATE stores SET last_sync_at=now(), last_error=NULL WHERE id=$1`, [store.id]);
    return {runId: run.id, ...counts};
  } catch (e) {
    // Cursor is persisted: the retried job resumes from the last completed page.
    await pool.query(`UPDATE sync_runs SET last_error=$2 WHERE id=$1`, [run.id, String(e.message).slice(0, 500)]);
    await pool.query(`UPDATE stores SET last_error=$2 WHERE id=$1`, [store.id, String(e.message).slice(0, 500)]);
    if (e.permanent) await pool.query(`UPDATE sync_runs SET status='failed', finished_at=now() WHERE id=$1`, [run.id]);
    throw e;
  }
}

export async function processWebhookEvent({pool, config}, {eventId}, opts = {}) {
  const ev = (await pool.query('SELECT * FROM webhook_events WHERE id=$1', [eventId])).rows[0];
  if (!ev || ev.processed_at || !ev.verified) return {skipped: true};
  const store = (await pool.query('SELECT * FROM stores WHERE id=$1', [ev.store_id])).rows[0];
  const adapter = opts.adapter || adapterFor(store, config, opts);
  const ref = adapter.orderFromWebhook(ev.payload);
  if (!ref) { await pool.query(`UPDATE webhook_events SET processed_at=now(), error='Užsakymas nerastas įvykyje' WHERE id=$1`, [ev.id]); return {skipped: true}; }
  // Prefer the current state from the API (handles delayed/out-of-order deliveries); fall back to the signed payload.
  let order = null;
  try { order = await adapter.fetchOrder(ref.externalId); } catch (e) { if (!ref.order) throw e; }
  order = order || ref.order;
  const r = await tx(pool, (db) => ingestOrder(db, store, order, `webhook:${ev.event_type}`));
  await pool.query(`UPDATE webhook_events SET processed_at=now(), error=NULL WHERE id=$1`, [ev.id]);
  return r;
}

export function integrationJobHandlers(deps) {
  return {
    store_sync: (p) => runStoreSync(deps, p),
    webhook_event: (p) => processWebhookEvent(deps, p),
  };
}

export {audit};
