// Ataskaitos: financial statements from the ledger, registers, aging, sales, drill-down, CSV/XLSX export, i.SAF, journal.
import {h, clear, get, post, api, pageHeader, section, table, money, date, dateTime, guard, select, input, field, can, modal, toast, yearStart, monthStart, today} from '../core.mjs';

const REPORTS = [
  ['pelnas', 'profit-loss', 'Pelno (nuostolių) ataskaita', 'period'], ['balansas', 'balance-sheet', 'Balansas', 'asOf'], ['bandomasis', 'trial-balance', 'Bandomasis balansas', 'period'],
  ['knyga', 'ledger', 'Didžioji knyga', 'ledger'], ['pvm-pardavimai', 'vat-sales', 'Pardavimų PVM registras', 'period'], ['pvm-pirkimai', 'vat-purchases', 'Pirkimų PVM registras', 'period'],
  ['gautinos', 'receivables', 'Pirkėjų skolos', 'asOf'], ['moketinos', 'payables', 'Skolos tiekėjams', 'asOf'], ['pardavimai', 'sales', 'Pardavimai', 'sales'],
  ['operaciniai', 'sales-operational', 'Užsakymų rodikliai (operaciniai)', 'period'], ['pirkimai', 'purchases', 'Pirkimai ir sąnaudos', 'purchases'], ['mokejimai', 'payments', 'Mokėjimų suvestinė', 'period'],
];
const EXTRA = [['isaf', 'i.SAF eksportas'], ['zurnalas', 'Žurnalas ir rankiniai įrašai'], ['savikaina', 'Savikaina (COGS)']];

export async function render(main, rest, state) {
  const key = rest[0] || 'pelnas';
  // Reports are chosen from the top menu (Ataskaitos / Finansai / Likučiai); no side menu.
  const title = [...REPORTS.map(([k, , t]) => [k, t]), ...EXTRA].find(([k]) => k === key)?.[1] || REPORTS[0][2];
  const body = h('div', {class: 'report-body'});
  clear(main, pageHeader(title), body);
  if (key === 'isaf') return isaf(body, state);
  if (key === 'zurnalas') return journal(body, state, rest[1]);
  if (key === 'savikaina') return cogs(body, state);
  const def = REPORTS.find(([k]) => k === key) || REPORTS[0];
  return reportView(body, def, rest);
}

