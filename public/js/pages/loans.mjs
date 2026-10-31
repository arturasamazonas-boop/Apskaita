// Palūkanos: loan agreements with interest calculated to a chosen date, from the day the money arrived.
// Terms come from an uploaded / stored agreement (read automatically, confirmed by the user) or are typed in.
import {h, clear, get, post, put, del, upload, pageHeader, section, table, money, date, guard, select, input, field, can, today, toast, showError, confirmDialog, modal, promptDialog} from '../core.mjs';

const DIR = {received: 'Gauta paskola', granted: 'Suteikta paskola'};
const EVENT = {disbursement: 'Išmokėta (pinigai gauti)', repayment: 'Grąžinta paskolos dalis', rate_change: 'Palūkanų normos pakeitimas', interest_payment: 'Sumokėtos palūkanos'};
const BASIS_SHORT = {act365: 'fakt./365', act360: 'fakt./360', actact: 'fakt./fakt.', '30e360': '30E/360'};
const BASES = {act365: 'Faktinės dienos / 365', act360: 'Faktinės dienos / 360', actact: 'Faktinės dienos / faktinės metų dienos (365 arba 366)', '30e360': '30E/360 (mėnuo – 30 d., metai – 360 d.)'};
const pct = (v) => `${Number(v).toLocaleString('lt-LT', {maximumFractionDigits: 4})} %`;
const lastDayLabel = 'Įskaičiuoti grąžinimo (paskutinę) dieną';
let draft = null; // a read agreement or a manual calculation waiting to be saved as a loan

export async function render(main, rest, state) {
  if (rest[0] === 'nauja') return form(main, state);
  if (rest[0]) return card(main, rest[0], state);
  return list(main, state);
}

/** Uploads an agreement (chosen or dropped), reads its terms and opens the review form. */
function readContract(file) {
  return guard(async () => {
    if (!file) return;
    if (!/\.(pdf|docx|jpe?g|png)$/i.test(file.name)) throw new Error('Tinka PDF, DOCX, JPG arba PNG failas.');
    const fd = new FormData(); fd.append('file', file, file.name);
    toast('Sutartis įkeliama ir skaitoma…', 'info');
    draft = await upload('/api/loans/read-contract', fd);
    location.hash = '#/palukanos/nauja';
  });
}

/** Drop area for an agreement: drag a file onto it or click to choose one. */
function dropZone() {
  const fileIn = h('input', {type: 'file', accept: '.pdf,.docx,.jpg,.jpeg,.png', hidden: true, onchange: () => { const f = fileIn.files[0]; fileIn.value = ''; readContract(f); }});
  const zone = h('div', {class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Įkelti paskolos sutartį',
    onclick: () => fileIn.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } },
    ondragover: (e) => { e.preventDefault(); zone.classList.add('over'); }, ondragleave: () => zone.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); zone.classList.remove('over'); readContract(e.dataTransfer.files[0]); }},
  fileIn, h('strong', null, '⇪ Nutempkite paskolos sutartį čia arba spustelėkite'), h('span', {class: 'hint'}, 'PDF, DOCX arba nuotrauka (JPG, PNG). Sutartis išsaugoma dokumentų saugykloje, o sąlygos perskaitomos automatiškai.'));
  return zone;
}

