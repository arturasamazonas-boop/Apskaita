// Mokėjimų ruošimas: choose open supplier invoices (or a payroll sheet) and download a SEPA pain.001 file for upload to the bank.
import {h, clear, get, api, pageHeader, section, table, money, date, guard, select, input, field, can, today, toast} from '../core.mjs';

async function download(body) {
  const res = await api('POST', '/api/payments/sepa', body, {raw: true});
  if (!res.ok) throw new Error((await res.json()).error);
  const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'mokejimai.xml';
  const a = h('a', {href: URL.createObjectURL(await res.blob()), download: name}); document.body.append(a); a.click(); a.remove();
  toast('Mokėjimų failas paruoštas – įkelkite jį banke (Mokėjimai → Importuoti failą) ir pasirašykite.', 'ok');
}

export async function render(main, rest, state) {
  const [accounts, payables, runs] = await Promise.all([get('/api/bank/accounts'), get('/api/payments/payables'), get('/api/payroll/runs')]);
  const acct = select(accounts.filter((a) => a.active && a.kind === 'bank').map((a) => [a.id, `${a.name} – ${a.iban}`]), accounts[0]?.id || '');
  const exec = input({type: 'date', value: today(), min: today()});
  const picked = new Map();
  const totalBox = h('strong');
  const recount = () => { totalBox.textContent = `Pažymėta: ${picked.size} sąsk., ${money([...picked.values()].reduce((s, x) => s + Number(x.amount.value.replace(',', '.') || 0), 0))} €`; };
  const rows = payables.map((p) => ({...p, amount: input({value: p.outstanding, inputmode: 'decimal', class: 'num-input', 'aria-label': `${p.label} mokama suma`}), iban: input({value: p.iban, placeholder: 'LT…', 'aria-label': `${p.label} IBAN`})}));
  rows.forEach((r) => r.amount.addEventListener('input', recount));
  const overdue = (d) => d && String(d).slice(0, 10) < today();
  const runOpts = runs.filter((r) => r.status === 'approved');
  const run = select(runOpts.map((r) => [r.id, `${r.period} – išmokėti ${money(r.to_pay)} €`]), runOpts[0]?.id || '');
  clear(main, pageHeader('Mokėjimų ruošimas (SEPA)'),
    h('p', {class: 'hint'}, 'Sugeneruojamas ISO 20022 pain.001.001.03 failas, kurį priima Lietuvos bankai. Failas tik paruošia mokėjimus – juos pasirašote banke. Apmokėjimai apskaitoje užregistruojami importavus banko išrašą.'),
    !accounts.length ? h('p', {class: 'issue issue-warning'}, h('a', {href: '#/bankas/saskaitos'}, 'Pirmiausia įveskite įmonės banko sąskaitą →')) : null,
    section(null, h('div', {class: 'form-grid'}, field('Mokėti iš sąskaitos', acct), field('Mokėjimo data', exec))),
    section('Tiekėjų sąskaitos',
      table([{label: '', render: (p) => h('input', {type: 'checkbox', 'aria-label': `Mokėti ${p.label}`, onchange: (e) => { if (e.target.checked) picked.set(p.id, p); else picked.delete(p.id); recount(); }})},
        {label: 'Tiekėjas', key: 'counterparty'}, {label: 'Sąskaita', key: 'label'}, {label: 'Data', render: (p) => date(p.issue_date)},
        {label: 'Terminas', render: (p) => (overdue(p.due_date) ? h('strong', {class: 'text-error'}, date(p.due_date)) : date(p.due_date))},
        {label: 'Likutis', num: true, render: (p) => money(p.outstanding)}, {label: 'Mokama suma', render: (p) => p.amount}, {label: 'Gavėjo IBAN', render: (p) => p.iban}],
      rows, {empty: 'Neapmokėtų tiekėjų sąskaitų nėra.'}),
      h('div', {class: 'actions-left'}, totalBox, can(state.user, 'approve') ? h('button', {class: 'btn btn-primary', onclick: () => guard(() => {
        if (!picked.size) throw new Error('Pažymėkite bent vieną sąskaitą.');
        return download({source: 'invoices', bankAccountId: acct.value, executionDate: exec.value, items: [...picked.values()].map((p) => ({id: p.id, amount: p.amount.value, iban: p.iban.value}))});
      })}, '⇩ Mokėjimų failas (XML)') : null)),
    section('Darbo užmokestis',
      runOpts.length ? [h('div', {class: 'form-grid'}, field('Patvirtintas žiniaraštis', run)), h('p', {class: 'hint'}, 'Mokama darbuotojams „Išmokėti“ sumos į darbuotojo kortelėje nurodytą IBAN (mokėjimo paskirtis – SALA).'),
        can(state.user, 'approve') ? h('button', {class: 'btn', onclick: () => guard(() => download({source: 'payroll', runId: run.value, bankAccountId: acct.value, executionDate: exec.value}))}, '⇩ Atlyginimų mokėjimų failas') : null]
        : h('p', {class: 'hint'}, 'Patvirtintų darbo užmokesčio žiniaraščių nėra.')));
  recount();
}
