// Prekės ir paslaugos: product list, product card (all fields), stock balances and movements.
import {h, clear, get, post, put, pageHeader, section, table, money, eur, date, guard, select, input, field, pager, debounce, can, modal, today} from '../core.mjs';

const KIND = {goods: 'Prekė', service: 'Paslauga'};
const MOVE = {purchase: 'Pirkimas', sale: 'Pardavimas', opening: 'Pradinis likutis', adjustment: 'Inventorizacijos koregavimas', writeoff: 'Nurašymas'};
const dec = (v) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
const qty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('lt-LT', {maximumFractionDigits: 4}));
const tabs = (cur) => h('div', {class: 'tabs'}, [['', 'Prekių sąrašas'], ['likuciai', 'Likučiai'], ['judejimas', 'Judėjimas']].map(([k, t]) => h('a', {class: ['tab', cur === k && 'active'], href: `#/prekes${k ? '/' + k : ''}`}, t)));

export async function render(main, rest, state) {
  if (rest[0] === 'likuciai') return stock(main, state);
  if (rest[0] === 'judejimas') return moves(main, state);
  if (rest[0] === 'nauja') return card(main, null, state);
  if (rest[0]) return card(main, rest[0], state);
  return list(main, state);
}

async function list(main, state) {
  const groups = await get('/api/products/groups');
  const st = {q: '', group: '', kind: '', active: 'true', low: '', offset: 0, limit: 50};
  const box = h('div');
  const load = async () => {
    const d = await get(`/api/products?${new URLSearchParams({q: st.q, group: st.group, kind: st.kind, active: st.active, low: st.low, limit: st.limit, offset: st.offset})}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(box, table([{label: 'Kodas', key: 'sku'}, {label: 'Pavadinimas', key: 'name'}, {label: 'Grupė', key: 'group_name'}, {label: 'Tipas', render: (p) => KIND[p.kind]}, {label: 'Vnt.', key: 'unit'},
      {label: 'Kaina be PVM', num: true, render: (p) => money(p.unit_price)}, {label: 'Pirkimo kaina', num: true, render: (p) => money(p.purchase_price)},
      {label: 'Likutis', num: true, render: (p) => (p.track_stock ? h('span', {class: p.min_stock !== null && Number(p.stock || 0) < Number(p.min_stock) ? 'neg' : null}, qty(p.stock || 0)) : '')},
      {label: 'Būsena', render: (p) => (p.active ? '' : 'neaktyvi')}],
    d.items, {onRow: (p) => { location.hash = `#/prekes/${p.id}`; }, empty: 'Prekių nerasta.'}), pager(st, load));
  };
  const q = input({type: 'search', placeholder: 'Kodas, pavadinimas, brūkšninis kodas', oninput: debounce(() => { st.q = q.value; st.offset = 0; load(); })});
  const grp = select([['', 'Visos'], ...groups.map((g) => [g.group_name, `${g.group_name} (${g.count})`])], '', {onchange: () => { st.group = grp.value; st.offset = 0; load(); }});
  const kind = select([['', 'Visi'], ['goods', 'Prekės'], ['service', 'Paslaugos']], '', {onchange: () => { st.kind = kind.value; st.offset = 0; load(); }});
  const act = h('input', {type: 'checkbox', checked: true, onchange: () => { st.active = act.checked ? 'true' : ''; load(); }});
  const low = h('input', {type: 'checkbox', onchange: () => { st.low = low.checked ? 'true' : ''; load(); }});
  clear(main, pageHeader('Prekės ir paslaugos', can(state.user, 'write') ? h('a', {class: 'btn btn-primary', href: '#/prekes/nauja'}, '+ Nauja prekė / paslauga') : null), tabs(''),
    h('div', {class: 'filters'}, field('Paieška', q), field('Grupė', grp), field('Tipas', kind), h('label', {class: 'check'}, act, ' tik aktyvios'), h('label', {class: 'check'}, low, ' žemiau minimalaus likučio')), box);
  await load();
}

async function card(main, id, state) {
  const [p, accounts, taxCodes, stores, groups, suppliers] = await Promise.all([id ? get(`/api/products/${id}`) : {kind: 'goods', unit: 'vnt.', tax_code: 'PVM1', active: true, track_stock: true},
    get('/api/accounts'), get('/api/tax-codes'), get('/api/stores'), get('/api/products/groups'), get('/api/counterparties?limit=200')]);
  const ro = !can(state.user, 'write');
  const accSel = (types, v) => select([['', '— pagal numatytas taisykles —'], ...accounts.filter((a) => a.active && types.includes(a.type)).map((a) => [a.code, `${a.code} ${a.name}`])], v || '');
  const dl = h('datalist', {id: 'product-groups'}, groups.map((g) => h('option', {value: g.group_name})));
  const f = {
    sku: input({value: p.sku || ''}), name: input({value: p.name || '', required: true}), kind: select(Object.entries(KIND), p.kind), unit: input({value: p.unit || 'vnt.'}),
    group_name: input({value: p.group_name || '', list: 'product-groups'}), barcode: input({value: p.barcode || '', inputmode: 'numeric'}),
    active: h('input', {type: 'checkbox', checked: p.active !== false}), track_stock: h('input', {type: 'checkbox', checked: !!p.track_stock}),
    unit_price: input({value: dec(p.unit_price), inputmode: 'decimal'}), purchase_price: input({value: dec(p.purchase_price), inputmode: 'decimal'}),
    tax_code: select([...new Set(taxCodes.filter((t) => t.active).map((t) => t.code))].map((c) => { const t = taxCodes.find((x) => x.code === c); return [c, `${c} ${t.rate === null ? '' : Number(t.rate) + ' %'}`]; }), p.tax_code || 'PVM1'),
    revenue_account: accSel(['revenue'], p.revenue_account), expense_account: accSel(['expense', 'asset'], p.expense_account),
    supplier_id: select([['', '—'], ...suppliers.items.filter((c) => c.is_supplier || String(c.id) === String(p.supplier_id)).map((c) => [c.id, c.name])], p.supplier_id || ''),
    supplier_sku: input({value: p.supplier_sku || ''}), manufacturer: input({value: p.manufacturer || ''}), origin_country: input({value: p.origin_country || '', maxlength: 2, placeholder: 'LT'}),
    cn_code: input({value: p.cn_code || '', inputmode: 'numeric'}), weight_kg: input({value: dec(p.weight_kg), inputmode: 'decimal'}), location: input({value: p.location || ''}), min_stock: input({value: dec(p.min_stock), inputmode: 'decimal'}),
    description: h('textarea', {rows: 3}, p.description || ''), notes: h('textarea', {rows: 3}, p.notes || ''),
  };
  Object.values(f).forEach((x) => { x.disabled = ro; });
  const body = () => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.type === 'checkbox' ? v.checked : v.value]));
  const save = async (e) => {
    e.preventDefault();
    const saved = await guard(() => (id ? put(`/api/products/${id}`, body()) : post('/api/products', body())), 'Prekės kortelė išsaugota.');
    if (saved && !id) location.hash = `#/prekes/${saved.id}`; else if (saved) card(main, id, state);
  };
  const stockBox = h('div');
  const loadMoves = async () => {
    const d = await get(`/api/stock/moves?product=${id}&limit=200`);
    clear(stockBox, table([{label: 'Data', render: (m) => date(m.move_date)}, {label: 'Operacija', render: (m) => MOVE[m.kind] || m.kind}, {label: 'Dokumentas', render: (m) => (m.source_type === 'invoice' ? h('a', {href: `#/${m.kind === 'purchase' ? 'pirkimai' : 'pardavimai'}/s/${m.source_id}`}, m.reference) : m.note)},
      {label: 'Kiekis', num: true, render: (m) => qty(m.quantity)}, {label: 'Kaina', num: true, render: (m) => money(m.unit_price)}, {label: 'Likutis', num: true, render: (m) => qty(m.balance)}], d.items, {empty: 'Judėjimų nėra.'}));
  };
  const adjust = () => {
    const g = {kind: select([['opening', MOVE.opening], ['adjustment', MOVE.adjustment], ['writeoff', MOVE.writeoff]], 'opening'), date: input({type: 'date', value: today()}), quantity: input({inputmode: 'decimal', required: true}),
      unitCost: input({inputmode: 'decimal', value: dec(p.purchase_price)}), note: input()};
    const m = modal('Likučio įrašas', h('form', {onsubmit: async (e) => {
      e.preventDefault();
      if (await guard(() => post('/api/stock/movements', {productId: id, kind: g.kind.value, date: g.date.value, quantity: g.quantity.value, unitCost: g.unitCost.value, note: g.note.value}), 'Likutis atnaujintas.')) { m.close(); card(main, id, state); }
    }}, h('div', {class: 'form-grid'}, field('Tipas', g.kind), field('Data', g.date), field('Kiekis', g.quantity, 'Koregavimui – su ženklu (pvz. -2); nurašymui – teigiamas kiekis'), field('Vieneto savikaina', g.unitCost), field('Pastaba / priežastis', g.note)),
    h('p', {class: 'hint'}, 'Tai kiekio įrašas. Nurašymo ar inventorizacijos vertės pokytį DK registruokite žurnale (pvz. D 6312 / K 204).'),
    h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))));
  };
  const extStore = select(stores.map((s) => [s.id, s.name]), ''), extId = input({placeholder: 'Išorinis prekės / varianto ID'});
  clear(main, pageHeader(id ? `Prekės kortelė: ${p.name}` : 'Nauja prekės kortelė', h('a', {class: 'btn', href: '#/prekes'}, '← Sąrašas')), dl,
    h('form', {class: 'product-card', onsubmit: save},
      section('Pagrindiniai duomenys', h('div', {class: 'form-grid'}, field('Kodas (SKU)', f.sku, 'Unikalus prekės kodas'), field('Pavadinimas', f.name), field('Tipas', f.kind), field('Mato vienetas', f.unit),
        field('Prekių grupė', f.group_name), field('Brūkšninis kodas (EAN)', f.barcode), h('label', {class: 'check'}, f.active, ' Aktyvi'), h('label', {class: 'check'}, f.track_stock, ' Skaičiuoti likutį'))),
      section('Kainos ir apskaita', h('div', {class: 'form-grid'}, field('Pardavimo kaina be PVM', f.unit_price), field('Pirkimo kaina be PVM', f.purchase_price), field('PVM kodas', f.tax_code),
        field('Pajamų sąskaita', f.revenue_account), field('Pirkimo sąskaita', f.expense_account, 'Prekėms perparduoti – 204 (atsargos), ne sąnaudos'))),
      section('Tiekimas ir sandėlis', h('div', {class: 'form-grid'}, field('Pagrindinis tiekėjas', f.supplier_id), field('Tiekėjo prekės kodas', f.supplier_sku), field('Gamintojas', f.manufacturer),
        field('Kilmės šalis', f.origin_country), field('KN kodas', f.cn_code, 'Kombinuotoji nomenklatūra (Intrastat)'), field('Svoris, kg', f.weight_kg), field('Vieta sandėlyje', f.location), field('Minimalus likutis', f.min_stock))),
      section('Aprašymas', h('div', {class: 'form-grid wide-fields'}, field('Aprašymas', f.description), field('Vidinės pastabos', f.notes))),
      ro ? null : h('div', {class: 'actions sticky-actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti kortelę'))),
    id && p.track_stock ? section('Likutis', h('dl', {class: 'dl'}, h('dt', null, 'Likutis dabar'), h('dd', null, h('strong', null, `${qty(p.stock || 0)} ${p.unit}`)),
      h('dt', null, 'Vidutinė savikaina'), h('dd', null, p.avg_cost ? eur(p.avg_cost) : '—'), h('dt', null, 'Nupirkta / parduota'), h('dd', null, `${qty(p.totals.purchased)} / ${qty(p.totals.sold)}`),
      h('dt', null, 'Rankiniai įrašai'), h('dd', null, qty(p.totals.manual)), h('dt', null, 'Paskutinis judėjimas'), h('dd', null, date(p.last_move))),
    ro ? null : h('button', {class: 'btn', onclick: adjust}, 'Pradinis likutis / koregavimas / nurašymas'), h('h3', null, 'Judėjimas'), stockBox) : null,
    id && stores.length ? section('E. parduotuvių susiejimai', h('p', null, (p.external_refs || []).map((x) => `${stores.find((s) => String(s.id) === String(x.storeId))?.name || x.storeId}: ${x.externalId}`).join('; ') || 'Nesusieta.'),
      ro ? null : h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post(`/api/products/${id}/external-refs`, {storeId: extStore.value, externalId: extId.value}), 'Susieta.')) card(main, id, state); }},
        h('div', {class: 'form-grid'}, field('Parduotuvė', extStore), field('Išorinis ID', extId)), h('button', {class: 'btn'}, 'Susieti'))) : null);
  if (id && p.track_stock) await loadMoves();
}