async function list(main, state) {
  const write = can(state.user, 'write');
  const asOf = input({type: 'date', value: today()});
  const lastDay = h('input', {type: 'checkbox'});
  const out = h('div'), cand = h('div');
  const approve = can(state.user, 'approve');
  let seq = 0, touched = false; // until the box is used, each loan is calculated with its own repayment-day setting
  lastDay.addEventListener('change', () => { touched = true; });
  const load = async () => {
    const my = ++seq;
    const d = await get(`/api/loans?${new URLSearchParams({asOf: asOf.value, ...(touched && {includeLastDay: String(lastDay.checked)})})}`);
    if (my !== seq) return;
    // Totals per currency (amounts in different currencies are not added up).
    const sum = (dir, k) => { const m = new Map(); for (const l of d.items.filter((x) => x.direction === dir)) m.set(l.currency, (m.get(l.currency) || 0) + Number(l.calc[k])); return [...m].map(([c, v]) => `${money(v)} ${c}`).join(' + ') || money(0); };
    clear(out, table([
      {label: 'Sutartis', render: (l) => h('a', {href: `#/palukanos/${l.id}`}, `${l.contract_no || 'be nr.'}${l.contract_date ? ` (${l.contract_date})` : ''}`)},
      {label: 'Kita šalis', render: (l) => l.cp_name || l.counterparty_name || '—'}, {label: 'Tipas', render: (l) => DIR[l.direction]},
      {label: 'Paskolos suma', num: true, render: (l) => `${money(l.principal)} ${l.currency}`}, {label: 'Likutis', num: true, render: (l) => money(l.calc.balance)},
      {label: 'Palūkanos', render: (l) => `${pct(l.annual_rate)}${l.rate_variable ? ' + bazė' : ''}, ${BASIS_SHORT[l.basis]}`},
      {label: 'Pinigai gauti', render: (l) => date(l.calc.firstDisbursement)}, {label: 'Grąžinti iki', render: (l) => date(l.maturity_date)},
      {label: 'Dienų', num: true, render: (l) => l.calc.days}, {label: 'Priskaičiuota', num: true, render: (l) => h('strong', null, money(l.calc.interest))},
      {label: 'Sumokėta', num: true, render: (l) => money(l.calc.paid)}, {label: 'Liko mokėti', num: true, render: (l) => money(l.calc.due)},
      {label: 'Sukaupta DK', num: true, render: (l) => (l.lastAccrual ? h('span', {title: `Sukaupta iki ${l.lastAccrual}`}, money(l.accrued)) : '—')},
      {label: '', render: (l) => (l.calc.notes.length ? h('span', {class: 'text-error', title: l.calc.notes.join('\n')}, '⚠') : '')}],
    d.items, {onRow: (l) => { location.hash = `#/palukanos/${l.id}`; }, empty: 'Paskolų dar nėra. Įkelkite paskolos sutartį arba įveskite sąlygas ranka.'}),
    d.items.length ? h('p', {class: 'total-line'}, `Iki ${d.asOf}: mokėtinos palūkanos (gautos paskolos) `, h('strong', null, sum('received', 'due')),
      `; gautinos palūkanos (suteiktos paskolos) `, h('strong', null, sum('granted', 'due')), '.') : null,
    d.items.length && approve ? h('div', {class: 'actions-left'}, h('button', {class: 'btn', onclick: () => accrueAll(d.asOf)}, `Kaupti palūkanas DK iki ${d.asOf}`),
      h('span', {class: 'hint'}, ' Kiekvienai paskolai – atskiras įrašas (gautos: D 6802 / K 491, suteiktos: D 292 / K 5802), kaupiama palūkanų dalis, dar neužregistruota DK. Taikoma kiekvienos paskolos grąžinimo dienos nuostata.')) : null);
  };
  const accrueAll = (d) => guard(async () => {
    if (!await confirmDialog('Palūkanų kaupimas', `Užregistruoti visų galiojančių paskolų palūkanų kaupimą DK iki ${d}?`, 'Registruoti')) return;
    const r = await post('/api/loans/accruals', {asOf: d});
    const posted = r.results.filter((x) => x.status === 'posted'), failed = r.results.filter((x) => x.status === 'error');
    modal('Palūkanų kaupimas', h('div', null, table([{label: 'Paskola', key: 'label'}, {label: 'Rezultatas', render: (x) => (x.status === 'posted' ? `Užregistruota: D ${x.debit} / K ${x.credit}` : x.status === 'error' ? h('span', {class: 'text-error'}, x.message) : x.message)},
      {label: 'Suma, EUR', num: true, render: (x) => (x.status === 'posted' ? money(x.amountEur) : '')}, {label: 'Įrašas', render: (x) => (x.entryId ? h('a', {href: `#/ataskaitos/zurnalas/${x.entryId}`}, `#${x.entryId}`) : '')}], r.results),
      h('p', null, `Užregistruota įrašų: ${posted.length}${failed.length ? `, nepavyko: ${failed.length}` : ''}.`)), {wide: true});
    load();
  });
  const loadCand = async () => {
    const rows = await get('/api/loans/candidates');
    clear(cand, rows.length ? section('Saugykloje rastos paskolos sutartys be skaičiavimo', table([{label: 'Dokumentas', render: (x) => h('a', {href: `#/dokumentai/${x.id}`}, x.title || `#${x.id}`)},
      {label: 'Nr.', key: 'reference_number'}, {label: 'Kita šalis', key: 'counterparty_name'}, {label: 'Įkelta', render: (x) => date(x.created_at)},
      {label: '', render: (x) => (write ? h('button', {class: 'btn btn-small', onclick: () => guard(async () => { draft = await post(`/api/loans/read-document/${x.id}`); location.hash = '#/palukanos/nauja'; })}, 'Nuskaityti sąlygas') : '')}], rows)) : null);
  };
  [asOf, lastDay].forEach((x) => x.addEventListener('change', () => guard(load)));
  clear(main, pageHeader('Palūkanos', write ? h('a', {class: 'btn', href: '#/palukanos/nauja', onclick: () => { draft = null; }}, '+ Paskola ranka') : null),
    write ? dropZone() : null,
    h('p', {class: 'hint'}, 'Palūkanos skaičiuojamos nuo pinigų gavimo (įkritimo į sąskaitą) dienos, ne nuo sutarties pasirašymo. Grąžinta suma palūkanų nebeneša nuo kitos dienos, jei pažymėta „įskaičiuoti grąžinimo dieną“, kitaip – nuo grąžinimo dienos.'),
    section(null, h('div', {class: 'filters'}, field('Skaičiuoti iki', asOf), h('label', {class: 'check'}, lastDay, ` ${lastDayLabel}`)), out),
    cand, calculator(state));
  await Promise.all([load(), loadCand()]);
}

