// App shell: login, navigation, hash router, onboarding wizard.
import {h, clear, get, post, put, setCsrf, toast, showError, guard, field, input, select, pageHeader, section, can} from './core.mjs';
import {rekvizitaiButton} from './lib/company-fill.mjs';

export const state = {user: null, company: null};
// Page modules by first hash segment.
const PAGES = {
  apzvalga: ['Apžvalga', () => import('./pages/dashboard.mjs')],
  deze: ['Dokumentų dėžutė', () => import('./pages/inbox.mjs')],
  pardavimai: ['Pardavimai', () => import('./pages/sales.mjs')],
  pirkimai: ['Pirkimai', () => import('./pages/purchases.mjs')],
  bankas: ['Bankas ir mokėjimai', () => import('./pages/bank.mjs')],
  dokumentai: ['Dokumentai', () => import('./pages/vault.mjs')],
  kontaktai: ['Kontrahentai', () => import('./pages/contacts.mjs')],
  prekes: ['Prekės ir paslaugos', () => import('./pages/products.mjs')],
  saskaitos: ['Sąskaitų planas', () => import('./pages/chart.mjs')],
  rekvizitai: ['Įmonė iš rekvizitai.lt', () => import('./pages/rekvizitai.mjs')],
  atlyginimai: ['Atlyginimai', () => import('./pages/payroll.mjs')],
  ataskaitos: ['Ataskaitos', () => import('./pages/reports.mjs')],
  integracijos: ['Integracijos', () => import('./pages/integrations.mjs')],
  nustatymai: ['Nustatymai', () => import('./pages/settings.mjs')],
};

// Top menu bar with drop-down menus. Items: [label, hash path, capability?] or '-' (separator).
export const MENU = [
  ['Žinynai', [['Sąskaitų planas', 'saskaitos'], ['Kontrahentai', 'kontaktai'], ['Įmonė iš rekvizitai.lt', 'rekvizitai'], ['Prekės ir paslaugos', 'prekes'], ['Darbuotojai', 'atlyginimai/darbuotojai'], '-',
    ['PVM kodai', 'nustatymai/pvm'], ['Dokumentų serijos', 'nustatymai/serijos'], ['Klasifikavimo taisyklės', 'nustatymai/taisykles']]],
  ['Dokumentai', [['Dokumentų dėžutė (įkėlimas)', 'deze'], ['Dokumentų archyvas', 'dokumentai'], ['Įkelti sutartį ar kitą dokumentą', 'dokumentai/naujas', 'write']]],
  ['Prekyba', [['Pardavimo sąskaitos', 'pardavimai'], ['Nauja pardavimo sąskaita', 'pardavimai/nauja', 'write'], ['Parduotuvių užsakymai', 'pardavimai/uzsakymai'], '-',
    ['Pirkimo sąskaitos', 'pirkimai'], ['Nauja pirkimo sąskaita', 'pirkimai/nauja', 'write']]],
  ['Likučiai', [['Prekių likučiai', 'prekes/likuciai'], ['Prekių judėjimas', 'prekes/judejimas'], ['Savikaina (COGS)', 'ataskaitos/savikaina']]],
  ['Finansai', [['Banko operacijos', 'bankas'], ['Banko išrašai', 'bankas/israsai'], ['Importuoti išrašą', 'bankas/importas', 'write'], ['Avansai', 'bankas/avansai'], ['Banko sąskaitos', 'bankas/saskaitos'], '-',
    ['Žurnalas ir rankiniai įrašai', 'ataskaitos/zurnalas'], ['Didžioji knyga', 'ataskaitos/knyga']]],
  ['Atlyginimai', [['Darbo užmokesčio žiniaraščiai', 'atlyginimai'], ['Naujas žiniaraštis', 'atlyginimai/naujas', 'write'], ['Darbuotojai', 'atlyginimai/darbuotojai'], ['Tarifai ir parametrai', 'atlyginimai/parametrai']]],
  ['Ataskaitos', [['Pelno (nuostolių) ataskaita', 'ataskaitos/pelnas'], ['Balansas', 'ataskaitos/balansas'], ['Bandomasis balansas', 'ataskaitos/bandomasis'], '-',
    ['Pardavimų PVM registras', 'ataskaitos/pvm-pardavimai'], ['Pirkimų PVM registras', 'ataskaitos/pvm-pirkimai'], ['i.SAF eksportas', 'ataskaitos/isaf'], '-',
    ['Pirkėjų skolos', 'ataskaitos/gautinos'], ['Skolos tiekėjams', 'ataskaitos/moketinos'], ['Pardavimai', 'ataskaitos/pardavimai'], ['Užsakymų rodikliai', 'ataskaitos/operaciniai'],
    ['Pirkimai ir sąnaudos', 'ataskaitos/pirkimai'], ['Mokėjimų suvestinė', 'ataskaitos/mokejimai']]],
  ['Servisas', [['Įmonės duomenys', 'nustatymai/imone'], ['Kontavimo susiejimai', 'nustatymai/kontavimas'], ['Laikotarpių užrakinimas', 'nustatymai/laikotarpiai'], ['Integracijos (e. parduotuvės)', 'integracijos'], '-',
    ['Naudotojai', 'nustatymai/naudotojai'], ['Audito žurnalas', 'nustatymai/auditas'], ['Foninės užduotys', 'nustatymai/uzduotys']]],
];
// Quick actions under the menu bar (like a desktop toolbar).
const TOOLBAR = [['Apžvalga', 'apzvalga'], ['+ Pardavimas', 'pardavimai/nauja', 'write'], ['+ Pirkimas', 'pirkimai/nauja', 'write'], ['Įkelti dokumentus', 'deze', 'write'], ['Banko išrašas', 'bankas/importas', 'write'], ['+ Prekė', 'prekes/nauja', 'write']];

