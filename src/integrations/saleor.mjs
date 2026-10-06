// Saleor adapter (targets Saleor 3.22+ GraphQL; verified against the 3.23 schema – see docs/INTEGRATIONS.md).
// Auth: app token "Authorization: Bearer <token>" with MANAGE_ORDERS. Incremental sync uses
// orders(where: {updatedAt: {gte}}, sortBy: {field: LAST_MODIFIED_AT, direction: ASC}) with relay cursors.
// Webhooks: JWS RS256 with detached, unencoded payload ("Saleor-Signature: <header>..<sig>"), keys from
// <origin>/.well-known/jwks.json; legacy HMAC-SHA256 hex when a webhook secret key is configured.
import crypto from 'node:crypto';
import {money} from '../lib/money.mjs';
import {rateLimiter, httpJson} from './http-client.mjs';

const ORDER_FIELDS = `
  id number status chargeStatus created updatedAt userEmail
  channel { slug }
  billingAddress { firstName lastName companyName streetAddress1 streetAddress2 city postalCode country { code } }
  total { currency net { amount } gross { amount } tax { amount } }
  shippingPrice { net { amount } gross { amount } tax { amount } }
  shippingTaxRate
  lines { id productName variantName productSku productVariantId quantity taxRate
    unitPrice { net { amount } gross { amount } } undiscountedUnitPrice { net { amount } }
    totalPrice { net { amount } gross { amount } tax { amount } } }
  invoices { number createdAt }
  fulfillments { created }
  grantedRefunds { id createdAt status shippingCostsIncluded amount { amount currency } lines { quantity orderLine { id productSku productName } } }
  metadata { key value }`;

