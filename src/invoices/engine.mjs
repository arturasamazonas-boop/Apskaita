// Proposal construction, deterministic recomputation, validation and journal entries.
// Pure functions: the service layer supplies context (company, rules, duplicates ...).
import crypto from 'node:crypto';
import {money, toUnits, qty as normQty, divRound, fromUnits} from '../lib/money.mjs';
import {normalizeVat, normalizeName, numberKey, ltVatValid} from '../extraction/ids.mjs';
import {classifyLine} from './classify.mjs';

export const DOC_TYPES = ['vat_invoice', 'invoice', 'credit_note', 'debit_note', 'proforma', 'contract', 'receipt', 'unknown'];
export const POSTABLE = ['vat_invoice', 'invoice', 'credit_note', 'debit_note'];
export const LINE_TYPES = ['expense', 'inventory', 'service', 'asset', 'prepaid', 'revenue_goods', 'revenue_services', 'other'];
export const VAT_TREATMENTS = ['deductible', 'non_deductible', 'review', 'output'];

const isAmount = (v) => typeof v === 'string' && /^-?\d+(\.\d{1,4})?$/.test(v);

/** Stable hash of proposal content (key order independent). Approval must quote it. */
export function contentHash(data) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return crypto.createHash('sha256').update(JSON.stringify(canon(data))).digest('hex');
}

export function taxCodeFor(rate, date, register, taxCodes) {
  if (rate === null || rate === undefined || rate === '') return null;
  const r = Number(rate);
  const candidates = taxCodes.filter((t) => t.active && t.rate !== null && Number(t.rate) === r && t.effective_from <= date && (!t.effective_to || t.effective_to >= date) && (t.applies_to === 'both' || t.applies_to === register));
  if (r === 0) return null; // 0 % needs an explicit reason code (export, EU supply, exempt ...)
  // Prefer the general domestic code (PVM1/2/3/58) over special-scheme codes.
  const order = ['PVM1', 'PVM2', 'PVM3', 'PVM58'];
  candidates.sort((a, b) => (order.indexOf(a.code) + 100) % 100 - (order.indexOf(b.code) + 100) % 100);
  return candidates[0]?.code || null;
}

function fv(f) { return f && f.value !== undefined && f.value !== null ? f.value : ''; }

