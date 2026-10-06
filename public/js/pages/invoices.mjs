// Shared invoice list, detail and manual invoice form (used by Pardavimai and Pirkimai).
import {h, clear, get, post, pageHeader, section, table, badge, PAY, DOC_TYPE, eur, money, date, dateTime, guard, select, input, field, pager, debounce, can, openFile, toast, LINE_TYPE, VAT_T, yearStart, today} from '../core.mjs';

export async function invoiceList(main, register, state, extraTabs = null) {
  const base = register === 'sales' ? 'pardavimai' : 'pirkimai';
  const st = {q: '', from: yearStart(), to: today(), store: '', offset: 0, limit: 50, count: 0, hasMore: false};
  const box = h('div');
  const stores = register === 'sales' ? await get('/api/stores') : [];
  const load = async () => {
    const qs = new URLSearchParams({register, limit: st.limit, offset: st.offset, from: st.from, to: st.to, ...(st.q && {q: st.q}), ...(st.store && {store: st.store})});
    const d = await get(`/api/invoices?${qs}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(box, table([
      {label: 'Data', render: (r) => date(r.issue_date)},
      {label: 'Numeris', render: (r) => h('a', {href: `#/${base}/s/${r.id}`}, `${r.series} ${r.number}`.trim())},
      {label: 'Tipas', render: (r) => DOC_TYPE[r.doc_type] || r.doc_type},
      {label: register === 'sales' ? 'Pirkėjas' : 'Tiekėjas', key: 'counterparty'},
      ...(register === 'sales' ? [{label: 'Parduotuvė', render: (r) => r.store_name || '—'}] : []),
      {label: 'Be PVM', num: true, render: (r) => money(r.net_total)}, {label: 'PVM', num: true, render: (r) => money(r.vat_total)}, {label: 'Su PVM', num: true, render: (r) => money(r.gross_total)},
      {label: 'Mokėjimas', render: (r) => (r.balance ? h('span', null, badge(PAY, r.balance.payment_status), Number(r.balance.outstanding) ? ` likutis ${money(r.balance.outstanding)}` : '') : r.related_invoice_id ? 'susieta' : '—')},
      {label: 'Terminas', render: (r) => date(r.due_date)},
    ], d.items, {onRow: (r) => { location.hash = `#/${base}/s/${r.id}`; }, empty: 'Užregistruotų sąskaitų nėra.'}), pager(st, load));
  };
  const from = input({type: 'date', value: st.from, onchange: () => { st.from = from.value; st.offset = 0; load(); }});
  const to = input({type: 'date', value: st.to, onchange: () => { st.to = to.value; st.offset = 0; load(); }});
  const q = input({type: 'search', placeholder: 'Numeris arba kontrahentas', oninput: debounce(() => { st.q = q.value; st.offset = 0; load(); })});
  const storeSel = stores.length ? select([['', 'Visos parduotuvės'], ...stores.map((s) => [s.id, s.name])], '', {onchange: () => { st.store = storeSel.value; load(); }, 'aria-label': 'Parduotuvė'}) : null;
  clear(main, pageHeader(register === 'sales' ? 'Pardavimai' : 'Pirkimai', can(state.user, 'write') ? h('a', {class: 'btn btn-primary', href: `#/${base}/nauja`}, register === 'sales' ? '+ Nauja sąskaita' : '+ Rankinis pirkimas') : null),
    extraTabs, h('div', {class: 'filters'}, field('Nuo', from), field('Iki', to), field('Paieška', q), storeSel ? field('Parduotuvė', storeSel) : null),
    h('p', {class: 'hint'}, 'Rodomos patvirtintos (užregistruotos) sąskaitos. Patvirtinimo ir apmokėjimo būsenos yra atskiros.'), box);
  await load();
}

