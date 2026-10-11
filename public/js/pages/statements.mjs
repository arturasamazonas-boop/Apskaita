// Finansinės ataskaitos pagal VAS formas: balansas (2 VAS 1–3 priedai), pelno (nuostolių) ataskaita (3 VAS 1–2 priedai), PDF.
import {h, clear, get, put, pageHeader, section, guard, select, input, field, can, today, toast} from '../core.mjs';

const nf0 = new Intl.NumberFormat('lt-LT', {maximumFractionDigits: 0}), nf2 = new Intl.NumberFormat('lt-LT', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmt = (v, cents) => { if (v === null || v === undefined) return ''; const n = Number(v); if (!n) return '–'; const s = (cents ? nf2 : nf0).format(Math.abs(n)); return n < 0 ? `(${s})` : s; };
const lastYearEnd = () => `${Number(today().slice(0, 4)) - 1}-12-31`;
const remember = (k, v) => { try { if (v === undefined) return localStorage.getItem(`fs.${k}`); localStorage.setItem(`fs.${k}`, v); } catch { return null; } return null; };

export async function render(main, rest, state) {
  const [forms, company] = await Promise.all([get('/api/statements'), get('/api/settings/company')]);
  const key = forms.some((f) => f.key === rest[0]) ? rest[0] : 'balansas-sutrumpintas';
  const form = forms.find((f) => f.key === key);
  const isBal = form.kind === 'balance';
  const isEq = form.kind === 'equity';
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = {
    form: select(forms.map((x) => [x.key, `${x.name} (${x.annex})`]), key, {onchange: () => { location.hash = `#/finansines/${f.form.value}`; }}),
    to: input({type: 'date', value: params.get('to') || lastYearEnd()}),
    from: input({type: 'date', value: params.get('from') || `${(params.get('to') || lastYearEnd()).slice(0, 4)}-01-01`}),
    prevTo: input({type: 'date', value: params.get('prevTo') || ''}),
    precision: select([['eur', 'Eurais (be centų)'], ['cents', 'Eurais ir centais']], params.get('precision') || remember('precision') || 'eur'),
    compiled: input({type: 'date', value: today()}), number: input({value: remember('number') || '1', style: {maxWidth: '6rem'}}), status: input({placeholder: 'tik jei įmonė likviduojama, reorganizuojama ar bankrutavusi'}),
    managerTitle: input({value: company.manager_title || 'Direktorius'}), managerName: input({value: company.manager || ''}),
    accountantTitle: input({value: company.accountant_title || 'Buhalteris'}), accountantName: input({value: company.accountant_name || ''}),
  };
  const out = h('div');
  let st = null, editPrior = false;
  const qs = () => new URLSearchParams({...(isBal ? {to: f.to.value, ...(f.prevTo.value && {prevTo: f.prevTo.value})} : isEq ? {to: f.to.value} : {from: f.from.value, to: f.to.value}), precision: f.precision.value});
  const pdfUrl = (inline) => `/api/statements/${key}/pdf?${qs()}&${new URLSearchParams({compiled: f.compiled.value, number: f.number.value, status: f.status.value, managerTitle: f.managerTitle.value,
    managerName: f.managerName.value, accountantTitle: f.accountantTitle.value, accountantName: f.accountantName.value, ...(inline && {inline: '1'})})}`;
  const priorInputs = new Map();
  const draw = () => {
    const cents = st.precision === 'cents';
    priorInputs.clear();
    const rows = st.lines.map((l) => {
      let prev = fmt(l.previous, cents);
      if (editPrior && l.editablePrior) { const i = input({value: l.priorOverridden ? String(l.previous) : '', placeholder: String(Number(l.previous) || ''), inputmode: 'decimal', class: 'num-input', 'aria-label': `${l.no} ${l.label} praėjęs laikotarpis`}); priorInputs.set(l.id, i); prev = i; }
      const strong = l.total || /^[A-H]\.$/.test(l.no) || (l.label === l.label.toUpperCase() && /[A-ZĄČĘĖĮŠŲŪŽ]/.test(l.label));
      return h('tr', {class: [l.heading && 'fs-heading', strong && 'fs-total', l.grand && 'fs-grand']},
        h('td', {class: 'fs-no'}, l.no), h('td', null, l.label), h('td', {class: 'fs-note'}), h('td', {class: 'num'}, l.heading ? '' : fmt(l.current, cents)),
        h('td', {class: ['num', l.priorOverridden && 'fs-manual'], title: l.priorOverridden ? 'Įvesta ranka' : null}, l.heading ? '' : prev));
    });
    clear(out,
      st.checks.length ? h('div', {class: 'checks'}, st.checks.map((c) => h('p', {class: `issue issue-${c.level}`, role: c.level === 'error' ? 'alert' : null}, c.message))) : h('p', {class: 'issue issue-ok'}, {balance: '✓ Turtas lygus nuosavam kapitalui ir įsipareigojimams; visos sąskaitos su likučiais priskirtos formos eilutėms.', pl: '✓ Visos pajamų ir sąnaudų sąskaitos priskirtos formos eilutėms.',
        cf: '✓ Pinigų srautų suma lygi pinigų likučio pokyčiui (VII eilutė = pinigai laikotarpio pabaigoje).', equity: '✓ Likučiai sutampa su pokyčiais ir balanso nuosavo kapitalo straipsniais.'}[st.form.kind]),
      h('div', {class: 'fs-sheet'},
        h('p', {class: 'fs-standard'}, st.form.standard, h('br'), st.form.annex),
        h('p', {class: 'fs-company'}, [st.company.name, st.company.code && `įmonės kodas ${st.company.code}`].filter(Boolean).join(', ')),
        h('p', {class: 'fs-caption'}, '(įmonės teisinė forma, pavadinimas, kodas)'),
        h('p', {class: 'fs-line'}, [st.company.address, 'Juridinių asmenų registras'].filter(Boolean).join(', ')), h('p', {class: 'fs-caption'}, '(buveinė (adresas), registras, kuriame kaupiami ir saugomi duomenys)'),
        h('h2', {class: 'fs-title'}, `${st.period.to} ${st.form.title}`),
        h('p', {class: 'fs-line'}, `${f.compiled.value} Nr. ${f.number.value}`), h('p', {class: 'fs-caption'}, '(ataskaitos sudarymo data)'),
        h('p', {class: 'fs-line'}, `${st.period.from} – ${st.period.to}    ·    ${cents ? 'eurais ir centais' : 'eurais'}`), h('p', {class: 'fs-caption'}, '(ataskaitinis laikotarpis) · (ataskaitos tikslumo lygis ir valiuta)'),
        st.matrix ? h('div', {class: 'table-wrap'}, h('table', {class: 'grid lines fs-matrix'},
          h('thead', null, h('tr', null, h('th', null, 'Eil. Nr.'), h('th', null, 'Straipsniai'), st.matrix.cols.map((c) => h('th', {class: 'num'}, c.label)))),
          h('tbody', null, st.matrix.rows.map((r) => h('tr', {class: r.strong && 'fs-total'}, h('td', {class: 'fs-no'}, `${r.no}.`), h('td', null, r.label), st.matrix.cols.map((c) => h('td', {class: 'num'}, fmt(st.matrix.cells[r.no][c.key], cents))))))))
          : h('div', {class: 'table-wrap'}, h('table', {class: 'grid lines fs-table'},
            h('thead', null, h('tr', null, h('th', null, 'Eil. Nr.'), h('th', null, 'Straipsniai'), h('th', null, 'Pastabos Nr.'), h('th', {class: 'num'}, st.form.colTitles[0]), h('th', {class: 'num'}, `${st.form.colTitles[1]} (${st.previousPeriod.to})`))),
            h('tbody', null, rows))),
        h('div', {class: 'fs-signs'}, h('p', null, `${f.managerTitle.value}  ______________  ${f.managerName.value}`), h('p', null, `${f.accountantTitle.value}  ______________  ${f.accountantName.value}`))),
      can(state.user, 'approve') && !st.matrix ? h('div', {class: 'actions-left'}, editPrior
        ? [h('button', {class: 'btn btn-primary', onclick: () => guard(async () => {
          await put(`/api/statements/${key}/prior`, {periodEnd: st.previousPeriod.to, values: Object.fromEntries([...priorInputs].map(([id, i]) => [id, i.value]))});
          editPrior = false; await load();
        }, 'Praėjusio laikotarpio duomenys išsaugoti.')}, 'Išsaugoti praėjusio laikotarpio sumas'), h('button', {class: 'btn', onclick: () => { editPrior = false; draw(); }}, 'Atšaukti'),
          h('span', {class: 'hint'}, 'Tuščias langelis – suma skaičiuojama iš didžiosios knygos. Sumos stulpeliai sumuojami automatiškai.')]
        : h('button', {class: 'btn', onclick: () => { editPrior = true; draw(); }}, 'Įvesti praėjusio laikotarpio sumas ranka')) : null);
  };
  const load = async () => {
    st = await get(`/api/statements/${key}?${qs()}`);
    remember('precision', f.precision.value); remember('number', f.number.value);
    history.replaceState(null, '', `#/finansines/${key}?${qs()}`);
    draw();
  };
  const saveSigners = () => guard(async () => {
    await put('/api/settings/company', {...(await get('/api/settings/company')), manager_title: f.managerTitle.value, manager: f.managerName.value, accountant_title: f.accountantTitle.value, accountant_name: f.accountantName.value});
  }, 'Parašų duomenys įsiminti.');
  clear(main, pageHeader(form.name,
    h('button', {class: 'btn btn-primary', onclick: () => { location.href = pdfUrl(false); }}, '⇩ Atsisiųsti PDF'),
    h('a', {class: 'btn', href: '#', onclick: (e) => { e.preventDefault(); window.open(pdfUrl(true), '_blank', 'noopener'); }}, 'Peržiūrėti PDF')),
    h('p', {class: 'hint'}, `${form.standard}, ${form.annex}. ${form.who} Sumos – iš užregistruotų didžiosios knygos įrašų pagal sąskaitų plano grupes.`),
    section(null,
      h('div', {class: 'form-grid'}, field('Forma', f.form), isBal || isEq ? null : field('Nuo', f.from), field(isBal ? 'Balanso data' : isEq ? 'Ataskaitinių metų pabaiga' : 'Iki', f.to),
        isBal ? field('Praėjusio laikotarpio data', f.prevTo, 'Tuščia – praėjusių metų gruodžio 31 d.') : null, field('Tikslumas', f.precision)),
      h('details', {class: 'fs-header-fields'}, h('summary', null, 'Antraštė ir parašai (PDF)'),
        h('div', {class: 'form-grid'}, field('Sudarymo data', f.compiled), field('Nr.', f.number), field('Teisinis statusas', f.status),
          field('Vadovo pareigos', f.managerTitle), field('Vadovo vardas, pavardė', f.managerName), field('Buhalterio pareigos', f.accountantTitle), field('Buhalterio vardas, pavardė', f.accountantName)),
        can(state.user, 'settings') ? h('button', {class: 'btn btn-small', onclick: saveSigners}, 'Įsiminti parašų duomenis') : null),
      h('button', {class: 'btn btn-primary', onclick: () => guard(load)}, 'Formuoti')),
    out);
  [f.to, f.from, f.prevTo, f.precision].forEach((x) => x.addEventListener('change', () => guard(load)));
  [f.compiled, f.number, f.managerTitle, f.managerName, f.accountantTitle, f.accountantName].forEach((x) => x.addEventListener('input', () => st && draw()));
  await load();
}
