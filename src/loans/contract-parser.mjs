// Paskolos sutarties skaitymas: finds the loan amount, the annual interest rate, the day-count basis, the dates,
// the contract number and the parties in the text of a loan agreement (Lithuanian or English). Every value comes
// with the text it was read from; nothing is saved until the user confirms it.

const MONTHS = {sausio: 1, vasario: 2, kovo: 3, balandžio: 4, gegužės: 5, birželio: 6, liepos: 7, rugpjūčio: 8, rugsėjo: 9, spalio: 10, lapkričio: 11, gruodžio: 12};
const CCY = {eur: 'EUR', 'eurų': 'EUR', 'eurai': 'EUR', 'euro': 'EUR', 'eurus': 'EUR', '€': 'EUR', usd: 'USD', gbp: 'GBP', pln: 'PLN'};
const pad = (n) => String(n).padStart(2, '0');
const validDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null; };

/** "10 000,50" / "10.000,50" / "10,000.50" / "10000" → "10000.50" (or null). */
export function parseAmount(raw) {
  let s = String(raw).replace(/[\s  ']/g, '');
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  const decSep = lastComma > lastDot ? ',' : '.';
  const decPos = Math.max(lastComma, lastDot);
  if (decPos >= 0 && s.length - decPos - 1 === 3 && s.split(decSep).length === 2 && !(decSep === ',' && lastDot >= 0)) {
    // "10.000" or "10,000": a thousands separator, not decimals.
    s = s.replace(/[.,]/g, '');
  } else if (decPos >= 0) {
    s = s.slice(0, decPos).replace(/[.,]/g, '') + '.' + s.slice(decPos + 1);
  }
  return /^\d+(\.\d{1,2})?$/.test(s) ? (s.includes('.') ? s.padEnd(s.indexOf('.') + 3, '0') : `${s}.00`) : null;
}

function findDates(text) {
  const out = [];
  const add = (index, raw, date) => { if (date) out.push({index, raw, date}); };
  for (const m of text.matchAll(/\b(20\d{2}|19\d{2})[-.\/](\d{1,2})[-.\/](\d{1,2})\b/g)) add(m.index, m[0], validDate(+m[1], +m[2], +m[3]));
  for (const m of text.matchAll(/\b(\d{1,2})[.\/](\d{1,2})[.\/](20\d{2})\b/g)) add(m.index, m[0], validDate(+m[3], +m[2], +m[1]));
  for (const m of text.matchAll(/\b(20\d{2})\s*m\.?\s*([a-ząčęėįšųūž]+)\s*(\d{1,2})\s*d\.?/gi)) add(m.index, m[0], MONTHS[m[2].toLowerCase()] ? validDate(+m[1], MONTHS[m[2].toLowerCase()], +m[3]) : null);
  return out.sort((a, b) => a.index - b.index);
}

const around = (text, i, before = 120, after = 60) => text.slice(Math.max(0, i - before), i + after);
const snippet = (text, i, len = 90) => text.slice(Math.max(0, i - 45), i + len).replace(/\s+/g, ' ').trim();

function amountCandidates(text) {
  const out = [];
  const re = /(\d{1,3}(?:[  .,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:\([^)]{0,120}\)\s*)?(EUR|Eur|eur|eurų|eurai|euro|eurus|€|USD|GBP|PLN)\b|(EUR|€)\s*(\d{1,3}(?:[  .,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g;
  for (const m of text.matchAll(re)) {
    const amount = parseAmount(m[1] || m[4]);
    if (!amount || Number(amount) <= 0) continue;
    const ctx = around(text, m.index, 160, 40).toLowerCase();
    let score = 0;
    if (/paskolos\s+(suma|dydis)|paskolą|paskolos\s+gavėjui|loan amount|principal|amount of the loan/.test(ctx)) score += 4;
    if (/suteikia|perduoda|išmoka|paskolina|lend/.test(ctx)) score += 2;
    if (/paskol|loan/.test(ctx)) score += 1;
    if (/palūkan|interest/.test(ctx)) score -= 2;
    if (/bauda|delspinig|netesyb|komisin|mokest|penalty|fee/.test(ctx)) score -= 4;
    out.push({index: m.index, amount, currency: CCY[(m[2] || m[3] || 'eur').toLowerCase()] || 'EUR', score});
  }
  return out;
}

function rateCandidates(text) {
  const out = [];
  for (const m of text.matchAll(/(\d{1,2}(?:[.,]\d{1,4})?)\s*(?:%|proc\.?|procent[a-ząčęėįšųūž]*)(?:\s*\([^)]{0,80}\))?/gi)) {
    const rate = m[1].replace(',', '.');
    if (!(Number(rate) > 0 && Number(rate) < 100)) continue;
    const ctx = around(text, m.index, 160, 100).toLowerCase();
    let score = 0;
    if (/palūkan|interest/.test(ctx)) score += 3;
    if (/metin|per metus|annual|per annum|p\.a\./.test(ctx)) score += 2;
    if (/delspinig|bauda|netesyb|pradelst|vėluo|\bdefault\b|penalt|\blate (?:payment|interest)/.test(ctx)) score -= 6;
    if (/pvm|vat|gpm/.test(ctx)) score -= 4;
    const variable = /euribor|vilibor|kintam/.test(ctx);
    out.push({index: m.index, rate, score, variable, base: (ctx.match(/(\d+)\s*(?:mėn\w*\.?|m\b|month)\w*\s*euribor|euribor\s*(\d+)\s*(?:mėn|m)/) || [])[0] || (variable ? 'EURIBOR' : null)});
  }
  return out;
}

const ORG = /(UAB|AB|MB|IĮ|VšĮ|ŽŪB|KB)\s*[„"“]?([^"”“\n,;]{2,80})[”"“]?/;

/**
 * text – plain text of the agreement; company – {name, company_code} of this company.
 * Returns {fields, evidence, warnings}; fields hold null where nothing reliable was found.
 */
export function parseLoanContract(text, company = {}) {
  const t = String(text || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  const fields = {}, evidence = {}, warnings = [];

  const amounts = amountCandidates(t).filter((a) => a.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  if (amounts[0]) { fields.principal = amounts[0].amount; fields.currency = amounts[0].currency; evidence.principal = snippet(t, amounts[0].index); }

  const rates = rateCandidates(t).filter((r) => r.score >= 3).sort((a, b) => b.score - a.score || a.index - b.index);
  if (rates[0]) {
    fields.rate = rates[0].rate; evidence.rate = snippet(t, rates[0].index);
    if (rates[0].variable) { fields.rateVariable = true; warnings.push(`Palūkanos kintamos (${rates[0].base || 'EURIBOR'} + ${rates[0].rate} %). Įrašyta tik marža – pridėkite bazinę normą ir jos pokyčius.`); }
    const other = rates.find((r) => r.rate !== rates[0].rate && r.score === rates[0].score);
    if (other) warnings.push(`Sutartyje rasta ir kita palūkanų norma (${other.rate} %) – patikrinkite.`);
  }
  const lower = t.toLowerCase();
  const basisAt = lower.search(/30e?\s*\/\s*360|36[05]\s*(?:dien|days|kalendor)|faktin[a-ząčęėįšųūž]*\s+(?:metų\s+)?dien|actual\s*\/\s*36[05]|act\s*\/\s*(?:36[05]|act)/);
  if (basisAt >= 0) {
    const s = lower.slice(Math.max(0, basisAt - 40), basisAt + 120);
    fields.basis = /30e?\s*\/\s*360/.test(s) ? '30e360' : /360/.test(s) ? 'act360' : /365/.test(s) ? 'act365' : /366|faktin[a-ząčęėįšųūž]*\s+metų\s+dien|act\s*\/\s*act/.test(s) ? 'actact' : 'act365';
    evidence.basis = snippet(t, basisAt);
  } else warnings.push('Dienų skaičiavimo bazė sutartyje nenurodyta – taikoma faktinės dienos / 365.');

  const dates = findDates(t);
  const dated = dates.map((d) => ({...d, ctx: around(lower, d.index, 100, 20)}));
  const signed = dated.find((d) => /sudaryt|pasiraš|data|dated|made on/.test(d.ctx)) || dated.find((d) => d.index < 500);
  if (signed) { fields.contractDate = signed.date; evidence.contractDate = snippet(t, signed.index); }
  const due = dated.filter((d) => d !== signed && /grąžin|terminas|termino|iki|not later|repay|maturity/.test(d.ctx) && !/išmok|pervest|disburs/.test(d.ctx.slice(-60)));
  if (due.length) { const d = due.sort((a, b) => (a.date < b.date ? 1 : -1))[0]; fields.maturityDate = d.date; evidence.maturityDate = snippet(t, d.index); }
  const paid = dated.find((d) => d !== signed && /išmok|pervest|disburs|perves/.test(d.ctx.slice(-80)));
  if (paid) { fields.plannedDisbursement = paid.date; evidence.plannedDisbursement = snippet(t, paid.index); }

  const no = t.match(/(?:sutart\w*|agreement)[^\n]{0,30}?\b(?:Nr|No)\.?\s*([A-Z0-9][A-Z0-9\-\/._]{0,30})/i) || t.slice(0, 600).match(/\b(?:Nr|No)\.\s*([A-Z0-9][A-Z0-9\-\/._]{0,30})/i);
  if (no) { fields.contractNo = no[1].replace(/[.,]$/, ''); evidence.contractNo = snippet(t, no.index); }

  // Parties: who lends and who borrows. Lithuanian agreements name the party first and the role after it
  // ("UAB „X“, kodas …, toliau – Paskolos gavėjas"); others use "Paskolos gavėjas: UAB „X“". This company's
  // name or code decides the direction.
  const orgs = [...t.matchAll(new RegExp(ORG.source, 'g'))].map((m) => {
    const tail = t.slice(m.index, m.index + 200), cc = tail.match(/\b(\d{9})\b/);
    return {index: m.index, name: `${m[1]} „${m[2].trim()}“`, plain: m[2].trim().toLowerCase(), code: cc ? cc[1] : null};
  });
  const party = (labelRe) => {
    const m = labelRe.exec(t);
    if (!m) return null;
    const after = orgs.find((o) => o.index > m.index && o.index - (m.index + m[0].length) <= 12 && /^\s*[:–-]/.test(t.slice(m.index + m[0].length)));
    if (after) return {...after, at: m.index};
    const before = orgs.filter((o) => o.index < m.index && m.index - o.index <= 300).pop();
    return before ? {...before, at: m.index} : null;
  };
  const lender = party(/paskolos\s+(?:davėj|teikėj)[a-ząčęėįšųūž]*|paskolintoj[a-ząčęėįšųūž]*|\blender\b|kreditori[a-ząčęėįšųūž]*/i);
  const borrower = party(/paskolos\s+gavėj[a-ząčęėįšųūž]*|\bborrower\b|skolinink[a-ząčęėįšųūž]*/i);
  const code = String(company.company_code || '').trim(), name = String(company.name || '').replace(/^(UAB|AB|MB)\s*/i, '').replace(/[„“"”]/g, '').trim().toLowerCase();
  const ours = (p) => !!p && ((code && p.code === code) || (name.length > 2 && p.plain.replace(/[„“"”]/g, '') === name));
  const take = (dir, mine, other) => { fields.direction = dir; fields.counterpartyName = other?.name || null; fields.counterpartyCode = other?.code || null; evidence.direction = snippet(t, mine.at); };
  if (ours(borrower) && !ours(lender)) take('received', borrower, lender);
  else if (ours(lender) && !ours(borrower)) take('granted', lender, borrower);
  else warnings.push('Nepavyko nustatyti, ar įmonė paskolą gavo, ar suteikė – pasirinkite.');

  if (!fields.principal) warnings.push('Paskolos suma nerasta – įrašykite.');
  if (!fields.rate) warnings.push('Palūkanų norma nerasta – įrašykite.');
  warnings.push('Palūkanos skaičiuojamos nuo pinigų gavimo dienos – ją nurodykite arba pasirinkite banko operaciją.');
  return {fields, evidence, warnings};
}
