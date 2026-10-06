// Bank statement adapters. Each returns a normalized statement:
// {format, iban, currency, statementRef, periodFrom, periodTo, opening, closing, rows:[Row], issues:[]}
// Row = {rowNo, bookingDate, valueDate, amount (signed: + incoming, − outgoing), currency, counterpartyName,
//        counterpartyIban, counterpartyCode, reference, description, bankTxId, endToEndId, source, issue?}
import {XMLParser} from 'fast-xml-parser';
import ExcelJS from 'exceljs';
import {parseAmount, money} from '../lib/money.mjs';
import {parseDate} from '../extraction/invoice-parser.mjs';
import {fold, normalizeIban, ibanValid} from '../extraction/ids.mjs';

export const FORMATS = {
  csv: 'CSV: bet kokie stulpeliai su susiejimu; skyrikliai ; , tab; datos YYYY-MM-DD, DD.MM.YYYY; sumos 1234,56 / 1 234.56; viena sumos kolona su ženklu arba atskiri debeto/kredito stulpeliai arba D/C požymis.',
  xlsx: 'XLSX: pirmas lapas, antraščių eilutė aptinkama automatiškai; tas pats susiejimas kaip CSV.',
  camt053: 'ISO 20022 camt.053.001.02–.08: vienas <Stmt> faile; Bal OPBD/PRCD (pradinis) ir CLBD (galutinis); tik BOOK būsenos įrašai; operacijos ID – AcctSvcrRef, NtryRef arba TxDtls/Refs/AcctSvcrRef.',
  mt940: 'SWIFT MT940: :25: sąskaita, :28C:, :60F/M: pradinis, :61: operacijos (banko nuoroda po //), :86: informacija, :62F/M: galutinis. Vienas pranešimas faile.',
  pdf: 'PDF/nuotrauka (atsarginis): eilutės, prasidedančios data ir besibaigiančios suma; likučiai pagal „Pradinis/Galutinis likutis“. Visada reikia peržiūros.',
};

// ------------------------------------------------------------------ CSV / XLSX
const HEADER_HINTS = {
  date: ['data', 'operacijos data', 'booking date', 'date', 'buhalterinė data', 'įrašo data', 'transaction date'],
  valueDate: ['valiutavimo data', 'value date'],
  amount: ['suma', 'amount', 'suma eur', 'operacijos suma'],
  debit: ['debetas', 'debit', 'išlaidos', 'nurašyta'],
  credit: ['kreditas', 'credit', 'pajamos', 'įskaityta'],
  direction: ['d/k', 'd/c', 'kryptis', 'debit/credit', 'cdtdbtind'],
  counterparty: ['gavėjas/mokėtojas', 'mokėtojas / gavėjas', 'mokėtojas/gavėjas', 'gavėjas', 'mokėtojas', 'counterparty', 'partneris', 'beneficiary', 'payer', 'kontrahentas'],
  iban: ['sąskaita', 'iban', 'gavėjo sąskaita', 'mokėtojo sąskaita', 'account', 'kontrahento sąskaita'],
  reference: ['paskirtis', 'mokėjimo paskirtis', 'details', 'description', 'reference', 'aprašymas', 'informacija'],
  code: ['įmokos kodas', 'kodas', 'payment code'],
  txId: ['operacijos id', 'transaction id', 'id', 'dokumento nr.', 'archyvinis kodas', 'nuoroda', 'operacijos nr.'],
  currency: ['valiuta', 'currency'],
};

export function guessMapping(headers) {
  const h = headers.map((x) => fold(String(x || '').trim()));
  const map = {};
  for (const [key, hints] of Object.entries(HEADER_HINTS)) {
    const fh = hints.map(fold);
    let idx = h.findIndex((x) => fh.includes(x));
    if (idx < 0) idx = h.findIndex((x) => x && fh.some((n) => x.startsWith(n)));
    if (idx >= 0 && !Object.values(map).includes(idx)) map[key] = idx;
  }
  return map;
}

function splitCsvLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export function readCsvTable(buf) {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = new TextDecoder('windows-1257').decode(buf); // Baltic legacy exports
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const first = lines[0] || '';
  const delim = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  return lines.map((l) => splitCsvLine(l, delim));
}

export async function readXlsxTable(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow({includeEmpty: false}, (row) => {
    const vals = [];
    for (let c = 1; c <= row.cellCount; c++) {
      const v = row.getCell(c).value;
      if (v instanceof Date) vals.push(v.toISOString().slice(0, 10));
      else if (v && typeof v === 'object' && 'result' in v) vals.push(String(v.result ?? ''));
      else if (v && typeof v === 'object' && 'richText' in v) vals.push(v.richText.map((t) => t.text).join(''));
      else if (typeof v === 'number') vals.push(String(v));
      else vals.push(v === null || v === undefined ? '' : String(v));
    }
    rows.push(vals);
  });
  return rows;
}