/** Build editable proposal data from an extraction. */
export function proposalFromExtraction(ex, ctx) {
  const {company} = ctx;
  const provenance = {};
  const prov = (path, f) => { if (f) provenance[path] = {source: f.source || null, status: f.status, reason: f.reason || null, extractedValue: f.value ?? null, providerScore: f.providerScore || null, derived: f.derived || null}; };
  // Register from identity.
  const ours = (p) => {
    if (!p) return false;
    const code = fv(p.companyCode), vat = normalizeVat(fv(p.vatCode));
    if (company.company_code && code === company.company_code) return true;
    if (company.vat_code && vat && vat === normalizeVat(company.vat_code)) return true;
    return !!(company.name && fv(p.name) && normalizeName(fv(p.name)) === normalizeName(company.name) && !code && !vat);
  };
  const sellerOurs = ours(ex.seller), buyerOurs = ours(ex.buyer);
  let register = null, registerReason;
  if (sellerOurs && !buyerOurs) { register = 'sales'; registerReason = 'Pardavėjas yra jūsų įmonė (sutampa kodas / PVM kodas) – pardavimų registras.'; }
  else if (buyerOurs && !sellerOurs) { register = 'purchase'; registerReason = 'Pirkėjas yra jūsų įmonė (sutampa kodas / PVM kodas) – pirkimų registras.'; }
  else if (sellerOurs && buyerOurs) registerReason = 'Ir pardavėjas, ir pirkėjas atitinka jūsų įmonę – pasirinkite registrą.';
  else registerReason = 'Nei pardavėjas, nei pirkėjas neatitinka jūsų įmonės rekvizitų – pasirinkite registrą arba patikrinkite įmonės nustatymus.';
  const party = register === 'sales' ? ex.buyer : ex.seller;
  const prefix = 'counterparty';
  if (party) for (const k of ['name', 'companyCode', 'vatCode', 'address', 'iban']) prov(`${prefix}.${k}`, party[k]);
  for (const k of ['docType', 'series', 'number', 'issueDate', 'dueDate', 'currency', 'paymentReference', 'orderReference', 'relatedDocument']) prov(k, ex[k]);
  prov('sourceTotals.net', ex.totals.net); prov('sourceTotals.vat', ex.totals.vat); prov('sourceTotals.gross', ex.totals.gross);
  ex.totals.vatByRate.forEach((r, i) => prov(`sourceTotals.vatByRate.${i}.amount`, r));
  const singleRate = ex.totals.vatByRate.length === 1 ? ex.totals.vatByRate[0].rate : null;
  const issueDate = fv(ex.issueDate) || '';
  const docType = fv(ex.docType) || 'unknown';
  const counterparty = {id: null, name: fv(party?.name), companyCode: fv(party?.companyCode), vatCode: fv(party?.vatCode), address: fv(party?.address), country: guessCountry(fv(party?.vatCode)), iban: fv(party?.iban)};
  const known = ctx.findCounterparty ? ctx.findCounterparty(counterparty) : null;
  if (known) counterparty.id = String(known.id);
  let currency = fv(ex.currency);
  if (!currency) {
    currency = company.currency || 'EUR';
    provenance.currency = {...(provenance.currency || {}), status: 'defaulted', reason: 'Valiuta dokumente nenurodyta – taikoma įmonės apskaitos valiuta EUR. Patikrinkite.'};
  }
  const lines = ex.lines.map((l, i) => {
    for (const k of ['description', 'sku', 'quantity', 'unit', 'unitPrice', 'discount', 'vatRate', 'net']) prov(`lines.${i}.${k}`, l[k]);
    let vatRate = fv(l.vatRate);
    if (!vatRate && singleRate) { vatRate = singleRate; provenance[`lines.${i}.vatRate`] = {...provenance[`lines.${i}.vatRate`], status: 'ok', derived: `Tarifas paimtas iš sumų eilutės „PVM ${singleRate} %“.`, source: ex.totals.vatByRate[0].source}; }
    let discount = fv(l.discount) || '0';
    if (l.discount?.percent && isAmount(fv(l.quantity)) && isAmount(fv(l.unitPrice))) {
      const base = money.lineNet(fv(l.quantity), fv(l.unitPrice));
      discount = fromUnits(divRound(toUnits(base) * toUnits(discount), 10000n));
      provenance[`lines.${i}.discount`] = {...provenance[`lines.${i}.discount`], derived: `Nuolaida ${fv(l.discount)} % perskaičiuota į sumą.`};
    }
    let quantity = fv(l.quantity), unitPrice = fv(l.unitPrice), net = fv(l.net);
    if (!quantity && net) { quantity = '1'; provenance[`lines.${i}.quantity`] = {status: 'defaulted', reason: 'Kiekis nenurodytas – laikoma 1.'}; }
    if (!unitPrice && net && quantity) unitPrice = fromUnits(divRound(toUnits(net, 4) * 10000n, toUnits(quantity, 4)), 4);
    return {description: fv(l.description), sku: fv(l.sku), quantity, unit: fv(l.unit), unitPrice, discount, sourceNet: net, vatRate, taxCode: '', accountCode: '', lineType: '', vatTreatment: '', productId: null, suggestion: null, sourceRef: l.rowSource || null};
  });
  const data = {
    docType, register, registerReason,
    series: fv(ex.series), number: fv(ex.number), issueDate, dueDate: fv(ex.dueDate), vatPointDate: '', currency,
    counterparty,
    paymentReference: fv(ex.paymentReference), orderReference: fv(ex.orderReference), relatedDocument: fv(ex.relatedDocument), relatedInvoiceId: null,
    lines,
    sourceTotals: {net: fv(ex.totals.net), vat: fv(ex.totals.vat), gross: fv(ex.totals.gross), vatByRate: ex.totals.vatByRate.map((r) => ({rate: r.rate, amount: r.value ?? ''}))},
    acknowledgements: {},
    confirmations: {},
    provenance,
    splitHint: ex.splitHint || null,
    extractionNotes: ex.notes || [],
  };
  return applyClassification(data, ctx);
}

