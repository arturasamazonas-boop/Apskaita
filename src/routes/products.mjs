// Prekės: product cards, stock balances and movements (quantities from posted invoices + manual movements).
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {readJson} from '../http.mjs';
import {audit} from '../audit.mjs';

const s = (v, n = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().replace(',', '.'));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const page = (q) => ({limit: Math.min(Math.max(Number(q.limit) || 50, 1), 500), offset: Math.max(Number(q.offset) || 0, 0)});

// Stock per product up to a date, with weighted average cost of incoming quantities (purchases and openings).
const STOCK_SQL = `
  SELECT product_id, sum(quantity) AS stock,
         CASE WHEN sum(quantity) FILTER (WHERE quantity > 0 AND kind IN ('purchase','opening','adjustment') AND unit_price IS NOT NULL) > 0
              THEN round(sum(quantity * unit_price) FILTER (WHERE quantity > 0 AND kind IN ('purchase','opening','adjustment') AND unit_price IS NOT NULL) / sum(quantity) FILTER (WHERE quantity > 0 AND kind IN ('purchase','opening','adjustment') AND unit_price IS NOT NULL), 4) END AS avg_cost,
         max(move_date) AS last_move
    FROM stock_moves WHERE move_date <= $1 AND kind IN ('purchase','sale','opening','adjustment','writeoff')
   GROUP BY product_id`;

const FIELDS = {
  sku: (v) => s(v, 60), name: (v) => s(v), kind: (v) => (v === 'service' ? 'service' : 'goods'), unit: (v) => s(v || 'vnt.', 20), tax_code: (v) => s(v || 'PVM1', 10),
  unit_price: num, purchase_price: num, revenue_account: (v) => s(v, 8) || null, expense_account: (v) => s(v, 8) || null, active: (v) => v !== false && v !== 'false',
  barcode: (v) => s(v, 40), group_name: (v) => s(v, 80), manufacturer: (v) => s(v, 120), supplier_id: (v) => (v ? String(v) : null), supplier_sku: (v) => s(v, 60),
  origin_country: (v) => s(v, 2).toUpperCase(), cn_code: (v) => s(v, 12).replace(/\s/g, ''), weight_kg: num, min_stock: num, location: (v) => s(v, 60),
  description: (v) => s(v, 2000), notes: (v) => s(v, 2000), track_stock: (v) => v === true || v === 'true',
};