function findHeaderRow(table) {
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const m = guessMapping(table[i]);
    if ((m.date !== undefined) && (m.amount !== undefined || m.debit !== undefined || m.credit !== undefined)) return i;
  }
  return 0;
}

/** Parse tabular statements with an explicit or guessed mapping (column indexes). */
export function parseTable(table, {mapping = null, format = 'csv', iban = '', currency = 'EUR', opening = null, closing = null} = {}) {
  const headerRow = findHeaderRow(table);
  const headers = table[headerRow] || [];
  const map = mapping || guessMapping(headers);
  const issues = [];
  if (map.date === undefined) issues.push({level: 'error', message: 'Nenurodytas datos stulpelis.'});
  if (map.amount === undefined && map.debit === undefined && map.credit === undefined) issues.push({level: 'error', message: 'Nenurodytas sumos stulpelis (arba debeto/kredito stulpeliai).'});
  const rows = [];
  for (let i = headerRow + 1; i < table.length; i++) {
    const r = table[i];
    if (!r.some((x) => String(x).trim())) continue;
    const get = (k) => (map[k] !== undefined ? String(r[map[k]] ?? '').trim() : '');
    const row = {rowNo: i + 1, source: {kind: format, row: i + 1, raw: r.slice(0, 20)}};
    row.bookingDate = parseDate(get('date'));
    row.valueDate = parseDate(get('valueDate')) || null;
    let amount = null;
    if (map.amount !== undefined) {
      amount = parseAmount(get('amount'));
      const dir = fold(get('direction'));
      if (amount !== null && dir) { const abs = money.abs(amount); amount = /^(d|db|dbit|debit|debetas|-)/.test(dir) ? money.neg(abs) : abs; }
    } else {
      const d = parseAmount(get('debit')), c = parseAmount(get('credit'));
      if (d && !money.isZero(d)) amount = money.neg(money.abs(d)); else if (c && !money.isZero(c)) amount = money.abs(c);
    }
    row.amount = amount === null ? null : money.norm(amount);
    row.currency = (get('currency') || currency || 'EUR').toUpperCase();
    row.counterpartyName = get('counterparty');
    const ib = normalizeIban(get('iban'));
    row.counterpartyIban = ib && ibanValid(ib) ? ib : '';
    if (ib && !row.counterpartyIban) row.counterpartyRaw = ib;
    row.reference = [get('reference'), get('code')].filter(Boolean).join(' ').trim();
    row.description = row.reference;
    row.bankTxId = get('txId') || null;
    row.endToEndId = '';
    if (!row.bookingDate) row.issue = `Neatpažinta data „${get('date')}“.`;
    else if (row.amount === null) row.issue = `Neatpažinta suma „${get('amount') || get('debit') || get('credit')}“.`;
    else if (money.isZero(row.amount)) row.issue = 'Nulinė suma.';
    rows.push(row);
  }
  const dates = rows.map((x) => x.bookingDate).filter(Boolean).sort();
  return {format, iban, currency, statementRef: '', periodFrom: dates[0] || null, periodTo: dates.at(-1) || null, opening, closing, rows, issues, headers, mapping: map, headerRow};
}

// ------------------------------------------------------------------ CAMT.053
const arr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => (x === undefined || x === null ? '' : typeof x === 'object' ? String(x['#text'] ?? '') : String(x));