async function stock(main, state) {
  const groups = await get('/api/products/groups');
  const f = {asOf: input({type: 'date', value: today()}), group: select([['', 'Visos'], ...groups.map((g) => [g.group_name, g.group_name])], ''), nonzero: h('input', {type: 'checkbox', checked: true})};
  const box = h('div');
  const load = async () => {
    const d = await get(`/api/stock?${new URLSearchParams({asOf: f.asOf.value, group: f.group.value, nonzero: f.nonzero.checked ? 'true' : ''})}`);
    clear(box, table([{label: 'Kodas', key: 'sku'}, {label: 'Pavadinimas', render: (r) => h('a', {href: `#/prekes/${r.id}`}, r.name)}, {label: 'Grupė', key: 'group_name'}, {label: 'Vieta', key: 'location'},
      {label: 'Likutis', num: true, render: (r) => h('span', {class: r.below_min ? 'neg' : null}, `${qty(r.stock)} ${r.unit}`)}, {label: 'Min.', num: true, render: (r) => (r.min_stock === null ? '' : qty(r.min_stock))},
      {label: 'Vid. savikaina', num: true, render: (r) => money(r.avg_cost)}, {label: 'Vertė', num: true, render: (r) => money(r.value)}, {label: 'Paskutinis judėjimas', render: (r) => date(r.last_move)}], d.items, {empty: 'Likučių nėra.'}),
    h('p', {class: 'total-line'}, `Iš viso vertė (pagal vidutinę savikainą): `, h('strong', null, eur(d.totalValue))));
  };
  [f.asOf, f.group, f.nonzero].forEach((x) => x.addEventListener('change', () => guard(load)));
  clear(main, pageHeader('Prekių likučiai'), tabs('likuciai'),
    h('p', {class: 'hint'}, 'Likutis = pirkimai − pardavimai (iš užregistruotų sąskaitų, susietų su preke) ± pradiniai likučiai, koregavimai ir nurašymai. Vertė informacinė; DK atsargų vertė – sąskaitoje 204.'),
    h('div', {class: 'filters'}, field('Datai', f.asOf), field('Grupė', f.group), h('label', {class: 'check'}, f.nonzero, ' tik nenuliniai')), box);
  await load();
}