export function register(r, {pool}) {
  r.get('/api/products', async ({user, query}) => {
    requireCap(user, 'read');
    const {limit, offset} = page(query);
    const q = s(query.q, 100);
    const rows = (await pool.query(`WITH st AS (${STOCK_SQL})
      SELECT p.*, st.stock, st.avg_cost, c.name AS supplier_name,
        (SELECT json_agg(json_build_object('storeId', x.store_id, 'externalId', x.external_id, 'externalSku', x.external_sku)) FROM product_external_refs x WHERE x.product_id=p.id) AS external_refs
      FROM products p LEFT JOIN st ON st.product_id=p.id LEFT JOIN counterparties c ON c.id=p.supplier_id
      WHERE ($2='' OR p.name ILIKE '%'||$2||'%' OR p.sku ILIKE $2||'%' OR p.barcode=$2)
        AND ($3='' OR p.group_name=$3) AND ($4='' OR p.kind=$4) AND ($5 <> 'true' OR p.active)
        AND ($6 <> 'true' OR (p.track_stock AND p.min_stock IS NOT NULL AND coalesce(st.stock,0) < p.min_stock))
      ORDER BY p.name, p.id LIMIT ${limit + 1} OFFSET ${offset}`,
    [query.asOf && isDate(query.asOf) ? query.asOf : '9999-12-31', q, s(query.group, 80), ['goods', 'service'].includes(query.kind) ? query.kind : '', query.active || '', query.low || ''])).rows;
    return {items: rows.slice(0, limit), hasMore: rows.length > limit};
  });
  r.get('/api/products/groups', async ({user}) => {
    requireCap(user, 'read');
    return (await pool.query(`SELECT group_name, count(*)::int AS count FROM products WHERE group_name <> '' GROUP BY group_name ORDER BY group_name`)).rows;
  });
  r.get('/api/products/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const p = (await pool.query(`WITH st AS (${STOCK_SQL}) SELECT p.*, st.stock, st.avg_cost, st.last_move, c.name AS supplier_name,
        (SELECT json_agg(json_build_object('storeId', x.store_id, 'externalId', x.external_id, 'externalSku', x.external_sku)) FROM product_external_refs x WHERE x.product_id=p.id) AS external_refs
      FROM products p LEFT JOIN st ON st.product_id=p.id LEFT JOIN counterparties c ON c.id=p.supplier_id WHERE p.id=$2`, ['9999-12-31', params.id])).rows[0];
    if (!p) throw new AppError(404, 'not_found', 'Prekė nerasta.');
    const totals = (await pool.query(`SELECT coalesce(sum(quantity) FILTER (WHERE kind='purchase'),0) AS purchased, coalesce(-sum(quantity) FILTER (WHERE kind='sale'),0) AS sold,
      coalesce(sum(quantity) FILTER (WHERE kind IN ('opening','adjustment','writeoff')),0) AS manual FROM stock_moves WHERE product_id=$1`, [params.id])).rows[0];
    return {...p, totals};
  });
  r.post('/api/products', async ({req, user}) => { requireCap(user, 'write'); return saveProduct(pool, user, null, await readJson(req)); });
  r.put('/api/products/:id', async ({req, user, params}) => { requireCap(user, 'write'); return saveProduct(pool, user, params.id, await readJson(req)); });
  r.post('/api/products/:id/external-refs', async ({req, user, params}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    const row = (await pool.query(`INSERT INTO product_external_refs(store_id, external_id, product_id, external_sku) VALUES ($1,$2,$3,$4)
      ON CONFLICT (store_id, external_id) DO UPDATE SET product_id=EXCLUDED.product_id, external_sku=EXCLUDED.external_sku RETURNING *`, [b.storeId, s(b.externalId, 100), params.id, s(b.externalSku, 100)])).rows[0];
    await audit(pool, {userId: user.id, action: 'product.external_ref', entityType: 'product', entityId: params.id, details: row});
    return row;
  });

  // ---------------------------------------------------------------- stock
  r.get('/api/stock', async ({user, query}) => {
    requireCap(user, 'read');
    const asOf = isDate(query.asOf) ? query.asOf : new Date().toISOString().slice(0, 10);
    const rows = (await pool.query(`WITH st AS (${STOCK_SQL})
      SELECT p.id, p.sku, p.name, p.unit, p.group_name, p.location, p.min_stock, coalesce(st.stock,0) AS stock, st.avg_cost,
             round(coalesce(st.stock,0) * coalesce(st.avg_cost, p.purchase_price, 0), 2) AS value, st.last_move,
             (p.min_stock IS NOT NULL AND coalesce(st.stock,0) < p.min_stock) AS below_min
        FROM products p LEFT JOIN st ON st.product_id=p.id
       WHERE p.track_stock AND ($2='' OR p.group_name=$2) AND ($3 <> 'true' OR coalesce(st.stock,0) <> 0)
       ORDER BY p.group_name, p.name`, [asOf, s(query.group, 80), query.nonzero || ''])).rows;
    const total = rows.reduce((a, x) => a + Number(x.value || 0), 0);
    return {asOf, items: rows, totalValue: total.toFixed(2)};
  });
  r.get('/api/stock/moves', async ({user, query}) => {
    requireCap(user, 'read');
    const from = isDate(query.from) ? query.from : '1900-01-01', to = isDate(query.to) ? query.to : '9999-12-31';
    const {limit, offset} = page(query);
    const rows = (await pool.query(`SELECT m.*, p.sku, p.name AS product_name, p.unit,
        sum(m.quantity) OVER (PARTITION BY m.product_id ORDER BY m.move_date, m.source_type, m.source_id ROWS UNBOUNDED PRECEDING)
          + coalesce((SELECT sum(quantity) FROM stock_moves o WHERE o.product_id=m.product_id AND o.move_date < $1), 0) AS balance
      FROM stock_moves m JOIN products p ON p.id=m.product_id
      WHERE m.move_date BETWEEN $1 AND $2 AND ($3='' OR m.product_id::text=$3)
      ORDER BY p.name, m.move_date, m.source_type, m.source_id LIMIT ${limit + 1} OFFSET ${offset}`, [from, to, s(query.product, 20)])).rows;
    return {items: rows.slice(0, limit), hasMore: rows.length > limit};
  });
  r.post('/api/stock/movements', async ({req, user}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    if (!['opening', 'adjustment', 'writeoff'].includes(b.kind)) throw new AppError(400, 'kind', 'Netinkamas judėjimo tipas.');
    if (!isDate(b.date)) throw new AppError(400, 'date', 'Nurodykite datą.');
    let qty = Number(num(b.quantity));
    if (!Number.isFinite(qty) || qty === 0) throw new AppError(400, 'quantity', 'Nurodykite kiekį (ne nulį).');
    if (b.kind === 'writeoff') qty = -Math.abs(qty);
    if (b.kind === 'writeoff' && !s(b.note)) throw new AppError(400, 'note', 'Nurašymui nurodykite priežastį.');
    return tx(pool, async (db) => {
      const p = (await db.query('SELECT id, track_stock FROM products WHERE id=$1', [b.productId])).rows[0];
      if (!p) throw new AppError(404, 'not_found', 'Prekė nerasta.');
      if (!p.track_stock) throw new AppError(400, 'no_stock', 'Šiai prekei likučiai neskaičiuojami (paslauga).');
      const row = (await db.query(`INSERT INTO stock_movements(product_id, movement_date, kind, quantity, unit_cost, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [p.id, b.date, b.kind, String(qty), num(b.unitCost), s(b.note, 500), user.id])).rows[0];
      await audit(db, {userId: user.id, action: `stock.${b.kind}`, entityType: 'product', entityId: p.id, details: {quantity: row.quantity, date: row.movement_date, note: row.note}});
      return row;
    });
  });
}

