// Deterministic, rules-based invoice field extractor ("rules-lt" provider).
// Input: TextDoc from text.mjs. Output: fields with provenance and status.
// Document text is treated purely as data: nothing in it is executed or followed.
import {parseAmount, money, toUnits} from '../lib/money.mjs';
import {fold, ltVatValid, ibanValid, normalizeVat, normalizeIban} from './ids.mjs';

export const PROVIDER = {name: 'rules-lt', version: '1.0'};
const LOW_CONF = 70;

const MONTHS = {sausio: 1, vasario: 2, kovo: 3, balandzio: 4, geguzes: 5, birzelio: 6, liepos: 7, rugpjucio: 8, rugsejo: 9, spalio: 10, lapkricio: 11, gruodzio: 12};

export function parseDate(s) {
  const t = fold(String(s));
  let m = /(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(t);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(t);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = /(\d{4})\s*m\.?\s*([a-z]+)\s*(\d{1,2})\s*d/.exec(t);
  if (m && MONTHS[m[2]]) return ymd(+m[1], MONTHS[m[2]], +m[3]);
  return null;
}
function ymd(y, mo, d) {
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function minConf(words) {
  const c = (words || []).map((w) => w.conf).filter((x) => typeof x === 'number');
  return c.length ? Math.min(...c) : null;
}

function srcOf(page, row, seg) {
  const s = {page: page.page, method: page.method, text: row.text.slice(0, 300)};
  if (seg?.bbox) s.bbox = seg.bbox.map((x) => Math.round(x * 10000) / 10000);
  else if (row.bbox) s.bbox = row.bbox.map((x) => Math.round(x * 10000) / 10000);
  const src = seg?.source || row.source;
  if (src) Object.assign(s, src);
  const conf = minConf(seg ? seg.words : row.words);
  if (conf !== null) s.ocrConfidence = conf;
  return s;
}

function field(value, source, extra = {}) {
  const f = {value, status: value === null || value === undefined || value === '' ? 'missing' : 'ok', source: source || null, ...extra};
  if (f.status === 'ok' && source?.ocrConfidence !== undefined && source.ocrConfidence < LOW_CONF) {
    f.status = 'uncertain';
    f.reason = `OCR atpažinimas nepatikimas (Tesseract žodžio patikimumas ${source.ocrConfidence}/100).`;
    f.providerScore = {provider: 'tesseract', score: source.ocrConfidence, meaning: 'Tesseract žodžio patikimumas 0–100; tai nėra tikimybė, kad reikšmė teisinga.'};
  }
  return f;
}
const missing = (reason) => ({value: null, status: 'missing', reason, source: null});

/** Text after a label inside the row: same segment after ':' or following segments. */
function valueAfter(row, labelRe) {
  const segs = row.segments?.length ? row.segments : [{text: row.text}];
  for (let i = 0; i < segs.length; i++) {
    const f = fold(segs[i].text);
    const m = labelRe.exec(f);
    if (!m) continue;
    let rest = segs[i].text.slice(m.index + m[0].length).replace(/^[\s:.#-]+/, '').trim();
    if (rest) return {text: rest, seg: segs[i]};
    if (segs[i + 1]) return {text: segs[i + 1].text.trim(), seg: segs[i + 1]};
  }
  return null;
}

function allRows(doc) {
  const out = [];
  for (const page of doc.pages) page.rows.forEach((row, idx) => out.push({page, row, idx, f: fold(row.text)}));
  return out;
}

// ---------------------------------------------------------------- doc type
const TYPE_PATTERNS = [
  ['credit_note', /kreditine|credit note|kredito saskaita/],
  ['debit_note', /debetine/],
  ['proforma', /isankstine|proforma|pro forma|avansine saskaita|isankstinio apmokejimo/],
  ['contract', /\bsutartis\b|\bcontract\b|\bagreement\b/],
  ['vat_invoice', /pvm\s*saskaita|vat invoice|pvm s\/?f/],
  ['invoice', /saskaita[\s-]*faktura|\binvoice\b|\bsaskaita\b/],
  ['receipt', /\bkvitas\b|\bcekis\b|\breceipt\b/],
];

function detectTitle(page) {
  for (const row of page.rows.slice(0, 10)) {
    const f = fold(row.text);
    for (const [type, re] of TYPE_PATTERNS) if (re.test(f) && f.length < 90) return {type, row};
  }
  return null;
}

// ---------------------------------------------------------------- number
const NUM_RE = [
  /serija\s*:?\s*([a-z0-9]{1,10})\s*,?\s*nr\.?\s*:?\s*([a-z0-9][a-z0-9\-\/]*)/,
  /(?:saskaitos|invoice|dokumento|sf)\s*(?:nr\.?|no\.?|numeris|number)\s*:?\s*([a-z0-9][a-z0-9\-\/ ]{0,24}[a-z0-9])/,
  /^(?:nr\.?|no\.?)\s*:?\s*([a-z0-9][a-z0-9\-\/]*)/,
];
function findNumber(page) {
  for (const row of page.rows.slice(0, 14)) {
    const f = fold(row.text);
    if (/uzsakym|order|koreguojam|kredituojam|pagal saskait|mokejimo paskirt|kodas/.test(f)) continue;
    const m0 = NUM_RE[0].exec(f);
    const orig = (m) => row.text.slice(m.index, m.index + m[0].length);
    if (m0) {
      const o = orig(m0);
      const mm = /serija\s*:?\s*(\S{1,10})\s*,?\s*nr\.?\s*:?\s*(\S+)/i.exec(fold(o)) && /^(\S+\s*:?\s*)(\S{1,10})(\s*,?\s*\S+\s*:?\s*)(\S+)/.exec(o);
      return {series: (mm ? mm[2] : m0[1]).toUpperCase(), number: (mm ? mm[4] : m0[2]).toUpperCase(), page, row};
    }
    for (const re of NUM_RE.slice(1)) {
      const m = re.exec(f);
      if (m) {
        const raw = row.text.slice(m.index + m[0].length - m[1].length, m.index + m[0].length).trim().toUpperCase();
        const parts = raw.split(/\s+/);
        return parts.length === 2 && /^[A-Z]{1,6}$/.test(parts[0]) ? {series: parts[0], number: parts[1], page, row} : {series: '', number: raw.replace(/\s+/g, ''), page, row};
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- parties
const SELLER_RE = /^(pardavejas|tiekejas|paslaugu teikejas|seller|supplier|vendor|isdave|rangovas)\b/;
const BUYER_RE = /^(pirkejas|uzsakovas|gavejas|klientas|buyer|customer|bill to|mokėtojas|mokatojas)\b/;

function partyBlocks(doc) {
  const page = doc.pages[0];
  const rows = page.rows;
  let sellerAt = null, buyerAt = null;
  rows.forEach((row, i) => {
    (row.segments || []).forEach((seg, j) => {
      const f = fold(seg.text).trim();
      if (sellerAt === null && SELLER_RE.test(f)) sellerAt = {i, j, seg};
      else if (buyerAt === null && BUYER_RE.test(f)) buyerAt = {i, j, seg};
    });
  });
  const stopRe = /^(nr\.?|eil|pavadinimas|preke|aprasymas|description|item)\b/;
  const blocks = {seller: [], buyer: []};
  const headerInline = (who, at) => {
    if (!at) return;
    const t = at.seg.text.replace(/^[^:]*:\s*/, '');
    if (t && t !== at.seg.text) blocks[who].push({page, row: rows[at.i], seg: {...at.seg, text: t}});
  };
  if (sellerAt && buyerAt && sellerAt.i === buyerAt.i && rows[sellerAt.i].segments[0].bbox) {
    const split = Math.min(sellerAt.seg.bbox[0], buyerAt.seg.bbox[0]) === sellerAt.seg.bbox[0] ? buyerAt.seg.bbox[0] - 0.01 : sellerAt.seg.bbox[0] - 0.01;
    const sellerLeft = sellerAt.seg.bbox[0] < buyerAt.seg.bbox[0];
    headerInline('seller', sellerAt); headerInline('buyer', buyerAt);
    for (let i = sellerAt.i + 1; i < Math.min(rows.length, sellerAt.i + 10); i++) {
      if (stopRe.test(fold(rows[i].segments[0]?.text || ''))) break;
      const sides = {seller: [], buyer: []};
      for (const seg of rows[i].segments) sides[(seg.bbox[0] < split) === sellerLeft ? 'seller' : 'buyer'].push(seg);
      for (const [who, segs] of Object.entries(sides)) {
        if (!segs.length) continue;
        const words = segs.flatMap((x) => x.words || []);
        const bbox = [Math.min(...segs.map((x) => x.bbox[0])), Math.min(...segs.map((x) => x.bbox[1])), Math.max(...segs.map((x) => x.bbox[2])), Math.max(...segs.map((x) => x.bbox[3]))];
        blocks[who].push({page, row: rows[i], seg: {text: segs.map((x) => x.text).join(' '), words, bbox}});
      }
    }
  } else {
    const take = (who, at, endIdx) => {
      if (!at) return;
      headerInline(who, at);
      for (let i = at.i + 1; i < Math.min(rows.length, endIdx, at.i + 9); i++) {
        const f = fold(rows[i].text);
        if (stopRe.test(f) || rows[i].isTableRow) break;
        blocks[who].push({page, row: rows[i], seg: {...(rows[i].segments?.[0] || {}), text: rows[i].text, words: rows[i].words, bbox: rows[i].bbox}});
      }
    };
    const sEnd = buyerAt && sellerAt && buyerAt.i > sellerAt.i ? buyerAt.i : rows.length;
    const bEnd = sellerAt && buyerAt && sellerAt.i > buyerAt.i ? sellerAt.i : rows.length;
    take('seller', sellerAt, sEnd); take('buyer', buyerAt, bEnd);
  }
  return {blocks, found: {seller: !!sellerAt, buyer: !!buyerAt}};
}

function parseParty(items) {
  const p = {name: missing('Pavadinimas nerastas.'), companyCode: missing('Įmonės kodas nerastas.'), vatCode: missing('PVM mokėtojo kodas nerastas.'), address: missing('Adresas nerastas.'), iban: missing('Banko sąskaita nerasta.')};
  for (const it of items) {
    const t = it.seg.text.trim();
    const f = fold(t);
    const src = srcOf(it.page, it.row, it.seg);
    let m;
    if ((m = /(?:pvm\s*(?:moketojo)?\s*kodas|vat\s*(?:no|number|code|id)?)\s*:?\s*([a-z]{2}\s?[0-9a-z ]{8,14})/i.exec(f))) {
      const v = normalizeVat(t.slice(m.index + m[0].length - m[1].length, m.index + m[0].length));
      p.vatCode = field(v, src);
      if (v.startsWith('LT') && !ltVatValid(v) && p.vatCode.status === 'ok') { p.vatCode.status = 'uncertain'; p.vatCode.reason = 'PVM mokėtojo kodo kontrolinis skaitmuo nesutampa – galima atpažinimo klaida.'; }
    } else if ((m = /(?:imones\s*kodas|im\.\s*k\.|kodas|company\s*(?:code|no)|reg\.?\s*(?:no|nr|code))\s*:?\s*(\d{7,9})\b/.exec(f))) {
      p.companyCode = field(m[1], src);
    } else if ((m = /(?:adresas|address)\s*:?\s*(.+)/.exec(f))) {
      p.address = field(t.slice(m.index + m[0].length - m[1].length).trim(), src);
    } else if ((m = /\b([a-z]{2}\d{2}(?:\s?[a-z0-9]{4}){3,7}(?:\s?[a-z0-9]{1,4})?)\b/.exec(f)) && /(a\/s|a\.s\.|iban|saskaita|account|lt\d{2})/.test(f)) {
      const v = normalizeIban(m[1]);
      p.iban = field(v, src);
      if (!ibanValid(v) && p.iban.status === 'ok') { p.iban.status = 'uncertain'; p.iban.reason = 'IBAN kontrolinė suma nesutampa – galima atpažinimo klaida.'; }
    } else if (/^(bankas|bank|swift|bic|tel|el\. ?p|e-?mail|www|faks)/.test(f)) {
      // ignore
    } else if (p.name.status === 'missing' && t.length >= 2 && !/:\s*$/.test(t)) {
      p.name = field(t, src);
    }
  }
  return p;
}

// ---------------------------------------------------------------- line table
const COLS = [
  ['no', ['eil. nr.', 'eil nr', 'nr.', 'nr', 'no.', '#']],
  ['sku', ['kodas', 'prekes kodas', 'sku', 'artikulas', 'code']],
  ['description', ['prekes pavadinimas', 'paslaugos pavadinimas', 'pavadinimas', 'aprasymas', 'prekes', 'preke', 'paslauga', 'description', 'item', 'produktas']],
  ['quantity', ['kiekis', 'kiek.', 'qty', 'quantity']],
  ['unit', ['mato vnt.', 'mato vnt', 'mat. vnt.', 'mato', 'mat.vnt.', 'vnt.', 'unit']],
  ['unitPrice', ['kaina be pvm', 'vnt. kaina', 'kaina', 'unit price', 'price']],
  ['discount', ['nuolaida', 'discount']],
  ['vatRate', ['pvm %', 'pvm%', 'pvm tarifas', 'tarifas', 'vat %', 'vat%', 'pvm, %']],
  ['net', ['suma be pvm', 'suma be', 'verte be pvm', 'net amount', 'net', 'suma', 'amount', 'verte']],
  ['vat', ['pvm suma', 'pvm', 'vat amount', 'vat']],
  ['gross', ['suma su pvm', 'is viso', 'total', 'viso']],
];

function headerColumns(row) {
  // DOCX tables: cells; PDF/OCR: words with x positions.
  const tokens = row.isTableRow
    ? row.segments.map((s, i) => ({t: fold(s.text).trim(), x0: i, x1: i + 1, cell: i}))
    : (row.words || []).map((w) => ({t: fold(w.text), x0: w.bbox[0], x1: w.bbox[2]}));
  const cols = [];
  if (row.isTableRow) {
    for (const tok of tokens) {
      const hit = COLS.find(([, names]) => names.some((n) => tok.t === n || tok.t.startsWith(n + ' ') || tok.t.replace(/\s+/g, ' ') === n));
      const loose = hit || COLS.find(([, names]) => names.some((n) => tok.t.includes(n)));
      if (loose && !cols.some((c) => c.key === loose[0])) cols.push({key: loose[0], cell: tok.cell});
    }
    return cols;
  }
  let i = 0;
  while (i < tokens.length) {
    let best = null;
    for (const [key, names] of COLS) {
      for (const n of names) {
        const parts = n.split(' ');
        const slice = tokens.slice(i, i + parts.length).map((x) => x.t.replace(/[:]/g, ''));
        if (slice.length === parts.length && slice.every((s, k) => s === parts[k] || (k === parts.length - 1 && s === parts[k] + ','))) {
          if (!best || parts.length > best.len) best = {key, len: parts.length};
        }
      }
    }
    if (best && !cols.some((c) => c.key === best.key)) {
      cols.push({key: best.key, x0: tokens[i].x0, x1: tokens[i + best.len - 1].x1});
      i += best.len;
    } else i++;
  }
  return cols.sort((a, b) => a.x0 - b.x0);
}

function isHeaderRow(row) {
  const cols = headerColumns(row);
  const keys = new Set(cols.map((c) => c.key));
  const hasNum = ['quantity', 'unitPrice', 'net', 'gross'].filter((k) => keys.has(k)).length;
  return keys.has('description') && hasNum >= 2 ? cols : null;
}

const TOTAL_RE = /^(suma be pvm|is viso|viso|tarpine suma|subtotal|total|pvm\s*\d|pvm suma|pvm:|bendra suma|apmoketi|moketi|suma su pvm|suma zodziais|grand total|net total)/;

function cellsByColumn(row, cols) {
  const out = {};
  if (row.isTableRow) {
    for (const c of cols) { const s = row.segments[c.cell]; if (s && s.text) out[c.key] = {text: s.text, seg: s}; }
    return out;
  }
  const bounds = cols.map((c, i) => ({key: c.key, from: i === 0 ? -1 : c.x0 - 0.012, to: i === cols.length - 1 ? 2 : cols[i + 1].x0 - 0.012}));
  for (const seg of row.segments || []) {
    // Assign words individually so merged segments split on column boundaries.
    for (const w of seg.words || []) {
      const b = bounds.find((bb) => w.bbox[0] >= bb.from && w.bbox[0] < bb.to) || bounds[bounds.length - 1];
      const cur = out[b.key];
      if (cur) { cur.text += ' ' + w.text; cur.seg.words.push(w); cur.seg.bbox = [Math.min(cur.seg.bbox[0], w.bbox[0]), Math.min(cur.seg.bbox[1], w.bbox[1]), Math.max(cur.seg.bbox[2], w.bbox[2]), Math.max(cur.seg.bbox[3], w.bbox[3])]; }
      else out[b.key] = {text: w.text, seg: {text: w.text, words: [w], bbox: [...w.bbox]}};
    }
  }
  return out;
}

function parseLines(doc) {
  const lines = [];
  let cols = null, inTable = false, ended = false, tableFound = false;
  const notes = [];
  for (const page of doc.pages) {
    for (let i = 0; i < page.rows.length; i++) {
      const row = page.rows[i];
      const f = fold(row.text).trim();
      const hdr = isHeaderRow(row);
      if (hdr) { cols = hdr; inTable = true; ended = false; tableFound = true; continue; }
      if (!inTable || ended) continue;
      if (TOTAL_RE.test(f.replace(/^[^a-z]*/, ''))) { ended = true; continue; }
      if (/^\(?tesinys\)?$|^perkelta|^puslapis/.test(f)) continue;
      const cells = cellsByColumn(row, cols);
      const num = (k) => (cells[k] ? parseAmount(cells[k].text.replace(/%/g, '')) : null);
      const hasNumbers = ['quantity', 'unitPrice', 'net', 'gross'].some((k) => num(k) !== null);
      if (!hasNumbers) {
        // Header continuation (directly after header) or wrapped description.
        if (lines.length && cells.description && !/\d{2,}[.,]\d{2}/.test(row.text)) {
          const last = lines[lines.length - 1];
          if (last.page === page.page) { last.description.value += ' ' + cells.description.text.trim(); last.description.continued = true; }
        }
        continue;
      }
      const src = (k) => (cells[k] ? srcOf(page, row, cells[k].seg) : srcOf(page, row));
      const fnum = (k) => { const v = num(k); return v === null ? missing('Stulpelyje nėra reikšmės.') : field(v, src(k)); };
      let discount = missing('Nuolaida nenurodyta.');
      if (cells.discount) {
        const raw = cells.discount.text;
        const v = parseAmount(raw.replace('%', ''));
        if (v !== null) discount = field(v, src('discount'), raw.includes('%') ? {percent: true} : {});
      }
      const line = {
        page: page.page,
        description: cells.description ? field(cells.description.text.trim(), src('description')) : missing('Aprašymas nerastas.'),
        sku: cells.sku ? field(cells.sku.text.trim(), src('sku')) : missing('Kodas nenurodytas.'),
        quantity: fnum('quantity'),
        unit: cells.unit ? field(cells.unit.text.trim(), src('unit')) : missing('Mato vienetas nenurodytas.'),
        unitPrice: fnum('unitPrice'),
        discount,
        vatRate: fnum('vatRate'),
        net: fnum('net'),
        vat: fnum('vat'),
        gross: fnum('gross'),
        rowSource: srcOf(page, row),
      };
      // SKU embedded in description (e.g. "SKU-1001").
      if (line.sku.status === 'missing' && line.description.value) {
        const m = /\b(SKU[-\s]?[A-Z0-9-]+)\b/i.exec(line.description.value);
        if (m) line.sku = {...field(m[1].toUpperCase(), line.description.source), derived: 'Kodas rastas aprašyme.'};
      }
      lines.push(line);
    }
  }
  if (!tableFound) notes.push('Eilučių lentelė neatpažinta.');
  return {lines, notes};
}

// ---------------------------------------------------------------- totals
/** Last amount in the row after the label; never reads digits from the label itself (e.g. "PVM 21 %"). */
function lastAmount(row, labelRe) {
  const segs = row.segments || [];
  const parts = [];
  let afterLabel = !labelRe;
  for (const s of segs) {
    if (!afterLabel) {
      const m = labelRe.exec(fold(s.text).trim());
      if (m) {
        afterLabel = true;
        const rest = s.text.trim().slice(m.index + m[0].length).replace(/^[\s:]+/, '');
        if (rest) parts.push({text: rest, seg: s});
        continue;
      }
      continue;
    }
    parts.push({text: s.text, seg: s});
  }
  if (!afterLabel) return null;
  const leftover = parts.map((p) => p.text).join(' ').trim();
  for (const p of parts.slice().reverse()) {
    for (const tok of p.text.split(/\s+/).reverse()) {
      const clean = tok.replace(/(EUR|€)$/i, '');
      if (!/\d/.test(clean)) continue;
      const v = parseAmount(clean);
      if (v !== null && /[.,]\d{2}$/.test(clean)) return {value: v, seg: p.seg};
      return {value: null, seg: p.seg, raw: tok};
    }
  }
  return {value: null, seg: parts.at(-1)?.seg || segs.at(-1), raw: leftover || '(tuščia)'};
}

function parseTotals(doc) {
  const t = {net: missing('Suma be PVM nerasta.'), vat: missing('PVM suma nerasta.'), gross: missing('Bendra suma nerasta.'), vatByRate: []};
  for (const {page, row, f} of allRows(doc)) {
    const lf = f.trim();
    let m;
    const put = (key, re) => {
      const a = lastAmount(row, re);
      if (!a) return;
      const src = srcOf(page, row, a.seg);
      if (a.value === null) t[key] = {value: null, status: 'uncertain', reason: `Suma neįskaitoma („${a.raw}“).`, source: src, raw: a.raw};
      else t[key] = field(a.value, src);
    };
    const NET = /^(suma be pvm|is viso be pvm|viso be pvm|tarpine suma|subtotal|net total|apmokestinama suma)/;
    const RATE = /^(?:pvm|vat)\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*(%|4(?=\s*:))/;
    const VAT = /^(pvm suma|pvm:|pvm$|vat:|vat amount|viso pvm)/;
    const GROSS = /^(is viso su pvm|viso su pvm|suma su pvm|bendra suma|is viso moketi|moketi|apmoketi|grand total|total|is viso|viso)\b/;
    if (NET.test(lf)) put('net', NET);
    else if ((m = RATE.exec(lf))) {
      const a = lastAmount(row, RATE);
      if (a) {
        const src = srcOf(page, row, a.seg);
        const rate = m[1].replace(',', '.');
        const entry = a.value === null ? {rate, value: null, status: 'uncertain', reason: `PVM suma neįskaitoma („${a.raw}“).`, source: src, raw: a.raw} : {rate, ...field(a.value, src)};
        if (m[2] === '4') { entry.rateUncertain = 'Procento ženklas atpažintas kaip „4“ – tarifas nustatytas pagal kontekstą.'; }
        t.vatByRate.push(entry);
      }
    } else if (VAT.test(lf)) put('vat', VAT);
    else if (GROSS.test(lf) && !/be pvm/.test(lf)) {
      if (t.gross.status !== 'ok' || /su pvm|moketi/.test(lf)) put('gross', GROSS);
    }
  }
  if (t.vat.status === 'missing' && t.vatByRate.length) {
    const ok = t.vatByRate.every((r) => r.value !== null);
    if (ok) t.vat = {value: money.sum(t.vatByRate.map((r) => r.value)), status: t.vatByRate.some((r) => r.status !== 'ok') ? 'uncertain' : 'ok', source: t.vatByRate[0].source, derived: 'Sudėta iš PVM eilučių pagal tarifus.', reason: t.vatByRate.find((r) => r.reason)?.reason};
    else t.vat = {value: null, status: 'uncertain', source: t.vatByRate.find((r) => r.value === null).source, reason: t.vatByRate.find((r) => r.value === null).reason};
  }
  return t;
}

// ---------------------------------------------------------------- misc labels
function labelField(doc, re, transform = (x) => x, {pageLimit = 99} = {}) {
  for (const {page, row} of allRows(doc)) {
    if (page.page > pageLimit) break;
    const v = valueAfter(row, re);
    if (v) {
      const val = transform(v.text);
      if (val !== null && val !== '') return field(val, srcOf(page, row, v.seg));
    }
  }
  return null;
}

function currencyField(doc) {
  const found = new Map();
  for (const {page, row} of allRows(doc)) {
    const re = /\b(EUR|USD|GBP|PLN|SEK|NOK|DKK|CHF)\b|€|\$|£/g;
    let m;
    while ((m = re.exec(row.text))) {
      const c = m[1] || {'€': 'EUR', $: 'USD', '£': 'GBP'}[m[0]];
      if (!found.has(c)) found.set(c, srcOf(page, row));
    }
  }
  if (found.size === 1) { const [[c, s]] = [...found]; return field(c, s); }
  if (found.size > 1) return {value: [...found.keys()][0], status: 'conflict', reason: `Dokumente rastos kelios valiutos: ${[...found.keys()].join(', ')}.`, source: [...found.values()][0]};
  return missing('Valiuta dokumente nenurodyta.');
}

function splitHint(doc) {
  if (doc.pages.length < 2) return null;
  const starts = [];
  const first = findNumber(doc.pages[0]);
  for (const page of doc.pages) {
    const title = detectTitle(page);
    const num = findNumber(page);
    if (page.page === 1) { starts.push({page: 1, number: num ? `${num.series} ${num.number}`.trim() : null}); continue; }
    if (title && num && first && `${num.series}${num.number}` !== `${first.series}${first.number}`) starts.push({page: page.page, number: `${num.series} ${num.number}`.trim()});
  }
  if (starts.length < 2) return null;
  const ranges = starts.map((s, i) => ({from: s.page, to: i + 1 < starts.length ? starts[i + 1].page - 1 : doc.pages.length, number: s.number}));
  return {reason: `Faile panašu į ${ranges.length} skirtingus dokumentus (${ranges.map((r) => r.number).join(', ')}). Padalinkite failą prieš registruojant.`, ranges};
}

export function parseInvoice(doc) {
  const page1 = doc.pages[0];
  const title = detectTitle(page1);
  const docType = title ? field(title.type, srcOf(page1, title.row)) : missing('Dokumento tipas neatpažintas (nerasta antraštė).');
  const num = findNumber(page1);
  const due = labelField(doc, /(apmoketi iki|apmokejimo terminas|mokejimo terminas|apmoketi|due date|payment due|terminas)/, parseDate, {pageLimit: 1});
  const issue = (() => {
    for (const {page, row, f} of allRows(doc)) {
      if (page.page > 1) break;
      if (/apmoketi|terminas|due|galioja|pristatymo/.test(f)) continue;
      const v = valueAfter(row, /(saskaitos data|israsymo data|dokumento data|invoice date|date of issue|data|date)/);
      const d = v && parseDate(v.text);
      if (d) return field(d, srcOf(page, row, v.seg));
    }
    return null;
  })();
  const {blocks, found} = partyBlocks(doc);
  const lineResult = parseLines(doc);
  const out = {
    provider: PROVIDER,
    docType,
    series: num ? field(num.series, srcOf(num.page, num.row)) : missing('Serija nerasta.'),
    number: num ? field(num.number, srcOf(num.page, num.row)) : missing('Dokumento numeris nerastas.'),
    issueDate: issue || missing('Išrašymo data nerasta.'),
    dueDate: due || missing('Apmokėjimo terminas nenurodytas.'),
    currency: currencyField(doc),
    seller: found.seller ? parseParty(blocks.seller) : null,
    buyer: found.buyer ? parseParty(blocks.buyer) : null,
    paymentReference: labelField(doc, /(mokejimo paskirtis|imokos kodas|payment reference|reference)/) || missing('Mokėjimo paskirtis nenurodyta.'),
    orderReference: labelField(doc, /(uzsakymo nr\.?|uzsakymas|order no\.?|order number|po number|pirkimo uzsakymas)/) || missing('Užsakymo numeris nenurodytas.'),
    relatedDocument: labelField(doc, /(koreguojama saskaita|kredituojama saskaita|pagal saskaita|originali saskaita|original invoice|koreguojamas dokumentas)/) || missing('Susijęs dokumentas nenurodytas.'),
    lines: lineResult.lines,
    totals: parseTotals(doc),
    splitHint: splitHint(doc),
    notes: lineResult.notes,
    pages: doc.pages.map((p) => ({page: p.page, method: p.method, ocr: p.ocr || null})),
  };
  if (!found.seller) out.notes.push('Pardavėjo blokas nerastas.');
  if (!found.buyer) out.notes.push('Pirkėjo blokas nerastas.');
  return out;
}

export function toUnitsSafe(v) { try { return toUnits(v); } catch { return null; } }
