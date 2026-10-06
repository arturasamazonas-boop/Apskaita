// Nustatymai: company, VAT codes, chart of accounts, posting mappings, series, rules, users, period lock, retention, audit, jobs.
import {h, clear, get, post, put, pageHeader, section, table, money, date, dateTime, guard, select, input, field, can, modal, LINE_TYPE, VAT_T, pager} from '../core.mjs';

const TABS = [['imone', 'Įmonė'], ['pvm', 'PVM kodai'], ['saskaitos', 'Sąskaitų planas'], ['kontavimas', 'Kontavimo susiejimai'], ['serijos', 'Dokumentų serijos'], ['taisykles', 'Klasifikavimo taisyklės'],
  ['laikotarpiai', 'Laikotarpių užrakinimas'], ['naudotojai', 'Naudotojai'], ['auditas', 'Audito žurnalas'], ['uzduotys', 'Foninės užduotys']];

export async function render(main, rest, state) {
  const key = rest[0] || 'imone';
  const body = h('div', {class: 'report-body'});
  clear(main, pageHeader('Nustatymai'), h('div', {class: 'report-layout'}, h('nav', {class: 'subnav', 'aria-label': 'Nustatymai'}, TABS.map(([k, t]) => h('a', {href: `#/nustatymai/${k}`, 'aria-current': k === key ? 'page' : 'false'}, t))), body));
  const fn = {imone: company, pvm: taxes, saskaitos: chart, kontavimas: roles, serijos: series, taisykles: rules, laikotarpiai: lock, naudotojai: users, auditas: auditLog, uzduotys: jobs}[key] || company;
  await fn(body, state);
}

async function company(body, state) {
  const c = await get('/api/settings/company');
  const f = {name: input({value: c.name}), legal_form: input({value: c.legal_form}), company_code: input({value: c.company_code}), vat_registered: h('input', {type: 'checkbox', checked: c.vat_registered}), vat_code: input({value: c.vat_code}),
    vat_registered_from: input({type: 'date', value: c.vat_registered_from || ''}), address: input({value: c.address}), email: input({value: c.email}), phone: input({value: c.phone}), asset_threshold: input({value: c.asset_threshold}), retention_note: h('textarea', {rows: 3}, c.retention_note)};
  const ro = !can(state.user, 'settings');
  Object.values(f).forEach((x) => { x.disabled = ro; });
  clear(body, h('h2', null, 'Įmonės rekvizitai'), h('form', {onsubmit: async (e) => { e.preventDefault(); await guard(() => put('/api/settings/company', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.type === 'checkbox' ? v.checked : v.value || (k.endsWith('from') ? null : v.value)]))), 'Išsaugota.'); }},
    h('div', {class: 'form-grid'}, field('Pavadinimas', f.name), field('Teisinė forma', f.legal_form), field('Įmonės kodas', f.company_code), h('label', {class: 'check'}, f.vat_registered, ' PVM mokėtoja'), field('PVM kodas', f.vat_code), field('PVM mokėtoja nuo', f.vat_registered_from),
      field('Adresas', f.address), field('El. paštas', f.email), field('Telefonas', f.phone), field('Ilgalaikio turto riba (EUR)', f.asset_threshold), field('Dokumentų saugojimo politika', f.retention_note, 'Įrašykite savo įmonės taikomus terminus; programa teisės aktų nustatytų terminų nenustato.')),
    h('p', {class: 'hint'}, 'Apskaitos valiuta: EUR. Laiko juosta: Europe/Vilnius.'), ro ? null : h('button', {class: 'btn btn-primary'}, 'Išsaugoti')));
}

