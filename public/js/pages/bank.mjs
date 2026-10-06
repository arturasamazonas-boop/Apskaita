// Bankas ir mokėjimai: accounts, statement import with mapping preview, statements with balance checks,
// transaction review with evidence-based allocation editor, advances.
import {h, clear, get, post, put, upload, pageHeader, section, table, badge, TX, eur, money, date, dateTime, toast, showError, guard, select, input, field, pager, debounce, can, modal, promptDialog, openFile} from '../core.mjs';

const TABS = [['', 'Operacijos'], ['israsai', 'Išrašai'], ['importas', 'Importuoti išrašą'], ['avansai', 'Avansai'], ['saskaitos', 'Banko sąskaitos']];
const tabs = (cur) => h('div', {class: 'tabs'}, TABS.map(([k, t]) => h('a', {class: ['tab', cur === k && 'active'], href: `#/bankas${k ? '/' + k : ''}`}, t)));

export async function render(main, rest, state) {
  const [sub, id] = rest;
  if (sub === 'tx') return txDetail(main, id, state);
  if (sub === 'israsai') return id ? statementDetail(main, id, state) : statements(main, state);
  if (sub === 'importas') return importView(main, state);
  if (sub === 'avansai') return advances(main, state);
  if (sub === 'saskaitos') return accountsView(main, state);
  return transactions(main, state);
}