async function moves(main, state) {
  const prods = await get('/api/products?limit=500&active=');
  const f = {product: select([['', 'Visos prekės'], ...prods.items.filter((p) => p.track_stock).map((p) => [p.id, `${p.sku ? p.sku + ' ' : ''}${p.name}`])], ''), from: input({type: 'date', value: today().slice(0, 8) + '01'}), to: input({type: 'date', value: today()})};
  const st = {offset: 0, limit: 100};
  const box = h('div');
  const load = async () => {
    const d = await get(`/api/stock/moves?${new URLSearchParams({product: f.product.value, from: f.from.value, to: f.to.value, limit: st.limit, offset: st.offset})}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(box, table([{label: 'Data', render: (m) => date(m.move_date)}, {label: 'Prekė', render: (m) => h('a', {href: `#/prekes/${m.product_id}`}, `${m.sku ? m.sku + ' ' : ''}${m.product_name}`)}, {label: 'Operacija', render: (m) => MOVE[m.kind] || m.kind},
      {label: 'Dokumentas / pastaba', render: (m) => (m.source_type === 'invoice' ? h('a', {href: `#/${m.kind === 'purchase' ? 'pirkimai' : 'pardavimai'}/s/${m.source_id}`}, m.reference) : m.note)},
      {label: 'Kiekis', num: true, render: (m) => qty(m.quantity)}, {label: 'Kaina', num: true, render: (m) => money(m.unit_price)}, {label: 'Likutis po', num: true, render: (m) => qty(m.balance)}], d.items, {empty: 'Judėjimų nėra.'}), pager(st, load));
  };
  [f.product, f.from, f.to].forEach((x) => x.addEventListener('change', () => { st.offset = 0; guard(load); }));
  clear(main, pageHeader('Prekių judėjimas'), tabs('judejimas'), h('div', {class: 'filters'}, field('Prekė', f.product), field('Nuo', f.from), field('Iki', f.to)), box);
  await load();
}