function guessCountry(vat) { const m = /^([A-Z]{2})/.exec(String(vat || '').toUpperCase()); return m ? (m[1] === 'EL' ? 'GR' : m[1]) : 'LT'; }

/** (Re)apply tax codes and classification suggestions to lines lacking a user choice. */
export function applyClassification(data, ctx, {force = false} = {}) {
  if (!data.register) return data;
  const cctx = {...ctx, register: data.register, issueDate: data.issueDate || ctx.today, docType: data.docType, counterparty: data.counterparty, counterpartyId: data.counterparty?.id};
  data.lines = data.lines.map((l) => {
    const line = {...l};
    if (!line.taxCode || force) {
      const code = taxCodeFor(line.vatRate, data.issueDate || ctx.today, data.register, ctx.taxCodes);
      if (code) line.taxCode = code;
      else if (data.register === 'purchase' && (line.vatRate === '' || line.vatRate === null) && data.docType === 'invoice') line.taxCode = 'BE_PVM';
    }
    if (!line.userClassified || force) {
      const c = classifyLine({...line, net: line.sourceNet || safeNet(line)}, cctx);
      line.accountCode = c.accountCode; line.lineType = c.lineType; line.vatTreatment = c.vatTreatment;
      line.suggestion = {...c.suggestion, vatRule: c.vatRuleId || null, vatExplanation: c.vatExplanation || ''};
      if (c.productId && !line.productId) line.productId = c.productId;
    }
    return line;
  });
  return data;
}

function safeNet(l) { try { return money.lineNet(l.quantity, l.unitPrice, l.discount || '0'); } catch { return '0'; } }

const VAT_TOLERANCE_PER_LINE = 1n; // 0.01 EUR per line: per-line rounding on the source document.

/**
 * Deterministic server-side computation and validation.
 * ctx: {company, roles, accounts:Map, taxCodes, today, duplicates:{posted:[], open:[], near:[]}, relatedInvoice}
 */