async function reportView(body, [key, name, title, mode], rest) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = {from: input({type: 'date', value: params.get('from') || yearStart()}), to: input({type: 'date', value: params.get('to') || today()}), asOf: input({type: 'date', value: params.get('asOf') || today()}),
    account: input({value: params.get('account') || rest[1] || '', placeholder: 'pvz. 2410'}), groupBy: select(mode === 'purchases' ? [['account', 'Pagal sąskaitą'], ['supplier', 'Pagal tiekėją']] : [['month', 'Pagal mėnesį'], ['store', 'Pagal parduotuvę'], ['customer', 'Pagal pirkėją'], ['product', 'Pagal prekę']], params.get('groupBy') || (mode === 'purchases' ? 'account' : 'month'))};
  const inputs = mode === 'asOf' ? [field('Dienai', f.asOf)] : [field('Nuo', f.from), field('Iki', f.to), mode === 'ledger' ? field('Sąskaita', f.account) : null, ['sales', 'purchases'].includes(mode) ? field('Grupuoti', f.groupBy) : null];
  const out = h('div');
  const qs = () => new URLSearchParams(mode === 'asOf' ? {asOf: f.asOf.value} : {from: f.from.value, to: f.to.value, ...(mode === 'ledger' && {account: f.account.value}), ...(['sales', 'purchases'].includes(mode) && {groupBy: f.groupBy.value})});
  const load = async () => {
    const r = await get(`/api/reports/${name}?${qs()}`);
    const drill = r.drill;
    const cols = r.columns.map(([k, label, type]) => ({label, num: type === 'money', render: (row) => {
      const v = row[k];
      if (drill && k === drill.column && v) {
        if (drill.to === 'ledger') return h('a', {href: `#/ataskaitos/knyga/${v}?from=${f.from.value}&to=${f.to.value || f.asOf.value}`}, v);
        if (drill.to === 'entry') return h('button', {class: 'link', onclick: () => entryModal(v)}, `#${v}`);
      }
      if (k === 'description' && row.document_id) return h('a', {href: `#/dokumentai/${row.document_id}`}, v);
      return type === 'money' ? money(v) : type === 'date' ? date(v) : v ?? '';
    }}));
    const onRow = drill?.to === 'invoice' ? (row) => { location.hash = `#/${['vat-sales', 'receivables', 'sales'].includes(name) ? 'pardavimai' : 'pirkimai'}/s/${row.id}`; } : null;
    clear(out, h('p', {class: 'definition'}, r.definition),
      r.incomplete ? h('div', {class: 'banner banner-warn', role: 'alert'}, r.incomplete.reason) : null,
      r.reconciliation ? h('p', {class: r.reconciliation.ok ? 'banner' : 'banner banner-warn'}, r.reconciliation.ok ? `✓ Sutikrinta su didžiąja knyga (${money(r.reconciliation.ledger)}). ` : `✗ Nesutampa su didžiąja knyga: registre ${money(r.reconciliation.register)}, knygoje ${money(r.reconciliation.ledger)}. `, r.reconciliation.note) : null,
      r.balanced === false ? h('div', {class: 'banner banner-warn'}, 'Dėmesio: ataskaita nesubalansuota.') : null,
      r.opening !== undefined ? h('p', null, `Pradinis likutis: ${money(r.opening)}`) : null,
      table(cols, r.rows, {onRow}),
      r.totals ? h('div', {class: 'totals'}, Object.entries(r.totals).filter(([, v]) => typeof v !== 'object').map(([k, v]) => h('div', null, h('span', null, {debit: 'Debetas', credit: 'Kreditas', closing: 'Galutinis', revenue: 'Pajamos', expenses: 'Sąnaudos', result: 'Rezultatas', assets: 'Turtas', liabilities: 'Įsipareigojimai', equity: 'Nuosavybė', check: 'Skirtumas', vat: 'PVM', net: 'Be PVM', outstanding: 'Likutis'}[k] || k), h('strong', null, money(v))))) : null);
  };
  const exportBtn = (fmt) => h('button', {class: 'btn btn-small', onclick: () => guard(async () => {
    const res = await api('GET', `/api/reports/${name}?${qs()}&format=${fmt}`, undefined, {raw: true});
    if (!res.ok) throw new Error('Eksportas nepavyko.');
    const blob = await res.blob(); const a = h('a', {href: URL.createObjectURL(blob), download: `${name}.${fmt}`}); document.body.append(a); a.click(); a.remove();
  })}, fmt.toUpperCase());
  clear(body, h('div', {class: 'filters'}, inputs, h('button', {class: 'btn btn-primary', onclick: () => guard(load)}, 'Rodyti'), exportBtn('csv'), exportBtn('xlsx')), out);
  if (mode !== 'ledger' || f.account.value) await load();
}

async function entryModal(id) {
  const e = await get(`/api/journal/${id}`);
  modal(`Įrašas #${e.id}`, h('div', null, h('p', null, `${date(e.entry_date)} · ${e.description} · šaltinis: ${e.source?.label || e.source_type}`),
    e.source?.documentId ? h('a', {class: 'btn btn-small', href: `#/dokumentai/${e.source.documentId}`}, 'Šaltinio dokumentas') : null,
    e.source?.type === 'invoice' ? h('a', {class: 'btn btn-small', href: `#/pirkimai/s/${e.source.id}`}, 'Sąskaita') : null,
    e.source?.type === 'bank_transaction' ? h('a', {class: 'btn btn-small', href: `#/bankas/tx/${e.source.id}`}, 'Banko operacija') : null,
    e.source?.type === 'payroll' ? h('a', {class: 'btn btn-small', href: e.source.href}, 'DU žiniaraštis') : null,
    table([{label: 'Sąskaita', render: (l) => `${l.account_code} ${l.account_name}`}, {label: 'Debetas', num: true, render: (l) => (Number(l.debit) ? money(l.debit) : '')}, {label: 'Kreditas', num: true, render: (l) => (Number(l.credit) ? money(l.credit) : '')}, {label: 'Aprašymas', key: 'description'}], e.lines)), {wide: true});
}

