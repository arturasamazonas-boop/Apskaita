// Periodic enqueueing (store reconciliation). Idempotency keys make concurrent schedulers harmless.
import {enqueue} from './jobs.mjs';

export function startScheduler(pool, {intervalMs = 15 * 60 * 1000} = {}) {
  const tick = async () => {
    try {
      const stores = (await pool.query(`SELECT id FROM stores WHERE active`)).rows;
      const slot = Math.floor(Date.now() / intervalMs);
      for (const s of stores) await enqueue(pool, 'store_sync', {storeId: s.id, kind: 'incremental'}, {idempotencyKey: `sync:${s.id}:${slot}`});
      const daily = Math.floor(Date.now() / 86400000);
      for (const s of stores) await enqueue(pool, 'store_sync', {storeId: s.id, kind: 'reconcile'}, {idempotencyKey: `reconcile:${s.id}:${daily}`});
    } catch (e) { console.error('[scheduler]', e.message); }
  };
  const t = setInterval(tick, intervalMs);
  t.unref();
  setTimeout(tick, 5000).unref();
  return () => clearInterval(t);
}
