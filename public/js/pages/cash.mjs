// Kasa: kasos pajamų (KPO) ir išlaidų (KIO) orderiai, kasos knyga.
import {h, clear, get, post, put, del, pageHeader, section, table, money, date, dateTime, guard, select, input, field, can, today, toast, badge, promptDialog, confirmDialog, apiUrl} from '../core.mjs';

const KIND = {receipt: 'Kasos pajamų orderis (KPO)', payment: 'Kasos išlaidų orderis (KIO)'};
const PURPOSE = {
  receipt: [['invoice', 'Pirkėjo sąskaitos apmokėjimas'], ['advance', 'Gautas avansas'], ['bank', 'Paimta iš banko'], ['accountable', 'Atskaitingo asmens grąžinti pinigai'], ['other', 'Kita (nurodyti sąskaitą)']],
  payment: [['invoice', 'Tiekėjo sąskaitos apmokėjimas'], ['advance', 'Sumokėtas avansas'], ['bank', 'Įnešta į banką'], ['accountable', 'Išduota atskaitingam asmeniui (avansas)'], ['other', 'Kita (nurodyti sąskaitą)']],
};
const STATUS = {posted: ['Užregistruotas', 'done'], cancelled: ['Anuliuotas', 'muted'], deleted: ['Ištrintas', 'muted']};
const tabs = (cur) => h('div', {class: 'tabs'}, [['', 'Orderiai'], ['knyga', 'Kasos knyga']].map(([k, t]) => h('a', {class: ['tab', cur === k && 'active'], href: `#/kasa${k ? '/' + k : ''}`}, t)));
const pdf = (id) => { location.href = apiUrl(`/api/cash/orders/${id}/pdf`); };

export async function render(main, rest, state) {
  if (rest[0] === 'knyga') return book(main);
  if (rest[0] === 'naujas') return newOrder(main, rest[1] === 'KIO' ? 'payment' : 'receipt', state);
  if (rest[0] && rest[1] === 'taisyti') { const o = await get(`/api/cash/orders/${rest[0]}`); return newOrder(main, o.kind, state, o); }
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

async function newOrder(main, kind, state, edit = null) {
  const [accounts, allEmployees] = await Promise.all([get('/api/accounts'), get('/api/employees')]);
  // Active employees, plus the one on the order being corrected (may have left since).
  const employees = allEmployees.filter((e) => e.active || String(e.id) === String(edit?.employee_id || ''));
  const cashAccounts = accounts.filter((a) => a.active && a.postable !== false && a.code.startsWith('272'));
  const f = {
    date: input({type: 'date', value: edit?.doc_date || today()}), purpose: select(PURPOSE[kind], edit?.purpose || 'invoice'), amount: input({inputmode: 'decimal', value: edit ? edit.amount : ''}), basis: input({placeholder: 'pvz. Apmokėjimas pagal PVM SF', value: edit?.basis || ''}),
    attachment: input({placeholder: 'pvz. sąskaita faktūra, kvitas', value: edit?.attachment || ''}), personName: input({value: edit?.person_name || ''}), personCode: input({placeholder: 'asmens ar įmonės kodas (nebūtina)', value: edit?.person_code || ''}),
    invoice: select([['', '— pasirinkite —']], ''), cp: select([['', '— pasirinkite —']], ''), cpSearch: input({type: 'search', placeholder: 'Ieškoti kontrahento'}),
    employee: select([['', '— pasirinkite —'], ...employees.map((e) => [e.id, `${e.first_name} ${e.last_name}`])], ''),
    cash: select(cashAccounts.map((a) => [a.code, `${a.code} ${a.name}`]), edit?.cash_account || cashAccounts[0]?.code || '272'),
    account: select([['', '— pasirinkite —'], ...accounts.filter((a) => a.active && a.postable !== false && !a.code.startsWith('272')).map((a) => [a.code, `${a.code} ${a.name}`])], ''),
  };
  let invoices = [];
  const extra = h('div', {class: 'form-grid'});
  const loadInvoices = async () => {
    invoices = await get(`/api/cash/open-invoices?kind=${kind}`);
    // The invoice this order pays is (partly) settled by it: offer it with what this order paid added back.
    if (edit?.invoice_id) {
      const own = invoices.find((x) => x.id === String(edit.invoice_id));
      if (own) own.outstanding = (Number(own.outstanding) + Number(edit.amount)).toFixed(2);
      else invoices.unshift({id: String(edit.invoice_id), label: `${edit.invoice_series || ''} ${edit.invoice_number}`.trim(), counterparty: edit.counterparty_name || edit.person_name, outstanding: edit.amount});
    }
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
    const reason = edit ? await promptDialog(`Taisyti ${edit.series} ${edit.number}`, 'Kas taisoma (bus įrašyta į audito žurnalą)', {minLength: 3}) : null;
    if (edit && !reason) return;
    const r = await (edit ? (b) => put(`/api/cash/orders/${edit.id}`, {...b, reason}) : (b) => post('/api/cash/orders', b))({kind, date: f.date.value, purpose: f.purpose.value, amount: f.amount.value, basis: f.basis.value, attachment: f.attachment.value, personName: f.personName.value, personCode: f.personCode.value,
      invoiceId: f.invoice.value || undefined, counterpartyId: f.cp.value || undefined, employeeId: f.employee.value || undefined, accountCode: f.account.value || undefined, cashAccount: f.cash.value || undefined});
    r.warnings?.forEach((w) => toast(w, 'error'));
    toast(`${r.series} ${r.number} ${edit ? 'pataisytas (senas įrašas atšauktas, užregistruotas naujas)' : 'užregistruotas'}.`, 'ok');
    location.hash = `#/kasa/${r.id}`;
  });
  clear(main, pageHeader(edit ? `Taisyti ${edit.series} ${edit.number}` : KIND[kind]), tabs(''),
    section(null, h('form', {onsubmit: submit},
      h('div', {class: 'form-grid'}, field('Data', f.date), field('Operacija', f.purpose), field('Suma, €', f.amount), cashAccounts.length > 1 || edit ? field('Kasa', f.cash) : null), extra,
      h('div', {class: 'form-grid'}, field(kind === 'receipt' ? 'Gauta iš' : 'Išmokėta (kam)', f.personName), field('Kodas', f.personCode), field('Pagrindas', f.basis), field('Priedai', f.attachment)),
      h('p', {class: 'hint'}, `Numeris (${kind === 'receipt' ? 'KPO' : 'KIO'}) suteikiamas išsaugant. ${kind === 'payment' ? 'Išmokėti galima tik tiek, kiek kasoje yra tos dienos pabaigoje. ' : ''}Atsiskaitymai grynaisiais virš 5 000 € pagal vieną sandorį ribojami.`),
      h('button', {class: 'btn btn-primary'}, edit ? 'Išsaugoti pataisymą' : 'Registruoti ir kontuoti'))));
  drawExtra();
  await Promise.all([loadInvoices(), loadCp()]);
  if (edit) {
    if (edit.invoice_id) f.invoice.value = String(edit.invoice_id);
    if (edit.counterparty_id && edit.purpose === 'advance') { f.cp.append(h('option', {value: edit.counterparty_id}, edit.counterparty_name || edit.person_name)); f.cp.value = String(edit.counterparty_id); }
    if (edit.employee_id) f.employee.value = String(edit.employee_id);
    if (edit.purpose === 'other') f.account.value = edit.account_code;
  }
}