async function isaf(body, state) {
  const from = input({type: 'date', value: monthStart()}), to = input({type: 'date', value: today()});
  const type = select([['F', 'Pilnas (F)'], ['S', 'Išrašytos sąskaitos (S)'], ['P', 'Gautos sąskaitos (P)']], 'F');
  const out = h('div');
  const check = async () => {
    const r = await get(`/api/isaf/check?${new URLSearchParams({from: from.value, to: to.value, type: type.value})}`);
    clear(out, h('p', {class: 'banner'}, r.note),
      h('p', null, `Pardavimai: ${r.summary.sales?.invoices ?? 0} sąsk., PVM ${money(r.summary.sales?.vat)}. Pirkimai: ${r.summary.purchase?.invoices ?? 0} sąsk., PVM ${money(r.summary.purchase?.vat)}.`),
      h('p', {class: r.xsd.valid ? 'banner' : 'banner banner-warn'}, r.xsd.valid ? '✓ Failas atitinka i.SAF 1.2 XSD schemą.' : r.xsd.valid === null ? r.xsd.messages[0] : `✗ XSD klaidos: ${r.xsd.messages.join(' ')}`),
      r.errors.length ? section('Blokuojančios klaidos', table([{label: 'Dokumentas', render: (e) => (e.invoiceId ? h('a', {href: `#/${e.register === 'sales' ? 'pardavimai' : 'pirkimai'}/s/${e.invoiceId}`}, e.label) : 'Įmonė')}, {label: 'Klaida', key: 'message'}], r.errors)) : null,
      r.warnings.length ? section('Įspėjimai', table([{label: 'Dokumentas', render: (e) => e.label || '—'}, {label: 'Pastaba', key: 'message'}], r.warnings)) : null,
      r.excluded.length ? section('Neįtraukta', table([{label: 'Dokumentas', key: 'label'}, {label: 'Priežastis', key: 'reason'}], r.excluded)) : null,
      r.exportable && can(state.user, 'approve') ? h('button', {class: 'btn btn-primary', onclick: () => guard(async () => {
        const res = await api('GET', `/api/isaf/download?${new URLSearchParams({from: from.value, to: to.value, type: type.value})}`, undefined, {raw: true});
        if (!res.ok) throw new Error((await res.json()).error);
        const blob = await res.blob(); const a = h('a', {href: URL.createObjectURL(blob), download: `isaf_${type.value}_${from.value}_${to.value}.xml`}); document.body.append(a); a.click(); a.remove();
        toast('Failas sugeneruotas ir išsaugotas dokumentuose. Pateikite jį VMI i.SAF sistemoje.', 'ok');
      })}, 'Atsisiųsti XML') : null);
  };
  clear(body, h('h2', null, 'i.SAF (VMI) eksportas'), h('p', {class: 'hint'}, 'Formuojama pagal i.SAF 1.2 specifikaciją ir tikrinama pagal XSD. Eksportas nėra pateikimas – failą įkelkite į VMI i.SAF sistemą patys. Juridiniams asmenims – iki kito mėnesio 20 d.'),
    h('div', {class: 'filters'}, field('Nuo', from), field('Iki', to), field('Duomenys', type), h('button', {class: 'btn btn-primary', onclick: () => guard(check)}, 'Tikrinti')), out);
}