async function taxes(body, state) {
  const rows = await get('/api/tax-codes');
  clear(body, h('h2', null, 'PVM kodai'), h('p', {class: 'hint'}, 'Pagal VMI PVM klasifikatorių (VA-49, redakcija nuo 2026-01-01). 9 % tarifas (PVM2) galiojo iki 2025-12-31; nuo 2026-01-01 paslaugoms – 12 % (PVM58). Konkretaus tarifo taikymą turi patvirtinti buhalteris.'),
    table([{label: 'Kodas', key: 'code'}, {label: 'Tarifas', render: (t) => (t.rate === null ? 'be tarifo' : `${Number(t.rate)} %`)}, {label: 'Aprašymas', key: 'description'}, {label: 'Taikoma', render: (t) => ({sales: 'pardavimams', purchase: 'pirkimams', both: 'abiem'}[t.applies_to])},
      {label: 'Galioja', render: (t) => `${date(t.effective_from)} – ${t.effective_to ? date(t.effective_to) : '…'}`}, {label: 'Aktyvus', render: (t) => (t.active ? 'taip' : 'ne')}], rows),
    can(state.user, 'settings') ? section('Naujas kodas', (() => {
      const f = {code: input({placeholder: 'PVM…'}), rate: input({inputmode: 'decimal', placeholder: 'tuščia – be tarifo'}), description: input(), applies_to: select([['both', 'Abiem'], ['sales', 'Pardavimams'], ['purchase', 'Pirkimams']], 'both'), effective_from: input({type: 'date'}), effective_to: input({type: 'date'})};
      return h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post('/api/tax-codes', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]))), 'Pridėta.')) taxes(body, state); }},
        h('div', {class: 'form-grid'}, field('Kodas', f.code), field('Tarifas %', f.rate), field('Aprašymas', f.description), field('Taikoma', f.applies_to), field('Galioja nuo', f.effective_from), field('Galioja iki', f.effective_to)), h('button', {class: 'btn btn-primary'}, 'Pridėti'));
    })()) : null);
}

async function chart(body, state) {
  const rows = await get('/api/accounts');
  clear(body, h('h2', null, 'Sąskaitų planas'), h('p', {class: 'hint'}, 'Pradinis supaprastintas planas – pritaikykite su buhalteriu. Naudojamų sąskaitų tipo keisti negalima.'),
    table([{label: 'Kodas', key: 'code'}, {label: 'Pavadinimas', key: 'name'}, {label: 'Tipas', render: (a) => ({asset: 'Turtas', liability: 'Įsipareigojimai', equity: 'Nuosavybė', revenue: 'Pajamos', expense: 'Sąnaudos'}[a.type])}, {label: 'Vaidmuo', key: 'system_role'},
      {label: 'Aktyvi', render: (a) => (can(state.user, 'settings') ? h('input', {type: 'checkbox', checked: a.active, 'aria-label': `Aktyvi ${a.code}`, onchange: (e) => guard(() => put(`/api/accounts/${a.code}`, {active: e.target.checked}), 'Išsaugota.')}) : a.active ? 'taip' : 'ne')}], rows),
    can(state.user, 'settings') ? section('Nauja sąskaita', (() => {
      const f = {code: input({inputmode: 'numeric'}), name: input(), type: select([['expense', 'Sąnaudos'], ['revenue', 'Pajamos'], ['asset', 'Turtas'], ['liability', 'Įsipareigojimai'], ['equity', 'Nuosavybė']], 'expense')};
      return h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post('/api/accounts', {code: f.code.value, name: f.name.value, type: f.type.value}), 'Pridėta.')) chart(body, state); }}, h('div', {class: 'form-grid'}, field('Kodas', f.code), field('Pavadinimas', f.name), field('Tipas', f.type)), h('button', {class: 'btn btn-primary'}, 'Pridėti'));
    })()) : null);
}

