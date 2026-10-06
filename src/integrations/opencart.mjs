// OpenCart adapter (targets OpenCart 4.1.x). The built-in catalog API (api/order, api/subscription) cannot
// list or read existing orders, so this adapter talks to the bundled read-only extension
// integrations/opencart/apskaita_export (no core file changes). No webhooks: polling + reconciliation.
import crypto from 'node:crypto';
import {money} from '../lib/money.mjs';
import {rateLimiter, httpJson} from './http-client.mjs';

export function signOpenCart(key, ts, since, afterId, limit) {
  return crypto.createHmac('sha256', key).update(`${ts}\n${since}\n${afterId}\n${limit}`).digest('hex');
}

const r2 = (x) => Math.round(x * 100) / 100;
const rateOf = (tax, base) => (Number(base) ? String(r2((Number(tax) / Number(base)) * 100)) : null);
const snap = (rate, known = [21, 12, 9, 5, 0]) => { if (rate === null) return null; const n = Number(rate); const k = known.find((x) => Math.abs(x - n) <= 0.05); return k === undefined ? rate : String(k); };

/** OpenCart stores local shop time without zone; convert from the shop's IANA zone (default Europe/Vilnius, DST-aware). */
export function toIso(local, tz = 'Europe/Vilnius') {
  if (!local) return null;
  const asUtc = Date.parse(local.replace(' ', 'T') + 'Z');
  const offsetAt = (t) => {
    const name = new Intl.DateTimeFormat('en-US', {timeZone: tz, timeZoneName: 'longOffset'}).formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName').value;
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
  };
  let t = asUtc - offsetAt(asUtc) * 60000;
  t = asUtc - offsetAt(t) * 60000;
  return new Date(t).toISOString();
}

export function normalizeOpenCartOrder(o, {timezone: tzOffset = 'Europe/Vilnius'} = {}) {
  const lines = (o.products || []).map((p) => {
    const rate = snap(rateOf(p.tax, p.price));
    return {externalLineId: String(p.order_product_id), productExternalId: String(p.product_id), sku: p.model || '', name: p.name, quantity: String(p.quantity),
      unitNet: money.norm(String(p.price).replace(/(\.\d{2})\d+$/, '$1')), totalNet: money.norm(String(Number(p.total).toFixed(2))), taxRate: rate, discountNet: '0'};
  });
  const tot = (code) => (o.totals || []).filter((t) => t.code === code).reduce((s, t) => s + Number(t.value), 0);
  const productTax = (o.products || []).reduce((s, p) => s + Number(p.tax) * Number(p.quantity), 0);
  const shippingNet = tot('shipping');
  const taxTotal = tot('tax');
  const rates = [...new Set(lines.map((l) => l.taxRate))];
  const coupon = tot('coupon') + tot('voucher') + tot('reward');
  const shippingTax = r2(taxTotal - productTax - (rates.length === 1 && rates[0] !== null ? coupon * Number(rates[0]) / 100 : 0));
  const shipRate = shippingNet ? snap(rateOf(shippingTax, shippingNet)) : null;
  const net = r2(tot('sub_total') + shippingNet + coupon);
  return {
    externalId: String(o.order_id), number: String(o.order_id), status: o.order_status || String(o.order_status_id), paymentStatus: '', currency: o.currency_code,
    createdAt: toIso(o.date_added, tzOffset), updatedAt: toIso(o.date_modified, tzOffset), fulfilledAt: null,
    customer: {name: o.payment_company || [o.firstname, o.lastname].filter(Boolean).join(' '), email: o.email || '', companyCode: '', vatCode: '',
      address: [o.payment_address_1, o.payment_address_2, o.payment_postcode, o.payment_city].filter(Boolean).join(', '), country: 'LT'},
    lines,
    shipping: shippingNet ? {net: money.norm(shippingNet.toFixed(2)), gross: money.norm((shippingNet + shippingTax).toFixed(2)), taxRate: shipRate} : null,
    orderDiscounts: coupon ? [{name: (o.totals || []).find((t) => ['coupon', 'voucher', 'reward'].includes(t.code))?.title || 'Kuponas', net: money.norm(coupon.toFixed(2)), taxRate: rates.length === 1 ? rates[0] : null}] : [],
    totals: {net: money.norm(net.toFixed(2)), tax: money.norm(taxTotal.toFixed(2)), gross: money.norm(Number(tot('total')).toFixed(2))},
    invoices: Number(o.invoice_no) > 0 ? [{number: `${o.invoice_prefix || ''}${o.invoice_no}`, createdAt: toIso(o.date_modified, tzOffset)}] : [],
    refunds: (o.returns || []).map((r) => {
      const p = (o.products || []).find((x) => String(x.product_id) === String(r.product_id));
      const unitGross = p ? Number(p.price) + Number(p.tax) : 0;
      return {externalId: `return-${r.return_id}`, amount: money.norm((unitGross * Number(r.quantity)).toFixed(2)), createdAt: toIso(r.date_modified, tzOffset), shipping: false, lines: [{sku: r.model || '', name: r.product, quantity: String(r.quantity)}]};
    }),
    storeName: o.store_name || '',
  };
}

export function createOpenCartAdapter(store, secrets, {fetchImpl = globalThis.fetch, now = () => Date.now()} = {}) {
  const limiter = rateLimiter(Number(store.config?.requestsPerSecond || 2));
  const tzOffset = store.config?.timezone || 'Europe/Vilnius';
  const endpoint = `${store.base_url.replace(/\/+$/, '')}/index.php`;
  return {
    platform: 'opencart',
    async fetchOrdersPage({cursor = null, pageSize = 50}) {
      const c = cursor ? JSON.parse(cursor) : {since: '1970-01-01 00:00:00', after_id: 0};
      const ts = String(Math.floor(now() / 1000));
      const sig = signOpenCart(secrets.apiKey || '', ts, c.since, String(c.after_id), String(pageSize));
      const url = `${endpoint}?route=extension/apskaita_export/other/apskaita_export&since=${encodeURIComponent(c.since)}&after_id=${c.after_id}&limit=${pageSize}`;
      await limiter();
      const body = await httpJson(fetchImpl, url, {headers: {'x-apskaita-timestamp': ts, 'x-apskaita-signature': sig}});
      if (body.api_version !== 1) throw Object.assign(new Error('Nepalaikoma plėtinio versija.'), {permanent: true});
      return {orders: body.orders.map((o) => normalizeOpenCartOrder(o, {timezone: tzOffset})), nextCursor: body.next ? JSON.stringify(body.next) : cursor, done: !body.has_more};
    },
    async fetchOrder() { return null; },
    async verifyWebhook() { return {ok: false, reason: 'OpenCart webhookai nepalaikomi – naudojamas periodinis sinchronizavimas.'}; },
    orderFromWebhook() { return null; },
  };
}