const root = document.getElementById('app');
let main, menubar;

function closeMenus(except) {
  menubar?.querySelectorAll('.menu-top[aria-expanded="true"]').forEach((b) => { if (b !== except) b.setAttribute('aria-expanded', 'false'); });
}

function menuBar() {
  const allowed = (it) => it === '-' || !it[2] || can(state.user, it[2]);
  const tops = [];
  const bar = h('ul', {class: 'menubar', role: 'menubar', 'aria-label': 'Pagrindinis meniu'}, MENU.map(([label, items], i) => {
    const list = h('ul', {class: 'menu-list', role: 'menu', 'aria-label': label}, items.filter(allowed).map((it) => (it === '-'
      ? h('li', {class: 'menu-sep', role: 'separator'})
      : h('li', {role: 'none'}, h('a', {role: 'menuitem', href: `#/${it[1]}`, 'data-path': it[1], tabindex: '-1', onclick: () => closeMenus()}, it[0])))));
    const items$ = () => [...list.querySelectorAll('a')];
    const btn = h('button', {class: 'menu-top', type: 'button', role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false', tabindex: i ? '-1' : '0',
      onclick: () => { const open = btn.getAttribute('aria-expanded') !== 'true'; closeMenus(btn); btn.setAttribute('aria-expanded', String(open)); },
      onmouseenter: () => { if (window.matchMedia('(hover: hover) and (min-width: 821px)').matches && menubar.querySelector('.menu-top[aria-expanded="true"]')) { closeMenus(btn); btn.setAttribute('aria-expanded', 'true'); } },
      onkeydown: (e) => {
        const k = e.key;
        if (k === 'ArrowDown' || k === 'Enter' || k === ' ') { e.preventDefault(); closeMenus(btn); btn.setAttribute('aria-expanded', 'true'); items$()[0]?.focus(); }
        else if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); const j = (i + (k === 'ArrowRight' ? 1 : tops.length - 1)) % tops.length; const wasOpen = btn.getAttribute('aria-expanded') === 'true'; closeMenus(); tops[j].focus(); if (wasOpen) tops[j].setAttribute('aria-expanded', 'true'); }
        else if (k === 'Escape') closeMenus();
      }}, label);
    list.addEventListener('keydown', (e) => {
      const its = items$(); const at = its.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); its[(at + 1) % its.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); its[(at - 1 + its.length) % its.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeMenus(); btn.focus(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); btn.dispatchEvent(new KeyboardEvent('keydown', {key: e.key})); }
      else if (e.key === 'Tab') closeMenus();
    });
    tops.push(btn);
    return h('li', {class: 'menu', role: 'none'}, btn, list);
  }));
  return bar;
}

