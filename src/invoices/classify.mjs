// Line classification: approved rules > product mapping > built-in keyword suggestions.
// Every suggestion carries its source and an explanation. Nothing here creates rules.
import {fold} from '../extraction/ids.mjs';
import {money} from '../lib/money.mjs';

// Built-in keyword suggestions (documented in docs/CLASSIFICATION.md). Accounts refer to the starter chart.
export const KEYWORDS = [
  {id: 'KW-ASSET', re: /(nesiojam\w* kompiuter|kompiuteri|laptop|monitori|spausdintuv|serveri(?!o nuoma)|planset|telefon\w* apar|iranga\b|irenginy|baldai|stalas|kede)/, purchase: {account: 'asset_or_small', lineType: 'asset'}, label: 'įranga / ilgalaikis turtas'},
  {id: 'KW-PREPAID', re: /(metine|metams|12 men|annual|yearly|prenumerata.*metu|draudimas)/, purchase: {account: '2810', lineType: 'prepaid'}, label: 'ilgesnio laikotarpio išankstinė paslauga'},
  {id: 'KW-GOODS', re: /(perpardav|prekes? sandel|prekiu partij|sku[- ]?\d|resale)/, purchase: {account: '2040', lineType: 'inventory'}, label: 'prekės perpardavimui'},
  {id: 'KW-SERVER', re: /(serverio nuoma|hosting|talpinim|domen|licencij|programin|saas|debesij|cloud)/, purchase: {account: '6309', lineType: 'service'}, label: 'IT paslaugos'},
  {id: 'KW-RENT', re: /(nuoma|nuomos)(?!.*server)/, purchase: {account: '6304', lineType: 'service'}, label: 'nuoma'},
  {id: 'KW-UTIL', re: /(elektr|silduma|sildym|vanduo|vandens|dujos|komunalin)/, purchase: {account: '6305', lineType: 'service'}, label: 'komunalinės paslaugos'},
  {id: 'KW-CLEAN', re: /(valym|patalpu prieziur)/, purchase: {account: '6306', lineType: 'service'}, label: 'valymas'},
  {id: 'KW-TELCO', re: /(interneto rysys|internetas|ryso|rysys|mobili|telefono rys|telekom)/, purchase: {account: '6307', lineType: 'service'}, label: 'ryšio paslaugos'},
  {id: 'KW-OFFICE', re: /(popierius|kanceliar|rasikl|segtuv|biuro prekes)/, purchase: {account: '6308', lineType: 'expense'}, label: 'kanceliarinės prekės'},
  {id: 'KW-ADS', re: /(reklam|google ads|facebook|meta ads|marketing)/, purchase: {account: '6110', lineType: 'service'}, label: 'reklama'},
  {id: 'KW-SHIP', re: /(kurjer|siunt|pristatym|transport|dpd|omniva|lp express|venipak|dhl)/, purchase: {account: '6120', lineType: 'service'}, sales: {account: '5002', lineType: 'revenue_services'}, label: 'pristatymas'},
  {id: 'KW-PROF', re: /(apskaitos paslaug|buhalter|teisin|konsultac|audit)/, purchase: {account: '6310', lineType: 'service'}, label: 'profesinės paslaugos'},
  {id: 'KW-REPR', re: /(reprezentac|vaisin|pietus|maitinim|restoran|kava ir uzkand|uzkandziai)/, purchase: {account: '6311', lineType: 'expense', vat: 'non_deductible', vatRule: 'BR-REPR'}, label: 'reprezentacinės sąnaudos'},
  {id: 'KW-CAR', re: /(lengvoj\w* automobil|lengvasis automobil|automobilio nuoma|degalai|kuras|benzin|dyzelin)/, purchase: {account: '6899', lineType: 'expense', vat: 'review', vatRule: 'BR-CAR'}, label: 'lengvieji automobiliai / degalai'},
];

