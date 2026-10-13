// FICTIONAL DEMO DATA for the /test environment: a furniture manufacturer ("UAB Ąžuolo dirbtuvės", invented name,
// codes and IBANs) with a year of activity up to `end`. Everything goes through the application's own HTTP API, as
// if typed in the browser, so the ledger, VAT, stock and payments follow the same rules as real work: suppliers and
// customers, raw materials and finished goods with attributes, ~190 purchase and sales invoices, monthly bank
// statements with payments matched to invoices, payroll, fixed assets with depreciation, a bank loan with interest
// accrual and production write-offs. Deterministic (fixed random seed).
import http from 'node:http';
import {ltVatCheckDigit} from '../extraction/ids.mjs';

/** A valid 12-digit LT VAT code: "LT" + 10 digits + "1" + check digit (fictional body). */
const vatLT = (body10) => { const b = `${body10}1`; return `LT${b}${ltVatCheckDigit(b)}`; };

/** A valid Lithuanian IBAN for a 16-digit fictional BBAN (ISO 13616 check digits). */
function ibanLT(bban) {
  const n = `${bban}212900`; // L=21, T=29, then "00"
  let r = 0; for (const ch of n) r = (r * 10 + Number(ch)) % 97;
  return `LT${String(98 - r).padStart(2, '0')}${bban}`;
}

const COMPANY = {name: 'UAB „Ąžuolo dirbtuvės“ (DEMO)', legal_form: 'UAB', company_code: '306999001', vat_code: vatLT('1000999001'), vat_registered: true, vat_registered_from: '2019-03-01',
  address: 'Pramonės g. 12, LT-51329 Kaunas', email: 'info@azuolo-dirbtuves.invalid', phone: '+370 600 00000', manager: 'Tomas Medinis', evrk_code: '310900', onboarding_done: true};
const BANK = {iban: ibanLT('7300010199990001'), name: 'Pagrindinė sąskaita (DEMO)', bank_name: 'Demo bankas', ledger_account: '2710'};

const SUPPLIERS = [
  {key: 'wood', name: 'UAB „Miško gėrybės“', company_code: '306999101', vat_code: vatLT('1000999101'), iban: ibanLT('7044060099990101'), series: 'MG'},
  {key: 'board', name: 'UAB „Plokštė LT“', company_code: '306999102', vat_code: vatLT('1000999102'), iban: ibanLT('7044060099990102'), series: 'PL'},
  {key: 'fittings', name: 'UAB „Furnitūros centras“', company_code: '306999103', vat_code: vatLT('1000999103'), iban: ibanLT('7044060099990103'), series: 'FC'},
  {key: 'finish', name: 'UAB „Dažų namai“', company_code: '306999104', vat_code: vatLT('1000999104'), iban: ibanLT('7044060099990104'), series: 'DN'},
  {key: 'power', name: 'AB „Energijos tiekimas“', company_code: '306999105', vat_code: vatLT('1000999105'), iban: ibanLT('7044060099990105'), series: 'ET'},
  {key: 'rent', name: 'UAB „Pramonės patalpos“', company_code: '306999106', vat_code: vatLT('1000999106'), iban: ibanLT('7044060099990106'), series: 'PR'},
  {key: 'transport', name: 'UAB „Greitas krovinys“', company_code: '306999107', vat_code: vatLT('1000999107'), iban: ibanLT('7044060099990107'), series: 'GK'},
  {key: 'it', name: 'UAB „Biuro sprendimai“', company_code: '306999108', vat_code: vatLT('1000999108'), iban: ibanLT('7044060099990108'), series: 'BS'},
  {key: 'telecom', name: 'UAB „Ryšio linija“', company_code: '306999109', vat_code: vatLT('1000999109'), iban: ibanLT('7044060099990109'), series: 'RL'},
];
const CUSTOMERS = ['UAB „Namų stilius“', 'UAB „Baldų rojus“', 'UAB „Interjero idėjos“', 'UAB „Jaukūs namai“', 'UAB „Biurų įranga“', 'UAB „Viešbučių tiekimas“',
  'MB „Medžio dirbtuvė“', 'UAB „Kavinių baldai“', 'VšĮ „Kultūros erdvė“', 'UAB „Sodybų projektai“', 'UAB „Mokyklų tiekimas“', 'UAB „Dizaino studija“']
  .map((name, i) => ({name, company_code: `3069992${String(i + 1).padStart(2, '0')}`, vat_code: vatLT(`10009992${String(i + 10).slice(-2)}`), iban: ibanLT(`70440600999902${String(i + 10).slice(-2)}`)}));