export function parseCamt053(buf) {
  const parser = new XMLParser({ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, attributeNamePrefix: '@'});
  const doc = parser.parse(buf.toString('utf8'));
  const root = doc.Document?.BkToCstmrStmt;
  if (!root) throw Object.assign(new Error('Tai ne camt.053 dokumentas (nerasta BkToCstmrStmt).'), {status: 422});
  const stmts = arr(root.Stmt);
  if (stmts.length !== 1) throw Object.assign(new Error(`Faile ${stmts.length} išrašai – palaikomas vienas išrašas viename faile.`), {status: 422});
  const s = stmts[0];
  const issues = [];
  const iban = normalizeIban(txt(s.Acct?.Id?.IBAN));
  const currency = txt(s.Acct?.Ccy) || 'EUR';
  const bal = (codes) => {
    const b = arr(s.Bal).find((x) => codes.includes(txt(x.Tp?.CdOrPrtry?.Cd)));
    if (!b) return null;
    const v = money.norm(txt(b.Amt));
    return txt(b.CdtDbtInd) === 'DBIT' ? money.neg(v) : v;
  };
  const rows = [];
  arr(s.Ntry).forEach((n, i) => {
    const status = txt(n.Sts?.Cd) || txt(n.Sts);
    if (status && status !== 'BOOK') { issues.push({level: 'warning', message: `Įrašas ${i + 1} būsenos ${status} – praleistas (importuojami tik BOOK).`}); return; }
    const amt = money.norm(txt(n.Amt));
    const sign = txt(n.CdtDbtInd) === 'DBIT' ? -1 : 1;
    const txs = arr(n.NtryDtls?.TxDtls ?? arr(n.NtryDtls).flatMap((d) => arr(d.TxDtls)));
    const t = txs[0] || {};
    const incoming = sign > 0;
    const party = incoming ? t.RltdPties?.Dbtr : t.RltdPties?.Cdtr;
    const partyAcct = incoming ? t.RltdPties?.DbtrAcct : t.RltdPties?.CdtrAcct;
    const name = txt(party?.Nm) || txt(party?.Pty?.Nm);
    const ib = normalizeIban(txt(partyAcct?.Id?.IBAN));
    const refs = arr(t.RmtInf?.Ustrd).map(txt);
    const strd = arr(t.RmtInf?.Strd).map((x) => txt(x?.CdtrRefInf?.Ref)).filter(Boolean);
    const bankTxId = txt(n.AcctSvcrRef) || txt(t.Refs?.AcctSvcrRef) || txt(n.NtryRef) || null;
    rows.push({
      rowNo: i + 1, source: {kind: 'camt053', entry: i + 1, path: `Stmt/Ntry[${i + 1}]`},
      bookingDate: (txt(n.BookgDt?.Dt) || txt(n.BookgDt?.DtTm)).slice(0, 10) || null, valueDate: (txt(n.ValDt?.Dt) || txt(n.ValDt?.DtTm)).slice(0, 10) || null,
      amount: sign < 0 ? money.neg(amt) : amt, currency: n.Amt?.['@Ccy'] || currency,
      counterpartyName: name, counterpartyIban: ib, counterpartyCode: txt(party?.Id?.OrgId?.Othr?.Id) || txt(party?.Pty?.Id?.OrgId?.Othr?.Id),
      reference: [...refs, ...strd].join(' ').trim(), description: txt(n.AddtlNtryInf) || refs.join(' '),
      bankTxId, endToEndId: txt(t.Refs?.EndToEndId) === 'NOTPROVIDED' ? '' : txt(t.Refs?.EndToEndId),
      ...(txs.length > 1 ? {issue: null, batch: txs.length} : {}),
    });
    if (txs.length > 1) issues.push({level: 'warning', message: `Įrašas ${i + 1} yra paketinis (${txs.length} operacijos) – importuojamas kaip viena operacija.`});
  });
  return {format: 'camt053', iban, currency, statementRef: txt(s.Id), sequence: txt(s.ElctrncSeqNb),
    periodFrom: txt(s.FrToDt?.FrDtTm).slice(0, 10) || null, periodTo: txt(s.FrToDt?.ToDtTm).slice(0, 10) || null,
    opening: bal(['OPBD', 'PRCD']), closing: bal(['CLBD']), rows, issues};
}