const BUILTIN_VAT_RULES = {
  'BR-LT-STD': 'PVM atskaita leidžiama: įmonė registruota PVM mokėtoja, tiekėjas turi galiojančio formato LT PVM kodą, dokumentas yra PVM sąskaita faktūra, tarifas standartinis arba lengvatinis, sąnaudos nepriskirtos ribojamoms kategorijoms (prielaida, kurią turi patvirtinti buhalteris – docs/TAX_RULES.md).',
  'BR-NOT-REGISTERED': 'Įmonė nėra PVM mokėtoja – pirkimo PVM neatskaitomas ir įtraukiamas į savikainą/sąnaudas.',
  'BR-REPR': 'Reprezentacinių sąnaudų pirkimo PVM paprastai neatskaitomas (prielaida; patikrinkite su buhalteriu).',
  'BR-CAR': 'Lengvųjų automobilių ir degalų PVM atskaitos teisė ribojama – reikia buhalterio sprendimo.',
  'BR-NO-VATCODE': 'Tiekėjo PVM mokėtojo kodas nerastas arba netinkamas – atskaitos teisė neaiški.',
  'BR-FOREIGN': 'Užsienio tiekėjas – atvirkštinis apmokestinimas automatiškai nepalaikomas.',
  'BR-NOT-VAT-INVOICE': 'Dokumentas nėra PVM sąskaita faktūra – PVM atskaita negalima be tinkamo dokumento.',
  'BR-ZERO': 'PVM nėra (0 % arba be PVM).',
};
export {BUILTIN_VAT_RULES};

function ruleMatches(rule, line, ctx) {
  if (rule.register !== ctx.register) return false;
  if (rule.effective_from > ctx.issueDate) return false;
  if (rule.effective_to && rule.effective_to < ctx.issueDate) return false;
  if (rule.counterparty_id && String(rule.counterparty_id) !== String(ctx.counterpartyId || '')) return false;
  if (rule.match_text && !fold(line.description || '').includes(fold(rule.match_text))) return false;
  return true;
}

export function pickRule(rules, line, ctx) {
  const hits = rules.filter((r) => r.status === 'active' && ruleMatches(r, line, ctx));
  hits.sort((a, b) => a.priority - b.priority || (b.match_text ? 1 : 0) - (a.match_text ? 1 : 0) || (b.counterparty_id ? 1 : 0) - (a.counterparty_id ? 1 : 0) || Number(b.id) - Number(a.id));
  return hits[0] || null;
}