export function computeProposal(data, ctx) {
  const issues = [];
  const err = (field, code, message) => issues.push({level: 'error', field, code, message});
  const warn = (field, code, message) => issues.push({level: 'warning', field, code, message});
  const info = (field, code, message) => issues.push({level: 'info', field, code, message});
  const ack = data.acknowledgements || {};
  const conf = data.confirmations || {};
  const {company, roles} = ctx;

  // Document type and register.
  if (!DOC_TYPES.includes(data.docType)) err('docType', 'doc_type', 'Nežinomas dokumento tipas.');
  else if (data.docType === 'proforma') err('docType', 'proforma', 'Išankstinė sąskaita (proforma) nėra mokesčių sąskaita faktūra ir neregistruojama. Laikykite ją dokumentų saugykloje; apmokėjimą registruokite kaip avansą.');
  else if (data.docType === 'contract') err('docType', 'contract', 'Sutartis nėra apskaitos dokumentas – jos vertė neregistruojama. Perkelkite į dokumentų saugyklą.');
  else if (data.docType === 'receipt') err('docType', 'receipt', 'Kasos kvitai automatiškai neregistruojami – įveskite rankiniu būdu kaip pirkimą arba laikykite saugykloje.');
  else if (data.docType === 'unknown') err('docType', 'doc_type_unknown', 'Dokumento tipas neatpažintas – pasirinkite tipą.');
  if (!['purchase', 'sales'].includes(data.register)) err('register', 'register', data.registerReason || 'Pasirinkite registrą (pirkimai ar pardavimai).');
  if (data.splitHint && !ack.splitReviewed) err('splitHint', 'split', data.splitHint.reason);

  // Field-level extraction status: uncertain/conflicting values must be corrected or confirmed.
  for (const [path, p] of Object.entries(data.provenance || {})) {
    if (!p || p.corrected || conf[path]) continue;
    if (p.status === 'uncertain' || p.status === 'conflict') {
      if (path.startsWith('lines.') && !data.lines[Number(path.split('.')[1])]) continue;
      err(path, 'uncertain_field', `${p.reason || 'Reikšmė neaiški.'} Pataisykite arba patvirtinkite reikšmę.`);
    }
    if (p.status === 'defaulted' && path === 'currency') warn(path, 'currency_default', p.reason);
  }

  // Required fields.
  if (!data.number && !data.issueHere) err('number', 'required', 'Nenurodytas dokumento numeris.');
  if (data.issueHere && !data.seriesCode) err('seriesCode', 'required', 'Pasirinkite dokumentų seriją.');
  if (!data.issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(data.issueDate)) err('issueDate', 'required', 'Nenurodyta arba netinkama išrašymo data.');
  if (!data.counterparty?.name) err('counterparty.name', 'required', data.register === 'sales' ? 'Nenurodytas pirkėjas.' : 'Nenurodytas tiekėjas.');
  const cpVat = normalizeVat(data.counterparty?.vatCode);
  if (cpVat && cpVat.startsWith('LT') && !ltVatValid(cpVat) && !conf['counterparty.vatCode']) err('counterparty.vatCode', 'vat_checksum', `PVM mokėtojo kodas ${cpVat} netinkamas (kontrolinis skaitmuo). Pataisykite arba patvirtinkite.`);
  if (data.register === 'purchase' && data.docType === 'vat_invoice' && !cpVat) warn('counterparty.vatCode', 'missing_vat', 'PVM sąskaitoje nenurodytas tiekėjo PVM mokėtojo kodas.');
  if (data.register === 'sales' && data.docType === 'vat_invoice' && !company.vat_registered) err('docType', 'not_vat_payer', 'Įmonė nėra PVM mokėtoja – negali išrašyti PVM sąskaitos faktūros.');

  // Currency.
  if (!data.currency) err('currency', 'required', 'Nenurodyta valiuta.');
  else if (data.currency !== 'EUR') err('currency', 'currency', `Valiuta ${data.currency} automatiškai nepalaikoma (reikia kurso ir perskaičiavimo). Registruokite rankiniu būdu su buhalteriu.`);
  else if (data.provenance?.currency?.status === 'defaulted' && !conf.currency && data.counterparty?.country && data.counterparty.country !== 'LT') err('currency', 'currency_default_foreign', 'Užsienio kontrahento dokumente valiuta nenurodyta – patvirtinkite valiutą.');

  // Dates.
  if (data.issueDate && ctx.today && data.issueDate > ctx.today) err('issueDate', 'future', 'Išrašymo data yra ateityje.');
  if (data.dueDate && data.issueDate && data.dueDate < data.issueDate) warn('dueDate', 'due_before_issue', 'Apmokėjimo terminas ankstesnis už išrašymo datą.');
  if (company.locked_through && data.issueDate && data.issueDate <= company.locked_through) err('issueDate', 'period_locked', `Laikotarpis iki ${company.locked_through} užrakintas. Registruokite koregavimą atviru laikotarpiu.`);
  if (company.vat_registered && company.vat_registered_from && data.issueDate && data.issueDate < company.vat_registered_from && data.register === 'sales') warn('issueDate', 'before_vat_registration', 'Data ankstesnė nei PVM registracijos pradžia.');

  // Lines.
  if (!data.lines?.length) err('lines', 'no_lines', 'Nėra eilučių. Įveskite bent vieną eilutę.');
  const accounts = ctx.accounts;
  const lines = [];
  (data.lines || []).forEach((l, i) => {
    const f = (k) => `lines.${i}.${k}`;
    const out = {...l, index: i};
    if (!l.description) err(f('description'), 'required', `${i + 1} eilutė: nėra aprašymo.`);
    if (!isAmount(l.quantity) || money.isZero(normAmount(l.quantity))) { err(f('quantity'), 'quantity', `${i + 1} eilutė: netinkamas kiekis.`); }
    if (!isAmount(l.unitPrice)) err(f('unitPrice'), 'unit_price', `${i + 1} eilutė: netinkama kaina.`);
    if (l.discount && !isAmount(l.discount)) err(f('discount'), 'discount', `${i + 1} eilutė: netinkama nuolaida.`);
    let net = null;
    if (isAmount(l.quantity) && isAmount(l.unitPrice) && (!l.discount || isAmount(l.discount))) {
      const computed = money.lineNet(normQty(l.quantity), l.unitPrice, money.norm(l.discount || '0'));
      net = computed;
      if (l.sourceNet && isAmount(l.sourceNet) && !money.eq(l.sourceNet, computed)) {
        const diff = money.abs(money.sub(l.sourceNet, computed));
        // Tolerance: unit price printed rounded to cents → |qty| × 0.005.
        const tol = fromUnits(divRound(toUnits(money.abs(normAmount(l.quantity)), 4) * 5000n, 1000000n * 100n) + 1n);
        if (money.cmp(diff, tol) <= 0) {
          net = money.norm(l.sourceNet);
          info(f('net'), 'line_rounding', `${i + 1} eilutė: dokumente suma ${l.sourceNet}, kiekis × kaina = ${computed}; skirtumas ${diff} dėl kainos apvalinimo – naudojama dokumento suma.`);
        } else if (!conf[f('net')]) {
          err(f('net'), 'line_arithmetic', `${i + 1} eilutė: kiekis × kaina − nuolaida = ${computed}, o dokumente nurodyta ${l.sourceNet}. Pataisykite kiekį, kainą arba sumą.`);
        }
      }
    }
    out.net = net;
    if (!l.accountCode) err(f('accountCode'), 'account', `${i + 1} eilutė: nepasirinkta sąskaita. ${l.suggestion?.explanation || ''}`.trim());
    else if (!accounts.has(l.accountCode)) err(f('accountCode'), 'account', `${i + 1} eilutė: sąskaita ${l.accountCode} nerasta arba neaktyvi.`);
    else {
      const t = accounts.get(l.accountCode).type;
      if (data.register === 'sales' && t !== 'revenue' && !conf[f('accountCode')]) warn(f('accountCode'), 'account_type', `${i + 1} eilutė: pardavimui parinkta ne pajamų sąskaita (${l.accountCode}).`);
      if (data.register === 'purchase' && t === 'revenue') err(f('accountCode'), 'account_type', `${i + 1} eilutė: pirkimui parinkta pajamų sąskaita.`);
    }
    if (!LINE_TYPES.includes(l.lineType)) err(f('lineType'), 'line_type', `${i + 1} eilutė: nenurodytas eilutės tipas.`);
    if (l.lineType === 'inventory') info(f('lineType'), 'inventory', `${i + 1} eilutė: prekės apskaitomos atsargose (ne sąnaudose). Savikaina registruojama atskirai.`);
    if (l.lineType === 'asset') info(f('lineType'), 'asset', `${i + 1} eilutė: ilgalaikis turtas – nusidėvėjimas automatiškai neskaičiuojamas.`);
    if (l.lineType === 'prepaid') info(f('lineType'), 'prepaid', `${i + 1} eilutė: ateinančių laikotarpių sąnaudos – paskirstymą registruokite rankiniu įrašu.`);
    // Tax.
    const rate = l.vatRate === '' || l.vatRate === null || l.vatRate === undefined ? null : l.vatRate;
    if (l.taxCode === 'BE_PVM') {
      if (rate !== null && Number(rate) !== 0) err(f('taxCode'), 'tax', `${i + 1} eilutė: „be PVM“, bet nurodytas tarifas ${rate} %.`);
      out.rate = '0';
    } else {
      const tc = ctx.taxCodes.find((t) => t.code === l.taxCode && t.effective_from <= (data.issueDate || ctx.today) && (!t.effective_to || t.effective_to >= (data.issueDate || ctx.today)));
      if (!l.taxCode) err(f('taxCode'), 'tax', `${i + 1} eilutė: nenustatytas PVM kodas${rate !== null ? ` tarifui ${rate} %` : ''}. ${rate !== null && Number(rate) === 9 && data.issueDate >= '2026-01-01' ? '9 % tarifas (PVM2) galiojo iki 2025-12-31 – patikrinkite dokumentą.' : 'Pasirinkite PVM kodą.'}`);
      else if (!tc) err(f('taxCode'), 'tax', `${i + 1} eilutė: PVM kodas ${l.taxCode} negalioja ${data.issueDate} datai.`);
      else if (tc.rate !== null && rate !== null && Number(tc.rate) !== Number(rate)) err(f('taxCode'), 'tax', `${i + 1} eilutė: kodas ${l.taxCode} (${tc.rate} %) nesutampa su tarifu ${rate} %.`);
      out.rate = tc?.rate ?? (rate || '0');
      out.isafCode = tc?.isaf_code || '';
    }
    if (!VAT_TREATMENTS.includes(l.vatTreatment)) err(f('vatTreatment'), 'vat_treatment', `${i + 1} eilutė: nenurodytas PVM traktavimas.`);
    else if (l.vatTreatment === 'review') err(f('vatTreatment'), 'vat_review', `${i + 1} eilutė: PVM atskaitos teisė neaiški. ${l.suggestion?.vatExplanation || ''} Pasirinkite „atskaitomas“ arba „neatskaitomas“.`.trim());
    else if (data.register === 'sales' && l.vatTreatment !== 'output') err(f('vatTreatment'), 'vat_treatment', `${i + 1} eilutė: pardavimo PVM turi būti „pardavimo PVM“.`);
    else if (data.register === 'purchase' && l.vatTreatment === 'output') err(f('vatTreatment'), 'vat_treatment', `${i + 1} eilutė: pirkimui netinka „pardavimo PVM“.`);
    if (l.vatTreatment === 'deductible' && data.register === 'purchase' && !company.vat_registered) err(f('vatTreatment'), 'vat_treatment', `${i + 1} eilutė: įmonė nėra PVM mokėtoja – PVM neatskaitomas.`);
    lines.push(out);
  });

  // VAT groups (per tax code), compared with printed totals.
  const groups = new Map();
  for (const l of lines) {
    if (l.net === null) continue;
    const key = l.taxCode || '?';
    const g = groups.get(key) || {taxCode: key, isafCode: l.isafCode || '', rate: l.rate ?? '0', taxable: '0.00', lines: []};
    g.taxable = money.add(g.taxable, l.net); g.lines.push(l);
    groups.set(key, g);
  }
  const srcRates = (data.sourceTotals?.vatByRate || []).filter((r) => r.rate !== undefined);
  const vatGroups = [];
  for (const g of groups.values()) {
    const computed = g.taxCode === 'BE_PVM' || g.rate === null ? '0.00' : money.vat(g.taxable, g.rate);
    let src = srcRates.find((r) => Number(r.rate) === Number(g.rate));
    if (!src && groups.size === 1 && data.sourceTotals?.vat !== '' && data.sourceTotals?.vat !== undefined && srcRates.length <= 1) src = {rate: g.rate, amount: data.sourceTotals.vat};
    let used = computed, note = 'PVM apskaičiuotas: apmokestinamoji vertė × tarifas, apvalinta iki cento (ROUND_HALF_UP).';
    if (src && src.amount !== '' && src.amount !== null && isAmount(String(src.amount))) {
      const diff = money.sub(src.amount, computed);
      const tol = fromUnits(BigInt(g.lines.length) * VAT_TOLERANCE_PER_LINE);
      if (money.isZero(diff)) note = 'Dokumento PVM suma sutampa su apskaičiuota.';
      else if (money.cmp(money.abs(diff), tol) <= 0) { used = money.norm(src.amount); note = `Dokumente PVM ${src.amount}, apskaičiuota ${computed}; skirtumas ${diff} neviršija apvalinimo per eilutes ribos (${tol}) – naudojama dokumento suma.`; info('sourceTotals.vat', 'vat_rounding', note); }
      else if (!conf['sourceTotals.vat']) err('sourceTotals.vat', 'vat_mismatch', `PVM ${Number(g.rate)} %: dokumente ${src.amount}, apskaičiuota ${computed} (skirtumas ${diff}). Patikrinkite eilutes, tarifą arba dokumento PVM sumą.`);
      else note = `Patvirtintas skirtumas: dokumente ${src.amount}, naudojama apskaičiuota ${computed}.`;
    } else if (g.rate !== null && Number(g.rate) > 0 && data.origin !== 'manual' && data.origin !== 'store') {
      warn('sourceTotals.vat', 'vat_not_printed', `PVM ${Number(g.rate)} % suma dokumente nerasta arba neperskaityta – naudojama apskaičiuota ${computed}.`);
    }
    vatGroups.push({taxCode: g.taxCode, isafCode: g.isafCode, rate: g.rate, taxable: g.taxable, vatComputed: computed, vatSource: src?.amount ?? null, vat: used, note});
    // Allocate group VAT to lines proportionally (exact sum).
    const shares = money.allocate(used, g.lines.map((l) => money.abs(l.net)));
    const sign = money.sign(used) < 0 ? -1 : 1;
    g.lines.forEach((l, k) => { l.vat = sign < 0 ? shares[k] : shares[k]; });
  }
  const net = money.sum(lines.filter((l) => l.net !== null).map((l) => l.net));
  const vat = money.sum(vatGroups.map((g) => g.vat));
  const gross = money.add(net, vat);
  for (const l of lines) { if (l.net !== null) { l.vat = l.vat || '0.00'; l.gross = money.add(l.net, l.vat); } }
  let deductibleVat = '0.00';
  if (data.register === 'purchase') deductibleVat = money.sum(lines.filter((l) => l.vatTreatment === 'deductible' && l.vat).map((l) => l.vat));

  // Totals vs printed totals.
  const st = data.sourceTotals || {};
  if (st.net !== '' && st.net !== undefined && isAmount(String(st.net)) && !money.eq(st.net, net) && !conf['sourceTotals.net']) err('sourceTotals.net', 'net_mismatch', `Eilučių suma be PVM ${net} nesutampa su dokumento suma ${st.net} (skirtumas ${money.sub(st.net, net)}). Galbūt praleista eilutė.`);
  if (st.gross !== '' && st.gross !== undefined && isAmount(String(st.gross)) && !money.eq(st.gross, gross) && !conf['sourceTotals.gross']) err('sourceTotals.gross', 'gross_mismatch', `Apskaičiuota bendra suma ${gross} nesutampa su dokumento suma ${st.gross} (skirtumas ${money.sub(st.gross, gross)}).`);
  if ((st.gross === '' || st.gross === undefined) && data.origin !== 'manual' && data.origin !== 'store') warn('sourceTotals.gross', 'gross_missing', 'Dokumento bendra suma nerasta – patikrinkite apskaičiuotą sumą.');

  // Sign consistency.
  const isCredit = data.docType === 'credit_note';
  if (lines.length && net !== '0.00') {
    if (isCredit && money.sign(gross) > 0) err('docType', 'credit_sign', 'Kreditinės sąskaitos suma turi būti neigiama.');
    if (!isCredit && money.sign(gross) < 0) err('docType', 'negative', 'Neigiama suma galima tik kreditinėje sąskaitoje.');
  }
  if (isCredit && !data.relatedInvoiceId) warn('relatedDocument', 'credit_unlinked', `Kreditinė sąskaita nesusieta su originalia sąskaita${data.relatedDocument ? ` („${data.relatedDocument}“ nerasta tarp registruotų)` : ''}.`);

  // Duplicates.
  const dup = ctx.duplicates || {};
  for (const d of dup.posted || []) err('number', 'duplicate_posted', `Dublikatas: ši sąskaita jau užregistruota (${d.label}). Antrą kartą registruoti negalima.`);
  if (dup.sameFile) err('file', 'duplicate_file', `Identiškas failas jau įkeltas (dokumentas #${dup.sameFile}).`);
  for (const d of dup.open || []) if (!ack[`dup:${d.documentId}`]) err('number', 'duplicate_open', `Galimas dublikatas: kitas dokumentas #${d.documentId} turi tą patį tiekėją ir numerį (${d.label}). Atmeskite vieną iš jų arba patvirtinkite, kad tai skirtingi dokumentai.`);
  for (const d of dup.near || []) if (!ack[`near:${d.id}`]) err('number', 'duplicate_near', `Galimas dublikatas: ${d.label} – tas pats kontrahentas, data ir suma, bet kitas numeris. Patikrinkite ir patvirtinkite, kad tai skirtingi dokumentai.`);

  // Journal entries.
  const entries = [];
  if (['purchase', 'sales'].includes(data.register) && lines.every((l) => l.net !== null) && lines.length) {
    const signed = new Map();
    const add = (account, amount, cp) => { if (!account || money.isZero(amount)) return; const k = `${account}|${cp ? 'cp' : ''}`; signed.set(k, money.add(signed.get(k) || '0', amount)); };
    if (data.register === 'purchase') {
      for (const l of lines) {
        const nd = l.vatTreatment === 'deductible' ? '0.00' : l.vat || '0.00';
        add(l.accountCode, money.add(l.net, nd));
        if (l.vatTreatment === 'deductible') add(roles.vat_input, l.vat || '0.00');
      }
      add(roles.payable, money.neg(gross), true);
    } else {
      for (const l of lines) add(l.accountCode, money.neg(l.net));
      add(roles.vat_output, money.neg(vat));
      add(roles.receivable, gross, true);
    }
    for (const [k, amt] of signed) {
      const [account, cp] = k.split('|');
      if (money.isZero(amt)) continue;
      const pos = money.sign(amt) > 0;
      entries.push({account, accountName: accounts.get(account)?.name || '', debit: pos ? money.norm(amt) : '0.00', credit: pos ? '0.00' : money.abs(amt), counterparty: cp ? data.counterparty?.name : ''});
    }
    const d = money.sum(entries.map((e) => e.debit)), c = money.sum(entries.map((e) => e.credit));
    if (!money.eq(d, c)) err('entries', 'unbalanced', `Įrašas nesubalansuotas: debetas ${d}, kreditas ${c}.`);
    for (const r of ['payable', 'receivable', 'vat_input', 'vat_output']) if (!roles[r]) err('entries', 'mapping', `Nenustatytas kontavimo susiejimas „${r}“.`);
  }

  // Same message from several provenance paths (e.g. VAT total derived from the per-rate VAT) is shown once.
  const seen = new Set();
  for (let i = issues.length - 1; i >= 0; i--) { const k = `${issues[i].level}|${issues[i].message}`; if (seen.has(k)) issues.splice(i, 1); else seen.add(k); }
  const blocking = issues.some((x) => x.level === 'error');
  return {computed: {lines: lines.map(({index, ...l}) => ({index, net: l.net, vat: l.vat ?? null, gross: l.gross ?? null, rate: l.rate ?? null, isafCode: l.isafCode || ''})), vatGroups, net, vat, gross, deductibleVat, entries, numberKey: numberKey(data.series, data.number), counterpartyKey: counterpartyKey(data)}, issues, blocking};
}

function normAmount(v) { try { return money.norm(fromUnits(toUnits(v, 4), 4).replace(/(\.\d{2})\d+$/, '$1')); } catch { return '0'; } }

export function counterpartyKey(data) {
  if (data.register === 'sales' && data.origin !== 'store_external') return 'own';
  if (data.origin === 'store_external') return `store:${data.storeId}`;
  const c = data.counterparty || {};
  if (c.companyCode) return `code:${c.companyCode}`;
  if (c.vatCode) return `vat:${normalizeVat(c.vatCode)}`;
  return `name:${normalizeName(c.name)}`;
}