async function transactions(main, state) {
  const st = {status: 'open', q: '', offset: 0, limit: 50};
  const box = h('div');
  const load = async () => {
    const d = await get(`/api/bank/transactions?${new URLSearchParams({status: st.status, q: st.q, limit: st.limit, offset: st.offset})}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(box, table([{label: 'Data', render: (t) => date(t.booking_date)}, {label: 'Sąskaita', key: 'account_name'}, {label: 'Kontrahentas', key: 'counterparty_name'}, {label: 'Paskirtis', render: (t) => h('span', {class: 'clip'}, t.reference)},
      {label: 'Suma', num: true, render: (t) => h('span', {class: Number(t.amount) < 0 ? 'neg' : 'pos'}, money(t.amount))}, {label: 'Būsena', render: (t) => h('span', null, badge(TX, t.status), t.duplicate_review ? h('span', {class: 'badge badge-error'}, ' galimas dublikatas') : null)},
      {label: 'Pasiūlymas', render: (t) => t.first_error || t.explanation || ''}], d.items, {onRow: (t) => { location.hash = `#/bankas/tx/${t.id}`; }, empty: 'Operacijų nėra.'}), pager(st, load));
  };
  const sSel = select([['open', 'Nesuderintos'], ['', 'Visos'], ['approved', 'Patvirtintos'], ['ignored', 'Ignoruotos']], 'open', {onchange: () => { st.status = sSel.value; st.offset = 0; load(); }});
  const q = input({type: 'search', placeholder: 'Kontrahentas arba paskirtis', oninput: debounce(() => { st.q = q.value; st.offset = 0; load(); })});
  clear(main, pageHeader('Bankas ir mokėjimai'), tabs(''), h('div', {class: 'filters'}, field('Rodyti', sSel), field('Paieška', q)),
    h('p', {class: 'hint'}, 'Importuotos operacijos laikomos atskirai nuo apskaitos įrašų. Įrašas sukuriamas tik patvirtinus paskirstymą.'), box);
  await load();
}

async function txDetail(main, id, state) {
  const t = await get(`/api/bank/transactions/${id}`);
  const accounts = await get('/api/accounts');
  const p = t.proposals.find((x) => x.status === 'open');
  const approved = t.proposals.find((x) => x.status === 'approved');
  const data = p ? structuredClone(p.data) : null;
  const allocBox = h('div');
  const allocs = data ? (data.allocations || []).map((a) => ({...a})) : [];
  const editable = !!p && can(state.user, 'write');
  const KINDS = [['invoice', 'Sąskaitos apmokėjimas'], ['fee', 'Mokestis (bankas / tarpininkas)'], ['advance', 'Avansas (tarpinė sąskaita)'], ['overpayment', 'Permoka'], ['own_transfer', 'Pervedimas tarp savų sąskaitų'], ['other', 'Kita (pasirinkta sąskaita)']];
  const drawAllocs = () => clear(allocBox, table([
    {label: 'Tipas', render: (a) => (editable ? select(KINDS, a.kind, {onchange: (e) => { a.kind = e.target.value; drawAllocs(); }}) : KINDS.find((k) => k[0] === a.kind)?.[1])},
    {label: 'Sąskaita / dokumentas', render: (a) => a.kind === 'invoice' ? (a.label || `#${a.invoiceId}`) : a.kind === 'other' || a.kind === 'fee' ? (editable ? select([['', '—'], ...accounts.filter((x) => x.active).map((x) => [x.code, `${x.code} ${x.name}`])], a.accountCode || '', {onchange: (e) => { a.accountCode = e.target.value; }}) : a.accountCode) : '—'},
    {label: 'Suma', render: (a) => (editable ? input({value: a.amount, inputmode: 'decimal', class: 'w-num', onchange: (e) => { a.amount = e.target.value.replace(',', '.'); }}) : money(a.amount))},
    {label: 'Pastaba', render: (a) => (editable ? input({value: a.note || '', onchange: (e) => { a.note = e.target.value; }}) : a.note)},
    {label: 'Įrodymai', render: (a) => h('ul', {class: 'evidence'}, (a.evidence || []).map((e) => h('li', null, e)))},
    {label: '', render: (a) => (editable ? h('button', {class: 'btn-icon', 'aria-label': 'Pašalinti', onclick: () => { allocs.splice(allocs.indexOf(a), 1); drawAllocs(); }}, '×') : '')},
  ], allocs, {empty: 'Paskirstymo nėra.'}));
  drawAllocs();
  const pickInvoice = async () => {
    const reg = Number(t.amount) > 0 ? 'sales' : 'purchase';
    const q = input({type: 'search', placeholder: 'Numeris arba kontrahentas'});
    const list = h('div');
    const load = async () => {
      const rows = await get(`/api/bank/open-invoices?q=${encodeURIComponent(q.value)}`);
      clear(list, table([{label: 'Registras', render: (r) => (r.register === 'sales' ? 'Pardavimas' : 'Pirkimas')}, {label: 'Numeris', render: (r) => `${r.series} ${r.number}`}, {label: 'Kontrahentas', key: 'counterparty_name'}, {label: 'Data', render: (r) => date(r.issue_date)}, {label: 'Likutis', num: true, render: (r) => money(r.outstanding)}],
        rows.sort((a, b) => (a.register === reg ? -1 : 1) - (b.register === reg ? -1 : 1)), {onRow: (r) => {
          const left = Math.abs(Number(t.amount)) - allocs.reduce((s, a) => s + Math.abs(Number(a.amount || 0)), 0);
          const amt = Math.min(Math.abs(Number(r.outstanding)), Math.max(left, 0)).toFixed(2);
          allocs.push({kind: 'invoice', invoiceId: String(r.id), label: `${r.series} ${r.number}`, amount: Number(r.outstanding) < 0 ? `-${amt}` : amt, evidence: ['Pasirinkta naudotojo.']});
          m.close(); drawAllocs();
        }}));
    };
    q.oninput = debounce(load);
    const m = modal('Pasirinkite sąskaitą', h('div', null, q, list), {wide: true});
    load();
  };
  const save = async () => {
    const r = await guard(() => put(`/api/bank/transactions/${t.id}/proposal`, {contentHash: p.content_hash, kind: allocs[0]?.kind === 'invoice' ? 'invoice' : allocs[0]?.kind || 'none', allocations: allocs}), 'Išsaugota.');
    if (r) txDetail(main, id, state);
  };
  const approve = async () => {
    const r = await guard(() => post(`/api/bank/transactions/${t.id}/approve`, {contentHash: p.content_hash}), 'Patvirtinta ir užregistruota.');
    if (r) txDetail(main, id, state);
  };
  const v = p?.validation || approved?.validation || {};
  clear(main, pageHeader(`Banko operacija ${date(t.booking_date)} ${money(t.amount)} €`, h('a', {class: 'btn btn-small', href: '#/bankas'}, '‹ Operacijos'), badge(TX, t.status)),
    h('div', {class: 'cols'},
      section('Operacija', h('dl', {class: 'dl'}, h('dt', null, 'Sąskaita'), h('dd', null, `${t.account_name} (${t.account_iban})`), h('dt', null, 'Kontrahentas'), h('dd', null, `${t.counterparty_name || '—'} ${t.counterparty_iban || ''}`),
        h('dt', null, 'Paskirtis'), h('dd', null, t.reference || '—'), h('dt', null, 'Banko ID'), h('dd', null, t.bank_tx_id || `(nėra; atpažinta pagal požymius, pasikartojimas ${t.occurrence})`),
        h('dt', null, 'Šaltinis'), h('dd', null, t.sources.map((s) => h('div', null, `Išrašas #${s.statement_id}, eilutė ${s.row_no} (${s.format}) – ${s.outcome === 'duplicate' ? 'pasikartojanti' : s.outcome}`, s.document_id ? h('a', {href: `#/dokumentai/${s.document_id}`}, ' [failas]') : null))))),
      t.duplicate_review ? section('Galimas dublikatas', h('p', null, t.duplicate_note), can(state.user, 'resolve') ? h('div', {class: 'actions'},
        h('button', {class: 'btn', onclick: async () => { const note = await promptDialog('Ne dublikatas', 'Kodėl tai atskira operacija?', {minLength: 5}); if (note) { await guard(() => post(`/api/bank/transactions/${t.id}/duplicate`, {decision: 'not_duplicate', note})); txDetail(main, id, state); } }}, 'Tai atskira operacija'),
        h('button', {class: 'btn btn-danger', onclick: async () => { const note = await promptDialog('Dublikatas', 'Pastaba', {minLength: 5}); if (note) { await guard(() => post(`/api/bank/transactions/${t.id}/duplicate`, {decision: 'duplicate', note})); txDetail(main, id, state); } }}, 'Pažymėti dublikatu')) : null) : null),
    section('Siūlomas suderinimas', data ? h('p', null, data.explanation || '') : null,
      data?.status === 'ambiguous' ? h('div', {class: 'banner banner-warn'}, 'Atitikmuo neaiškus – pasirinkite sąskaitas rankiniu būdu.') : null,
      data?.candidates?.length ? h('details', null, h('summary', null, `Galimos sąskaitos (${data.candidates.length})`), table([{label: 'Sąskaita', key: 'label'}, {label: 'Kontrahentas', key: 'counterparty'}, {label: 'Likutis', num: true, render: (c) => money(c.outstanding)}, {label: 'Balai', key: 'score'}, {label: 'Įrodymai', render: (c) => c.evidence.join(' ')}], data.candidates)) : null,
      allocBox,
      editable ? h('div', {class: 'actions'}, h('button', {class: 'btn btn-small', onclick: pickInvoice}, '+ Sąskaita'), h('button', {class: 'btn btn-small', onclick: () => { allocs.push({kind: 'other', amount: t.amount, note: ''}); drawAllocs(); }}, '+ Kita eilutė'), h('button', {class: 'btn', onclick: save}, 'Išsaugoti paskirstymą')) : null),
    section('Patikra ir įrašai', h('ul', {class: 'issues'}, (v.issues || []).map((i) => h('li', {class: `issue-${i.level}`}, i.message))),
      table([{label: 'Sąskaita', key: 'account'}, {label: 'Debetas', num: true, render: (e) => (Number(e.debit) ? money(e.debit) : '')}, {label: 'Kreditas', num: true, render: (e) => (Number(e.credit) ? money(e.credit) : '')}, {label: 'Aprašymas', key: 'description'}], v.entries || []),
      p && can(state.user, 'approve') ? h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary', disabled: p.blocking, onclick: approve}, 'Patvirtinti')) : null),
    t.allocations.length ? section('Patvirtinti paskirstymai', table([{label: 'Tipas', key: 'kind'}, {label: 'Dokumentas', render: (a) => (a.invoice_id ? h('a', {href: `#/${a.register === 'sales' ? 'pardavimai' : 'pirkimai'}/s/${a.invoice_id}`}, `${a.series} ${a.number}`) : a.account_code || '—')}, {label: 'Suma', num: true, render: (a) => money(a.amount)}, {label: 'Patvirtinta', render: (a) => dateTime(a.approved_at)}], t.allocations)) : null);
}

async function statements(main, state) {
  const rows = await get('/api/bank/statements');
  clear(main, pageHeader('Bankas ir mokėjimai'), tabs('israsai'), table([{label: 'Sąskaita', key: 'account_name'}, {label: 'Laikotarpis', render: (s) => `${date(s.period_from)} – ${date(s.period_to)}`}, {label: 'Formatas', key: 'format'},
    {label: 'Pradinis', num: true, render: (s) => money(s.opening_balance)}, {label: 'Galutinis', num: true, render: (s) => money(s.closing_balance)},
    {label: 'Likučių patikra', render: (s) => (s.balance_status === 'ok' ? badge({ok: ['Sutampa', 'done']}, 'ok') : s.resolved_at ? h('span', {class: 'badge badge-info'}, 'Patvirtinta su pastaba') : badge({mismatch: ['Neatitikimas', 'error'], missing: ['Trūksta likučių', 'warn']}, s.balance_status))},
    {label: 'Eilutės', render: (s) => `${s.rows_total} (naujos ${s.rows_new}, pasikartojančios ${s.rows_duplicate}, peržiūrai ${s.rows_review})`}], rows, {onRow: (s) => { location.hash = `#/bankas/israsai/${s.id}`; }, empty: 'Išrašų nėra.'}));
}

async function statementDetail(main, id, state) {
  const s = await get(`/api/bank/statements/${id}`);
  clear(main, pageHeader(`Išrašas ${s.account_name} ${date(s.period_from)} – ${date(s.period_to)}`, h('a', {class: 'btn btn-small', href: '#/bankas/israsai'}, '‹ Išrašai'), h('a', {class: 'btn btn-small', href: `#/dokumentai/${s.document_id}`}, 'Originalus failas')),
    section('Likučiai', h('dl', {class: 'dl'}, h('dt', null, 'Pradinis'), h('dd', null, eur(s.opening_balance)), h('dt', null, 'Įplaukos'), h('dd', null, eur(s.credits_total)), h('dt', null, 'Išmokos'), h('dd', null, eur(s.debits_total)), h('dt', null, 'Galutinis'), h('dd', null, eur(s.closing_balance))),
      h('ul', {class: 'issues'}, s.issues.map((i) => h('li', {class: `issue-${i.level}`}, i.message))),
      s.resolved_at ? h('p', {class: 'banner'}, `Neatitikimą patvirtino ${s.resolved_by_name || ''} ${dateTime(s.resolved_at)}: ${s.resolution_note}`) : null,
      s.balance_status !== 'ok' && !s.resolved_at && can(state.user, 'resolve') ? h('button', {class: 'btn', onclick: async () => {
        const note = await promptDialog('Patvirtinti neatitikimą', 'Paaiškinimas (bus įrašytas į audito žurnalą)', {minLength: 10, multiline: true});
        if (note && await guard(() => post(`/api/bank/statements/${id}/resolve`, {note}), 'Patvirtinta.')) statementDetail(main, id, state);
      }}, 'Patvirtinti neatitikimą su pastaba') : null),
    section('Išrašo eilutės', table([{label: '#', key: 'row_no'}, {label: 'Data', render: (r) => r.raw.bookingDate}, {label: 'Suma', num: true, render: (r) => money(r.raw.amount)}, {label: 'Kontrahentas', render: (r) => r.raw.counterpartyName}, {label: 'Paskirtis', render: (r) => r.raw.reference},
      {label: 'Rezultatas', render: (r) => ({new: 'Nauja', duplicate: 'Jau importuota', review: 'Galimas dublikatas', invalid: 'Netinkama'}[r.outcome])}, {label: 'Pastaba', key: 'issue'}], s.rows, {onRow: (r) => r.transaction_id && (location.hash = `#/bankas/tx/${r.transaction_id}`)})));
}

async function importView(main, state) {
  const [formats, accounts] = await Promise.all([get('/api/bank/formats'), get('/api/bank/accounts')]);
  const fileIn = h('input', {type: 'file', accept: '.csv,.xlsx,.xml,.sta,.mt940,.txt,.pdf,.jpg,.jpeg,.png'});
  const acc = select([['', 'Pagal išrašo IBAN'], ...accounts.map((a) => [a.id, `${a.name} ${a.iban}`])], '');
  const opening = input({inputmode: 'decimal', placeholder: 'jei formate nėra'}), closing = input({inputmode: 'decimal', placeholder: 'jei formate nėra'});
  const out = h('div');
  let documentId = null, mapping = null;
  const preview = async () => {
    const r = await guard(() => post('/api/bank/statements/preview', {documentId, bankAccountId: acc.value || null, mapping, opening: opening.value, closing: closing.value}));
    if (!r) return;
    mapping = r.mapping;
    const mapUi = r.headers ? h('div', {class: 'form-grid'}, Object.entries({date: 'Data', amount: 'Suma (su ženklu)', debit: 'Debetas', credit: 'Kreditas', direction: 'D/K požymis', counterparty: 'Kontrahentas', iban: 'Kontrahento IBAN', reference: 'Paskirtis', txId: 'Operacijos ID', currency: 'Valiuta'}).map(([k, label]) =>
      field(label, select([['', '—'], ...r.headers.map((hh, i) => [i, hh || `Stulpelis ${i + 1}`])], mapping[k] ?? '', {onchange: (e) => { if (e.target.value === '') delete mapping[k]; else mapping[k] = Number(e.target.value); }})))) : null;
    clear(out, section('Peržiūra', h('p', null, `Formatas: ${r.format}. Sąskaita: ${r.iban || 'nenurodyta'}${r.needsAccount ? ' – pasirinkite banko sąskaitą arba sukurkite ją.' : ''}. Laikotarpis ${date(r.periodFrom)} – ${date(r.periodTo)}. Eilučių: ${r.totalRows}.`),
      h('p', {class: r.balance.status === 'ok' ? 'banner' : 'banner banner-warn'}, r.balance.message),
      h('ul', {class: 'issues'}, r.issues.map((i) => h('li', {class: `issue-${i.level}`}, i.message))),
      mapUi ? h('details', {open: true}, h('summary', null, 'Stulpelių susiejimas'), mapUi, h('button', {class: 'btn btn-small', onclick: preview}, 'Atnaujinti peržiūrą')) : null,
      table([{label: '#', key: 'rowNo'}, {label: 'Data', key: 'bookingDate'}, {label: 'Suma', num: true, render: (x) => money(x.amount)}, {label: 'Kontrahentas', key: 'counterpartyName'}, {label: 'IBAN', key: 'counterpartyIban'}, {label: 'Paskirtis', key: 'reference'}, {label: 'ID', key: 'bankTxId'}, {label: 'Problema', key: 'issue'}], r.rows.slice(0, 50)),
      can(state.user, 'write') ? h('button', {class: 'btn btn-primary', disabled: r.needsAccount && !acc.value, onclick: async () => {
        const res = await guard(() => post('/api/bank/statements/import', {documentId, bankAccountId: acc.value || null, mapping, opening: opening.value, closing: closing.value}));
        if (res) { toast(res.alreadyImported ? 'Šis failas jau importuotas.' : `Importuota: naujų ${res.new}, pasikartojančių ${res.duplicate}, peržiūrai ${res.review}.`, 'ok'); location.hash = `#/bankas/israsai/${res.statementId}`; }
      }}, 'Importuoti') : null));
  };
  clear(main, pageHeader('Bankas ir mokėjimai'), tabs('importas'),
    section('Išrašo failas', h('ul', {class: 'hint'}, Object.entries(formats).map(([k, v]) => h('li', null, h('strong', null, k.toUpperCase()), ': ', v))),
      h('div', {class: 'form-grid'}, field('Failas', fileIn), field('Banko sąskaita', acc), field('Pradinis likutis', opening), field('Galutinis likutis', closing)),
      h('button', {class: 'btn btn-primary', onclick: async () => {
        if (!fileIn.files[0]) return toast('Pasirinkite failą.', 'error');
        const fd = new FormData(); fd.append('workflow', 'bank'); fd.append('files', fileIn.files[0], fileIn.files[0].name);
        try {
          const r = await upload('/api/uploads', fd);
          const res = r.results[0];
          if (res.status === 'error') return toast(res.message, 'error');
          if (res.status === 'duplicate') toast(res.message, 'info');
          documentId = res.documentId; mapping = null; await preview();
        } catch (e) { showError(e); }
      }}, 'Įkelti ir peržiūrėti')),
    out);
}

async function advances(main, state) {
  const rows = await get('/api/bank/advances');
  clear(main, pageHeader('Bankas ir mokėjimai'), tabs('avansai'), h('p', {class: 'hint'}, 'Gauti / sumokėti avansai ir permokos tarpinėse sąskaitose. Pritaikius sąskaitai, pinigų judėjimas antrą kartą neregistruojamas.'),
    table([{label: 'Data', render: (a) => date(a.booking_date)}, {label: 'Mokėtojas', render: (a) => a.counterparty_name || a.payer}, {label: 'Tipas', key: 'kind'}, {label: 'Suma', num: true, render: (a) => money(a.amount)}, {label: 'Likutis', num: true, render: (a) => money(a.remaining)},
      {label: '', render: (a) => (can(state.user, 'approve') ? h('button', {class: 'btn btn-small', onclick: () => applyDialog(a)}, 'Pritaikyti sąskaitai') : '')}], rows, {empty: 'Nepritaikytų avansų nėra.'}));
  async function applyDialog(a) {
    const inv = await get('/api/bank/open-invoices');
    const reg = Number(a.amount) > 0 ? 'sales' : 'purchase';
    const sel = select(inv.filter((i) => i.register === reg && Number(i.outstanding) > 0).map((i) => [i.id, `${i.series} ${i.number} – ${i.counterparty_name} (likutis ${money(i.outstanding)})`]), '');
    const amt = input({value: Math.abs(Number(a.remaining)).toFixed(2), inputmode: 'decimal'});
    const m = modal('Pritaikyti avansą', h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post(`/api/bank/advances/${a.id}/apply`, {invoiceId: sel.value, amount: amt.value}), 'Avansas pritaikytas.')) { m.close(); advances(main, state); } }},
      field('Sąskaita', sel), field('Suma', amt), h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Patvirtinti'))));
  }
}

