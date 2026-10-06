// Integracijos: Saleor and OpenCart connections, sync status, counts, errors, retry, status mapping, setup instructions.
import {h, clear, get, post, put, pageHeader, section, table, dateTime, guard, select, input, field, can, modal, toast} from '../core.mjs';

export async function render(main, rest, state) {
  const [stores, defaults, jobs] = await Promise.all([get('/api/stores'), get('/api/stores/defaults'), get('/api/jobs?status=dead')]);
  const syncJobs = jobs.filter((j) => j.type === 'store_sync' || j.type === 'webhook_event');
  clear(main, pageHeader('Integracijos', can(state.user, 'settings') ? h('button', {class: 'btn btn-primary', onclick: () => storeForm(null, defaults, () => render(main, rest, state))}, '+ Prijungti parduotuvę') : null),
    h('p', {class: 'hint'}, 'Duomenys sinchronizuojami iš parduotuvės į apskaitą. Užsakymai tampa sąskaitų pasiūlymais tik pagal būsenų susiejimą ir registruojami tik patvirtinus. Užregistruotos sąskaitos po užsakymo pakeitimų niekada nekeičiamos automatiškai.'),
    stores.length ? stores.map((s) => storeCard(s, defaults, state, () => render(main, rest, state))) : section(null, h('p', null, 'Parduotuvių dar nėra.')),
    syncJobs.length ? section('Nepavykusios sinchronizavimo užduotys', table([{label: 'Užduotis', key: 'id'}, {label: 'Tipas', key: 'type'}, {label: 'Bandymų', key: 'attempts'}, {label: 'Klaida', key: 'last_error'},
      {label: '', render: (j) => (can(state.user, 'write') ? h('button', {class: 'btn btn-small', onclick: () => guard(() => post(`/api/jobs/${j.id}/retry`), 'Užduotis grąžinta į eilę.').then(() => render(main, rest, state))}, 'Kartoti') : '')}], syncJobs)) : null,
    section('Diegimo instrukcijos',
      h('h3', null, 'Saleor (3.22+)'), h('ol', null,
        h('li', null, 'Saleor valdymo skydelyje sukurkite vietinę programėlę (Apps → Local app) su teise MANAGE_ORDERS ir nukopijuokite raktą (app token).'),
        h('li', null, 'Čia prijunkite parduotuvę: API adresas https://jusu-saleor/graphql/ ir raktas.'),
        h('li', null, 'Programėlėje sukurkite asinchroninius webhookus (ORDER_CREATED, ORDER_UPDATED, ORDER_FULLY_PAID, ORDER_FULFILLED, ORDER_REFUNDED, ORDER_FULLY_REFUNDED, ORDER_CANCELLED) į adresą, rodomą parduotuvės kortelėje. Parašai tikrinami JWS (RS256) pagal Saleor /.well-known/jwks.json.'),
        h('li', null, 'Pirmą kartą paleiskite „Pilnas importas“. Vėliau veiks webhookai ir periodinis suderinimas kas 15 min. bei kasdien.')),
      h('h3', null, 'OpenCart (4.1)'), h('ol', null,
        h('li', null, 'Įdiekite plėtinį apskaita_export.ocmod.zip (integrations/opencart/ kataloge): Extensions → Installer → Upload, tada Extensions → Extensions → Other → Apskaita order export → Install ir Edit.'),
        h('li', null, 'Plėtinio nustatymuose įjunkite, nukopijuokite raktą, pasirinktinai nurodykite leidžiamus IP ir užbaigtų grąžinimų būsenų ID.'),
        h('li', null, 'Čia prijunkite parduotuvę: parduotuvės adresas (be index.php) ir raktas. OpenCart webhookų neturi – naudojamas periodinis sinchronizavimas.'),
        h('li', null, 'Plėtinys tik skaito užsakymus (SELECT), nekeičia OpenCart branduolio failų ir duomenų.')),
      h('p', {class: 'hint'}, 'Automatiniai testai naudoja vietinius imitacinius serverius ir testinius duomenis; tikros parduotuvės prijungimas turi būti patikrintas atskirai.')));
}