/** Suggest account/type/VAT treatment for one line. Returns only suggestions; user approval required. */
export function classifyLine(line, ctx) {
  const {register, company, rules, products} = ctx;
  const desc = fold(line.description || '');
  const out = {accountCode: '', lineType: register === 'sales' ? 'revenue_goods' : 'expense', vatTreatment: register === 'sales' ? 'output' : 'review', suggestion: {source: 'none', explanation: 'Nerasta taisyklė ar atitikmuo – pasirinkite sąskaitą.'}, vatExplanation: ''};
  const rule = pickRule(rules, line, ctx);
  const product = line.sku ? products.find((p) => p.sku && p.sku.toUpperCase() === String(line.sku).toUpperCase()) : null;
  let kwVat = null;
  if (rule) {
    out.accountCode = rule.account_code; out.lineType = rule.line_type;
    out.suggestion = {source: 'rule', ruleId: String(rule.id), ruleKey: rule.rule_key, ruleVersion: rule.version, explanation: `Patvirtinta taisyklė „${rule.name}“ (v${rule.version}, prioritetas ${rule.priority}${rule.match_text ? `, tekstas „${rule.match_text}“` : ''}).`};
  } else if (product && (register === 'sales' ? product.revenue_account : product.expense_account || product.kind === 'goods')) {
    out.accountCode = register === 'sales' ? product.revenue_account : (product.expense_account || ctx.roles.inventory);
    out.lineType = register === 'sales' ? (product.kind === 'service' ? 'revenue_services' : 'revenue_goods') : (product.kind === 'goods' ? 'inventory' : 'service');
    out.productId = String(product.id);
    out.suggestion = {source: 'product', explanation: `Prekės kortelė ${product.sku} „${product.name}“.`};
  } else {
    const kw = KEYWORDS.find((k) => k[register] && k.re.test(desc));
    if (kw) {
      const s = kw[register];
      let account = s.account;
      let lineType = s.lineType;
      let extra = '';
      if (account === 'asset_or_small') {
        const net = line.net && /^-?\d/.test(line.net) ? line.net : '0';
        if (money.cmp(money.abs(net), company.asset_threshold) >= 0) { account = ctx.roles.fixed_assets || '1240'; extra = ` Vertė ≥ ${company.asset_threshold} EUR – siūloma ilgalaikiam turtui.`; } else { account = '6312'; lineType = 'expense'; extra = ` Vertė < ${company.asset_threshold} EUR – siūloma smulkiam inventoriui.`; }
      }
      out.accountCode = account; out.lineType = lineType;
      out.suggestion = {source: 'keyword', keywordId: kw.id, explanation: `Raktažodžių pasiūlymas: ${kw.label}.${extra} Tai ne taisyklė – patikrinkite.`};
      if (s.vat) kwVat = {treatment: s.vat, rule: s.vatRule};
    } else if (register === 'sales') {
      out.accountCode = ctx.roles.revenue_goods || '5000'; out.lineType = 'revenue_goods';
      out.suggestion = {source: 'default', explanation: 'Pardavimo eilutė be prekės kortelės – siūlomos prekių pardavimo pajamos. Patikrinkite, ar tai ne paslauga.'};
    }
  }
  // VAT treatment.
  if (register === 'sales') { out.vatTreatment = 'output'; return out; }
  const vt = purchaseVatTreatment(line, ctx, rule, kwVat);
  out.vatTreatment = vt.treatment; out.vatExplanation = vt.explanation; out.vatRuleId = vt.rule;
  return out;
}

export function purchaseVatTreatment(line, ctx, rule, kwVat) {
  const {company, docType, counterparty} = ctx;
  const rate = line.vatRate === '' || line.vatRate === null || line.vatRate === undefined ? null : Number(line.vatRate);
  if (!company.vat_registered) return {treatment: 'non_deductible', rule: 'BR-NOT-REGISTERED', explanation: BUILTIN_VAT_RULES['BR-NOT-REGISTERED']};
  if (rate === 0 || line.taxCode === 'BE_PVM') return {treatment: 'deductible', rule: 'BR-ZERO', explanation: BUILTIN_VAT_RULES['BR-ZERO']};
  if (rule && rule.vat_treatment !== 'output') return {treatment: rule.vat_treatment, rule: `RULE-${rule.rule_key}`, explanation: `Patvirtinta taisyklė „${rule.name}“ nustato PVM: ${rule.vat_treatment}.`};
  if (kwVat) return {treatment: kwVat.treatment, rule: kwVat.rule, explanation: BUILTIN_VAT_RULES[kwVat.rule]};
  const vat = String(counterparty?.vatCode || '').toUpperCase();
  if (vat && !vat.startsWith('LT')) return {treatment: 'review', rule: 'BR-FOREIGN', explanation: BUILTIN_VAT_RULES['BR-FOREIGN']};
  if (!/^LT(\d{9}|\d{12})$/.test(vat)) return {treatment: 'review', rule: 'BR-NO-VATCODE', explanation: BUILTIN_VAT_RULES['BR-NO-VATCODE']};
  if (!['vat_invoice', 'credit_note', 'debit_note'].includes(docType)) return {treatment: 'review', rule: 'BR-NOT-VAT-INVOICE', explanation: BUILTIN_VAT_RULES['BR-NOT-VAT-INVOICE']};
  return {treatment: 'deductible', rule: 'BR-LT-STD', explanation: BUILTIN_VAT_RULES['BR-LT-STD']};
}