async function accountsView(main, state) {
  const rows = await get('/api/bank/accounts');
  const iban = input({placeholder: 'LT…'}), name = input(), bank = input(), ledger = input({value: '2710'}), kind = select([['bank', 'Banko sąskaita'], ['processor', 'Mokėjimų tarpininkas']], 'bank');
  clear(main, pageHeader('Bankas ir mokėjimai'), tabs('saskaitos'),
    table([{label: 'Pavadinimas', key: 'name'}, {label: 'IBAN', key: 'iban'}, {label: 'Bankas', key: 'bank_name'}, {label: 'DK sąskaita', key: 'ledger_account'}, {label: 'Likutis DK', num: true, render: (a) => money(a.ledger_balance)},
      {label: 'Paskutinis išrašas', render: (a) => `${date(a.last_statement_date)} ${a.last_statement_balance !== null ? money(a.last_statement_balance) : ''}`}], rows),
    can(state.user, 'settings') ? section('Nauja sąskaita', h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post('/api/bank/accounts', {iban: iban.value, name: name.value, bank_name: bank.value, ledger_account: ledger.value, kind: kind.value}), 'Sąskaita pridėta.')) accountsView(main, state); }},
      h('div', {class: 'form-grid'}, field('IBAN', iban), field('Pavadinimas', name), field('Bankas', bank), field('DK sąskaita', ledger), field('Tipas', kind)), h('button', {class: 'btn btn-primary'}, 'Pridėti'))) : null);
}
