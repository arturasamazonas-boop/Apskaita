// Įmonė iš rekvizitai.lt: landing page of the "→ Apskaita" bookmarklet and the paste flow.
// The page text travels only inside this browser (URL fragment, never sent to the server); it is parsed here.
import {h, clear, get, post, put, pageHeader, section, guard, input, field, can, toast} from '../core.mjs';
import {parseCompanyText, bookmarklet} from '../lib/company-parse.mjs';
import {pasteDialog, vatCheckButton, REKVIZITAI_URL} from '../lib/company-fill.mjs';

const LABELS = {name: 'Pavadinimas', legal_form: 'Teisinė forma', company_code: 'Įmonės kodas', vat_code: 'PVM mokėtojo kodas', address: 'Adresas', phone: 'Telefonas', email: 'El. paštas',
  website: 'Tinklalapis', manager: 'Vadovas', iban: 'Banko sąskaita (IBAN)', bank_name: 'Bankas'};

export async function render(main, rest, state) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  let data = null;
  if (params.get('d')) {
    try { const d = JSON.parse(params.get('d')); data = parseCompanyText(d.x, {title: d.t, url: d.u}); } catch { toast('Nepavyko perskaityti puslapio duomenų.', 'error'); }
    history.replaceState(null, '', '#/rekvizitai'); // keep the page text out of history and bookmarks
  }
  if (data) return review(main, data, state);
  const bm = h('a', {class: 'btn btn-primary bookmarklet', href: bookmarklet(location.origin), onclick: (e) => { e.preventDefault(); toast('Nutempkite šį mygtuką į naršyklės žymių juostą.', 'info'); }}, '→ Apskaita');
  clear(main, pageHeader('Įmonė iš rekvizitai.lt'),
    section('Vienu paspaudimu (rekomenduojama kompiuteryje)', h('ol', {class: 'howto'},
      h('li', null, 'Įjunkite žymių juostą (Ctrl+Shift+B).'),
      h('li', null, 'Nutempkite šį mygtuką į žymių juostą: ', bm),
      h('li', null, 'Atsidarykite įmonę ', h('a', {href: REKVIZITAI_URL, target: '_blank', rel: 'noopener noreferrer'}, 'rekvizitai.lt'), ' ir paspauskite žymę „→ Apskaita“.'),
      h('li', null, 'Atsidarys ši programa su užpildytais duomenimis – liks patikrinti ir paspausti „Sukurti kontrahentą“ arba „Naudoti kaip mano įmonės duomenis“.')),
    h('p', {class: 'hint'}, 'Žymė perskaito tik jūsų atidaryto puslapio tekstą jūsų naršyklėje ir perduoda jį šiai programai. Rekvizitai.lt automatinių užklausų iš serverių neleidžia, todėl duomenys imami per jūsų naršyklę.')),
    section('Be žymės', h('p', null, 'Nukopijuokite visą įmonės puslapio tekstą ir įklijuokite.'),
      h('button', {class: 'btn', onclick: () => pasteDialog((d) => review(main, d, state))}, 'Įklijuoti įmonės puslapio tekstą')));
}

async function review(main, data, state) {
  const f = Object.fromEntries(Object.keys(LABELS).map((k) => [k, input({value: data[k] || ''})]));
  const supplier = h('input', {type: 'checkbox', checked: true}), customer = h('input', {type: 'checkbox'});
  const matchBox = h('div');
  const body = () => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value.trim()]));
  const findExisting = async () => {
    const code = f.company_code.value.trim(), vat = f.vat_code.value.trim();
    if (!code && !vat) return null;
    const d = await get(`/api/counterparties?q=${encodeURIComponent(code || vat)}&limit=5`);
    return d.items.find((c) => (code && c.company_code === code) || (vat && c.vat_code === vat.toUpperCase())) || null;
  };
  const existing = await findExisting();
  const merge = (c) => { const b = body(); return {...c, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v))}; };
  clear(matchBox, existing ? h('p', {class: 'hint'}, `Toks kontrahentas jau yra: ${existing.name} (#${existing.id}).`) : null);
  const actions = [];
  if (can(state.user, 'write')) {
    if (existing) actions.push(h('button', {class: 'btn btn-primary', onclick: () => guard(async () => { await put(`/api/counterparties/${existing.id}`, merge(existing)); location.hash = '#/kontaktai'; }, 'Kontrahentas atnaujintas.')}, `Atnaujinti kontrahentą`));
    else actions.push(h('button', {class: 'btn btn-primary', onclick: () => guard(async () => { await post('/api/counterparties', {...body(), country: 'LT', is_supplier: supplier.checked, is_customer: customer.checked}); location.hash = '#/kontaktai'; }, 'Kontrahentas sukurtas.')}, 'Sukurti kontrahentą'));
  }
  if (can(state.user, 'settings')) actions.push(h('button', {class: 'btn', onclick: () => guard(async () => {
    const c = await get('/api/settings/company');
    const b = body();
    await put('/api/settings/company', {...c, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v)), vat_registered: c.vat_registered || !!b.vat_code});
    state.company = (await get('/api/me')).company;
    location.hash = '#/nustatymai/imone';
  }, 'Įmonės duomenys atnaujinti.')}, 'Naudoti kaip mano įmonės duomenis'));
  clear(main, pageHeader('Įmonė iš rekvizitai.lt'),
    section('Patikrinkite duomenis', /^https?:\/\//.test(data.source || '') ? h('p', {class: 'hint'}, 'Šaltinis: ', h('a', {href: data.source, target: '_blank', rel: 'noopener noreferrer'}, data.source)) : null,
      h('div', {class: 'form-grid'}, Object.entries(LABELS).map(([k, label]) => field(label, f[k], k === 'vat_code' ? vatCheckButton(f.vat_code) : null))),
      existing ? null : h('div', {class: 'filters'}, h('label', {class: 'check'}, supplier, ' Tiekėjas'), h('label', {class: 'check'}, customer, ' Pirkėjas')),
      matchBox, h('div', {class: 'actions'}, actions)));
  if (data.vat_code) f.vat_code.parentElement.querySelector('.vat-check button')?.click();
}