async function roles(body, state) {
  const rows = await get('/api/accounts');
  const ROLE = {receivable: 'Pirkėjų skolos', payable: 'Skolos tiekėjams', vat_input: 'Gautinas PVM', vat_output: 'Mokėtinas PVM', bank_default: 'Bankas (numatyta)', advances_received: 'Gauti avansai', advances_paid: 'Sumokėti avansai',
    transfer_clearing: 'Pinigai kelyje', unidentified: 'Neišaiškinti mokėjimai', bank_fees: 'Banko mokesčiai', processor_fees: 'Tarpininkų mokesčiai', cogs: 'Savikaina', inventory: 'Atsargos', revenue_goods: 'Prekių pajamos', revenue_services: 'Paslaugų pajamos',
    revenue_shipping: 'Pristatymo pajamos', retained_earnings: 'Nepaskirstytasis pelnas', current_result: 'Ataskaitinių metų rezultatas', prepaid: 'Ateinančių laik. sąnaudos', fixed_assets: 'Ilgalaikis turtas'};
  const sel = Object.fromEntries(Object.keys(ROLE).map((r) => [r, select(rows.filter((a) => a.active).map((a) => [a.code, `${a.code} ${a.name}`]), rows.find((a) => a.system_role === r)?.code || '', {disabled: !can(state.user, 'settings')})]));
  clear(body, h('h2', null, 'Kontavimo susiejimai'), h('p', {class: 'hint'}, 'Kurios sąskaitos naudojamos automatiniuose įrašuose. Pakeitimai taikomi tik naujiems įrašams.'),
    h('form', {onsubmit: async (e) => { e.preventDefault(); await guard(() => put('/api/posting-roles', Object.fromEntries(Object.entries(sel).map(([k, v]) => [k, v.value]))), 'Išsaugota.'); }}, h('div', {class: 'form-grid'}, Object.entries(ROLE).map(([k, t]) => field(t, sel[k]))),
      can(state.user, 'settings') ? h('button', {class: 'btn btn-primary'}, 'Išsaugoti') : null));
}

async function series(body, state) {
  const rows = await get('/api/series');
  const f = {code: input(), doc_type: select([['invoice', 'Sąskaitos'], ['credit_note', 'Kreditinės']], 'invoice'), next_number: input({value: '1', inputmode: 'numeric'}), padding: input({value: '6', inputmode: 'numeric'}), description: input()};
  clear(body, h('h2', null, 'Dokumentų serijos'), h('p', {class: 'hint'}, 'Numeris suteikiamas patvirtinant, užrakinant seriją duomenų bazėje – numeriai unikalūs ir be tarpų net kai tvirtina keli naudotojai vienu metu.'),
    table([{label: 'Serija', key: 'code'}, {label: 'Tipas', key: 'doc_type'}, {label: 'Kitas numeris', key: 'next_number'}, {label: 'Skaitmenų', key: 'padding'}, {label: 'Aprašymas', key: 'description'}], rows),
    can(state.user, 'settings') ? section('Nauja serija / keisti', h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post('/api/series', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]))), 'Išsaugota.')) series(body, state); }},
      h('div', {class: 'form-grid'}, field('Serija', f.code), field('Tipas', f.doc_type), field('Kitas numeris (tik didinti)', f.next_number), field('Skaitmenų', f.padding), field('Aprašymas', f.description)), h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))) : null);
}