/** Quick calculation without an agreement: amount, dates, rate. */
function calculator(state) {
  const f = {amount: input({inputmode: 'decimal', placeholder: '10 000,00'}), from: input({type: 'date'}), to: input({type: 'date', value: today()}), rate: input({inputmode: 'decimal', placeholder: '5,5'}),
    basis: select(Object.entries(BASES), 'actact'), lastDay: h('input', {type: 'checkbox', checked: true})};
  const out = h('div');
  const calc = (e) => guard(async () => {
    e?.preventDefault();
    const r = await post('/api/loans/calc', {amount: f.amount.value, from: f.from.value, to: f.to.value, rate: f.rate.value, basis: f.basis.value, includeLastDay: f.lastDay.checked});
    clear(out, h('p', {class: 'calc-result'}, `${r.days} d. × ${pct(r.rate)} per metus nuo ${money(r.amount)}: palūkanos `, h('strong', null, `${money(r.interest)}`)),
      r.periods.length > 1 ? periodsTable(r) : null,
      can(state.user, 'write') ? h('button', {type: 'button', class: 'btn', onclick: () => {
        draft = {fields: {principal: r.amount, rate: r.rate, basis: f.basis.value, disbursementDate: f.from.value, includeLastDay: f.lastDay.checked}, evidence: {}, warnings: [], bankMatches: []};
        location.hash = '#/palukanos/nauja';
      }}, 'Išsaugoti kaip paskolą') : null);
  });
  return section('Skaičiavimas ranka (be sutarties)', h('form', {onsubmit: calc},
    h('div', {class: 'form-grid'}, field('Suma', f.amount), field('Pinigų gavimo diena', f.from), field('Skaičiuoti iki (grąžinimo diena)', f.to), field('Palūkanos, % per metus', f.rate), field('Dienų skaičiavimo bazė', f.basis),
      h('label', {class: 'check'}, f.lastDay, ` ${lastDayLabel}`)), h('button', {class: 'btn btn-primary'}, 'Skaičiuoti')), out);
}