// ------------------------------------------------------------------ MT940
export function parseMt940(buf) {
  const text = buf.toString('utf8').replace(/\r/g, '');
  const msgs = text.split(/^-\s*$/m).filter((m) => /:20:/.test(m));
  if (msgs.length !== 1) throw Object.assign(new Error(`Faile ${msgs.length} MT940 pranešimai – palaikomas vienas.`), {status: 422});
  const fields = [];
  for (const line of msgs[0].split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) fields.push({tag: m[1], value: m[2]}); else if (fields.length && line.trim()) fields.at(-1).value += '\n' + line;
  }
  const get = (t) => fields.find((f) => f.tag === t)?.value || '';
  const balance = (v) => { const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/.exec(v); if (!m) return null; const a = money.norm(m[4].replace(',', '.')); return {amount: m[1] === 'D' ? money.neg(a) : a, date: `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`, currency: m[3]}; };
  const open = balance(get('60F') || get('60M')), close = balance(get('62F') || get('62M'));
  const rows = [];
  const issues = [];
  fields.forEach((f, i) => {
    if (f.tag !== '61') return;
    const m = /^(\d{6})(\d{4})?(R?[CD])([A-Z])?([\d,]+)([A-Z][A-Z0-9]{3})([^/\n]*)(?:\/\/([^\n]*))?/.exec(f.value);
    if (!m) { issues.push({level: 'error', message: `Neatpažinta :61: eilutė: ${f.value.slice(0, 60)}`}); return; }
    const info = fields[i + 1]?.tag === '86' ? fields[i + 1].value.replace(/\n/g, ' ') : '';
    const ib = (/\b([A-Z]{2}\d{2}[A-Z0-9]{12,30})\b/.exec(info) || [])[1] || '';
    const name = ib ? info.slice(0, info.indexOf(ib)).trim() : '';
    const a = money.norm(m[5].replace(',', '.'));
    const debit = m[3] === 'D' || m[3] === 'RC';
    const d = `20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`;
    rows.push({rowNo: rows.length + 1, source: {kind: 'mt940', field: `:61: #${rows.length + 1}`, raw: f.value.slice(0, 120)}, bookingDate: m[2] ? `${d.slice(0, 5)}${m[2].slice(0, 2)}-${m[2].slice(2, 4)}` : d, valueDate: d,
      amount: debit ? money.neg(a) : a, currency: open?.currency || 'EUR', counterpartyName: name, counterpartyIban: ibanValid(ib) ? ib : '', reference: ib ? info.slice(info.indexOf(ib) + ib.length).trim() : info, description: info,
      bankTxId: (m[8] || '').trim() || (m[7] && m[7] !== 'NONREF' ? m[7].trim() : null), endToEndId: ''});
  });
  const acct = get('25').trim();
  return {format: 'mt940', iban: normalizeIban(acct.split('/').pop()), currency: open?.currency || 'EUR', statementRef: `${get('20').trim()}/${get('28C').trim()}`,
    periodFrom: open?.date || rows[0]?.bookingDate || null, periodTo: close?.date || rows.at(-1)?.bookingDate || null, opening: open?.amount ?? null, closing: close?.amount ?? null, rows, issues};
}

// ------------------------------------------------------------------ PDF / OCR fallback
export function parseStatementText(textDoc) {
  const rows = [];
  const issues = [{level: 'warning', message: 'Išrašas atpažintas iš PDF/vaizdo – patikrinkite kiekvieną eilutę prieš tvirtinant.'}];
  let iban = '', opening = null, closing = null, periodFrom = null, periodTo = null;
  for (const page of textDoc.pages) {
    for (const r of page.rows) {
      const f = fold(r.text);
      const ib = /\b(LT\d{2}\s?(?:\d{4}\s?){4})\b/.exec(r.text);
      if (!iban && ib && /saskait|account|iban/.test(f)) iban = normalizeIban(ib[1]);
      const lastAmt = () => { const toks = r.text.split(/\s+/).reverse(); for (const t of toks) { const v = parseAmount(t); if (v !== null && /[.,]\d{2}$/.test(t)) return money.norm(v); } return null; };
      if (/pradinis likutis|opening balance/.test(f)) { opening = lastAmt(); continue; }
      if (/galutinis likutis|closing balance/.test(f)) { closing = lastAmt(); continue; }
      const per = /(\d{4}-\d{2}-\d{2})\s*[–-]\s*(\d{4}-\d{2}-\d{2})/.exec(r.text);
      if (per && /laikotarp|period/.test(f)) { periodFrom = per[1]; periodTo = per[2]; continue; }
      const segs = r.segments || [];
      const d = parseDate(segs[0]?.text || '');
      const amt = segs.length >= 2 ? parseAmount(segs.at(-1).text) : null;
      if (d && amt !== null && /^\s*\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}/.test(segs[0].text)) {
        rows.push({rowNo: rows.length + 1, source: {kind: page.method, page: page.page, bbox: r.bbox, text: r.text}, bookingDate: d, valueDate: null, amount: money.norm(amt), currency: 'EUR',
          counterpartyName: segs.length > 2 ? segs[1].text : '', counterpartyIban: '', reference: segs.length > 3 ? segs.slice(2, -1).map((x) => x.text).join(' ') : '', description: r.text, bankTxId: null, endToEndId: '',
          ...(segs.some((x) => (x.words || []).some((w) => w.conf !== undefined && w.conf < 70)) ? {issue: 'OCR nepatikimas – patikrinkite eilutę.'} : {})});
      }
    }
  }
  return {format: 'pdf', iban, currency: 'EUR', statementRef: '', periodFrom: periodFrom || rows[0]?.bookingDate || null, periodTo: periodTo || rows.at(-1)?.bookingDate || null, opening, closing, rows, issues, needsReview: true};
}