export async function invoiceDetail(main, id, state) {
  const inv = await get(`/api/invoices/${id}`);
  const base = inv.register === 'sales' ? 'pardavimai' : 'pirkimai';
  const actions = [];
  if (inv.register === 'sales' && ['vat_invoice', 'invoice'].includes(inv.doc_type) && can(state.user, 'write')) actions.push(h('button', {class: 'btn', onclick: () => creditNote(inv)}, 'Kreditinė sąskaita / grąžinimas'));
  if (inv.document_id) actions.push(h('a', {class: 'btn', href: inv.register === 'sales' && !inv.document_id ? '#' : `#/dokumentai/${inv.document_id}`}, 'Dokumentas ir failai'));
  if (inv.register === 'sales') actions.push(h('button', {class: 'btn', onclick: () => guard(async () => { const {url} = await get(`/api/invoices/${inv.id}/pdf-link`); window.open(url, '_blank', 'noopener'); })}, 'PDF'));
  const cp = inv.counterparty_snapshot || {};
  clear(main, pageHeader(`${DOC_TYPE[inv.doc_type] || ''} ${inv.series} ${inv.number}`, h('a', {class: 'btn btn-small', href: `#/${base}`}, '‹ Sąrašas'), ...actions),
    h('div', {class: 'cols'},
      section('Rekvizitai', h('dl', {class: 'dl'},
        h('dt', null, 'Išrašyta'), h('dd', null, date(inv.issue_date)), h('dt', null, 'PVM data'), h('dd', null, date(inv.vat_point_date)), h('dt', null, 'Terminas'), h('dd', null, date(inv.due_date)),
        h('dt', null, inv.register === 'sales' ? 'Pirkėjas' : 'Tiekėjas'), h('dd', null, `${cp.name || ''} ${cp.companyCode ? `(${cp.companyCode})` : ''} ${cp.vatCode || ''}`),
        h('dt', null, 'Adresas'), h('dd', null, cp.address || '—'), h('dt', null, 'Užsakymas'), h('dd', null, inv.order ? `${inv.store_name || ''} #${inv.order.order_number} (${inv.order.state})` : inv.order_reference || '—'),
        h('dt', null, 'Patvirtino'), h('dd', null, `${inv.approved_by_name} ${dateTime(inv.approved_at)}`))),
      section('Apmokėjimas', inv.balance ? h('dl', {class: 'dl'}, h('dt', null, 'Būsena'), h('dd', null, badge(PAY, inv.balance.payment_status)), h('dt', null, 'Su korekcijomis'), h('dd', null, eur(inv.balance.gross)),
        h('dt', null, 'Apmokėta'), h('dd', null, eur(inv.balance.paid)), h('dt', null, 'Likutis'), h('dd', null, eur(inv.balance.outstanding))) : h('p', null, 'Susieta su kita sąskaita.'),
      table([{label: 'Data', render: (a) => date(a.booking_date || a.approved_at)}, {label: 'Tipas', key: 'kind'}, {label: 'Mokėtojas', key: 'counterparty_name'}, {label: 'Suma', num: true, render: (a) => money(a.amount)}], inv.allocations, {empty: 'Mokėjimų nėra.', onRow: (a) => a.transaction_id && (location.hash = `#/bankas/tx/${a.transaction_id}`)}))),
    section('Eilutės', table([{label: '#', key: 'line_no'}, {label: 'Aprašymas', key: 'description'}, {label: 'Kiekis', num: true, render: (l) => Number(l.quantity)}, {label: 'Kaina', num: true, render: (l) => money(l.unit_price)},
      {label: 'Be PVM', num: true, render: (l) => money(l.net)}, {label: 'PVM', render: (l) => `${l.tax_code} ${Number(l.vat_rate)} %`}, {label: 'PVM suma', num: true, render: (l) => money(l.vat)}, {label: 'Sąskaita', key: 'account_code'}, {label: 'Tipas', render: (l) => LINE_TYPE[l.line_type] || l.line_type}, {label: 'PVM atskaita', render: (l) => VAT_T[l.vat_treatment] || ''}], inv.lines),
    h('div', {class: 'totals'}, h('div', null, h('span', null, 'Be PVM'), h('strong', null, eur(inv.net_total))), h('div', null, h('span', null, 'PVM'), h('strong', null, eur(inv.vat_total))), h('div', null, h('span', null, 'Iš viso'), h('strong', null, eur(inv.gross_total))))),
    section('Didžiosios knygos įrašas', table([{label: 'Sąskaita', render: (l) => `${l.account_code} ${l.account_name}`}, {label: 'Debetas', num: true, render: (l) => (Number(l.debit) ? money(l.debit) : '')}, {label: 'Kreditas', num: true, render: (l) => (Number(l.credit) ? money(l.credit) : '')}], inv.entry)),
    inv.related.length ? section('Susiję dokumentai', table([{label: 'Tipas', render: (r) => DOC_TYPE[r.doc_type]}, {label: 'Numeris', render: (r) => `${r.series} ${r.number}`}, {label: 'Data', render: (r) => date(r.issue_date)}, {label: 'Suma', num: true, render: (r) => money(r.gross_total)}], inv.related, {onRow: (r) => { location.hash = `#/${base}/s/${r.id}`; }})) : null);
}

