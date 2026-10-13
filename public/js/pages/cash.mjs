// Kasa: kasos pajamų (KPO) ir išlaidų (KIO) orderiai, kasos knyga.
import {h, clear, get, post, pageHeader, section, table, money, date, guard, select, input, field, can, today, toast, badge, promptDialog, apiUrl} from '../core.mjs';

const KIND = {receipt: 'Kasos pajamų orderis (KPO)', payment: 'Kasos išlaidų orderis (KIO)'};
const PURPOSE = {
  receipt: [['invoice', 'Pirkėjo sąskaitos apmokėjimas'], ['advance', 'Gautas avansas'], ['bank', 'Paimta iš banko'], ['accountable', 'Atskaitingo asmens grąžinti pinigai'], ['other', 'Kita (nurodyti sąskaitą)']],
  payment: [['invoice', 'Tiekėjo sąskaitos apmokėjimas'], ['advance', 'Sumokėtas avansas'], ['bank', 'Įnešta į banką'], ['accountable', 'Išduota atskaitingam asmeniui (avansas)'], ['other', 'Kita (nurodyti sąskaitą)']],
};
const STATUS = {posted: ['Užregistruotas', 'done'], cancelled: ['Anuliuotas', 'muted']};
const tabs = (cur) => h('div', {class: 'tabs'}, [['', 'Orderiai'], ['knyga', 'Kasos knyga']].map(([k, t]) => h('a', {class: ['tab', cur === k && 'active'], href: `#/kasa${k ? '/' + k : ''}`}, t)));
const pdf = (id) => { location.href = apiUrl(`/api/cash/orders/${id}/pdf`); };

export async function render(main, rest, state) {
  if (rest[0] === 'knyga') return book(main);
  if (rest[0] === 'naujas') return newOrder(main, rest[1] === 'KIO' ? 'payment' : 'receipt', state);
  if (rest[0]) return card(main, rest[0], state);
  return list(main, state);
}

async function list(main, state) {
  const from = input({type: 'date', value: `${today().slice(0, 4)}-01-01`}), to = input({type: 'date', value: today()});
  const kind = select([['', 'Visi'], ['receipt', 'KPO'], ['payment', 'KIO']], '');
  const out = h('div');
  const load = async () => {
    const rows = await get(`/api/cash/orders?${new URLSearchParams({from: from.value, to: to.value, kind: kind.value})}`);
    clear(out, table([{label: 'Data', render: (o) => date(o.doc_date)}, {label: 'Dokumentas', render: (o) => `${o.series} ${o.number}`}, {label: 'Rūšis', render: (o) => (o.kind === 'receipt' ? 'Pajamos' : 'Išlaidos')},
      {label: 'Gauta iš / išmokėta', key: 'who'}, {label: 'Pagrindas', key: 'basis'}, {label: 'Kor. sąsk.', key: 'account_code'},
      {label: 'Pajamos', num: true, render: (o) => (o.kind === 'receipt' ? money(o.amount) : '')}, {label: 'Išlaidos', num: true, render: (o) => (o.kind === 'payment' ? money(o.amount) : '')}, {label: 'Būsena', render: (o) => badge(STATUS, o.status)}],
    rows, {onRow: (o) => { location.hash = `#/kasa/${o.id}`; }, empty: 'Orderių šiuo laikotarpiu nėra.'}));
  };
  [from, to, kind].forEach((x) => x.addEventListener('change', () => guard(load)));
  clear(main, pageHeader('Kasa', can(state.user, 'approve') ? [h('a', {class: 'btn btn-primary', href: '#/kasa/naujas/KPO'}, '+ KPO (pajamos)'), h('a', {class: 'btn btn-primary', href: '#/kasa/naujas/KIO'}, '+ KIO (išlaidos)')] : null), tabs(''),
    section(null, h('div', {class: 'filters'}, field('Nuo', from), field('Iki', to), field('Rūšis', kind))), out);
  await load();
}

