// App shell: login, navigation, hash router, onboarding wizard.
import {h, clear, get, post, put, setCsrf, toast, showError, guard, field, input, select, pageHeader, section, can} from './core.mjs';

export const state = {user: null, company: null};
const NAV = [
  ['apzvalga', 'Apžvalga', () => import('./pages/dashboard.mjs')],
  ['deze', 'Dokumentų dėžutė', () => import('./pages/inbox.mjs')],
  ['pardavimai', 'Pardavimai', () => import('./pages/sales.mjs')],
  ['pirkimai', 'Pirkimai', () => import('./pages/purchases.mjs')],
  ['bankas', 'Bankas ir mokėjimai', () => import('./pages/bank.mjs')],
  ['dokumentai', 'Dokumentai', () => import('./pages/vault.mjs')],
  ['kontaktai', 'Kontaktai ir prekės', () => import('./pages/contacts.mjs')],
  ['ataskaitos', 'Ataskaitos', () => import('./pages/reports.mjs')],
  ['integracijos', 'Integracijos', () => import('./pages/integrations.mjs')],
  ['nustatymai', 'Nustatymai', () => import('./pages/settings.mjs')],
];

const root = document.getElementById('app');
let main;

function shell() {
  const navList = h('ul', {class: 'nav-list'}, NAV.map(([key, label]) => h('li', null, h('a', {href: `#/${key}`, 'data-key': key}, label))));
  const toggle = h('button', {class: 'nav-toggle', 'aria-expanded': 'false', 'aria-controls': 'nav', onclick: () => { const open = document.body.classList.toggle('nav-open'); toggle.setAttribute('aria-expanded', String(open)); }}, '☰ Meniu');
  main = h('main', {id: 'main', tabindex: '-1'});
  clear(root,
    h('a', {class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); }}, 'Pereiti prie turinio'),
    h('header', {class: 'topbar'}, toggle, h('div', {class: 'brand'}, 'Apskaita', state.company?.name ? h('span', {class: 'brand-company'}, state.company.name) : null),
      h('div', {class: 'userbox'}, h('span', null, `${state.user.name || state.user.email} · ${{admin: 'Administratorius', accountant: 'Buhalteris', readonly: 'Tik skaitymas'}[state.user.role]}`),
        h('button', {class: 'btn btn-small', onclick: logout}, 'Atsijungti'))),
    h('nav', {id: 'nav', 'aria-label': 'Pagrindinis meniu'}, navList),
    main);
}

async function logout() { await post('/api/logout').catch(() => {}); location.hash = ''; location.reload(); }

function loginView(message) {
  const email = input({type: 'email', autocomplete: 'username', required: true});
  const pass = input({type: 'password', autocomplete: 'current-password', required: true});
  const err = h('p', {class: 'form-error', role: 'alert'}, message || '');
  clear(root, h('main', {class: 'login'}, h('form', {class: 'card login-card', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await post('/api/login', {email: email.value, password: pass.value});
      setCsrf(r.csrf);
      await boot();
    } catch (x) { err.textContent = x.message; }
  }}, h('h1', null, 'Apskaita'), h('p', {class: 'muted'}, 'Prisijunkite prie apskaitos sistemos.'), field('El. paštas', email), field('Slaptažodis', pass), err, h('button', {class: 'btn btn-primary btn-block'}, 'Prisijungti'))));
  email.focus();
}

export function navigate(path) { location.hash = `#/${path}`; }