async function saveProduct(pool, user, id, b) {
  const v = Object.fromEntries(Object.entries(FIELDS).filter(([k]) => k in b || !id).map(([k, f]) => [k, f(b[k])]));
  if (!id && !('track_stock' in b)) v.track_stock = v.kind === 'goods';
  if ('name' in v && !v.name) throw new AppError(400, 'name', 'Nurodykite pavadinimą.');
  for (const k of ['unit_price', 'purchase_price', 'weight_kg', 'min_stock']) if (v[k] !== null && v[k] !== undefined && !/^-?\d+(\.\d+)?$/.test(v[k])) throw new AppError(400, k, 'Netinkamas skaičius.');
  for (const k of ['revenue_account', 'expense_account']) {
    if (v[k] && !(await pool.query('SELECT 1 FROM accounts WHERE code=$1 AND active AND postable', [v[k]])).rowCount) throw new AppError(400, k, `Sąskaita ${v[k]} nerasta arba į ją kontuoti negalima.`);
  }
  if (v.sku && (await pool.query('SELECT 1 FROM products WHERE sku=$1 AND id <> $2', [v.sku, id || 0])).rowCount) throw new AppError(409, 'sku', `Prekė su kodu ${v.sku} jau yra.`);
  const keys = Object.keys(v);
  const row = id
    ? (await pool.query(`UPDATE products SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => v[k])])).rows[0]
    : (await pool.query(`INSERT INTO products(${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, keys.map((k) => v[k]))).rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Prekė nerasta.');
  await audit(pool, {userId: user.id, action: id ? 'product.update' : 'product.create', entityType: 'product', entityId: row.id});
  return row;
}