async function newOrder(main, kind, state) {
  const [accounts, employees] = await Promise.all([get('/api/accounts'), get('/api/employees?active=true')]);
  const f = {
    date: input({type: 'date', value: today()}), purpose: select(PURPOSE[kind], 'invoice'), amount: input({inputmode: 'decimal'}), basis: input({placeholder: 'pvz. Apmokėjimas pagal PVM SF'}),
    attachment: input({placeholder: 'pvz. sąskaita faktūra, kvitas'}), personName: input(), personCode: input({placeholder: 'asmens ar įmonės kodas (nebūtina)'}),
    invoice: select([['', '— pasirinkite —']], ''), cp: select([['', '— pasirinkite —']], ''), cpSearch: input({type: 'search', placeholder: 'Ieškoti kontrahento'}),
    employee: select([['', '— pasirinkite —'], ...employees.map((e) => [e.id, `${e.first_name} ${e.last_name}`])], ''),
    account: select([['', '— pasirinkite —'], ...accounts.filter((a) => a.active && a.postable !== false && !a.code.startsWith('272')).map((a) => [a.code, `${a.code} ${a.name}`])], ''),
  };
  let invoices = [];
  const extra = h('div', {class: 'form-grid'});
  const loadInvoices = async () => {
    invoices = await get(`/api/cash/open-invoices?kind=${kind}`);
    clear(f.invoice, h('option', {value: ''}, '— pasirinkite —'), invoices.map((x) => h('option', {value: x.id}, `${x.label} · ${x.counterparty} · likutis ${money(x.outstanding)} €`)));
  };
  const loadCp = async () => {
    const d = await get(`/api/counterparties?${new URLSearchParams({q: f.cpSearch.value, limit: 50})}`);
    clear(f.cp, h('option', {value: ''}, '— pasirinkite —'), d.items.map((c) => h('option', {value: c.id}, `${c.name}${c.company_code ? ` (${c.company_code})` : ''}`)));
  };
  f.invoice.addEventListener('change', () => { const x = invoices.find((i) => i.id === f.invoice.value); if (x) { f.amount.value = x.outstanding; f.personName.value = x.counterparty || ''; f.basis.value = `Sąskaita ${x.label}`; } });
  f.cpSearch.addEventListener('input', () => guard(loadCp));
  f.cp.addEventListener('change', () => { f.personName.value = f.cp.selectedOptions[0]?.textContent.replace(/ \(\d+\)$/, '') || ''; });
  f.employee.addEventListener('change', () => { f.personName.value = f.employee.selectedOptions[0]?.textContent || ''; });
  const drawExtra = () => {
    const p = f.purpose.value;
    clear(extra, p === 'invoice' ? field('Sąskaita', f.invoice) : null, p === 'advance' ? [field('Kontrahento paieška', f.cpSearch), field('Kontrahentas', f.cp)] : null,
      p === 'accountable' ? field('Atskaitingas asmuo', f.employee, 'Sąskaita 2445 „Iš atskaitingų asmenų gautinos sumos“') : null,
      p === 'other' ? field('Korespondencinė sąskaita', f.account) : null,
      p === 'bank' ? h('p', {class: 'hint'}, 'Kontuojama per 273 „Pinigai kelyje“; banko išraše tą operaciją pažymėkite kaip pervedimą tarp savo sąskaitų.') : null);
  };
  f.purpose.addEventListener('change', drawExtra);
  const submit = (e) => guard(async () => {
    e.preventDefault();
    const r = await post('/api/cash/orders', {kind, date: f.date.value, purpose: f.purpose.value, amount: f.amount.value, basis: f.basis.value, attachment: f.attachment.value, personName: f.personName.value, personCode: f.personCode.value,
      invoiceId: f.invoice.value || undefined, counterpartyId: f.cp.value || undefined, employeeId: f.employee.value || undefined, accountCode: f.account.value || undefined});
    r.warnings?.forEach((w) => toast(w, 'error'));
    toast(`${r.series} ${r.number} užregistruotas.`, 'ok');
    location.hash = `#/kasa/${r.id}`;
  });
  clear(main, pageHeader(KIND[kind]), tabs(''),
    section(null, h('form', {onsubmit: submit},
      h('div', {class: 'form-grid'}, field('Data', f.date), field('Operacija', f.purpose), field('Suma, €', f.amount)), extra,
      h('div', {class: 'form-grid'}, field(kind === 'receipt' ? 'Gauta iš' : 'Išmokėta (kam)', f.personName), field('Kodas', f.personCode), field('Pagrindas', f.basis), field('Priedai', f.attachment)),
      h('p', {class: 'hint'}, `Numeris (${kind === 'receipt' ? 'KPO' : 'KIO'}) suteikiamas išsaugant. ${kind === 'payment' ? 'Išmokėti galima tik tiek, kiek kasoje yra tos dienos pabaigoje. ' : ''}Atsiskaitymai grynaisiais virš 5 000 € pagal vieną sandorį ribojami.`),
      h('button', {class: 'btn btn-primary'}, 'Registruoti ir kontuoti'))));
  drawExtra();
  await Promise.all([loadInvoices(), loadCp()]);
}

