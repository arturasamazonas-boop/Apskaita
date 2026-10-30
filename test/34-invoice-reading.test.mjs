// Purchase-invoice reading: right-aligned/centred table headers, thousands with spaces, title numbers,
// bank lines in the letterhead, issue and due date on one row, a logo beside the letterhead.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {extractPdf, wordsToRows} from '../src/extraction/text.mjs';
import {parseInvoice} from '../src/extraction/invoice-parser.mjs';

const FONT = new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url).pathname;
const FONT_B = new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url).pathname;
const v = (f) => (f && f.value !== undefined && f.value !== null ? f.value : '');

async function read(draw) {
  const {default: PDFDocument} = await import('pdfkit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-read-'));
  const file = path.join(dir, 'in.pdf');
  await new Promise((res) => {
    const d = new PDFDocument({size: 'A4', margin: 40}); const ws = fs.createWriteStream(file); d.pipe(ws);
    d.registerFont('r', FONT); d.registerFont('b', FONT_B); d.font('r');
    const T = (s, x, y, o = {}) => d.font(o.bold ? 'b' : 'r').fontSize(o.size || 9).text(s, x, y, {lineBreak: false, ...(o.w ? {width: o.w, align: o.align || 'right'} : {})});
    draw(d, T); d.end(); ws.on('finish', res);
  });
  try { return parseInvoice(await extractPdf(file, dir)); } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
const lines = (ex) => ex.lines.map((l) => [v(l.description), v(l.quantity), v(l.unit), v(l.unitPrice), v(l.vatRate), v(l.net)]);
const BUYER = ['Pirkėjas:', 'UAB „Pavyzdinė prekyba“', 'Įmonės kodas: 305555555', 'PVM mokėtojo kodas: LT100015555519'];

// Header text right-aligned or centred in a column box (as many invoicing programs print it).
function header(d, T, cols, names, align) {
  names.forEach((h, i) => {
    const c = cols[i];
    d.font('b').fontSize(8);
    const w = d.widthOfString(h);
    const x = c.w && align === 'right' ? c.x + c.w - w : c.w && align === 'center' ? c.x + (c.w - w) / 2 : c.x;
    T(h, x, c.y, {bold: true, size: 8});
  });
}

for (const align of ['right', 'center']) {
  test(`line table with ${align}-aligned headers: amounts wider than the header, "1 092,00", "1.189,00", "Eil." column, two rates`, async () => {
    const ex = await read((d, T) => {
      T('PVM SĄSKAITA FAKTŪRA', 190, 40, {bold: true, size: 15});
      T('Serija AB Nr. 000123', 240, 62); T('Išrašymo data 2026.10.16', 225, 76); T('Apmokėti iki 2026.10.30', 228, 88);
      T('Pardavėjas: UAB Šilumos ratas, Taikos pr. 120, Klaipėda, įm. k. 305123456, PVM k. LT305123419', 40, 120, {size: 8});
      T('Pirkėjas: UAB „Pavyzdinė prekyba“, įm. k. 305555555, PVM k. LT100015555519', 40, 134, {size: 8});
      const y = 170;
      const cols = [{x: 40}, {x: 70}, {x: 260, w: 40}, {x: 310}, {x: 345, w: 75}, {x: 428, w: 30}, {x: 465, w: 85}].map((c) => ({...c, y}));
      header(d, T, cols, ['Eil.', 'Prekė / paslauga', 'Kiekis', 'Mato vnt.', 'Kaina', 'PVM %', 'Suma'], align);
      const rows = [['1', 'Kava pupelėmis 1 kg', '40', 'kg', '18,50', '21', '740,00'], ['2', 'Šildymo paslauga', '1', 'vnt.', '1 000,00', '9', '1 000,00'],
        ['3', 'Kompiuteris', '8', 'vnt.', '1.189,00', '21', '9.512,00'], ['4', 'Lentynų sistema', '1', 'kompl.', '1 184 000,00', '21', '1 184 000,00']];
      rows.forEach((r, k) => r.forEach((c, i) => T(c, cols[i].x, y + 14 * (k + 1), cols[i].w ? {w: cols[i].w} : {})));
      T('Suma be PVM:', 330, y + 80); T('1 195 252,00', 450, y + 80, {w: 100});
    });
    assert.deepEqual(lines(ex), [
      ['Kava pupelėmis 1 kg', '40', 'kg', '18.50', '21', '740.00'],
      ['Šildymo paslauga', '1', 'vnt.', '1000.00', '9', '1000.00'],
      ['Kompiuteris', '8', 'vnt.', '1189.00', '21', '9512.00'],
      ['Lentynų sistema', '1', 'kompl.', '1184000.00', '21', '1184000.00'],
    ]);
    assert.equal(v(ex.totals.net), '1195252.00');
  });
}

