// Kontaktai ir prekės: counterparties and products (SKU, units, tax settings, external mappings).
import {h, clear, get, post, put, pageHeader, section, table, money, guard, select, input, field, pager, debounce, can, modal} from '../core.mjs';

export async function render(main, rest, state) {
  const tab = rest[0] === 'prekes' ? 'prekes' : 'kontaktai';
  const tabs = h('div', {class: 'tabs'}, h('a', {class: ['tab', tab === 'kontaktai' && 'active'], href: '#/kontaktai'}, 'Kontrahentai'), h('a', {class: ['tab', tab === 'prekes' && 'active'], href: '#/kontaktai/prekes'}, 'Prekės ir paslaugos'));
  return tab === 'prekes' ? products(main, tabs, state) : counterparties(main, tabs, state);
}

async function counterparties(main, tabs, state) {
  const st = {q: '', offset: 0, limit: 50};
  const box = h('div');
  const load = async () => {
    const d = await get(`/api/counterparties?${new URLSearchParams({q: st.q, limit: st.limit, offset: st.offset})}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(box, table([{label: 'ID', key: 'id'}, {label: 'Pavadinimas', key: 'name'}, {label: 'Įmonės kodas', key: 'company_code'}, {label: 'PVM kodas', key: 'vat_code'}, {label: 'IBAN', key: 'iban'},
      {label: 'Vaidmuo', render: (c) => [c.is_customer && 'Pirkėjas', c.is_supplier && 'Tiekėjas'].filter(Boolean).join(', ')}, {label: 'Pardavimai', num: true, render: (c) => money(c.sales_total)}, {label: 'Pirkimai', num: true, render: (c) => money(c.purchase_total)}],
    d.items, {onRow: can(state.user, 'write') ? (c) => edit(c) : null}), pager(st, load));
  };
  const edit = (c = {}) => {
    const f = {name: input({value: c.name || ''}), company_code: input({value: c.company_code || ''}), vat_code: input({value: c.vat_code || ''}), address: input({value: c.address || ''}), country: input({value: c.country || 'LT'}),
      email: input({value: c.email || '', type: 'email'}), iban: input({value: c.iban || ''}), is_supplier: h('input', {type: 'checkbox', checked: c.is_supplier}), is_customer: h('input', {type: 'checkbox', checked: c.is_customer}), is_individual: h('input', {type: 'checkbox', checked: c.is_individual}), notes: h('textarea', {rows: 2}, c.notes || '')};
    const m = modal(c.id ? 'Kontrahentas' : 'Naujas kontrahentas', h('form', {onsubmit: async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.type === 'checkbox' ? v.checked : v.value]));
      if (await guard(() => (c.id ? put(`/api/counterparties/${c.id}`, body) : post('/api/counterparties', body)), 'Išsaugota.')) { m.close(); load(); }
    }}, h('div', {class: 'form-grid'}, field('Pavadinimas', f.name), field('Įmonės kodas', f.company_code), field('PVM kodas', f.vat_code), field('Adresas', f.address), field('Šalis', f.country), field('El. paštas', f.email), field('IBAN', f.iban),
      h('label', {class: 'check'}, f.is_customer, ' Pirkėjas'), h('label', {class: 'check'}, f.is_supplier, ' Tiekėjas'), h('label', {class: 'check'}, f.is_individual, ' Fizinis asmuo'), field('Pastabos', f.notes)),
    h('p', {class: 'hint'}, 'Užregistruotose sąskaitose saugoma rekvizitų kopija – jos šis pakeitimas nekeičia.'), h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))), {wide: true});
  };
  const q = input({type: 'search', placeholder: 'Pavadinimas, kodas', oninput: debounce(() => { st.q = q.value; st.offset = 0; load(); })});
  clear(main, pageHeader('Kontaktai ir prekės', can(state.user, 'write') ? h('button', {class: 'btn btn-primary', onclick: () => edit()}, '+ Kontrahentas') : null), tabs, h('div', {class: 'filters'}, q), box);
  await load();
}

async function products(main, tabs, state) {
  const [accounts, taxCodes, stores] = await Promise.all([get('/api/accounts'), get('/api/tax-codes'), get('/api/stores')]);
  const st = {q: '', offset: 0, limit: 50};
  const box = h('div');
  const load = async () => {
    const d = await get(`/api/products?${new URLSearchParams({q: st.q, limit: st.limit, offset: st.offset})}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(box, table([{label: 'SKU', key: 'sku'}, {label: 'Pavadinimas', key: 'name'}, {label: 'Tipas', render: (p) => (p.kind === 'service' ? 'Paslauga' : 'Prekė')}, {label: 'Vnt.', key: 'unit'}, {label: 'PVM', key: 'tax_code'}, {label: 'Kaina', num: true, render: (p) => money(p.unit_price)},
      {label: 'Pajamų sąsk.', key: 'revenue_account'}, {label: 'Sąnaudų / atsargų sąsk.', key: 'expense_account'}, {label: 'Parduotuvių susiejimai', render: (p) => (p.external_refs || []).map((x) => `${stores.find((s) => String(s.id) === String(x.storeId))?.name || x.storeId}: ${x.externalId}`).join('; ')}],
    d.items, {onRow: can(state.user, 'write') ? (p) => edit(p) : null}), pager(st, load));
  };
  const accSel = (types, v) => select([['', '—'], ...accounts.filter((a) => a.active && types.includes(a.type)).map((a) => [a.code, `${a.code} ${a.name}`])], v || '');
  const edit = (p = {}) => {
    const f = {sku: input({value: p.sku || ''}), name: input({value: p.name || ''}), kind: select([['goods', 'Prekė'], ['service', 'Paslauga']], p.kind || 'goods'), unit: input({value: p.unit || 'vnt.'}),
      tax_code: select([...new Set(taxCodes.filter((t) => t.active).map((t) => t.code))], p.tax_code || 'PVM1'), unit_price: input({value: p.unit_price || '', inputmode: 'decimal'}),
      revenue_account: accSel(['revenue'], p.revenue_account), expense_account: accSel(['expense', 'asset'], p.expense_account)};
    const extStore = select(stores.map((s) => [s.id, s.name]), ''), extId = input({placeholder: 'Išorinis prekės / varianto ID'});
    const m = modal(p.id ? 'Prekė' : 'Nauja prekė', h('form', {onsubmit: async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]));
      const saved = await guard(() => (p.id ? put(`/api/products/${p.id}`, body) : post('/api/products', body)), 'Išsaugota.');
      if (saved && extId.value && extStore.value) await guard(() => post(`/api/products/${saved.id}/external-refs`, {storeId: extStore.value, externalId: extId.value}));
      if (saved) { m.close(); load(); }
    }}, h('div', {class: 'form-grid'}, field('SKU', f.sku, 'Pavadinimas nėra unikalus identifikatorius – naudokite SKU'), field('Pavadinimas', f.name), field('Tipas', f.kind), field('Mato vnt.', f.unit), field('PVM kodas', f.tax_code), field('Kaina be PVM', f.unit_price),
      field('Pajamų sąskaita', f.revenue_account), field('Pirkimo sąskaita', f.expense_account, 'Prekėms – atsargos (2040), ne sąnaudos')),
    stores.length ? h('fieldset', null, h('legend', null, 'Susieti su parduotuvės preke'), h('div', {class: 'form-grid'}, field('Parduotuvė', extStore), field('Išorinis ID', extId))) : null,
    h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))), {wide: true});
  };
  const q = input({type: 'search', placeholder: 'SKU arba pavadinimas', oninput: debounce(() => { st.q = q.value; st.offset = 0; load(); })});
  clear(main, pageHeader('Kontaktai ir prekės', can(state.user, 'write') ? h('button', {class: 'btn btn-primary', onclick: () => edit()}, '+ Prekė / paslauga') : null), tabs, h('div', {class: 'filters'}, q), box);
  await load();
}