function shell() {
  const toggle = h('button', {class: 'nav-toggle', 'aria-expanded': 'false', 'aria-controls': 'menubar', onclick: () => { const open = document.body.classList.toggle('nav-open'); toggle.setAttribute('aria-expanded', String(open)); }}, '☰ Meniu');
  main = h('main', {id: 'main', tabindex: '-1'});
  menubar = h('nav', {id: 'menubar', class: 'menubar-wrap'}, menuBar());
  const toolbar = h('div', {class: 'toolbar', role: 'toolbar', 'aria-label': 'Greiti veiksmai'},
    TOOLBAR.filter((t) => !t[2] || can(state.user, t[2])).map(([label, path]) => h('a', {class: 'tool', href: `#/${path}`}, label)));
  clear(root,
    h('a', {class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); }}, 'Pereiti prie turinio'),
    h('header', {class: 'topbar'}, toggle, h('a', {class: 'brand', href: '#/apzvalga'}, 'Apskaita', state.company?.name ? h('span', {class: 'brand-company'}, state.company.name) : null),
      h('div', {class: 'userbox'}, h('span', null, `${state.user.name || state.user.email} · ${{admin: 'Administratorius', accountant: 'Buhalteris', readonly: 'Tik skaitymas'}[state.user.role]}`),
        h('button', {class: 'btn btn-small', onclick: logout}, 'Atsijungti'))),
    menubar, toolbar, main);
}
document.addEventListener('click', (e) => { if (menubar && !menubar.contains(e.target)) closeMenus(); });

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
  const here = [key, ...rest].join('/');
  menubar?.querySelectorAll('.menu').forEach((m) => {
    let best = '';
    m.querySelectorAll('a[data-path]').forEach((a) => { const p = a.dataset.path; if ((here === p || here.startsWith(p + '/')) && p.length > best.length) best = p; });
    m.classList.toggle('current', !!best);
    m.querySelectorAll('a[data-path]').forEach((a) => a.setAttribute('aria-current', a.dataset.path === best ? 'page' : 'false'));
  });
  closeMenus();
  document.body.classList.remove('nav-open');
  clear(main, h('div', {class: 'loading'}, 'Kraunama…'));
  try {
    if (key === 'pradzia') return onboarding();
    const entry = PAGES[key];
    if (!entry) { clear(main, pageHeader('Puslapis nerastas')); return; }
    const mod = await entry[1]();
    await mod.render(main, rest, state);
    document.title = `${entry[0]} – Apskaita`;
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
    ['Įmonė', () => h('div', null, h('div', {class: 'actions-left'}, rekvizitaiButton(f), h('span', {class: 'hint'}, ' – nukopijuokite savo įmonės puslapį iš rekvizitai.lt, ir laukai užsipildys')), h('div', {class: 'form-grid'}, field('Pavadinimas', f.name), field('Teisinė forma', f.legal_form), field('Įmonės kodas', f.company_code, '7–9 skaitmenys'), field('Adresas', f.address), field('El. paštas', f.email), field('Telefonas', f.phone)))],
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
    if (e.status !== 401) return loginView(e.message);
    if (await openLogin()) return boot();
    loginView();
  }
}

// Test deployments with OPEN_ACCESS=true: sign in automatically, no password.
let openLogins = 0;
async function openLogin() {
  if (++openLogins > 3) return false; // cookie not kept by the browser: fall back to the login form
  try {
    if (!(await get('/api/bootstrap-status')).openAccess) return false;
    setCsrf((await post('/api/open-login')).csrf);
    return true;
  } catch { return false; }
}
window.addEventListener('unauthenticated', async () => {
  state.user = null;
  if (await openLogin()) return boot();
  loginView('Sesija baigėsi – prisijunkite iš naujo.');
});
boot();