function periodsTable(c) {
  return table([{label: 'Nuo', key: 'from'}, {label: 'Iki (imtinai)', key: 'to'}, {label: 'Dienų', num: true, key: 'days'}, {label: 'Paskolos likutis', num: true, render: (p) => money(p.balance)},
    {label: 'Norma', num: true, render: (p) => pct(p.rate)}, {label: 'Palūkanos', num: true, render: (p) => money(p.interest)}], c.periods, {empty: 'Palūkanų skaičiuoti nėra už ką.'});
}

/** New loan: from a read agreement (with evidence), from the calculator, or empty. */
async function form(main, state) {
  const d = draft || {fields: {}, evidence: {}, warnings: [], bankMatches: []};
  const x = d.fields;
  const f = {
    direction: select([['', '— pasirinkite —'], ...Object.entries(DIR)], x.direction || ''), counterparty_name: input({value: x.counterpartyName || ''}), counterparty_code: input({value: x.counterpartyCode || '', inputmode: 'numeric'}),
    contract_no: input({value: x.contractNo || ''}), contract_date: input({type: 'date', value: x.contractDate || ''}), principal: input({value: x.principal ? money(x.principal) : '', inputmode: 'decimal'}),
    currency: input({value: x.currency || 'EUR', maxlength: 3, style: {maxWidth: '6rem'}}), annual_rate: input({value: x.rate ? String(x.rate).replace('.', ',') : '', inputmode: 'decimal'}),
    rate_variable: h('input', {type: 'checkbox', checked: !!x.rateVariable}), basis: select(Object.entries(BASES), x.basis || 'actact'), maturity_date: input({type: 'date', value: x.maturityDate || ''}),
    include_last_day: h('input', {type: 'checkbox', checked: x.includeLastDay === undefined ? true : !!x.includeLastDay}), notes: h('textarea', {rows: 2}),
    disb_date: input({type: 'date', value: x.disbursementDate || ''}), disb_amount: input({inputmode: 'decimal', value: x.principal ? money(x.principal) : ''}),
  };
  let bankTx = null;
  const ev = (k) => (d.evidence?.[k] ? h('small', {class: 'evidence', title: d.evidence[k]}, `Sutartyje: „…${d.evidence[k]}…“`) : null);
  const fld = (label, el, k, hint) => h('div', null, field(label, el, hint), ev(k));
  const matches = (d.bankMatches || []).map((t) => h('label', {class: 'check'}, h('input', {type: 'radio', name: 'bankmatch', onchange: () => { bankTx = t.id; f.disb_date.value = t.booking_date; f.disb_amount.value = money(Math.abs(Number(t.amount))); }}),
    ` ${t.booking_date} · ${money(Math.abs(Number(t.amount)))} ${t.currency} · ${t.counterparty_name || ''} · ${t.reference || ''} (${t.account_name})`));
  const save = (e) => guard(async () => {
    e.preventDefault();
    const events = f.disb_date.value ? [{kind: 'disbursement', date: f.disb_date.value, amount: f.disb_amount.value || f.principal.value, bank_transaction_id: bankTx}] : [];
    const body = {direction: f.direction.value, counterparty_name: f.counterparty_name.value, counterparty_code: f.counterparty_code.value, counterparty_id: x.counterpartyId || null, contract_no: f.contract_no.value,
      contract_date: f.contract_date.value, principal: f.principal.value, currency: f.currency.value, annual_rate: f.annual_rate.value, rate_variable: f.rate_variable.checked, basis: f.basis.value,
      maturity_date: f.maturity_date.value, include_last_day: f.include_last_day.checked, notes: f.notes.value, document_id: d.documentId || null, events,
      extracted: d.documentId ? {fields: x, evidence: d.evidence, warnings: d.warnings} : null};
    const l = await post('/api/loans', body);
    draft = null; toast('Paskola išsaugota.', 'ok');
    location.hash = `#/palukanos/${l.id}`;
  });
  clear(main, pageHeader(d.documentId ? 'Paskolos sutarties sąlygos' : 'Nauja paskola', h('a', {class: 'btn', href: '#/palukanos'}, '← Palūkanos')),
    d.documentId ? h('p', {class: 'banner'}, 'Sąlygos perskaitytos iš sutarties ', h('a', {href: `#/dokumentai/${d.documentId}`}, d.documentTitle || `#${d.documentId}`), '. Patikrinkite ir patvirtinkite – niekas neišsaugota, kol nepaspausite „Išsaugoti“.') : null,
    d.warnings?.length ? h('ul', {class: 'issue issue-warning'}, d.warnings.map((w) => h('li', null, w))) : null,
    h('form', {onsubmit: save},
      section('Sutartis', h('div', {class: 'form-grid'}, fld('Tipas', f.direction, 'direction'), field('Kita šalis', f.counterparty_name), field('Kitos šalies įmonės kodas', f.counterparty_code),
        fld('Sutarties Nr.', f.contract_no, 'contractNo'), fld('Sutarties data', f.contract_date, 'contractDate'), fld('Grąžinti iki', f.maturity_date, 'maturityDate'))),
      section('Suma ir palūkanos', h('div', {class: 'form-grid'}, fld('Paskolos suma', f.principal, 'principal'), field('Valiuta', f.currency), fld('Palūkanos, % per metus', f.annual_rate, 'rate'),
        h('label', {class: 'check'}, f.rate_variable, ' Kintamos (bazinė norma + marža)'), fld('Dienų skaičiavimo bazė', f.basis, 'basis'), h('label', {class: 'check'}, f.include_last_day, ` Pagal nutylėjimą ${lastDayLabel.toLowerCase()}`))),
      section('Pinigų gavimas', h('p', {class: 'hint'}, 'Palūkanos skaičiuojamos nuo dienos, kai pinigai įkrito į sąskaitą (suteiktos paskolos – kai išmokėti). Pasirinkite banko operaciją arba įrašykite datą.'),
        matches.length ? h('div', {class: 'stack'}, h('strong', null, 'Banko operacijos, panašios į paskolos išmokėjimą:'), matches) : null,
        d.evidence?.plannedDisbursement ? ev('plannedDisbursement') : null,
        h('div', {class: 'form-grid'}, field('Pinigų gavimo diena', f.disb_date), field('Gauta suma', f.disb_amount, 'Jei paskola išmokėta dalimis – kitas dalis pridėkite paskolos kortelėje'))),
      section('Pastabos', f.notes),
      h('div', {class: 'actions sticky-actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti paskolą'))));
}