async function rules(body, state) {
  const [rows, accounts] = await Promise.all([get('/api/rules?all=1'), get('/api/accounts')]);
  const form = (r = {}) => {
    const f = {name: input({value: r.name || ''}), register: select([['purchase', 'Pirkimai'], ['sales', 'Pardavimai']], r.register || 'purchase'), counterparty_id: input({value: r.counterparty_id || '', inputmode: 'numeric'}), match_text: input({value: r.match_text || ''}),
      priority: input({value: r.priority || '100', inputmode: 'numeric'}), effective_from: input({type: 'date', value: r.effective_from || new Date().toISOString().slice(0, 10)}), effective_to: input({type: 'date', value: r.effective_to || ''}),
      account_code: select(accounts.filter((a) => a.active).map((a) => [a.code, `${a.code} ${a.name}`]), r.account_code || ''), line_type: select(Object.entries(LINE_TYPE), r.line_type || 'expense'),
      vat_treatment: select(Object.entries(VAT_T), r.vat_treatment || 'deductible'), note: input({value: ''})};
    const m = modal(r.rule_key ? `Nauja taisyklės versija (${r.rule_key})` : 'Nauja taisyklė', h('form', {onsubmit: async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value || null]));
      if (await guard(() => post('/api/rules', {...b, rule_key: r.rule_key}), 'Taisyklė patvirtinta jūsų vardu.')) { m.close(); rules(body, state); }
    }}, h('div', {class: 'form-grid'}, field('Pavadinimas', f.name), field('Registras', f.register), field('Kontrahento ID (tuščia – visiems)', f.counterparty_id), field('Aprašyme yra tekstas', f.match_text), field('Prioritetas', f.priority, 'Mažesnis – svarbesnis'),
      field('Galioja nuo', f.effective_from), field('Galioja iki', f.effective_to), field('Sąskaita', f.account_code), field('Eilutės tipas', f.line_type), field('PVM', f.vat_treatment), field('Pastaba', f.note)),
    h('p', {class: 'hint'}, 'Taisyklė niekada nesukuriama automatiškai iš AI pasiūlymų. Kiekviena versija saugoma su tvirtinusio naudotojo vardu.'), h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Patvirtinti'))), {wide: true});
  };
  clear(body, h('h2', null, 'Klasifikavimo taisyklės'), can(state.user, 'rules') ? h('button', {class: 'btn btn-primary', onclick: () => form()}, '+ Nauja taisyklė') : null,
    table([{label: 'Taisyklė', render: (r) => `${r.rule_key} v${r.version}`}, {label: 'Pavadinimas', key: 'name'}, {label: 'Būsena', render: (r) => (r.status === 'active' ? 'aktyvi' : 'pakeista / išjungta')}, {label: 'Kontrahentas', render: (r) => r.counterparty_name || 'visi'},
      {label: 'Tekstas', key: 'match_text'}, {label: 'Sąskaita', key: 'account_code'}, {label: 'PVM', render: (r) => VAT_T[r.vat_treatment]}, {label: 'Prioritetas', key: 'priority'}, {label: 'Galioja', render: (r) => `${date(r.effective_from)} – ${r.effective_to ? date(r.effective_to) : '…'}`},
      {label: 'Patvirtino', render: (r) => `${r.approved_by_name || ''} ${dateTime(r.approved_at)}`}, {label: 'Panaudota', key: 'used_count'},
      {label: '', render: (r) => (r.status === 'active' && can(state.user, 'rules') ? h('span', null, h('button', {class: 'btn btn-small', onclick: () => form(r)}, 'Keisti'), ' ', h('button', {class: 'btn btn-small', onclick: () => guard(() => post(`/api/rules/${r.rule_key}/retire`), 'Išjungta.').then(() => rules(body, state))}, 'Išjungti')) : '')}], rows));
}

async function lock(body, state) {
  const c = await get('/api/settings/company');
  const d = input({type: 'date', value: c.locked_through || ''}), note = input();
  clear(body, h('h2', null, 'Laikotarpių užrakinimas'), h('p', null, `Užrakinta iki: ${c.locked_through ? date(c.locked_through) : 'neužrakinta'}.`),
    h('p', {class: 'hint'}, 'Užrakintame laikotarpyje negalima registruoti jokių įrašų – nei per vartotojo sąsają, nei per API ar fonines užduotis (tikrinama ir duomenų bazėje). Atrakinti gali tik administratorius.'),
    can(state.user, 'lock') ? h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post('/api/settings/lock-period', {lockedThrough: d.value || null, note: note.value}), 'Išsaugota.')) lock(body, state); }}, h('div', {class: 'form-grid'}, field('Užrakinti iki (imtinai)', d), field('Pastaba', note)), h('button', {class: 'btn btn-primary'}, 'Išsaugoti')) : null);
}