async function card(main, id, state) {
  const o = await get(`/api/cash/orders/${id}`);
  const who = o.person_name || o.counterparty_name;
  clear(main, pageHeader(`${o.kind === 'receipt' ? 'KPO' : 'KIO'} ${o.series} ${o.number}`,
    h('button', {class: 'btn btn-primary', onclick: () => pdf(o.id)}, '⇩ PDF (spausdinti)'),
    o.status === 'posted' && can(state.user, 'approve') ? h('button', {class: 'btn btn-danger', onclick: () => guard(async () => {
      const reason = await promptDialog('Anuliuoti orderį', 'Priežastis', {minLength: 5});
      if (!reason) return;
      await post(`/api/cash/orders/${o.id}/cancel`, {reason}); toast('Orderis anuliuotas atvirkštiniu įrašu.', 'ok'); card(main, id, state);
    })}, 'Anuliuoti') : null), tabs(''),
    section(KIND[o.kind], h('dl', {class: 'details'},
      ...[['Data', o.doc_date], [o.kind === 'receipt' ? 'Gauta iš' : 'Išmokėta', [who, o.person_code || o.counterparty_code].filter(Boolean).join(', ')], ['Pagrindas', o.basis || (o.invoice_number ? `Sąskaita ${o.invoice_series || ''} ${o.invoice_number}` : '—')],
        ['Korespondencinė sąskaita', `${o.account_code} ${o.account_name}`], ['Kasos sąskaita', o.cash_account], ['Suma', `${money(o.amount)} €`], ['Priedai', o.attachment || '—'],
        ['Būsena', o.status === 'cancelled' ? `Anuliuotas: ${o.cancel_reason}` : 'Užregistruotas'], ['Įrašas', o.journal_entry_id ? `#${o.journal_entry_id}` : '—']].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))));
}

async function book(main) {
  const from = input({type: 'date', value: `${today().slice(0, 7)}-01`}), to = input({type: 'date', value: today()});
  const out = h('div');
  const load = async () => {
    const b = await get(`/api/cash/book?${new URLSearchParams({from: from.value, to: to.value})}`);
    clear(out, h('div', {class: 'cards'}, [['Likutis laikotarpio pradžioje', b.opening], ['Pajamos', b.receipts], ['Išlaidos', b.payments], ['Likutis laikotarpio pabaigoje', b.closing]]
      .map(([t, v]) => h('div', {class: 'card stat'}, h('div', {class: 'stat-title'}, t), h('div', {class: 'stat-value'}, `${money(v)} €`)))),
    b.days.length ? b.days.map((d) => section(`${d.date} · likutis dienos pradžioje ${money(d.opening)} €`,
      table([{label: 'Dokumentas', render: (r) => (r.orderId ? h('a', {href: `#/kasa/${r.orderId}`}, r.document) : r.document)}, {label: 'Gauta iš / išmokėta', key: 'who'}, {label: 'Turinys', key: 'description'},
        {label: 'Pajamos', num: true, render: (r) => (Number(r.receipt) ? money(r.receipt) : '')}, {label: 'Išlaidos', num: true, render: (r) => (Number(r.payment) ? money(r.payment) : '')}, {label: 'Likutis', num: true, render: (r) => money(r.balance)}], d.rows),
      h('p', {class: 'hint'}, `Dienos apyvarta: pajamos ${money(d.receipts)} €, išlaidos ${money(d.payments)} €, likutis dienos pabaigoje ${money(d.closing)} €.`)))
      : h('p', {class: 'hint'}, 'Kasos operacijų šiuo laikotarpiu nėra.'));
  };
  [from, to].forEach((x) => x.addEventListener('change', () => guard(load)));
  clear(main, pageHeader('Kasos knyga'), tabs('knyga'), section(null, h('div', {class: 'filters'}, field('Nuo', from), field('Iki', to)),
    h('p', {class: 'hint'}, 'Visi 272 „Kasa“ sąskaitos judėjimai pagal dienas: kasos orderiai ir kiti įrašai su kasa.')), out);
  await load();
}