function storeCard(s, defaults, state, reload) {
  const run = s.last_run;
  const hookUrl = `${location.origin}/api/webhooks/${s.platform}/${s.id}`;
  return section(`${s.name} (${s.platform === 'saleor' ? 'Saleor' : 'OpenCart'})${s.is_demo ? ' — DEMO' : ''}`,
    s.is_demo ? h('div', {class: 'banner'}, 'DEMONSTRACINĖ jungtis: naudojami testiniai duomenys iš fixtures/stores, ne tikra parduotuvė.') : null,
    h('dl', {class: 'dl'}, h('dt', null, 'Adresas'), h('dd', null, s.base_url), h('dt', null, 'Sąskaitos'), h('dd', null, s.invoice_mode === 'issue_here' ? 'Išrašo ši programa (parduotuvė sąskaitų neišrašo)' : 'Importuojamos parduotuvės sąskaitos (ši programa numerių nesuteikia)'),
      h('dt', null, 'Užsakymų'), h('dd', null, `${s.orders} (užregistruota ${s.posted}, reikia peržiūros ${s.needs_review})`),
      h('dt', null, 'Paskutinis sinchronizavimas'), h('dd', null, run ? `${dateTime(run.started_at)} – ${run.status === 'done' ? 'baigta' : run.status === 'running' ? 'vyksta' : 'nepavyko'}: gauta ${run.fetched}, nauji ${run.created}, atnaujinti ${run.updated}, be pakeitimų ${run.unchanged}, klaidų ${run.errors}` : 'dar nebuvo'),
      s.last_error ? [h('dt', null, 'Klaida'), h('dd', {class: 'error-text'}, s.last_error)] : null,
      s.platform === 'saleor' && !s.is_demo ? [h('dt', null, 'Webhook adresas'), h('dd', null, h('code', null, hookUrl))] : null),
    h('div', {class: 'actions'},
      can(state.user, 'write') ? h('button', {class: 'btn', onclick: () => guard(() => post(`/api/stores/${s.id}/sync`, {kind: 'incremental'}), 'Sinchronizavimas pradėtas.').then(reload)}, 'Sinchronizuoti dabar') : null,
      can(state.user, 'write') ? h('button', {class: 'btn', onclick: () => guard(() => post(`/api/stores/${s.id}/sync`, {kind: 'initial'}), 'Pilnas importas pradėtas.').then(reload)}, 'Pilnas importas') : null,
      can(state.user, 'settings') ? h('button', {class: 'btn', onclick: () => guard(async () => { const r = await post(`/api/stores/${s.id}/test`); toast(r.ok ? `Ryšys veikia${r.demo ? ' (demo)' : ''}.` : `Ryšys neveikia: ${r.error}`, r.ok ? 'ok' : 'error'); })}, 'Tikrinti ryšį') : null,
      can(state.user, 'settings') ? h('button', {class: 'btn', onclick: () => storeForm(s, defaults, reload)}, 'Nustatymai') : null,
      h('a', {class: 'btn', href: `#/pardavimai/uzsakymai?store=${s.id}`}, 'Užsakymai')));
}

function storeForm(s, defaults, reload) {
  const isNew = !s;
  const f = {platform: select([['saleor', 'Saleor'], ['opencart', 'OpenCart']], s?.platform || 'saleor', {disabled: !isNew}), name: input({value: s?.name || ''}), base_url: input({value: s?.base_url || '', disabled: !isNew, placeholder: 'https://…'}),
    secret: input({type: 'password', placeholder: s?.has_secret ? '•••• (palikite tuščią, jei nekeičiate)' : '', autocomplete: 'off'}), webhookSecret: input({type: 'password', autocomplete: 'off', placeholder: 'tik senesniems HMAC webhookams'}),
    invoice_mode: select([['issue_here', 'Sąskaitas išrašo ši programa'], ['import_external', 'Importuoti parduotuvės išrašytas sąskaitas']], s?.invoice_mode || 'issue_here'),
    seriesCode: input({value: s?.config?.seriesCode || 'PP'}), is_demo: h('input', {type: 'checkbox', checked: s?.is_demo, disabled: !isNew})};
  const mappingBox = h('div', {class: 'form-grid'});
  const mapping = {...(defaults.statusMapping[s?.platform || 'saleor']), ...(s?.status_mapping || {})};
  const drawMap = () => clear(mappingBox, Object.keys({...defaults.statusMapping[f.platform.value], ...(s?.status_mapping || {})}).map((k) => field(k, select([['invoice', 'Išrašyti / importuoti sąskaitą'], ['wait', 'Laukti'], ['ignore', 'Ignoruoti']], mapping[k] || 'wait', {onchange: (e) => { mapping[k] = e.target.value; }}))));
  f.platform.onchange = () => { Object.assign(mapping, defaults.statusMapping[f.platform.value]); drawMap(); };
  drawMap();
  const m = modal(isNew ? 'Prijungti parduotuvę' : `Nustatymai: ${s.name}`, h('form', {onsubmit: async (e) => {
    e.preventDefault();
    const secretKey = f.platform.value === 'saleor' ? 'apiToken' : 'apiKey';
    const body = {platform: f.platform.value, name: f.name.value, base_url: f.base_url.value, invoice_mode: f.invoice_mode.value, status_mapping: mapping, config: {...(s?.config || {}), seriesCode: f.seriesCode.value}, is_demo: f.is_demo.checked,
      ...(f.secret.value && {[secretKey]: f.secret.value}), ...(f.webhookSecret.value && {webhookSecret: f.webhookSecret.value})};
    let r = await guard(() => (isNew ? post('/api/stores', body) : put(`/api/stores/${s.id}`, body)));
    if (r === undefined && !isNew && s.invoice_mode !== body.invoice_mode && confirm('Ši parduotuvė jau turi užregistruotų sąskaitų. Ar tikrai keisti sąskaitų išrašymo būdą? Tai gali sukelti dvigubą išrašymą.')) r = await guard(() => put(`/api/stores/${s.id}`, {...body, confirmModeChange: true}));
    if (r) { m.close(); toast('Išsaugota. Raktai saugomi šifruoti serveryje.', 'ok'); reload(); }
  }}, h('div', {class: 'form-grid'}, field('Platforma', f.platform), field('Pavadinimas', f.name), field('Adresas', f.base_url, 'Saleor: GraphQL API adresas; OpenCart: parduotuvės adresas'),
    field('Raktas (Saleor app token / OpenCart plėtinio raktas)', f.secret), field('Webhook HMAC raktas (nebūtina)', f.webhookSecret), field('Sąskaitų išrašymas', f.invoice_mode, 'Neleidžia išrašyti sąskaitos dukart: arba čia, arba parduotuvėje.'),
    field('Pardavimo serija', f.seriesCode), h('label', {class: 'check'}, f.is_demo, ' Demonstracinė jungtis (testiniai duomenys)')),
  h('h3', null, 'Užsakymų būsenų susiejimas'), mappingBox, h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))), {wide: true});
}
