// Company details from rekvizitai.lt page text (parsed in the browser) and the EU VIES VAT check.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startTestApp} from './helpers.mjs';
import {parseCompanyText, bookmarklet, normalizeName} from '../public/js/lib/company-parse.mjs';

// Text as copied from a rekvizitai.lt company page (labels and values on separate lines, header and footer noise).
const PAGE = `Rekvizitai.lt
Įmonių katalogas
Energitech, UAB
Rekvizitai
Įmonės kodas
306988664
PVM kodas
LT100017188012
Adresas
Panerių g. 51, LT-03160 Vilnius
Mobilus telefonas
+370 612 34567
Tinklalapis
www.energitech.lt
Vadovas
Jonas Jonaitis, direktorius
Darbuotojai
5 (2026-09)
Banko sąskaita
LT12 7300 0101 2345 6789
Kontaktai
Verslo žinios, Jogailos g. 9, Vilnius`;

test('rekvizitai.lt page text → company fields', () => {
  const d = parseCompanyText(PAGE, {title: 'Energitech, UAB', url: 'https://rekvizitai.vz.lt/imone/energitech/'});
  assert.deepEqual({...d}, {name: 'UAB „Energitech“', company_code: '306988664', vat_code: 'LT100017188012', legal_form: 'UAB', address: 'Panerių g. 51, LT-03160 Vilnius',
    phone: '+370 612 34567', email: '', website: 'www.energitech.lt', manager: 'Jonas Jonaitis, direktorius', iban: 'LT127300010123456789', bank_name: '', source: 'https://rekvizitai.vz.lt/imone/energitech/'});
});

test('other layouts: same-line labels, non-VAT payer, MB, e-mail', () => {
  const d = parseCompanyText('Pavadinimas: MB "Saulės baldai"\nĮmonės kodas: 305123456\nPVM kodas: Ne PVM mokėtojas\nAdresas: Laisvės al. 1, Kaunas\nEl. paštas: info@saules.lt\nTel.: 8 612 34567');
  assert.equal(d.name, 'MB „Saulės baldai“'); assert.equal(d.legal_form, 'MB'); assert.equal(d.company_code, '305123456');
  assert.equal(d.vat_code, ''); assert.equal(d.email, 'info@saules.lt'); assert.equal(d.address, 'Laisvės al. 1, Kaunas'); assert.equal(d.phone, '8 612 34567');
  assert.equal(parseCompanyText('Įmonės kodas\t302564383\nPVM kodas\tLT 100005748413').vat_code, 'LT100005748413');
  assert.equal(normalizeName('Litgrid, AB'), 'AB „Litgrid“');
  assert.equal(parseCompanyText('nieko čia nėra').company_code, '');
  assert.match(bookmarklet('https://apskaita.example'), /^javascript:\(\(\)=>\{.*https:\/\/apskaita\.example\/#\/rekvizitai\?d=/);
});

let t, acc, ro, vies, viesCalls = [];
before(async () => {
  vies = http.createServer((req, res) => {
    viesCalls.push(req.url);
    const m = /\/ms\/(\w+)\/vat\/(\w+)$/.exec(req.url);
    if (m && m[2] === '999999999') { res.writeHead(503); return res.end('down'); }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify(m && m[2] === '100017188012' ? {isValid: true, userError: 'VALID', name: 'UAB ENERGITECH', address: 'N/A'} : {isValid: false, userError: 'INVALID', name: '---', address: '---'}));
  });
  await new Promise((r) => vies.listen(0, '127.0.0.1', r));
  t = await startTestApp({config: {viesUrl: `http://127.0.0.1:${vies.address().port}`}});
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
});
after(async () => { await t.close(); vies.close(); });

test('VIES VAT check: valid with name, invalid, service down, bad input', async () => {
  const ok = await ro.get('/api/vat-check?code=lt%20100017188012');
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.valid, ok.body.name, ok.body.address, ok.body.code], [true, 'UAB ENERGITECH', '', 'LT100017188012']);
  assert.equal(viesCalls.at(-1), '/ms/LT/vat/100017188012');
  assert.equal((await ro.get('/api/vat-check?code=LT100000000000')).body.valid, false);
  const down = await ro.get('/api/vat-check?code=LT999999999');
  assert.equal(down.status, 502); assert.match(down.body.error, /VIES/);
  assert.equal((await ro.get('/api/vat-check?code=abc')).status, 400);
});

test('counterparty and own company keep the extra details; duplicate company code refused', async () => {
  const d = parseCompanyText(PAGE, {title: 'Energitech, UAB'});
  const c = await acc.post('/api/counterparties', {...d, is_supplier: true});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual([c.body.legal_form, c.body.phone, c.body.website, c.body.manager, c.body.iban], ['UAB', '+370 612 34567', 'www.energitech.lt', 'Jonas Jonaitis, direktorius', 'LT127300010123456789']);
  assert.equal((await acc.post('/api/counterparties', {...d})).status, 409);
  const admin = await t.client('admin').login();
  const cur = (await admin.get('/api/settings/company')).body;
  const s = await admin.put('/api/settings/company', {...cur, website: 'www.manoimone.lt', manager: 'Ona Onaitė', iban: 'LT12 7300 0101 2345 6789', bank_name: 'Swedbank'});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual([s.body.website, s.body.manager, s.body.iban, s.body.bank_name], ['www.manoimone.lt', 'Ona Onaitė', 'LT127300010123456789', 'Swedbank']);
  const {website, manager, iban, bank_name, ...older} = cur; void website; void manager; void iban; void bank_name;
  const again = await admin.put('/api/settings/company', {...older, name: 'Kitas'});
  assert.equal(again.body.website, 'www.manoimone.lt', 'fields not sent are kept');
});
