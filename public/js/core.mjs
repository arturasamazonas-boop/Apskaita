// UI core: safe DOM builder, API client, formatting, toasts, modals, routing helpers.
// All text is inserted as text nodes (never innerHTML) to keep document content inert.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' && (tag === 'input' || tag === 'select' || tag === 'textarea')) el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple' || k === 'required' || k === 'readOnly') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el, ...children) => { el.replaceChildren(); append(el, children); return el; };

// ---------------------------------------------------------------- API
let csrf = '';
export const setCsrf = (v) => { csrf = v; };
export class ApiError extends Error { constructor(status, body) { super(body?.error || `Klaida ${status}`); this.status = status; this.body = body; } }

export async function api(method, url, body, {raw = false} = {}) {
  const opts = {method, credentials: 'same-origin', headers: {}};
  if (method !== 'GET') opts.headers['x-csrf-token'] = csrf;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (res.status === 401 && !url.endsWith('/api/login')) { window.dispatchEvent(new CustomEvent('unauthenticated')); throw new ApiError(401, {error: 'Prisijunkite iš naujo.'}); }
  if (raw) return res;
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {error: text}; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b = {}) => api('POST', u, b);
export const put = (u, b) => api('PUT', u, b);
export const del = (u) => api('DELETE', u);

export function upload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('x-csrf-token', csrf);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    x.onload = () => { let d; try { d = JSON.parse(x.responseText); } catch { d = {error: x.responseText}; } x.status < 300 ? resolve(d) : reject(new ApiError(x.status, d)); };
    x.onerror = () => reject(new ApiError(0, {error: 'Ryšio klaida.'}));
    x.send(formData);
  });
}

/** Open a protected file via a short-lived signed link. */
export async function openFile(fileId, {download = false} = {}) {
  const {url} = await post(`/api/files/${fileId}/link`);
  if (download) { const a = h('a', {href: url + '&download=1'}); document.body.append(a); a.click(); a.remove(); } else window.open(url, '_blank', 'noopener');
}
export async function fileUrl(fileId) { return (await post(`/api/files/${fileId}/link`)).url; }

// ---------------------------------------------------------------- formatting
const nf = new Intl.NumberFormat('lt-LT', {minimumFractionDigits: 2, maximumFractionDigits: 2});
export const money = (v) => (v === null || v === undefined || v === '' ? '—' : nf.format(Number(v)));
export const eur = (v) => (v === null || v === undefined || v === '' ? '—' : `${money(v)} €`);
export const date = (v) => (v ? String(v).slice(0, 10) : '—');
export const dateTime = (v) => (v ? new Date(v).toLocaleString('lt-LT', {timeZone: 'Europe/Vilnius'}) : '—');
export const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Vilnius'}).format(new Date());
export const monthStart = () => today().slice(0, 8) + '01';
export const yearStart = () => today().slice(0, 5) + '01-01';

export const STATUS = {
  uploaded: ['Įkelta', 'neutral'], processing: ['Apdorojama', 'info'], needs_review: ['Reikia peržiūros', 'warn'], ready: ['Paruošta tvirtinti', 'ok'],
  posted: ['Patvirtinta / užregistruota', 'done'], rejected: ['Atmesta', 'muted'], failed: ['Nepavyko', 'error'], stored: ['Saugoma', 'neutral'],
};
export const PAY = {unpaid: ['Neapmokėta', 'warn'], partial: ['Iš dalies', 'info'], paid: ['Apmokėta', 'done'], overpaid: ['Permokėta', 'error'], credited: ['Kredituota', 'muted'], zero: ['0', 'muted']};
export const TX = {unmatched: ['Nesuderinta', 'warn'], proposed: ['Pasiūlyta', 'ok'], needs_review: ['Reikia peržiūros', 'warn'], approved: ['Patvirtinta', 'done'], ignored: ['Ignoruota', 'muted']};
export const DOC_TYPE = {vat_invoice: 'PVM sąskaita faktūra', invoice: 'Sąskaita faktūra (be PVM)', credit_note: 'Kreditinė sąskaita', debit_note: 'Debetinė sąskaita', proforma: 'Išankstinė (proforma)', contract: 'Sutartis', receipt: 'Kvitas / čekis', unknown: 'Neatpažinta', correction: 'Koregavimas'};
export const KIND = {unknown: 'Neatpažinta', purchase_invoice: 'Pirkimo sąskaita', sales_invoice: 'Pardavimo sąskaita', credit_note: 'Kreditinė sąskaita', proforma: 'Išankstinė sąskaita', contract: 'Sutartis', bank_statement: 'Banko išrašas', receipt: 'Kvitas', generated_invoice: 'Išrašyta sąskaita', other: 'Kitas'};
export const LINE_TYPE = {expense: 'Sąnaudos', inventory: 'Atsargos (prekės)', service: 'Paslaugos (sąnaudos)', asset: 'Ilgalaikis turtas', prepaid: 'Ateinančių laik. sąnaudos', revenue_goods: 'Prekių pajamos', revenue_services: 'Paslaugų pajamos', other: 'Kita'};
export const VAT_T = {deductible: 'Atskaitomas', non_deductible: 'Neatskaitomas (į savikainą)', review: 'Neaišku – reikia sprendimo', output: 'Pardavimo PVM'};
export const CONTRACT = {draft: 'Projektas', active: 'Galioja', expired: 'Pasibaigusi', terminated: 'Nutraukta', archived: 'Archyvuota'};