test('a price column header sharing a segment with "PVM %" ("Kaina PVM %"): "2.350,00" wider than "Kaina" stays a price', async () => {
  const ex = await read((d, T) => {
    T('PVM SĄSKAITA FAKTŪRA', 190, 40, {bold: true, size: 15}); T('Serija ŪK Nr. 55', 250, 62); T('Data 2026-10-20', 250, 76);
    const y = 120;
    const cols = [{x: 40}, {x: 70}, {x: 300, w: 50}, {x: 365, w: 70}, {x: 440, w: 30}, {x: 480, w: 70}].map((c) => ({...c, y}));
    header(d, T, cols, ['Nr.', 'Pavadinimas', 'Kiekis', 'Kaina', 'PVM %', 'Suma'], 'right');
    [['1', 'Sūris 36 mėn.', '2,5 kg', '32,40', '21', '81,00'], ['2', 'Kavos aparatas', '1 vnt.', '2.350,00', '21', '2.350,00']]
      .forEach((r, k) => r.forEach((c, i) => T(c, cols[i].x, y + 14 * (k + 1), cols[i].w ? {w: cols[i].w} : {})));
  });
  assert.deepEqual(lines(ex), [['Sūris 36 mėn.', '2.5', 'kg', '32.40', '21', '81.00'], ['Kavos aparatas', '1', 'vnt.', '2350.00', '21', '2350.00']]);
});

test('number only in the title; table header "Nr. Paslaugos pavadinimas" is not the number; "Išrašyta …, apmokėti iki …" on one row', async () => {
  const ex = await read((d, T) => {
    T('UAB „Kasybos technika“', 330, 40, {bold: true, size: 10});
    T('Įm. k. 306789123, PVM k. LT306789114', 330, 56, {size: 8});
    T('Pramonės g. 3, LT-35100 Panevėžys', 330, 67, {size: 8});
    T('PVM SĄSKAITA FAKTŪRA KT-7781', 170, 110, {bold: true, size: 14});
    T('Išrašyta 2026-10-19, apmokėti iki 2026-11-18', 175, 130);
    BUYER.forEach((b, i) => T(b, 40, 160 + 12 * i));
    const y = 230;
    const cols = [{x: 40}, {x: 65}, {x: 290, w: 40}, {x: 340}, {x: 385, w: 70}, {x: 465, w: 85}].map((c) => ({...c, y}));
    header(d, T, cols, ['Nr.', 'Paslaugos pavadinimas', 'Kiekis', 'Mato vnt.', 'Kaina', 'Suma be PVM'], 'right');
    ['1', 'Ekskavatoriaus nuoma', '22', 'val.', '65,00', '1 430,00'].forEach((c, i) => T(c, cols[i].x, y + 14, cols[i].w ? {w: cols[i].w} : {}));
  });
  assert.deepEqual([v(ex.series), v(ex.number), v(ex.issueDate), v(ex.dueDate)], ['', 'KT-7781', '2026-10-19', '2026-11-18']);
  assert.deepEqual([v(ex.seller.name), v(ex.seller.companyCode), v(ex.seller.vatCode)], ['UAB „Kasybos technika“', '306789123', 'LT306789114']);
  assert.deepEqual(lines(ex), [['Ekskavatoriaus nuoma', '22', 'val.', '65.00', '', '1430.00']]);
});