async function users(body, state) {
  if (!can(state.user, 'users')) return clear(body, h('p', null, 'Tik administratorius.'));
  const rows = await get('/api/users');
  const f = {email: input({type: 'email'}), name: input(), role: select([['accountant', 'Buhalteris'], ['readonly', 'Tik skaitymas'], ['admin', 'Administratorius']], 'accountant'), password: input({type: 'password', autocomplete: 'new-password'})};
  const ROLE = {admin: 'Administratorius', accountant: 'Buhalteris', readonly: 'Tik skaitymas'};
  clear(body, h('h2', null, 'Naudotojai'), table([{label: 'El. paštas', key: 'email'}, {label: 'Vardas', key: 'name'}, {label: 'Vaidmuo', render: (u) => (u.id === state.user.id ? ROLE[u.role] : select(Object.entries(ROLE), u.role, {'aria-label': 'Vaidmuo', onchange: (e) => guard(() => put(`/api/users/${u.id}`, {role: e.target.value}), 'Pakeista.')}))},
    {label: 'Aktyvus', render: (u) => (u.id === state.user.id ? 'taip' : h('input', {type: 'checkbox', checked: u.active, 'aria-label': 'Aktyvus', onchange: (e) => guard(() => put(`/api/users/${u.id}`, {active: e.target.checked}), 'Pakeista.')}))}], rows),
  section('Naujas naudotojas', h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post('/api/users', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]))), 'Naudotojas sukurtas.')) users(body, state); }},
    h('div', {class: 'form-grid'}, field('El. paštas', f.email), field('Vardas', f.name), field('Vaidmuo', f.role), field('Pradinis slaptažodis (≥10)', f.password)), h('button', {class: 'btn btn-primary'}, 'Sukurti'))));
}

async function auditLog(body, state) {
  if (!can(state.user, 'resolve')) return clear(body, h('p', null, 'Neturite teisės.'));
  const st = {offset: 0, limit: 100, entityType: ''};
  const box = h('div');
  const load = async () => {
    const d = await get(`/api/audit?${new URLSearchParams({limit: st.limit, offset: st.offset, entityType: st.entityType})}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(box, table([{label: 'Laikas', render: (a) => dateTime(a.at)}, {label: 'Naudotojas', render: (a) => a.user_name || a.actor}, {label: 'Veiksmas', key: 'action'}, {label: 'Objektas', render: (a) => `${a.entity_type} ${a.entity_id || ''}`}, {label: 'Detalės', render: (a) => h('code', {class: 'clip'}, JSON.stringify(a.details))}], d.items), pager(st, load));
  };
  const t = select([['', 'Visi'], ['document', 'Dokumentai'], ['proposal', 'Pasiūlymai'], ['bank_transaction', 'Banko operacijos'], ['bank_statement', 'Išrašai'], ['rule', 'Taisyklės'], ['user', 'Naudotojai'], ['company', 'Įmonė'], ['store', 'Parduotuvės'], ['journal_entry', 'Įrašai']], '', {onchange: () => { st.entityType = t.value; st.offset = 0; load(); }});
  clear(body, h('h2', null, 'Audito žurnalas'), h('p', {class: 'hint'}, 'Žurnalas tik papildomas – įrašų keisti ar trinti negalima.'), field('Objektų tipas', t), box);
  await load();
}

async function jobs(body, state) {
  const rows = await get('/api/jobs');
  clear(body, h('h2', null, 'Foninės užduotys'), table([{label: 'ID', key: 'id'}, {label: 'Tipas', key: 'type'}, {label: 'Būsena', key: 'status'}, {label: 'Bandymai', render: (j) => `${j.attempts}/${j.max_attempts}`}, {label: 'Sukurta', render: (j) => dateTime(j.created_at)}, {label: 'Klaida', key: 'last_error'},
    {label: '', render: (j) => (j.status === 'dead' && can(state.user, 'write') ? h('button', {class: 'btn btn-small', onclick: () => guard(() => post(`/api/jobs/${j.id}/retry`), 'Grąžinta į eilę.').then(() => jobs(body, state))}, 'Kartoti') : '')}], rows));
}