async function creditNote(inv) {
  const {modal} = await import('../core.mjs');
  const qty = inv.lines.map((l) => input({value: '0', inputmode: 'decimal', 'aria-label': `Kiekis ${l.description}`}));
  const reason = input({placeholder: 'Pvz. grąžintos prekės'});
  const dt = input({type: 'date', value: today()});
  const m = modal('Kreditinė sąskaita', h('form', {onsubmit: async (e) => {
    e.preventDefault();
    const lines = inv.lines.map((l, i) => ({lineNo: l.line_no, quantity: qty[i].value})).filter((x) => Number(x.quantity) > 0);
    const r = await guard(() => post(`/api/invoices/${inv.id}/credit-note`, {lines, reason: reason.value, issueDate: dt.value}));
    if (r) { m.close(); toast('Kreditinės sąskaitos pasiūlymas sukurtas – peržiūrėkite ir patvirtinkite.', 'ok'); location.hash = `#/deze/${r.documentId}`; }
  }}, h('p', {class: 'hint'}, 'Originali sąskaita nekeičiama; sukuriama susieta kreditinė sąskaita su neigiamais kiekiais.'),
  table([{label: 'Eilutė', key: 'description'}, {label: 'Parduota', num: true, render: (l) => Number(l.quantity)}, {label: 'Kredituoti', render: (l) => qty[inv.lines.indexOf(l)]}], inv.lines),
  field('Priežastis', reason), field('Data', dt), h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Sukurti pasiūlymą'))), {wide: true});
}

export async function manualForm(main, register, state) {
  const base = register === 'sales' ? 'pardavimai' : 'pirkimai';
  const [series, taxCodes, accounts, products] = await Promise.all([get('/api/series'), get('/api/tax-codes'), get('/api/accounts'), get('/api/products?limit=200')]);
  const cps = (await get(`/api/counterparties?limit=200`)).items;
  const cpSel = select([['', '— naujas kontrahentas —'], ...cps.map((c) => [c.id, `${c.name}${c.company_code ? ` (${c.company_code})` : ''}`])], '');
  const cpNew = {name: input(), companyCode: input(), vatCode: input(), address: input(), country: input({value: 'LT'})};
  const f = {issueDate: input({type: 'date', value: today()}), dueDate: input({type: 'date'}), seriesCode: select(series.filter((s) => s.doc_type === 'invoice').map((s) => [s.code, `${s.code} (${s.description})`]), 'PP'),
    series: input(), number: input(), orderReference: input(), notes: input()};
  const taxOpts = [...new Set(taxCodes.filter((t) => t.active).map((t) => t.code))].map((c) => [c, c]);
  if (register === 'purchase') taxOpts.unshift(['BE_PVM', 'Be PVM']);
  const lines = [];
  const linesBox = h('tbody');
  const accOpts = [['', 'Pagal taisykles / pasirinkite'], ...accounts.filter((a) => a.active && (register === 'sales' ? a.type === 'revenue' : ['expense', 'asset'].includes(a.type))).map((a) => [a.code, `${a.code} ${a.name}`])];
  const addLine = () => {
    const l = {product: select([['', '—'], ...products.items.map((p) => [p.id, `${p.sku ? p.sku + ' ' : ''}${p.name}`])], ''), description: input({'aria-label': 'Aprašymas'}), quantity: input({value: '1', inputmode: 'decimal', 'aria-label': 'Kiekis'}),
      unitPrice: input({inputmode: 'decimal', 'aria-label': 'Kaina'}), taxCode: select(taxOpts, 'PVM1', {'aria-label': 'PVM'}), accountCode: select(accOpts, '', {'aria-label': 'Sąskaita'})};
    l.product.onchange = () => { const p = products.items.find((x) => String(x.id) === l.product.value); if (p) { l.description.value = p.name; if (p.unit_price) l.unitPrice.value = p.unit_price; l.taxCode.value = p.tax_code; } };
    lines.push(l);
    linesBox.append(h('tr', null, h('td', null, l.product), h('td', null, l.description), h('td', null, l.quantity), h('td', null, l.unitPrice), h('td', null, l.taxCode), h('td', null, l.accountCode)));
  };
  addLine();
  const submit = async (e) => {
    e.preventDefault();
    const body = {register, issueDate: f.issueDate.value, dueDate: f.dueDate.value, seriesCode: f.seriesCode.value, series: f.series.value, number: f.number.value, orderReference: f.orderReference.value, notes: f.notes.value,
      counterpartyId: cpSel.value || null, counterparty: Object.fromEntries(Object.entries(cpNew).map(([k, v]) => [k, v.value])),
      lines: lines.filter((l) => l.description.value).map((l) => ({productId: l.product.value || null, description: l.description.value, quantity: l.quantity.value, unitPrice: l.unitPrice.value.replace(',', '.'), taxCode: l.taxCode.value, accountCode: l.accountCode.value || undefined}))};
    const r = await guard(() => post('/api/manual-invoices', body));
    if (r) { toast('Juodraštis sukurtas – peržiūrėkite ir patvirtinkite.', 'ok'); location.hash = `#/deze/${r.documentId}`; }
  };
  clear(main, pageHeader(register === 'sales' ? 'Nauja pardavimo sąskaita' : 'Rankinis pirkimas', h('a', {class: 'btn btn-small', href: `#/${base}`}, '‹ Atgal')),
    h('form', {onsubmit: submit},
      section('Dokumentas', h('div', {class: 'form-grid'}, field('Data', f.issueDate), field('Apmokėti iki', f.dueDate),
        register === 'sales' ? field('Serija', f.seriesCode, 'Numeris suteikiamas tvirtinant') : [field('Tiekėjo serija', f.series), field('Numeris', f.number)], field('Užsakymo nr.', f.orderReference), field('Pastabos', f.notes))),
      section(register === 'sales' ? 'Pirkėjas' : 'Tiekėjas', field('Esamas kontrahentas', cpSel), h('div', {class: 'form-grid'}, field('Pavadinimas', cpNew.name), field('Įmonės kodas', cpNew.companyCode), field('PVM kodas', cpNew.vatCode), field('Adresas', cpNew.address), field('Šalis', cpNew.country))),
      section('Eilutės', h('div', {class: 'table-wrap'}, h('table', {class: 'grid'}, h('thead', null, h('tr', null, ['Prekė', 'Aprašymas', 'Kiekis', 'Kaina be PVM', 'PVM', 'Sąskaita'].map((t) => h('th', null, t)))), linesBox)),
        h('button', {type: 'button', class: 'btn btn-small', onclick: addLine}, '+ Eilutė')),
      h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Sukurti juodraštį peržiūrai'))));
}