test('letterhead whose bank line ("Atsiskaitomoji sąskaita …") comes first is the supplier, not the title; "Data: …   Apmokėti iki: …" on one row', async () => {
  const ex = await read((d, T) => {
    T('UAB „Spalvų pasaulis“', 40, 40, {bold: true, size: 12});
    T('Atsiskaitomoji sąskaita LT347044060009990001, AB SEB bankas', 40, 57, {size: 8});
    T('Įmonės kodas 301112223', 40, 68, {size: 8});
    T('PVM mokėtojo kodas LT301112215', 40, 79, {size: 8});
    T('Ukmergės g. 220, LT-07157 Vilnius', 40, 90, {size: 8});
    T('PVM SĄSKAITA FAKTŪRA', 190, 120, {bold: true, size: 14});
    T('Serija SP Nr. 10045', 240, 140);
    T('Data: 2026-10-23', 120, 154); T('Apmokėti iki: 2026-11-06', 330, 154);
    BUYER.forEach((b, i) => T(b, 40, 180 + 12 * i));
  });
  assert.equal(v(ex.docType), 'vat_invoice');
  assert.deepEqual([v(ex.series), v(ex.number), v(ex.issueDate), v(ex.dueDate)], ['SP', '10045', '2026-10-23', '2026-11-06']);
  const s = ex.seller;
  assert.deepEqual([v(s.name), v(s.companyCode), v(s.vatCode), v(s.address), v(s.iban)], ['UAB „Spalvų pasaulis“', '301112223', 'LT301112215', 'Ukmergės g. 220, LT-07157 Vilnius', 'LT347044060009990001']);
});

test('"Data … Apmokėti iki …" in one segment and a "Banko sąskaita" letterhead line keep the IBAN', async () => {
  const ex = await read((d, T) => {
    T('MB „Kodo dirbtuvės“, Vytauto g. 12-4, Šiauliai, įm. k. 309012345, PVM k. LT309012316', 40, 40, {size: 8});
    T('Banko sąskaita LT022140001231231234 (Luminor)', 40, 51, {size: 8});
    T('PVM SĄSKAITA FAKTŪRA', 190, 80, {bold: true, size: 15});
    T('Serija KD Nr. 0042', 250, 100);
    T('Data 2026-10-22  Apmokėti iki 2026-11-05', 200, 114);
    BUYER.forEach((b, i) => T(b, 40, 140 + 12 * i));
  });
  assert.deepEqual([v(ex.issueDate), v(ex.dueDate)], ['2026-10-22', '2026-11-05']);
  assert.deepEqual([v(ex.seller.name), v(ex.seller.iban)], ['MB „Kodo dirbtuvės“', 'LT022140001231231234']);
});

test('a due date alone on a row is never read as the issue date', async () => {
  const ex = await read((d, T) => {
    T('PVM SĄSKAITA FAKTŪRA', 190, 40, {bold: true, size: 15});
    T('Nr. SND-000918', 245, 62);
    T('Apmokėti iki 2026-12-20', 230, 76);
    T('2026-10-21', 262, 90);
  });
  assert.deepEqual([v(ex.number), v(ex.issueDate), v(ex.dueDate)], ['SND-000918', '2026-10-21', '2026-12-20']);
});

test('a large logo word beside a two-line letterhead does not merge the two lines (wordsToRows)', () => {
  const W = (text, x0, y0, x1, y1) => ({text, bbox: [x0, y0, x1, y1]});
  const rows = wordsToRows([
    W('KASTA', 0.067, 0.0475, 0.202, 0.0779),
    W('UAB', 0.554, 0.0475, 0.593, 0.0613), W('„Kasybos', 0.599, 0.0475, 0.689, 0.0613), W('technika“', 0.695, 0.0475, 0.788, 0.0613),
    W('Įm.', 0.554, 0.0641, 0.576, 0.0752), W('k.', 0.580, 0.0641, 0.592, 0.0752), W('306789123', 0.596, 0.0641, 0.677, 0.0752),
    W('Pramonės', 0.554, 0.0772, 0.621, 0.0883), W('g.', 0.625, 0.0772, 0.638, 0.0883), W('3', 0.642, 0.0772, 0.650, 0.0883),
  ]);
  assert.deepEqual(rows.map((r) => r.text), ['UAB „Kasybos technika“', 'KASTA', 'Įm. k. 306789123', 'Pramonės g. 3']);
  // Words of one line with slightly different heights (OCR) stay together.
  const one = wordsToRows([W('Iš', 0.1, 0.50, 0.12, 0.515), W('viso', 0.13, 0.498, 0.17, 0.516), W('1', 0.6, 0.501, 0.61, 0.515), W('234,00', 0.62, 0.499, 0.68, 0.517)]);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].words.map((w) => w.text), ['Iš', 'viso', '1', '234,00']);
});