async function route() {
  if (!state.user) return;
  const [key, ...rest] = (location.hash.replace(/^#\/?/, '').split('?')[0] || 'apzvalga').split('/');
  if (!state.company?.onboarding_done && can(state.user, 'settings') && key !== 'pradzia') { location.hash = '#/pradzia'; return; }
  document.querySelectorAll('.nav-list a').forEach((a) => a.setAttribute('aria-current', a.dataset.key === key ? 'page' : 'false'));
  document.body.classList.remove('nav-open');
  clear(main, h('div', {class: 'loading'}, 'Kraunama…'));
  try {
    if (key === 'pradzia') return onboarding();
    const entry = NAV.find(([k]) => k === key);
    if (!entry) { clear(main, pageHeader('Puslapis nerastas')); return; }
    const mod = await entry[2]();
    await mod.render(main, rest, state);
    document.title = `${entry[1]} – Apskaita`;
  } catch (e) {
    if (e.status === 401) return;
    showError(e);
    clear(main, pageHeader('Klaida'), h('p', null, e.message));
  }
}

// ---------------------------------------------------------------- onboarding
async function onboarding() {
  const company = await get('/api/settings/company');
  const series = await get('/api/series');
  const accounts = await get('/api/bank/accounts');
  let step = 0;
  const f = {
    name: input({value: company.name, required: true}), legal_form: input({value: company.legal_form, placeholder: 'UAB, MB, IĮ…'}), company_code: input({value: company.company_code, inputmode: 'numeric'}),
    address: input({value: company.address}), email: input({value: company.email, type: 'email'}), phone: input({value: company.phone}),
    vat_registered: h('input', {type: 'checkbox', checked: company.vat_registered}), vat_code: input({value: company.vat_code, placeholder: 'LT…'}), vat_registered_from: input({type: 'date', value: company.vat_registered_from || ''}),
    asset_threshold: input({value: company.asset_threshold, inputmode: 'decimal'}),
  };
  const seriesInputs = series.map((s) => ({code: s.code, doc_type: s.doc_type, padding: s.padding, description: s.description, next: input({value: s.next_number, inputmode: 'numeric', 'aria-label': `${s.code} kitas numeris`})}));
  const iban = input({placeholder: 'LT…'}), bankName = input({placeholder: 'Banko pavadinimas'});
  const steps = [
    ['Įmonė', () => h('div', {class: 'form-grid'}, field('Pavadinimas', f.name), field('Teisinė forma', f.legal_form), field('Įmonės kodas', f.company_code, '7–9 skaitmenys'), field('Adresas', f.address), field('El. paštas', f.email), field('Telefonas', f.phone))],
    ['PVM', () => h('div', {class: 'form-grid'}, h('label', {class: 'check'}, f.vat_registered, ' Įmonė yra PVM mokėtoja'), field('PVM mokėtojo kodas', f.vat_code), field('PVM mokėtoja nuo', f.vat_registered_from),
      h('p', {class: 'hint'}, 'PVM tarifai ir kodai pagal VMI PVM klasifikatorių (galioja nuo 2026-01-01). Taikymą turi patikrinti buhalteris – žr. Nustatymai → PVM kodai.'))],
    ['Sąskaitos', () => h('div', null, h('p', null, 'Įdiegtas pradinis supaprastintas sąskaitų planas ir kontavimo susiejimai (pirkėjų/tiekėjų skolos, PVM, bankas, avansai, mokesčiai). Juos galite keisti Nustatymuose.'),
      field('Ilgalaikio turto vertės riba (EUR be PVM)', f.asset_threshold, 'Pagal įmonės apskaitos politiką. Brangesnė įranga siūloma kaip ilgalaikis turtas.'))],
    ['Numeracija', () => h('div', null, h('p', null, 'Pardavimo sąskaitų serijos. Numeris suteikiamas tik patvirtinant sąskaitą ir yra unikalus.'),
      ...seriesInputs.map((s) => field(`${s.code} – ${s.description} (kitas numeris)`, s.next)))],
    ['Bankas', () => h('div', null, accounts.length ? h('p', null, `Banko sąskaitos: ${accounts.map((a) => a.iban).join(', ')}`) : h('p', null, 'Pridėkite pagrindinę banko sąskaitą (galima ir vėliau).'), h('div', {class: 'form-grid'}, field('IBAN', iban), field('Bankas', bankName)))],
    ['Parduotuvės', () => h('div', null, h('p', null, 'Saleor ir OpenCart parduotuves prijungsite skiltyje „Integracijos“. Ten nurodysite, ar sąskaitas išrašo ši programa, ar jos importuojamos iš parduotuvės (kad nebūtų dvigubo išrašymo).'))],
  ];
  const body = h('div');
  const nav = h('div', {class: 'actions'});
  const save = async () => {
    await put('/api/settings/company', {name: f.name.value, legal_form: f.legal_form.value, company_code: f.company_code.value, address: f.address.value, email: f.email.value, phone: f.phone.value,
      vat_registered: f.vat_registered.checked, vat_code: f.vat_code.value, vat_registered_from: f.vat_registered_from.value || null, asset_threshold: f.asset_threshold.value});
  };
  const draw = () => {
    clear(body, h('ol', {class: 'steps'}, steps.map(([t], i) => h('li', {class: i === step ? 'current' : i < step ? 'done' : '', 'aria-current': i === step ? 'step' : null}, t))), section(steps[step][0], steps[step][1]()));
    clear(nav,
      step > 0 ? h('button', {class: 'btn', onclick: () => { step--; draw(); }}, '‹ Atgal') : null,
      step < steps.length - 1 ? h('button', {class: 'btn btn-primary', onclick: () => guard(async () => { if (step <= 2) await save(); if (step === 3) for (const s of seriesInputs) await post('/api/series', {code: s.code, doc_type: s.doc_type, padding: s.padding, description: s.description, next_number: s.next.value}); if (step === 4 && iban.value) await post('/api/bank/accounts', {iban: iban.value, name: 'Pagrindinė', bank_name: bankName.value}); step++; draw(); })}, 'Toliau ›')
        : h('button', {class: 'btn btn-primary', onclick: () => guard(async () => { await save(); await put('/api/settings/company', {...(await get('/api/settings/company')), onboarding_done: true}); state.company = (await get('/api/me')).company; toast('Nustatymai išsaugoti.', 'ok'); location.hash = '#/apzvalga'; })}, 'Baigti'));
  };
  clear(main, pageHeader('Pradiniai nustatymai'), body, nav);
  draw();
}

async function boot() {
  try {
    const me = await get('/api/me');
    state.user = me.user; state.company = me.company; setCsrf(me.csrf);
    shell();
    window.onhashchange = route;
    await route();
  } catch (e) {
    if (e.status === 401) loginView(); else loginView(e.message);
  }
}
window.addEventListener('unauthenticated', () => { state.user = null; loginView('Sesija baigėsi – prisijunkite iš naujo.'); });
boot();