const MATERIALS = [
  ['ZAL-AZ30', 'Ąžuolo lenta 30 mm', 'm3', '1450', 'wood', {species: 'Ąžuolas', size: '30 mm'}],
  ['ZAL-BE25', 'Beržo lenta 25 mm', 'm3', '780', 'wood', {species: 'Beržas', size: '25 mm'}],
  ['ZAL-PU40', 'Pušies lenta 40 mm', 'm3', '420', 'wood', {species: 'Pušis', size: '40 mm'}],
  ['ZAL-UO30', 'Uosio lenta 30 mm', 'm3', '1200', 'wood', {species: 'Uosis', size: '30 mm'}],
  ['ZAL-FAN18', 'Beržo fanera 18 mm', 'lakšt.', '62', 'board', {species: 'Beržas', size: '2500×1250×18 mm'}],
  ['ZAL-MDF16', 'MDF plokštė 16 mm', 'lakšt.', '28', 'board', {size: '2800×2070×16 mm'}],
  ['ZAL-PVA', 'Medžio klijai PVA D3', 'kg', '4.20', 'finish', {}],
  ['ZAL-ALY', 'Aliejus-vaškas', 'l', '24', 'finish', {}],
  ['ZAL-VYR', 'Vyriai su prisitraukimu', 'vnt.', '2.80', 'fittings', {}],
  ['ZAL-RAN', 'Rankenėlė, juodas metalas', 'vnt.', '4.50', 'fittings', {}],
  ['ZAL-SRG', 'Medsraigčiai 4×40 (200 vnt.)', 'pak.', '6.90', 'fittings', {}],
  ['ZAL-BEG', 'Stalčių bėgeliai 450 mm', 'kompl.', '11', 'fittings', {}],
];
const GOODS = [
  ['GAM-ST180', 'Ąžuolinis valgomojo stalas 180×90', '890', {species: 'Ąžuolas', size: '180×90×76 cm', color: 'Natūrali'}],
  ['GAM-KED', 'Ąžuolinė kėdė „Klasika“', '145', {species: 'Ąžuolas', size: '45×52×88 cm', color: 'Natūrali'}],
  ['GAM-LEN', 'Beržinė knygų lentyna 80×200', '320', {species: 'Beržas', size: '80×35×200 cm', color: 'Balta'}],
  ['GAM-KOM', 'Ąžuolinė komoda, 4 stalčiai', '640', {species: 'Ąžuolas', size: '90×45×85 cm', color: 'Riešutinė'}],
  ['GAM-LOV', 'Uosinė lova 160×200', '980', {species: 'Uosis', size: '170×210×95 cm', color: 'Natūrali'}],
  ['GAM-DST', 'Pušinis darbo stalas 140×70', '410', {species: 'Pušis', size: '140×70×75 cm', color: 'Natūrali'}],
  ['GAM-BST', 'Biuro stalas su stalčiais', '520', {species: 'Beržas', size: '160×80×75 cm', color: 'Balta'}],
  ['GAM-KAV', 'Kavos staliukas', '260', {species: 'Ąžuolas', size: '100×60×45 cm', color: 'Juoda'}],
];
const EMPLOYEES = [
  ['Tomas', 'Medinis', 'Direktorius', '3600', '6304', '2019-03-01'], ['Rasa', 'Skaičiuotė', 'Vyr. buhalterė', '2400', '6304', '2020-02-01'],
  ['Mantas', 'Obliuotojas', 'Stalius', '1900', '6003', '2021-04-12'], ['Darius', 'Pjovėjas', 'CNC operatorius', '2100', '6003', '2022-01-10'],
  ['Laura', 'Šlifuotoja', 'Apdailininkė', '1700', '6003', '2023-05-02'], ['Andrius', 'Surinkėjas', 'Baldų surinkėjas', '1650', '6003', '2024-09-02'],
  ['Eglė', 'Pardavėja', 'Pardavimų vadybininkė', '2000', '6203', '2022-08-16'], ['Paulius', 'Vairuotojas', 'Vairuotojas-ekspeditorius', '1600', '6206', '2023-11-06'],
];
const ASSETS = [
  ['IT-001', 'CNC frezavimo staklės', '1220', '2023-03-15', '52800', 96], ['IT-002', 'Formatinio pjovimo staklės', '1220', '2024-02-10', '18000', 60],
  ['IT-003', 'Kraštų klijavimo staklės', '1220', '2025-05-20', '15000', 60], ['IT-004', 'Krovininis mikroautobusas', '1230', '2024-09-05', '28800', 72],
];

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const r2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const workday = (s) => { let d = s; while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1); return d; };

