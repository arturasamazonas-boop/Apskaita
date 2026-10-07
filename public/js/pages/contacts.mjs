// Kontrahentai: customers and suppliers (products are in pages/products.mjs).
import {h, clear, get, post, put, pageHeader, table, money, guard, input, field, pager, debounce, can, modal} from '../core.mjs';
import {rekvizitaiButton, vatCheckButton} from '../lib/company-fill.mjs';

export async function render(main, rest, state) {
  if (rest[0] === 'prekes') { location.replace('#/prekes'); return; }
  return counterparties(main, null, state);
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
      email: input({value: c.email || '', type: 'email'}), iban: input({value: c.iban || ''}), is_supplier: h('input', {type: 'checkbox', checked: c.is_supplier}), is_customer: h('input', {type: 'checkbox', checked: c.is_customer}), is_individual: h('input', {type: 'checkbox', checked: c.is_individual}), notes: h('textarea', {rows: 2}, c.notes || ''),
      legal_form: input({value: c.legal_form || ''}), phone: input({value: c.phone || ''}), website: input({value: c.website || ''}), manager: input({value: c.manager || ''})};
    const m = modal(c.id ? 'Kontrahentas' : 'Naujas kontrahentas', h('form', {onsubmit: async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.type === 'checkbox' ? v.checked : v.value]));
      if (await guard(() => (c.id ? put(`/api/counterparties/${c.id}`, body) : post('/api/counterparties', body)), 'Išsaugota.')) { m.close(); load(); }
    }}, h('div', {class: 'actions-left'}, rekvizitaiButton(f)), h('div', {class: 'form-grid'}, field('Pavadinimas', f.name), field('Teisinė forma', f.legal_form), field('Įmonės kodas', f.company_code), field('PVM kodas', f.vat_code, vatCheckButton(f.vat_code)), field('Adresas', f.address), field('Šalis', f.country),
      field('El. paštas', f.email), field('Telefonas', f.phone), field('Tinklalapis', f.website), field('Vadovas', f.manager), field('IBAN', f.iban),
      h('label', {class: 'check'}, f.is_customer, ' Pirkėjas'), h('label', {class: 'check'}, f.is_supplier, ' Tiekėjas'), h('label', {class: 'check'}, f.is_individual, ' Fizinis asmuo'), field('Pastabos', f.notes)),
    h('p', {class: 'hint'}, 'Užregistruotose sąskaitose saugoma rekvizitų kopija – jos šis pakeitimas nekeičia.'), h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))), {wide: true});
  };
  const q = input({type: 'search', placeholder: 'Pavadinimas, kodas', oninput: debounce(() => { st.q = q.value; st.offset = 0; load(); })});
  clear(main, pageHeader('Kontrahentai', can(state.user, 'write') ? h('a', {class: 'btn', href: '#/rekvizitai'}, 'Iš rekvizitai.lt') : null, can(state.user, 'write') ? h('button', {class: 'btn btn-primary', onclick: () => edit()}, '+ Kontrahentas') : null), tabs, h('div', {class: 'filters'}, q), box);
  await load();
}