async function card(main, id, state) {
  const o = await get(`/api/cash/orders/${id}`);
  const who = o.person_name || o.counterparty_name;
  clear(main, pageHeader(`${o.series} ${o.display_number || o.number}${o.status === 'deleted' ? ' (ištrintas)' : ''}`,
    h('button', {class: 'btn btn-primary', onclick: () => pdf(o.id)}, '⇩ PDF (spausdinti)'),
    o.status === 'posted' && can(state.user, 'approve') ? h('a', {class: 'btn', href: `#/kasa/${o.id}/taisyti`}, 'Taisyti') : null,
    o.status === 'posted' && can(state.user, 'approve') ? h('button', {class: 'btn', onclick: () => guard(async () => {
      const reason = await promptDialog('Anuliuoti orderį', 'Priežastis (numeris lieka, orderis žymimas anuliuotu)', {minLength: 5});
      if (!reason) return;
      await post(`/api/cash/orders/${o.id}/cancel`, {reason}); toast('Orderis anuliuotas atvirkštiniu įrašu.', 'ok'); card(main, id, state);
    })}, 'Anuliuoti') : null,
    o.status !== 'deleted' && can(state.user, 'approve') ? h('button', {class: 'btn btn-danger', onclick: () => guard(async () => {
      const reason = await promptDialog(`Ištrinti ${o.series} ${o.number}`, 'Kodėl trinama? Ištrinti galima tik paskutinį serijos orderį: jo įrašas atšaukiamas, o numeris vėl laisvas kitam orderiui.', {minLength: 3});
      if (!reason) return;
      const r = await del(`/api/cash/orders/${o.id}`, {reason}); toast(`Ištrinta. Numeris ${r.freedNumber} vėl laisvas.`, 'ok'); location.hash = '#/kasa';
    })}, 'Ištrinti') : null), tabs(''),
    section(KIND[o.kind], h('dl', {class: 'details'},
      ...[['Data', o.doc_date], [o.kind === 'receipt' ? 'Gauta iš' : 'Išmokėta', [who, o.person_code || o.counterparty_code].filter(Boolean).join(', ')], ['Pagrindas', o.basis || (o.invoice_number ? `Sąskaita ${o.invoice_series || ''} ${o.invoice_number}` : '—')],
        ['Korespondencinė sąskaita', `${o.account_code} ${o.account_name}`], ['Kasos sąskaita', o.cash_account], ['Suma', `${money(o.amount)} €`], ['Priedai', o.attachment || '—'],
        ['Būsena', o.status === 'cancelled' ? `Anuliuotas: ${o.cancel_reason}` : o.status === 'deleted' ? `Ištrintas: ${o.cancel_reason}` : 'Užregistruotas'], ['Įrašas', o.journal_entry_id ? `#${o.journal_entry_id}` : '—']].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
    o.revisions?.length ? section('Pakeitimų istorija', table([{label: 'Kada', render: (v) => dateTime(v.changed_at)}, {label: 'Veiksmas', render: (v) => (v.kind === 'edit' ? 'Pataisyta' : 'Ištrinta')},
      {label: 'Kas pakeista (buvo → tapo)', render: (v) => v.changes || (v.kind === 'edit' ? '—' : `Buvo: ${v.doc_date}, ${money(v.amount)} €, ${v.person_name || ''}`)}, {label: 'Priežastis', key: 'reason'}, {label: 'Kas', key: 'changed_by'}], o.revisions)) : null);
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