/** Runs the seed against an app (its handle, pool and auth). Returns counts. */
export async function seedManufacturing(app, {end = '2026-10-12', log = console} = {}) {
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const {token, csrf} = await app.deps.auth.openLogin();
  const cookie = `${app.config.cookieName || 'sid'}=${token}`;
  const call = async (method, url, body) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + url, {method, headers: {cookie, origin: base, 'x-csrf-token': csrf, ...(body && !isForm ? {'content-type': 'application/json'} : {})}, body: body ? (isForm ? body : JSON.stringify(body)) : undefined});
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${data?.error || text}`.slice(0, 500));
    return data;
  };
  const post = (u, b) => call('POST', u, b || {}), put = (u, b) => call('PUT', u, b), get = (u) => call('GET', u);
  const rand = rng(20261013);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const [endY, endM, endD] = end.split('-').map(Number);
  const months = []; for (let m = 1; m <= endM; m++) months.push(m);
  const year = endY;
  const counts = {invoices: 0, purchases: 0, sales: 0, bankRows: 0};
  try {
    await put('/api/settings/company', COMPANY);
    const bank = await post('/api/bank/accounts', BANK);
    // Reference data.
    const sup = {};
    for (const s of SUPPLIERS) sup[s.key] = {...s, id: (await post('/api/counterparties', {name: s.name, company_code: s.company_code, vat_code: s.vat_code, iban: s.iban, country: 'LT', is_supplier: true})).id};
    const cust = [];
    for (const c of CUSTOMERS) cust.push({...c, id: (await post('/api/counterparties', {name: c.name, company_code: c.company_code, vat_code: c.vat_code, iban: c.iban, country: 'LT', is_customer: true, address: 'Lietuva'})).id});
    const bankCp = (await post('/api/counterparties', {name: 'AB „Demo bankas“', company_code: '306999300', country: 'LT', is_supplier: true})).id;
    const attr = {
      species: (await post('/api/product-attributes', {name: 'Medienos rūšis', kind: 'choice', options: 'Ąžuolas\nBeržas\nPušis\nUosis'})).id,
      size: (await post('/api/product-attributes', {name: 'Matmenys', kind: 'text'})).id,
      color: (await post('/api/product-attributes', {name: 'Spalva / apdaila', kind: 'choice', options: 'Natūrali\nBalta\nRiešutinė\nJuoda'})).id,
    };
    const attrs = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [attr[k], v]));
    const mat = [];
    for (const [sku, name, unit, price, s, a] of MATERIALS) mat.push({sku, name, unit, price: Number(price), supplier: s, id: (await post('/api/products', {sku, name, unit, kind: 'goods', group_name: 'Žaliavos ir medžiagos', purchase_price: price, expense_account: '201', supplier_id: sup[s].id, track_stock: true, min_stock: unit === 'm3' ? '2' : '20', attributes: attrs(a)})).id});
    const goods = [];
    for (const [sku, name, price, a] of GOODS) goods.push({sku, name, price: Number(price), id: (await post('/api/products', {sku, name, unit: 'vnt.', kind: 'goods', group_name: 'Pagaminti baldai', unit_price: price, revenue_account: '5000', track_stock: true, min_stock: '2', location: 'Gatavos produkcijos sandėlis', attributes: attrs(a)})).id});
    const delivery = (await post('/api/products', {sku: 'PASL-PRIST', name: 'Pristatymas', kind: 'service', unit: 'kart.', unit_price: '45', revenue_account: '5002'})).id;
    const assembly = (await post('/api/products', {sku: 'PASL-MONT', name: 'Montavimas', kind: 'service', unit: 'val.', unit_price: '35', revenue_account: '5001'})).id;

    // Fixed assets (bought before this year) and opening balances on 1 January.
    const assets = [];
    for (const [inv_no, name, acc, date, cost, life] of ASSETS) {
      const months0 = Math.min(life, (year - 1 - Number(date.slice(0, 4))) * 12 + (12 - Number(date.slice(5, 7))));
      const opening = r2((Number(cost) / life) * months0);
      const created = await post('/api/fixed-assets', {inv_no, name, cost_account: acc, acquisition_date: date, cost, useful_life_months: life, opening_accumulated: opening, opening_period: `${year - 1}-12`, location: 'Gamybos cechas', responsible: 'Tomas Medinis'});
      assets.push(await get(`/api/fixed-assets/${created.id}`));
    }
    const openingLines = [];
    for (const a of assets) { openingLines.push({account: a.cost_account, debit: a.cost}); if (Number(a.opening_accumulated)) openingLines.push({account: a.depreciation_account, credit: a.opening_accumulated}); }
    openingLines.push({account: '2710', debit: '38000'}, {account: '201', debit: '12500'}, {account: '203', debit: '9800'}, {account: '3011', credit: '10000'});
    const bal = openingLines.reduce((t, l) => t + Number(l.debit || 0) - Number(l.credit || 0), 0);
    openingLines.push({account: '342', credit: r2(bal - 0)});
    await post('/api/journal', {date: `${year}-01-01`, description: `Pradiniai likučiai ${year}-01-01 (DEMO)`, kind: 'opening', lines: openingLines.map((l) => ({...l, debit: l.debit ? String(l.debit) : undefined, credit: l.credit ? String(l.credit) : undefined}))});
    // Opening stock quantities.
    for (const m of mat) await post('/api/stock/movements', {productId: m.id, kind: 'opening', date: `${year}-01-01`, quantity: m.unit === 'm3' ? '4' : m.unit === 'kg' ? '60' : m.unit === 'l' ? '20' : '150', unitCost: String(m.price), note: 'Pradinis likutis'});
    for (const g of goods) await post('/api/stock/movements', {productId: g.id, kind: 'opening', date: `${year}-01-01`, quantity: String(between(2, 6)), unitCost: r2(g.price * 0.55), note: 'Pradinis likutis'});

    const employees = [];
    for (const [first_name, last_name, position, base_salary, expense_account, employment_start] of EMPLOYEES) {
      employees.push(await post('/api/employees', {first_name, last_name, position, base_salary, expense_account, employment_start, department: expense_account === '6003' ? 'Gamyba' : expense_account === '6304' ? 'Administracija' : 'Pardavimai', apply_npd: true}));
    }
    const loan = await post('/api/loans', {direction: 'received', counterparty_name: 'AB „Demo bankas“', counterparty_id: bankCp, contract_no: 'KR-2026/014', contract_date: `${year}-02-12`, principal: '60000', annual_rate: '4.9', basis: 'act365', maturity_date: `${year + 3}-02-12`,
      notes: 'Investicinė paskola naujoms staklėms (DEMO).'});

    // Invoices, production and payments month by month.
    const payments = []; // {date, amount (+in/−out), name, iban, ref, kind: 'invoice'|'other', account?}
    const invoice = async (body) => {
      const r = await post('/api/manual-invoices', body);
      await post(`/api/proposals/${r.proposal.id}/approve`, {contentHash: r.proposal.content_hash});
      const inv = (await app.pool.query(`SELECT id, series, number, gross_total, due_date FROM invoices WHERE document_id=$1 ORDER BY id DESC LIMIT 1`, [r.documentId])).rows[0];
      counts.invoices++;
      return inv;
    };
    let supNo = 1000;
    const purchase = async (s, date, lines, payIn = [5, 30]) => {
      const inv = await invoice({register: 'purchase', counterpartyId: sup[s].id, series: sup[s].series, number: `${year}-${++supNo}`, issueDate: date, dueDate: addDays(date, 30), lines});
      counts.purchases++;
      const pay = addDays(date, between(...payIn));
      if (pay <= end && rand() < 0.93) payments.push({date: workday(pay), amount: -Number(inv.gross_total), name: sup[s].name, iban: sup[s].iban, ref: `Apmokėjimas pagal sąskaitą ${inv.series}${inv.number}`, kind: 'invoice'});
    };
    const consumed = {}; // material id → quantity used this month
    for (const m of months) {
      const days = m === endM ? endD : lastDay(year, m);
      const d = (n) => iso(year, m, Math.min(n, days));
      // Raw materials.
      for (let k = 0; k < 2; k++) {
        const woods = mat.filter((x) => x.supplier === 'wood');
        const w = pick(woods);
        await purchase('wood', d(between(2, 26)), [{description: w.name, productId: w.id, quantity: String(between(1, 3)), unitPrice: String(w.price), taxCode: 'PVM1', accountCode: '201', lineType: 'inventory', vatTreatment: 'deductible'}]);
      }
      await purchase('board', d(between(3, 20)), mat.filter((x) => x.supplier === 'board').map((b) => ({description: b.name, productId: b.id, quantity: String(between(10, 30)), unitPrice: String(b.price), taxCode: 'PVM1', accountCode: '201', lineType: 'inventory', vatTreatment: 'deductible'})));
      await purchase('fittings', d(between(5, 22)), mat.filter((x) => x.supplier === 'fittings').map((f) => ({description: f.name, productId: f.id, quantity: String(between(30, 120)), unitPrice: String(f.price), taxCode: 'PVM1', accountCode: '201', lineType: 'inventory', vatTreatment: 'deductible'})));
      if (m % 2) await purchase('finish', d(between(4, 18)), mat.filter((x) => x.supplier === 'finish').map((f) => ({description: f.name, productId: f.id, quantity: String(between(15, 40)), unitPrice: String(f.price), taxCode: 'PVM1', accountCode: '201', lineType: 'inventory', vatTreatment: 'deductible'})));
      // Overheads.
      if (m < endM || endD >= 5) await purchase('rent', d(1), [{description: `Gamybinių patalpų nuoma ${year}-${pad(m)}`, quantity: '1', unitPrice: '2400', taxCode: 'PVM1', accountCode: '6004', lineType: 'expense', vatTreatment: 'deductible'}], [3, 9]);
      if (m < endM) {
        await purchase('power', d(days), [{description: `Elektros energija ${year}-${pad(m)}`, quantity: String(between(5200, 7800)), unitPrice: '0.165', taxCode: 'PVM1', accountCode: '6004', lineType: 'expense', vatTreatment: 'deductible'}], [8, 15]);
        await purchase('telecom', d(days), [{description: `Ryšio ir interneto paslaugos ${year}-${pad(m)}`, quantity: '1', unitPrice: '79', taxCode: 'PVM1', accountCode: '6316', lineType: 'service', vatTreatment: 'deductible'}], [8, 15]);
        await purchase('it', d(between(10, 25)), [{description: 'Apskaitos ir projektavimo programų licencijos', quantity: '1', unitPrice: '145', taxCode: 'PVM1', accountCode: '6317', lineType: 'service', vatTreatment: 'deductible'},
          ...(rand() < 0.4 ? [{description: 'Kanceliarinės prekės', quantity: '1', unitPrice: r2(between(30, 90)), taxCode: 'PVM1', accountCode: '6322', lineType: 'expense', vatTreatment: 'deductible'}] : [])]);
      }
      for (let k = 0; k < (m === endM ? 1 : 2); k++) await purchase('transport', d(between(6, 28)), [{description: 'Krovinių pervežimas (išvežimas pirkėjams)', quantity: '1', unitPrice: r2(between(120, 380)), taxCode: 'PVM1', accountCode: '6206', lineType: 'service', vatTreatment: 'deductible'}]);

      // Sales of the month are planned first; production covers them (gamybos aktas on the 3rd).
      const plan = [];
      const salesCount = m === endM ? 5 : between(11, 14);
      for (let k = 0; k < salesCount; k++) {
        const c = pick(cust), date = d(between(4, days));
        const project = rand() < 0.12; // a larger order (hotel, school, office)
        const items = project ? [[pick(goods), between(8, 20)]] : [[pick(goods), between(1, 4)], ...(rand() < 0.6 ? [[pick(goods), between(1, 4)]] : [])];
        plan.push({c, date, items, delivery: project || rand() < 0.6, assembly: project ? between(8, 20) : rand() < 0.3 ? between(2, 6) : 0});
      }
      const sold = new Map();
      for (const p of plan) for (const [g, q] of p.items) sold.set(g, (sold.get(g) || 0) + q);
      let producedValue = 0, soldValue = 0;
      for (const g of goods) {
        const q = (sold.get(g) || 0) + between(0, 2);
        if (q) await post('/api/stock/movements', {productId: g.id, kind: 'adjustment', date: d(3), quantity: String(q), unitCost: r2(g.price * 0.55), note: `Pagaminta, gamybos aktas G-${year}-${pad(m)}`});
        producedValue += q * Number(r2(g.price * 0.55));
        soldValue += (sold.get(g) || 0) * Number(r2(g.price * 0.55));
      }
      plan.sort((a, b) => (a.date < b.date ? -1 : 1));
      for (const p of plan) {
        const lines = p.items.map(([g, q]) => ({description: g.name, productId: g.id, quantity: String(q), unitPrice: String(g.price), taxCode: 'PVM1'}));
        if (p.delivery) lines.push({description: 'Pristatymas', productId: delivery, quantity: '1', unitPrice: '45', taxCode: 'PVM1'});
        if (p.assembly) lines.push({description: 'Montavimas', productId: assembly, quantity: String(p.assembly), unitPrice: '35', taxCode: 'PVM1'});
        const inv = await invoice({register: 'sales', counterpartyId: p.c.id, issueDate: p.date, dueDate: addDays(p.date, 14), lines});
        counts.sales++;
        const pay = addDays(p.date, between(7, 40));
        if (pay <= end && rand() < 0.88) payments.push({date: workday(pay), amount: Number(inv.gross_total), name: p.c.name, iban: p.c.iban, ref: `Apmokėjimas už sąskaitą ${inv.series}${inv.number}`, kind: 'invoice'});
      }
      // Materials used in production: quantity write-off and its cost in the ledger (D 6003 / K 201).
      if (m < endM) {
        let value = 0;
        for (const x of mat) {
          const q = x.unit === 'm3' ? between(1, 2) : x.unit === 'kg' ? between(15, 30) : x.unit === 'l' ? between(6, 15) : x.unit === 'lakšt.' ? between(8, 25) : between(25, 90);
          const have = Number((await app.pool.query(`SELECT coalesce(sum(quantity),0) AS q FROM stock_moves WHERE product_id=$1 AND move_date <= $2`, [x.id, d(days)])).rows[0].q);
          const use = Math.min(q, Math.floor(have * 0.8));
          if (use <= 0) continue;
          await post('/api/stock/movements', {productId: x.id, kind: 'writeoff', date: d(days), quantity: String(use), note: `Sunaudota gamyboje, aktas G-${year}-${pad(m)}`});
          value += use * x.price;
        }
        await post('/api/journal', {date: d(days), description: `Žaliavų ir medžiagų nurašymas į gamybą, aktas G-${year}-${pad(m)} (DEMO)`, lines: [{account: '6003', debit: r2(value)}, {account: '201', credit: r2(value)}]});
        // Payroll, its payments and depreciation.
        const run = await post('/api/payroll/runs', {period: `${year}-${pad(m)}`});
        await post(`/api/payroll/runs/${run.id}/approve`);
        const sheet = await get(`/api/payroll/runs/${run.id}`);
        const payDay = workday(iso(m === 12 ? year + 1 : year, m === 12 ? 1 : m + 1, 10));
        if (payDay <= end) {
          for (const l of sheet.lines) payments.push({date: payDay, amount: -Number(l.to_pay), name: `${l.first_name || ''} ${l.last_name || ''}`.trim() || 'Darbuotojas', iban: '', ref: `Darbo užmokestis ${year}-${pad(m)}`, kind: 'other', account: '4480'});
          payments.push({date: workday(addDays(payDay, 5)), amount: -Number(sheet.totals.gpm), name: 'Valstybinė mokesčių inspekcija', iban: ibanLT('7300010112394300'), ref: `GPM ${year}-${pad(m)}`, kind: 'other', account: '4481'});
          payments.push({date: workday(addDays(payDay, 5)), amount: -Number(sheet.totals.sodra_total), name: 'Valstybinio socialinio draudimo fondo valdyba', iban: ibanLT('7300010002366813'), ref: `Sodra ${year}-${pad(m)}`, kind: 'other', account: '4482'});
        }
        await post('/api/depreciation/runs', {period: `${year}-${pad(m)}`});
      }
      // Production at cost into finished goods (D 203 / K 6005) and the cost of goods sold (D 6000 / K 203), confirmed per month.
      await post('/api/journal', {date: d(days), description: `Pagaminta produkcija, gamybos aktas G-${year}-${pad(m)} (DEMO)`, kind: 'adjustment', lines: [{account: '203', debit: r2(producedValue)}, {account: '6005', credit: r2(producedValue)}]});
      await post('/api/journal', {date: d(days), description: `Parduotos produkcijos savikaina ${year}-${pad(m)} (DEMO)`, kind: 'cogs', cogsPeriod: `${year}-${pad(m)}`, lines: [{account: '6000', debit: r2(soldValue)}, {account: '203', credit: r2(soldValue)}]});
      // VAT of the month: input VAT set off against output VAT (D 4492 / K 2441), the rest paid to VMI by the 25th.
      if (m < endM) {
        const vat = (await app.pool.query(`SELECT coalesce(sum(credit - debit) FILTER (WHERE l.account_code='4492'),0) AS out, coalesce(sum(debit - credit) FILTER (WHERE l.account_code='2441'),0) AS inp
          FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.entry_date BETWEEN $1 AND $2 AND e.source_type <> 'manual'`, [d(1), d(days)])).rows[0];
        const setOff = Math.min(Number(vat.out), Number(vat.inp));
        if (setOff > 0) await post('/api/journal', {date: d(days), description: `PVM sudengimas ${year}-${pad(m)} (DEMO)`, lines: [{account: '4492', debit: r2(setOff)}, {account: '2441', credit: r2(setOff)}]});
        const due = Number(vat.out) - setOff;
        const payDay = workday(iso(m === 12 ? year + 1 : year, m === 12 ? 1 : m + 1, 24));
        if (due > 0 && payDay <= end) payments.push({date: payDay, amount: -Number(r2(due)), name: 'Valstybinė mokesčių inspekcija', iban: ibanLT('7300010112394300'), ref: `PVM ${year}-${pad(m)}`, kind: 'other', account: '4492'});
      }
      // Bank fee.
      if (m < endM) payments.push({date: workday(d(days)), amount: -12.5, name: 'Demo bankas', iban: '', ref: 'Mokestis už sąskaitos aptarnavimą', kind: 'fee'});
    }
    // The loan: money arrives on 17 February; repayments every three months; interest paid with them.
    const loanIn = {date: `${year}-02-17`, amount: 60000, name: 'AB „Demo bankas“', iban: ibanLT('7300010199990999'), ref: 'Paskolos išmokėjimas pagal sutartį KR-2026/014', kind: 'other', account: '441', loan: 'disbursement'};
    payments.push(loanIn);
    for (const date of [`${year}-05-18`, `${year}-08-17`]) {
      if (date > end) continue;
      payments.push({date, amount: -5000, name: 'AB „Demo bankas“', iban: ibanLT('7300010199990999'), ref: 'Paskolos grąžinimas KR-2026/014', kind: 'other', account: '441', loan: 'repayment'});
    }

    // Monthly bank statements (CSV), imported and matched; matched invoice payments approved.
    payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let balance = 38000;
    const intents = new Map();
    for (const m of months) {
      const rows = payments.filter((p) => Number(p.date.slice(5, 7)) === m && p.date.slice(0, 4) === String(year));
      if (!rows.length) continue;
      const opening = balance;
      for (const p of rows) balance += p.amount;
      const csv = ['Data;Gavėjas/Mokėtojas;Sąskaita;Paskirtis;Suma;Valiuta', ...rows.map((p) => [p.date, p.name.replace(/;/g, ','), p.iban, p.ref, r2(p.amount).replace('.', ','), 'EUR'].join(';'))].join('\n');
      const fd = new FormData(); fd.append('workflow', 'bank'); fd.append('files', new Blob([csv]), `israsas-${year}-${pad(m)}.csv`);
      const up = await post('/api/uploads', fd);
      const imp = await post('/api/bank/statements/import', {documentId: up.results[0].documentId, bankAccountId: bank.id, opening: r2(opening), closing: r2(balance)});
      counts.bankRows += rows.length;
      for (const p of rows) intents.set(`${p.date}|${r2(p.amount)}|${p.ref}`, p);
      void imp;
    }
    const txs = (await app.pool.query(`SELECT id, booking_date, amount, reference FROM bank_transactions WHERE bank_account_id=$1 ORDER BY booking_date, id`, [bank.id])).rows;
    let approved = 0;
    for (const t of txs) {
      const intent = intents.get(`${String(t.booking_date).slice(0, 10)}|${r2(Number(t.amount))}|${t.reference}`);
      const d = await get(`/api/bank/transactions/${t.id}`);
      let p = d.proposals?.find((x) => x.status === 'open');
      if (!p || !intent) continue;
      try {
        if (intent.kind === 'other') {
          p = await put(`/api/bank/transactions/${t.id}/proposal`, {contentHash: p.content_hash, kind: 'other', allocations: [{kind: 'other', amount: r2(Number(t.amount)), accountCode: intent.account, note: intent.ref}]});
          p = p.proposal || p;
        }
        if (p.blocking) continue;
        await post(`/api/bank/transactions/${t.id}/approve`, {contentHash: p.content_hash});
        approved++;
        if (intent.loan) await post(`/api/loans/${loan.id}/events`, {kind: intent.loan, date: intent.date, amount: r2(Math.abs(intent.amount)), bank_transaction_id: t.id, note: intent.ref});
      } catch (e) { log.warn?.(`[demo] banko operacija ${t.id}: ${e.message}`); }
    }
    counts.bankApproved = approved;
    // Interest accrued to the end of the last full month.
    const lastFull = iso(year, endM - 1, lastDay(year, endM - 1));
    try { await post(`/api/loans/${loan.id}/accruals`, {asOf: lastFull}); } catch (e) { log.warn?.(`[demo] palūkanų kaupimas: ${e.message}`); }
    return counts;
  } finally {
    server.close();
  }
}