export const badge = (map, key) => { const [t, c] = map[key] || [key || '—', 'neutral']; return h('span', {class: `badge badge-${c}`}, t); };

// ---------------------------------------------------------------- feedback
export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const t = h('div', {class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status'}, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4500);
}
export function showError(e) {
  const issues = e?.body?.issues;
  toast(issues?.length ? `${e.message} ${issues.map((i) => i.message).join(' ')}` : e.message || String(e), 'error');
}
export async function guard(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { showError(e); return undefined; }
}

export function modal(title, content, {wide = false} = {}) {
  const prev = document.activeElement;
  const close = () => { overlay.remove(); prev?.focus?.(); };
  const dialog = h('div', {class: ['modal', wide && 'modal-wide'], role: 'dialog', 'aria-modal': 'true', 'aria-label': title},
    h('div', {class: 'modal-head'}, h('h2', null, title), h('button', {class: 'btn-icon', 'aria-label': 'Uždaryti', onclick: close}, '×')),
    h('div', {class: 'modal-body'}, content));
  const overlay = h('div', {class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); }}, dialog);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(overlay);
  (dialog.querySelector('input,select,textarea,button:not(.btn-icon)') || dialog.querySelector('button'))?.focus();
  return {close, dialog};
}
export function confirmDialog(title, text, okLabel = 'Patvirtinti') {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { m.close(); resolve(v); };
    m = modal(title, h('div', null, h('p', null, text), h('div', {class: 'actions'}, h('button', {class: 'btn', onclick: () => done(false)}, 'Atšaukti'), h('button', {class: 'btn btn-primary', onclick: () => done(true)}, okLabel))));
  });
}
export function promptDialog(title, label, {placeholder = '', minLength = 0, multiline = false} = {}) {
  return new Promise((resolve) => {
    let m;
    const input = multiline ? h('textarea', {rows: 3, placeholder, 'aria-label': label}) : h('input', {placeholder, 'aria-label': label});
    const done = (v) => { m.close(); resolve(v); };
    m = modal(title, h('form', {onsubmit: (e) => { e.preventDefault(); if (input.value.trim().length < minLength) { toast(`Įveskite bent ${minLength} simbolių.`, 'error'); return; } done(input.value.trim()); }},
      h('label', {class: 'field'}, h('span', null, label), input),
      h('div', {class: 'actions'}, h('button', {type: 'button', class: 'btn', onclick: () => done(null)}, 'Atšaukti'), h('button', {class: 'btn btn-primary'}, 'Gerai'))));
  });
}

// ---------------------------------------------------------------- forms & tables
export function field(label, input, hint) {
  const id = input.id || `f${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', {class: 'field'}, h('label', {for: id}, label), input, hint ? h('small', {class: 'hint'}, hint) : null);
}
export const input = (attrs = {}) => h('input', {type: 'text', ...attrs});
export function select(options, value, attrs = {}) {
  const el = h('select', attrs);
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    el.append(h('option', {value: v, selected: String(v) === String(value ?? '')}, t));
  }
  return el;
}
export function table(columns, rows, {onRow, empty = 'Įrašų nėra.', rowClass} = {}) {
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', {class: c.num ? 'num' : null, scope: 'col'}, c.label))));
  const tbody = h('tbody');
  for (const r of rows) {
    const tr = h('tr', {class: [onRow && 'clickable', rowClass?.(r)]}, columns.map((c) => h('td', {class: c.num ? 'num' : null, 'data-label': c.label}, c.render ? c.render(r) : r[c.key] ?? '')));
    if (onRow) { tr.tabIndex = 0; tr.addEventListener('click', (e) => { if (!e.target.closest('button,a,input,select,label')) onRow(r); }); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) onRow(r); }); }
    tbody.append(tr);
  }
  if (!rows.length) tbody.append(h('tr', null, h('td', {colspan: columns.length, class: 'empty'}, empty)));
  return h('div', {class: 'table-wrap'}, h('table', {class: 'grid'}, thead, tbody));
}
export function pager(state, reload) {
  return h('div', {class: 'pager'},
    h('button', {class: 'btn btn-small', disabled: !state.offset, onclick: () => { state.offset = Math.max(0, state.offset - state.limit); reload(); }}, '‹ Ankstesni'),
    h('span', null, `${state.offset + 1}–${state.offset + state.count}`),
    h('button', {class: 'btn btn-small', disabled: !state.hasMore, onclick: () => { state.offset += state.limit; reload(); }}, 'Kiti ›'));
}
export function section(title, ...children) { return h('section', {class: 'card'}, title ? h('h2', null, title) : null, ...children); }
export function pageHeader(title, ...actions) { return h('header', {class: 'page-head'}, h('h1', null, title), h('div', {class: 'page-actions'}, ...actions)); }
export function loading() { return h('div', {class: 'loading', role: 'status'}, 'Kraunama…'); }
export function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const can = (user, cap) => ({admin: ['read', 'write', 'approve', 'rules', 'settings', 'users', 'resolve', 'lock'], accountant: ['read', 'write', 'approve', 'rules', 'resolve', 'lock'], readonly: ['read']}[user?.role] || []).includes(cap);