async function journal(body, state) {
  const accounts = await get('/api/accounts');
  const list = h('div');
  const load = async () => {
    const d = await get('/api/journal?limit=100');
    clear(list, table([{label: 'Data', render: (e) => date(e.entry_date)}, {label: '#', key: 'id'}, {label: 'Aprašymas', key: 'description'}, {label: 'Šaltinis', key: 'source_type'}, {label: 'Suma', num: true, render: (e) => money(e.amount)},
      {label: 'Eilutės', render: (e) => (e.lines || []).map((l) => `${l.account} ${Number(l.debit) ? 'D ' + l.debit : 'K ' + l.credit}`).join('; ')}, {label: 'Atšauktas', render: (e) => (e.reversed_by ? `#${e.reversed_by}` : '')},
      {label: '', render: (e) => (can(state.user, 'approve') && ['manual', 'opening', 'cogs', 'adjustment'].includes(e.source_type) && !e.reversed_by ? h('button', {class: 'btn btn-small', onclick: () => guard(() => post(`/api/journal/${e.id}/reverse`, {date: today(), reason: 'Atšaukta'}), 'Atšaukta atvirkštiniu įrašu.').then(load)}, 'Atšaukti') : '')}],
    d.items, {onRow: (e) => entryModal(e.id)}));
  };
  const lines = [];
  const linesBox = h('tbody');
  const accOpts = [['', '—'], ...accounts.filter((a) => a.active).map((a) => [a.code, `${a.code} ${a.name}`])];
  const addLine = () => { const l = {account: select(accOpts, ''), debit: input({inputmode: 'decimal', class: 'w-num'}), credit: input({inputmode: 'decimal', class: 'w-num'}), description: input()}; lines.push(l); linesBox.append(h('tr', null, h('td', null, l.account), h('td', null, l.debit), h('td', null, l.credit), h('td', null, l.description))); };
  addLine(); addLine();
  const dt = input({type: 'date', value: today()}), desc = input(), kind = select([['manual', 'Rankinis koregavimas'], ['opening', 'Pradiniai likučiai'], ['adjustment', 'Koregavimas']], 'manual');
  clear(body, h('h2', null, 'Žurnalas'),
    can(state.user, 'approve') ? section('Naujas rankinis įrašas', h('form', {onsubmit: async (e) => {
      e.preventDefault();
      const r = await guard(() => post('/api/journal', {date: dt.value, description: desc.value, kind: kind.value, lines: lines.filter((l) => l.account.value).map((l) => ({account: l.account.value, debit: l.debit.value, credit: l.credit.value, description: l.description.value}))}), 'Įrašas užregistruotas.');
      if (r) load();
    }}, h('div', {class: 'form-grid'}, field('Data', dt), field('Aprašymas', desc), field('Tipas', kind)),
    h('table', {class: 'grid'}, h('thead', null, h('tr', null, ['Sąskaita', 'Debetas', 'Kreditas', 'Pastaba'].map((t) => h('th', null, t)))), linesBox),
    h('div', {class: 'actions'}, h('button', {type: 'button', class: 'btn btn-small', onclick: addLine}, '+ Eilutė'), h('button', {class: 'btn btn-primary'}, 'Registruoti')),
    h('p', {class: 'hint'}, 'Debetas turi būti lygus kreditui. Užregistruoti įrašai nekeičiami – klaidos taisomos atvirkštiniu ar koreguojančiu įrašu.'))) : null,
    list);
  await load();
}

async function cogs(body, state) {
  const periods = await get('/api/cogs-periods');
  const month = input({type: 'month', value: today().slice(0, 7)}), amount = input({inputmode: 'decimal'}), note = input();
  clear(body, h('h2', null, 'Parduotų prekių savikaina'),
    h('p', {class: 'hint'}, 'Atsargos apskaitomos pirkimo metu (204), o savikaina registruojama atskirai buhalterio. Kol mėnesio savikaina nepatvirtinta, pelno ataskaita žymima kaip neišsami – savikaina nelaikoma nuliu.'),
    table([{label: 'Mėnuo', key: 'period'}, {label: 'Įrašas', key: 'journal_entry_id'}, {label: 'Patvirtinta', render: (p) => dateTime(p.confirmed_at)}, {label: 'Pastaba', key: 'note'}], periods, {empty: 'Savikaina dar neregistruota.'}),
    can(state.user, 'approve') ? section('Registruoti savikainą', h('form', {onsubmit: async (e) => {
      e.preventDefault();
      const [y, m] = month.value.split('-');
      const last = new Date(Date.UTC(Number(y), Number(m), 0)).toISOString().slice(0, 10);
      const r = await guard(() => post('/api/journal', {date: last, kind: 'cogs', cogsPeriod: month.value, description: `Parduotų prekių savikaina ${month.value}${note.value ? ' – ' + note.value : ''}`,
        lines: [{account: '6000', debit: amount.value}, {account: '204', credit: amount.value}]}), 'Savikaina užregistruota.');
      if (r) cogs(body, state);
    }}, h('div', {class: 'form-grid'}, field('Mėnuo', month), field('Suma (EUR)', amount, 'Įrašas: D 6000 / K 204 (suma pagal atsargų inventorizaciją ar kitą buhalterio skaičiavimą)'), field('Pastaba', note)), h('button', {class: 'btn btn-primary'}, 'Registruoti'))) : null);
}
