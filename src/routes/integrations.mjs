// Store connections, sync status/controls, imported orders and webhook intake.
import crypto from 'node:crypto';
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {readJson, send} from '../http.mjs';
import {audit} from '../audit.mjs';
import {enqueue} from '../jobs.mjs';
import {encryptSecret} from '../lib/secrets.mjs';
import {adapterFor} from '../integrations/sync.mjs';
import {DEFAULT_STATUS_MAPPING} from '../integrations/common.mjs';

const publicStore = (s) => ({...s, secret_encrypted: undefined, has_secret: !!s.secret_encrypted});

export function register(r, deps) {
  const {pool, config} = deps;
  r.get('/api/stores', async ({user}) => {
    requireCap(user, 'read');
    const rows = (await pool.query(`SELECT s.*,
        (SELECT count(*) FROM external_orders o WHERE o.store_id=s.id) AS orders,
        (SELECT count(*) FROM external_orders o WHERE o.store_id=s.id AND o.state IN ('needs_review','changed_after_post')) AS needs_review,
        (SELECT count(*) FROM external_orders o WHERE o.store_id=s.id AND o.state='posted') AS posted,
        (SELECT count(*) FROM jobs j WHERE j.type='store_sync' AND j.payload->>'storeId' = s.id::text AND j.status='dead') AS failed_jobs,
        (SELECT row_to_json(x) FROM (SELECT * FROM sync_runs WHERE store_id=s.id ORDER BY id DESC LIMIT 1) x) AS last_run
      FROM stores s ORDER BY s.id`)).rows;
    return rows.map(publicStore);
  });
  r.get('/api/stores/defaults', async () => ({statusMapping: DEFAULT_STATUS_MAPPING}));
  r.post('/api/stores', async ({req, user}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    if (!['saleor', 'opencart'].includes(b.platform)) throw new AppError(400, 'platform', 'Pasirinkite Saleor arba OpenCart.');
    let url;
    try { url = new URL(b.base_url); } catch { throw new AppError(400, 'url', 'Netinkamas parduotuvės adresas.'); }
    if (!b.is_demo && url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new AppError(400, 'https', 'Parduotuvės API turi naudoti HTTPS.');
    const secrets = {apiToken: b.apiToken || undefined, webhookSecret: b.webhookSecret || undefined, apiKey: b.apiKey || undefined};
    const row = (await pool.query(`INSERT INTO stores(platform, name, base_url, config, secret_encrypted, invoice_mode, status_mapping, is_demo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.platform, String(b.name || url.host).slice(0, 100), url.toString().replace(/\/+$/, ''), b.config || {}, encryptSecret(config.secretKey, JSON.stringify(secrets)),
        b.invoice_mode === 'import_external' ? 'import_external' : 'issue_here', b.status_mapping || {}, !!b.is_demo])).rows[0];
    await audit(pool, {userId: user.id, action: 'store.create', entityType: 'store', entityId: row.id, details: {platform: row.platform, url: row.base_url, demo: row.is_demo, invoiceMode: row.invoice_mode}});
    return publicStore(row);
  });
  r.put('/api/stores/:id', async ({req, user, params}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    return tx(pool, async (db) => {
      const cur = (await db.query('SELECT * FROM stores WHERE id=$1 FOR UPDATE', [params.id])).rows[0];
      if (!cur) throw new AppError(404, 'not_found', 'Parduotuvė nerasta.');
      if (b.invoice_mode && b.invoice_mode !== cur.invoice_mode) {
        const posted = (await db.query(`SELECT 1 FROM invoices WHERE store_id=$1 LIMIT 1`, [cur.id])).rowCount;
        if (posted && !b.confirmModeChange) throw new AppError(409, 'mode_change', 'Šiai parduotuvei jau užregistruota sąskaitų. Sąskaitų išrašymo būdo keitimas gali sukelti dvigubą išrašymą – patvirtinkite sąmoningai.');
      }
      let secret = cur.secret_encrypted;
      if (b.apiToken || b.webhookSecret || b.apiKey) secret = encryptSecret(config.secretKey, JSON.stringify({apiToken: b.apiToken || undefined, webhookSecret: b.webhookSecret || undefined, apiKey: b.apiKey || undefined}));
      const row = (await db.query(`UPDATE stores SET name=COALESCE($2,name), config=COALESCE($3,config), invoice_mode=COALESCE($4,invoice_mode), status_mapping=COALESCE($5,status_mapping), active=COALESCE($6,active), secret_encrypted=$7 WHERE id=$1 RETURNING *`,
        [cur.id, b.name || null, b.config || null, b.invoice_mode || null, b.status_mapping || null, typeof b.active === 'boolean' ? b.active : null, secret])).rows[0];
      await audit(db, {userId: user.id, action: 'store.update', entityType: 'store', entityId: cur.id, details: {invoiceMode: b.invoice_mode, statusMapping: b.status_mapping, secretChanged: secret !== cur.secret_encrypted}});
      return publicStore(row);
    });
  });
  r.post('/api/stores/:id/sync', async ({req, user, params}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    const kind = ['initial', 'incremental', 'reconcile'].includes(b.kind) ? b.kind : 'incremental';
    const j = await enqueue(pool, 'store_sync', {storeId: String(params.id), kind}, {idempotencyKey: `manual-sync:${params.id}:${kind}:${Math.floor(Date.now() / 10000)}`});
    await audit(pool, {userId: user.id, action: 'store.sync_requested', entityType: 'store', entityId: params.id, details: {kind, jobId: j.id}});
    return j;
  });
  r.post('/api/stores/:id/test', async ({user, params}) => {
    requireCap(user, 'settings');
    const store = (await pool.query('SELECT * FROM stores WHERE id=$1', [params.id])).rows[0];
    if (!store) throw new AppError(404, 'not_found', 'Parduotuvė nerasta.');
    try {
      const page = await adapterFor(store, config).fetchOrdersPage({pageSize: 1});
      return {ok: true, sample: page.orders.length, demo: !!store.is_demo};
    } catch (e) { return {ok: false, error: e.message}; }
  });
  r.get('/api/stores/:id/runs', async ({user, params}) => { requireCap(user, 'read'); return (await pool.query('SELECT * FROM sync_runs WHERE store_id=$1 ORDER BY id DESC LIMIT 50', [params.id])).rows; });
  r.get('/api/orders', async ({user, query}) => {
    requireCap(user, 'read');
    const limit = Math.min(Number(query.limit) || 50, 200), offset = Math.max(Number(query.offset) || 0, 0);
    const rows = (await pool.query(`SELECT o.id, o.store_id, s.name AS store_name, s.is_demo, o.external_id, o.order_number, o.external_status, o.currency, o.state, o.state_note, o.invoice_id,
        o.external_updated_at, o.data->'totals'->>'gross' AS gross, o.data->'customer'->>'name' AS customer, p.id AS proposal_id, p.blocking
      FROM external_orders o JOIN stores s ON s.id=o.store_id LEFT JOIN proposals p ON p.external_order_id=o.id AND p.status='open'
      WHERE ($1='' OR o.store_id::text=$1) AND ($2='' OR o.state=$2) AND ($3='' OR o.order_number ILIKE $3||'%')
      ORDER BY o.updated_at DESC, o.id DESC LIMIT ${limit + 1} OFFSET ${offset}`, [String(query.store || ''), String(query.state || ''), String(query.q || '')])).rows;
    return {items: rows.slice(0, limit), hasMore: rows.length > limit};
  });
  r.get('/api/orders/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const o = (await pool.query(`SELECT o.*, s.name AS store_name, s.is_demo, s.invoice_mode FROM external_orders o JOIN stores s ON s.id=o.store_id WHERE o.id=$1`, [params.id])).rows[0];
    if (!o) throw new AppError(404, 'not_found', 'Užsakymas nerastas.');
    const versions = (await pool.query('SELECT id, data_hash, external_updated_at, received_at, source FROM external_order_versions WHERE external_order_id=$1 ORDER BY id DESC', [o.id])).rows;
    const proposals = (await pool.query('SELECT id, kind, version, status, blocking, created_at FROM proposals WHERE external_order_id=$1 ORDER BY id DESC', [o.id])).rows;
    const refunds = (await pool.query('SELECT * FROM external_refunds WHERE external_order_id=$1 ORDER BY id', [o.id])).rows;
    const invoices = (await pool.query('SELECT id, doc_type, series, number, gross_total FROM invoices WHERE external_order_id=$1 OR id=$2 ORDER BY id', [o.id, o.invoice_id || 0])).rows;
    return {...o, versions, proposals, refunds, invoices};
  });

  // Webhook intake (public, authenticated by signature). Stored first, processed by a durable job.
  r.post('/api/webhooks/:platform/:storeId', async ({req, res, params}) => {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) throw new AppError(413, 'too_large', 'Per didelis.'); chunks.push(c); }
    const raw = Buffer.concat(chunks);
    const store = (await pool.query('SELECT * FROM stores WHERE id=$1 AND platform=$2 AND active', [params.storeId, params.platform])).rows[0];
    if (!store) { send(res, 404, {error: 'not found'}); return; }
    const v = await adapterFor(store, config).verifyWebhook(req.headers, raw);
    if (!v.ok) {
      await audit(pool, {actor: 'webhook', action: 'webhook.rejected', entityType: 'store', entityId: store.id, details: {reason: v.reason}});
      send(res, 401, {error: 'signature'});
      return;
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { send(res, 400, {error: 'json'}); return; }
    const key = crypto.createHash('sha256').update(`${v.event}|`).update(raw).digest('hex');
    const ins = await pool.query(`INSERT INTO webhook_events(store_id, event_key, event_type, verified, payload) VALUES ($1,$2,$3,true,$4) ON CONFLICT (store_id, event_key) DO NOTHING RETURNING id`, [store.id, key, v.event || 'UNKNOWN', payload]);
    if (ins.rows[0]) await enqueue(pool, 'webhook_event', {eventId: ins.rows[0].id}, {idempotencyKey: `webhook:${ins.rows[0].id}`});
    send(res, 200, {ok: true, duplicate: !ins.rows[0]});
  }, {public: true});
}