async function card(main, id, state) {
  const write = can(state.user, 'write');
  const asOf = input({type: 'date', value: today()});
  const lastDay = h('input', {type: 'checkbox'});
  const body = h('div');
  let seq = 0, first = true;
  const load = async () => {
    const my = ++seq;
    const l = await get(`/api/loans/${id}?${new URLSearchParams({asOf: asOf.value, ...(first ? {} : {includeLastDay: String(lastDay.checked)})})}`);
    if (my !== seq) return;
    if (first) { lastDay.checked = l.calc.includeLastDay; first = false; }
    const c = l.calc;
    const addEv = {kind: select(Object.entries(EVENT), 'repayment'), date: input({type: 'date', value: today()}), amount: input({inputmode: 'decimal'}), rate: input({inputmode: 'decimal'}), note: input()};
    const rateF = field('Nauja norma, %', addEv.rate), amtF = field('Suma', addEv.amount);
    const syncKind = () => { rateF.hidden = addEv.kind.value !== 'rate_change'; amtF.hidden = addEv.kind.value === 'rate_change'; };
    addEv.kind.addEventListener('change', syncKind); syncKind();
    const addEvent = (e) => guard(async () => {
      e.preventDefault();
      await post(`/api/loans/${id}/events`, {kind: addEv.kind.value, date: addEv.date.value, amount: addEv.amount.value, rate: addEv.rate.value, note: addEv.note.value});
      toast('Įrašas pridėtas.', 'ok'); load();
    });
    // Money in the loan's direction (in for a received loan, out for a granted one) is a disbursement, the other way a repayment.
    const txKind = (t) => ((l.direction === 'received') === (Number(t.amount) > 0) ? 'disbursement' : 'repayment');
    const useTx = (t) => guard(async () => {
      await post(`/api/loans/${id}/events`, {kind: txKind(t), date: t.booking_date, amount: String(Math.abs(Number(t.amount))), bank_transaction_id: t.id});
      toast(txKind(t) === 'disbursement' ? 'Pinigų gavimas pridėtas.' : 'Grąžinimas pridėtas.', 'ok'); load();
    });
    clear(body,
      c.notes.length ? h('ul', {class: 'issue issue-warning'}, c.notes.map((n) => h('li', null, n))) : null,
      h('div', {class: 'cols'},
        section('Sutartis', h('dl', {class: 'dl'}, h('dt', null, 'Tipas'), h('dd', null, DIR[l.direction]), h('dt', null, 'Kita šalis'), h('dd', null, l.cp_name || l.counterparty_name || '—'),
          h('dt', null, 'Sutarties data'), h('dd', null, date(l.contract_date)), h('dt', null, 'Paskolos suma'), h('dd', null, `${money(l.principal)} ${l.currency}`),
          h('dt', null, 'Palūkanos'), h('dd', null, `${pct(l.annual_rate)} per metus${l.rate_variable ? ' (kintamos)' : ''}`), h('dt', null, 'Dienų bazė'), h('dd', null, BASES[l.basis]),
          h('dt', null, 'Grąžinti iki'), h('dd', null, date(l.maturity_date)), h('dt', null, 'Sutarties dokumentas'), h('dd', null, l.document_id ? h('a', {href: `#/dokumentai/${l.document_id}`}, l.document_title || `#${l.document_id}`) : 'įvesta ranka'))),
        section(`Palūkanos iki ${c.asOf}`, h('dl', {class: 'dl'}, h('dt', null, 'Pinigai gauti'), h('dd', null, date(c.firstDisbursement)), h('dt', null, 'Paskolos likutis'), h('dd', null, `${money(c.balance)} ${l.currency}`),
          h('dt', null, 'Dienų'), h('dd', null, String(c.days)), h('dt', null, 'Priskaičiuota palūkanų'), h('dd', null, h('strong', {class: 'big'}, `${money(c.interest)} ${l.currency}`)),
          h('dt', null, 'Sumokėta palūkanų'), h('dd', null, money(c.paid)), h('dt', null, 'Liko mokėti'), h('dd', null, h('strong', null, `${money(c.due)} ${l.currency}`))))),
      section('Skaičiavimas pagal laikotarpius', periodsTable(c), h('p', {class: 'hint'}, `Kiekvieno laikotarpio palūkanos = likutis × norma × dienos / ${l.basis === 'act360' || l.basis === '30e360' ? 360 : l.basis === 'actact' ? '365 arba 366' : 365}. Suma suapvalinama iki cento tik pabaigoje.`)),
      accrualSection(l),
      section('Pinigų judėjimas ir pakeitimai', table([{label: 'Data', render: (e) => date(e.event_date)}, {label: 'Įvykis', render: (e) => EVENT[e.kind]},
        {label: 'Suma / norma', num: true, render: (e) => (e.kind === 'rate_change' ? pct(e.rate) : money(e.amount))}, {label: 'Banko operacija', render: (e) => (e.bank_transaction_id ? h('a', {href: `#/bankas/tx/${e.bank_transaction_id}`}, `#${e.bank_transaction_id}`) : '')},
        {label: 'Pastaba', key: 'note'}, {label: '', render: (e) => (write ? h('button', {class: 'btn btn-small', onclick: () => guard(async () => { if (await confirmDialog('Pašalinti įrašą', `Pašalinti „${EVENT[e.kind]}“ ${e.event_date}?`, 'Pašalinti')) { await del(`/api/loans/${id}/events/${e.id}`); load(); } })}, 'Pašalinti') : '')}],
      l.events, {empty: 'Įrašų nėra – pridėkite pinigų gavimo dieną.'}),
      write ? h('form', {onsubmit: addEvent}, h('div', {class: 'form-grid'}, field('Įvykis', addEv.kind), field('Data', addEv.date), amtF, rateF, field('Pastaba', addEv.note)), h('button', {class: 'btn'}, 'Pridėti')) : null),
      write && l.bankMatches.length ? section('Banko operacijos, kurios gali būti susijusios', table([{label: 'Data', key: 'booking_date'}, {label: 'Suma', num: true, render: (t) => `${money(t.amount)} ${t.currency}`}, {label: 'Mokėtojas / gavėjas', key: 'counterparty_name'},
        {label: 'Paskirtis', key: 'reference'}, {label: 'Sąskaita', key: 'account_name'}, {label: '', render: (t) => h('button', {class: 'btn btn-small', onclick: () => useTx(t)}, txKind(t) === 'disbursement' ? 'Pridėti kaip pinigų gavimą' : 'Pridėti kaip grąžinimą')}], l.bankMatches)) : null);
    clear(head, pageHeader(`${DIR[l.direction]}${l.contract_no ? ` Nr. ${l.contract_no}` : ''}${l.cp_name || l.counterparty_name ? ` – ${l.cp_name || l.counterparty_name}` : ''}`, h('a', {class: 'btn', href: '#/palukanos'}, '← Palūkanos'),
      write ? h('button', {class: 'btn', onclick: () => edit(l)}, 'Keisti sąlygas') : null,
      write ? h('button', {class: 'btn btn-danger', onclick: () => guard(async () => { if (await confirmDialog('Ištrinti paskolą', 'Paskola ir jos įrašai bus ištrinti (sutarties dokumentas saugykloje lieka).', 'Ištrinti')) { await del(`/api/loans/${id}`); location.hash = '#/palukanos'; } })}, 'Ištrinti') : null));
  };
  const accrualSection = (l) => {
    const a = l.accrual, approve = can(state.user, 'approve');
    const sign = Number(a.amount) < 0;
    return section('Palūkanų kaupimas DK',
      h('p', {class: 'hint'}, `Kaupiama palūkanų dalis, dar neužregistruota DK: apskaičiuotos palūkanos iki pasirinktos datos (${a.includeLastDay ? 'su' : 'be'} grąžinimo / paskutinės dienos – pagal paskolos nuostatą) minus jau sukauptos. Sąskaitas galima pakeisti „Keisti sąlygas“ arba Nustatymai → Kontavimo susiejimai.`),
      h('dl', {class: 'dl'}, h('dt', null, `Apskaičiuota iki ${a.asOf} imtinai`), h('dd', null, h('span', {title: 'Kaupiant DK pasirinkta diena įskaičiuojama visada (mėnesio paskutinė diena priklauso tam mėnesiui), todėl suma gali būti 1 dienos palūkanomis didesnė nei viršuje, jei grąžinimo diena neįskaičiuojama.'}, money(a.interestTotal))), h('dt', null, 'Jau sukaupta DK'), h('dd', null, `${money(a.booked)}${a.lastAccrual ? ` (iki ${a.lastAccrual})` : ''}`),
        h('dt', null, 'Bus užregistruota'), h('dd', null, a.blockers.length ? '—' : h('strong', null, `D ${a.debit} ${a.debitName} / K ${a.credit} ${a.creditName}: ${money(a.amountEur)} €${sign ? ' (koregavimas)' : ''}${a.fxRate ? ` (${money(a.amount)} ${l.currency} / ${a.fxRate})` : ''}, laikotarpis ${a.from || '—'} – ${a.asOf}`))),
      a.blockers.length ? h('p', {class: 'hint'}, a.blockers.join(' ')) : approve ? h('button', {class: 'btn btn-primary', onclick: () => guard(async () => {
        if (!await confirmDialog('Palūkanų kaupimas', `Užregistruoti DK: D ${a.debit} / K ${a.credit} ${money(a.amountEur)} € (${a.asOf})?`, 'Registruoti')) return;
        const r = await post(`/api/loans/${id}/accruals`, {asOf: a.asOf}); toast(`Užregistruota (įrašas #${r.entryId}).`, 'ok'); load();
      })}, `Kaupti palūkanas DK iki ${a.asOf}`) : null,
      l.accruals.length ? table([{label: 'Iki', key: 'as_of'}, {label: 'Laikotarpis nuo', render: (x) => date(x.period_from)}, {label: 'Suma', num: true, render: (x) => money(x.amount)}, {label: 'EUR', num: true, render: (x) => money(x.amount_eur)},
        {label: 'D / K', render: (x) => `${x.debit_account} / ${x.credit_account}`}, {label: 'Įrašas', render: (x) => (x.journal_entry_id ? h('a', {href: `#/ataskaitos/zurnalas/${x.journal_entry_id}`}, `#${x.journal_entry_id}`) : '')},
        {label: 'Būsena', render: (x) => (x.status === 'posted' ? 'Užregistruota' : 'Atšaukta')},
        {label: '', render: (x) => (approve && x.status === 'posted' && x.id === l.accruals.filter((y) => y.status === 'posted').at(-1).id ? h('button', {class: 'btn btn-small', onclick: () => guard(async () => {
          const reason = await promptDialog('Atšaukti kaupimą', 'Priežastis', {minLength: 5});
          if (!reason) return;
          await post(`/api/loans/${id}/accruals/${x.id}/cancel`, {reason}); toast('Kaupimas atšauktas atvirkštiniu įrašu.', 'ok'); load();
        })}, 'Atšaukti') : '')}], l.accruals) : null);
  };
  const edit = (l) => {
    const g = {contract_no: input({value: l.contract_no}), contract_date: input({type: 'date', value: l.contract_date || ''}), maturity_date: input({type: 'date', value: l.maturity_date || ''}), principal: input({value: money(l.principal), inputmode: 'decimal'}),
      annual_rate: input({value: String(Number(l.annual_rate)).replace('.', ','), inputmode: 'decimal'}), basis: select(Object.entries(BASES), l.basis), rate_variable: h('input', {type: 'checkbox', checked: l.rate_variable}),
      include_last_day: h('input', {type: 'checkbox', checked: l.include_last_day}), counterparty_name: input({value: l.counterparty_name || l.cp_name || ''}), status: select([['active', 'Galiojanti'], ['closed', 'Grąžinta / uždaryta']], l.status), notes: h('textarea', {rows: 2}, l.notes),
      interest_account: input({value: l.interest_account || '', placeholder: l.direction === 'received' ? '6802' : '5802'}), accrual_account: input({value: l.accrual_account || '', placeholder: l.direction === 'received' ? '491' : '292'})};
    const m = modal('Paskolos sąlygos', h('form', {onsubmit: (e) => guard(async () => {
      e.preventDefault();
      await put(`/api/loans/${id}`, Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.type === 'checkbox' ? v.checked : v.value])));
      m.close(); toast('Išsaugota.', 'ok'); first = true; load();
    })}, h('div', {class: 'form-grid'}, field('Kita šalis', g.counterparty_name), field('Sutarties Nr.', g.contract_no), field('Sutarties data', g.contract_date), field('Grąžinti iki', g.maturity_date), field('Paskolos suma', g.principal),
      field('Palūkanos, % per metus', g.annual_rate, 'Normos pasikeitimą nuo tam tikros datos įrašykite kaip įvykį'), field('Dienų bazė', g.basis), field('Būsena', g.status), h('label', {class: 'check'}, g.rate_variable, ' Kintamos'), h('label', {class: 'check'}, g.include_last_day, ` Pagal nutylėjimą ${lastDayLabel.toLowerCase()}`),
      field(l.direction === 'received' ? 'Palūkanų sąnaudų sąskaita' : 'Palūkanų pajamų sąskaita', g.interest_account, 'Tuščia – pagal kontavimo susiejimus'), field(l.direction === 'received' ? 'Sukauptų sąnaudų sąskaita' : 'Sukauptų pajamų sąskaita', g.accrual_account, 'Tuščia – pagal kontavimo susiejimus'), field('Pastabos', g.notes)),
    h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))), {wide: true});
  };
  const head = h('div');
  [asOf, lastDay].forEach((x) => x.addEventListener('change', () => guard(load)));
  clear(main, head, section(null, h('div', {class: 'filters'}, field('Skaičiuoti iki', asOf), h('label', {class: 'check'}, lastDay, ` ${lastDayLabel}`))), body);
  await load();
}
