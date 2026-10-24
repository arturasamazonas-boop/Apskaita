// Periodic enqueueing (store reconciliation). Idempotency keys make concurrent schedulers harmless.
import {enqueue} from './jobs.mjs';
import {fetchRatesForDate} from './fx/rates.mjs';
import {generateRecurring} from './sales/recurring.mjs';

export function startScheduler(pool, {intervalMs = 15 * 60 * 1000, fxUrl = ''} = {}) {
  let fxDay = '';
  const tick = async () => {
    try {
      const stores = (await pool.query(`SELECT id FROM stores WHERE active`)).rows;
      const slot = Math.floor(Date.now() / intervalMs);
      for (const s of stores) await enqueue(pool, 'store_sync', {storeId: s.id, kind: 'incremental'}, {idempotencyKey: `sync:${s.id}:${slot}`});
      const daily = Math.floor(Date.now() / 86400000);
      for (const s of stores) await enqueue(pool, 'store_sync', {storeId: s.id, kind: 'reconcile'}, {idempotencyKey: `reconcile:${s.id}:${daily}`});
    } catch (e) { console.error('[scheduler]', e.message); }
    // Exchange rates: once a day after 17:00 Vilnius time (ECB/LB publish around 16:00 CET).
    try {
      const now = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Vilnius', dateStyle: 'short', timeStyle: 'short'}).format(new Date());
      const [day, time] = now.split(' ');
      if (fxUrl && day !== fxDay && time >= '17:00') { await fetchRatesForDate(pool, fxUrl, day); fxDay = day; }
    } catch (e) { console.error('[scheduler] fx', e.message); }
  };
  // Recurring invoices: drafts for templates due today, once a day from 06:00 Vilnius time (drafts still need approval).
  let recurringDay = '';
  const recurring = async () => {
    try {
      const [day, time] = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Vilnius', dateStyle: 'short', timeStyle: 'short'}).format(new Date()).split(' ');
      if (day !== recurringDay && time >= '06:00') { await generateRecurring(pool, {id: null, role: 'system'}, {asOf: day}); recurringDay = day; }
    } catch (e) { console.error('[scheduler] recurring', e.message); }
  };
  const tickAll = async () => { await tick(); await recurring(); };
  const t = setInterval(tickAll, intervalMs);
  t.unref();
  setTimeout(tickAll, 5000).unref();
  return () => clearInterval(t);
}
