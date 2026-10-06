import {h, clear, get, table, badge, eur, date, pager, select, field, debounce, input} from '../core.mjs';
import {invoiceList, invoiceDetail, manualForm} from './invoices.mjs';

const ORDER_STATE = {new: ['Naujas', 'neutral'], waiting_status: ['Laukia būsenos', 'neutral'], proposed: ['Pasiūlyta sąskaita', 'ok'], posted: ['Užregistruota', 'done'], changed_after_post: ['Pakeistas po registracijos', 'error'], needs_review: ['Reikia peržiūros', 'warn'], ignored: ['Ignoruojamas', 'muted']};

export async function render(main, rest, state) {
  if (rest[0] === 'nauja') return manualForm(main, 'sales', state);
  if (rest[0] === 's') return invoiceDetail(main, rest[1], state);
  if (rest[0] === 'uzsakymai') return orders(main, rest, state);
  return invoiceList(main, 'sales', state, h('div', {class: 'tabs'}, h('a', {class: 'tab active', href: '#/pardavimai'}, 'Sąskaitos'), h('a', {class: 'tab', href: '#/pardavimai/uzsakymai'}, 'Parduotuvių užsakymai')));
}

async function orders(main, rest) {
  if (rest[1]) return orderDetail(main, rest[1]);
  const stores = await get('/api/stores');
  const st = {store: '', state: '', q: '', offset: 0, limit: 50};
  const box = h('div');
  const load = async () => {
    const d = await get(`/api/orders?${new URLSearchParams({store: st.store, state: st.state, q: st.q, limit: st.limit, offset: st.offset})}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(box, table([{label: 'Parduotuvė', render: (o) => h('span', null, o.store_name, o.is_demo ? h('span', {class: 'badge badge-info'}, ' DEMO') : null)}, {label: 'Užsakymas', key: 'order_number'}, {label: 'Pirkėjas', key: 'customer'},
      {label: 'Parduotuvės būsena', key: 'external_status'}, {label: 'Apskaitos būsena', render: (o) => badge(ORDER_STATE, o.state)}, {label: 'Suma', num: true, render: (o) => `${eur(o.gross)} ${o.currency !== 'EUR' ? o.currency : ''}`}, {label: 'Pastaba', key: 'state_note'}],
    d.items, {onRow: (o) => { location.hash = `#/pardavimai/uzsakymai/${o.id}`; }, empty: 'Užsakymų nėra. Prijunkite parduotuvę skiltyje „Integracijos“.'}), pager(st, load));
  };
  const storeSel = select([['', 'Visos'], ...stores.map((s) => [s.id, s.name])], '', {onchange: () => { st.store = storeSel.value; st.offset = 0; load(); }});
  const stateSel = select([['', 'Visos'], ...Object.entries(ORDER_STATE).map(([k, v]) => [k, v[0]])], '', {onchange: () => { st.state = stateSel.value; st.offset = 0; load(); }});
  const q = input({type: 'search', oninput: debounce(() => { st.q = q.value; load(); })});
  clear(main, h('header', {class: 'page-head'}, h('h1', null, 'Pardavimai')), h('div', {class: 'tabs'}, h('a', {class: 'tab', href: '#/pardavimai'}, 'Sąskaitos'), h('a', {class: 'tab active', href: '#/pardavimai/uzsakymai'}, 'Parduotuvių užsakymai')),
    h('p', {class: 'hint'}, 'Užsakymai nėra sąskaitos ir nėra pajamos: sąskaitos pasiūlymas sukuriamas tik kai užsakymo būsena susieta su „išrašyti sąskaitą“, o registruojama tik patvirtinus.'),
    h('div', {class: 'filters'}, field('Parduotuvė', storeSel), field('Būsena', stateSel), field('Užsakymo nr.', q)), box);
  await load();
}

async function orderDetail(main, id) {
  const o = await get(`/api/orders/${id}`);
  const d = o.data;
  clear(main, h('header', {class: 'page-head'}, h('h1', null, `Užsakymas ${o.order_number} – ${o.store_name}`), h('a', {class: 'btn btn-small', href: '#/pardavimai/uzsakymai'}, '‹ Atgal')),
    o.is_demo ? h('div', {class: 'banner'}, 'DEMONSTRACINĖ parduotuvė – duomenys iš testinių rinkinių, ne tikros parduotuvės.') : null,
    h('section', {class: 'card'}, h('dl', {class: 'dl'}, h('dt', null, 'Parduotuvės būsena'), h('dd', null, o.external_status), h('dt', null, 'Apskaitos būsena'), h('dd', null, badge(ORDER_STATE, o.state), ' ', o.state_note || ''),
      h('dt', null, 'Sąskaitų režimas'), h('dd', null, o.invoice_mode === 'issue_here' ? 'Sąskaitas išrašo ši programa' : 'Importuojamos parduotuvės sąskaitos'), h('dt', null, 'Pirkėjas'), h('dd', null, `${d.customer?.name || ''} ${d.customer?.email || ''}`),
      h('dt', null, 'Sumos'), h('dd', null, `be PVM ${eur(d.totals?.net)}, PVM ${eur(d.totals?.tax)}, su PVM ${eur(d.totals?.gross)} ${o.currency}`))),
    h('section', {class: 'card'}, h('h2', null, 'Eilutės'), table([{label: 'SKU', key: 'sku'}, {label: 'Pavadinimas', key: 'name'}, {label: 'Kiekis', key: 'quantity'}, {label: 'Kaina be PVM', key: 'unitNet'}, {label: 'PVM %', render: (l) => l.taxRate ?? '?'}], d.lines || [])),
    h('section', {class: 'card'}, h('h2', null, 'Sąskaitos ir pasiūlymai'), table([{label: 'Pasiūlymas', key: 'id'}, {label: 'Tipas', key: 'kind'}, {label: 'Versija', key: 'version'}, {label: 'Būsena', key: 'status'}], o.proposals, {onRow: (p) => { location.hash = `#/deze/p${p.id}`; }}),
      table([{label: 'Sąskaita', render: (i) => h('a', {href: `#/pardavimai/s/${i.id}`}, `${i.series} ${i.number}`)}, {label: 'Tipas', key: 'doc_type'}, {label: 'Suma', num: true, render: (i) => eur(i.gross_total)}], o.invoices),
      o.proposals.some((p) => p.status === 'open') ? h('a', {class: 'btn btn-primary', href: `#/deze/p${o.proposals.find((p) => p.status === 'open').id}`}, 'Peržiūrėti ir patvirtinti sąskaitą') : null),
    h('section', {class: 'card'}, h('h2', null, 'Grąžinimai'), table([{label: 'ID', key: 'external_id'}, {label: 'Suma', num: true, render: (r) => eur(r.amount)}, {label: 'Pasiūlymas', key: 'proposal_id'}], o.refunds, {empty: 'Grąžinimų nėra.'})),
    h('section', {class: 'card'}, h('h2', null, 'Gautos versijos'), table([{label: 'Gauta', render: (v) => date(v.received_at)}, {label: 'Atnaujinta parduotuvėje', render: (v) => v.external_updated_at}, {label: 'Šaltinis', key: 'source'}], o.versions)));
}