export const ORDERS_QUERY = `query Orders($first: Int!, $after: String, $since: DateTime) {
  orders(first: $first, after: $after, where: {updatedAt: {gte: $since}}, sortBy: {field: LAST_MODIFIED_AT, direction: ASC}) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${ORDER_FIELDS} } }
  }
}`;
export const ORDER_QUERY = `query Order($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;

const amt = (x) => money.norm(String(x?.amount ?? '0'));
const pct = (rate, net, gross) => {
  // taxRate may be a fraction (0.21) or percent; cross-check with prices and flag inconsistency.
  let r = Number(rate);
  if (r > 0 && r < 1) r *= 100;
  const n = Number(net), g = Number(gross);
  const implied = n ? Math.round(((g - n) / n) * 10000) / 100 : null;
  if (implied !== null && Math.abs(implied - r) > 0.6) return null;
  return String(Math.round(r * 100) / 100);
};

export function normalizeSaleorOrder(o) {
  const b = o.billingAddress || {};
  const lines = (o.lines || []).map((l) => ({
    externalLineId: l.id, productExternalId: l.productVariantId || '', sku: l.productSku || '', name: [l.productName, l.variantName].filter(Boolean).join(' – '),
    quantity: String(l.quantity), unitNet: money.norm(String(l.unitPrice?.net?.amount ?? '0')), totalNet: amt(l.totalPrice?.net),
    taxRate: pct(l.taxRate, l.unitPrice?.net?.amount, l.unitPrice?.gross?.amount), discountNet: '0',
  }));
  const shipNet = amt(o.shippingPrice?.net);
  return {
    externalId: o.id, number: String(o.number), status: o.status, paymentStatus: o.chargeStatus, currency: o.total?.currency || 'EUR',
    createdAt: o.created, updatedAt: o.updatedAt, fulfilledAt: o.fulfillments?.[0]?.created || null,
    customer: {name: b.companyName || [b.firstName, b.lastName].filter(Boolean).join(' ') || o.userEmail || '', email: o.userEmail || '',
      companyCode: (o.metadata || []).find((m) => m.key === 'company_code')?.value || '', vatCode: (o.metadata || []).find((m) => m.key === 'vat_code')?.value || '',
      address: [b.streetAddress1, b.streetAddress2, b.postalCode, b.city].filter(Boolean).join(', '), country: b.country?.code || 'LT'},
    lines,
    shipping: money.isZero(shipNet) ? null : {net: shipNet, gross: amt(o.shippingPrice?.gross), taxRate: pct(o.shippingTaxRate, o.shippingPrice?.net?.amount, o.shippingPrice?.gross?.amount)},
    orderDiscounts: [],
    totals: {net: amt(o.total?.net), tax: amt(o.total?.tax), gross: amt(o.total?.gross)},
    invoices: (o.invoices || []).filter((i) => i.number).map((i) => ({number: i.number, createdAt: i.createdAt})),
    refunds: (o.grantedRefunds || []).filter((r) => r.status === 'SUCCESS').map((r) => ({externalId: r.id, amount: amt(r.amount), createdAt: r.createdAt, shipping: !!r.shippingCostsIncluded,
      lines: (r.lines || []).map((l) => ({sku: l.orderLine?.productSku || '', name: l.orderLine?.productName || '', quantity: String(l.quantity)}))})),
    channel: o.channel?.slug || '',
  };
}

export function createSaleorAdapter(store, secrets, {fetchImpl = globalThis.fetch} = {}) {
  const api = store.base_url.replace(/\/+$/, '') + (store.base_url.includes('/graphql') ? '' : '/graphql/');
  const limiter = rateLimiter(Number(store.config?.requestsPerSecond || 4));
  async function gql(query, variables) {
    await limiter();
    const body = await httpJson(fetchImpl, api, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${secrets.apiToken || ''}`}, body: JSON.stringify({query, variables})});
    if (body.errors?.length) throw Object.assign(new Error(`Saleor: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}`), {permanent: /permission|PermissionDenied|authenticat/i.test(JSON.stringify(body.errors))});
    return body.data;
  }
  let jwksCache = null;
  async function jwks(apiUrl) {
    if (jwksCache && jwksCache.at > Date.now() - 3600000) return jwksCache.keys;
    const origin = new URL(apiUrl || api).origin;
    const body = await httpJson(fetchImpl, `${origin}/.well-known/jwks.json`, {});
    jwksCache = {keys: body.keys || [], at: Date.now()};
    return jwksCache.keys;
  }
  return {
    platform: 'saleor',
    async fetchOrdersPage({cursor = null, since = '1970-01-01T00:00:00Z', pageSize = 50}) {
      const d = await gql(ORDERS_QUERY, {first: pageSize, after: cursor, since});
      const c = d.orders;
      return {orders: c.edges.map((e) => normalizeSaleorOrder(e.node)), nextCursor: c.pageInfo.endCursor, done: !c.pageInfo.hasNextPage};
    },
    async fetchOrder(id) { const d = await gql(ORDER_QUERY, {id}); return d.order ? normalizeSaleorOrder(d.order) : null; },
    /** Verify authenticity; never trust payload content before this returns ok. */
    async verifyWebhook(headers, raw) {
      const sig = headers['saleor-signature'] || headers['x-saleor-signature'] || '';
      const apiUrl = headers['saleor-api-url'] || headers['x-saleor-api-url'] || '';
      const event = String(headers['saleor-event'] || headers['x-saleor-event'] || '').toUpperCase();
      if (apiUrl && new URL(apiUrl).origin !== new URL(api).origin) return {ok: false, reason: 'Saleor-Api-Url neatitinka parduotuvės adreso.'};
      if (!sig) return {ok: false, reason: 'Nėra parašo.'};
      if (secrets.webhookSecret && /^[a-f0-9]{64}$/i.test(sig)) {
        const mac = crypto.createHmac('sha256', secrets.webhookSecret).update(raw).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sig.toLowerCase())) ? {ok: true, event, method: 'hmac'} : {ok: false, reason: 'HMAC parašas netinka.'};
      }
      const [h, empty, s] = sig.split('.');
      if (!h || empty !== '' || !s) return {ok: false, reason: 'Netinkamas JWS formatas.'};
      let header;
      try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); } catch { return {ok: false, reason: 'Netinkama JWS antraštė.'}; }
      if (header.alg !== 'RS256' || header.b64 !== false || !(header.crit || []).includes('b64')) return {ok: false, reason: 'Nepalaikomas JWS algoritmas.'};
      const keys = await jwks(apiUrl);
      const jwk = keys.find((k) => !header.kid || k.kid === header.kid);
      if (!jwk) return {ok: false, reason: 'Viešasis raktas nerastas.'};
      const ok = crypto.verify('RSA-SHA256', Buffer.concat([Buffer.from(h + '.'), Buffer.from(raw)]), crypto.createPublicKey({key: jwk, format: 'jwk'}), Buffer.from(s, 'base64url'));
      return ok ? {ok: true, event, method: 'jws'} : {ok: false, reason: 'JWS parašas netinka.'};
    },
    /** Extract the order from a verified payload (subscription payload {order {...}} or legacy list). */
    orderFromWebhook(payload) {
      const o = payload?.order || payload?.data?.order || (Array.isArray(payload) ? payload[0] : null);
      return o?.id ? {externalId: o.id, order: o.lines ? normalizeSaleorOrder(o) : null} : null;
    },
  };
}
