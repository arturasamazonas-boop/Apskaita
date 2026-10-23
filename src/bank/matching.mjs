// Payment matching, reconciliation proposals, allocation approval.
// Allocation amount semantics:
//   invoice: in the invoice's sign (positive reduces a positive outstanding balance);
//   fee: positive = expense deducted from the payout;
//   advance / overpayment / own_transfer / other: cash-signed like the bank transaction.
// Cash effect: invoice → +amount (sales) / −amount (purchase); fee → −amount; others → amount.
// Every allocation posts −effect to its account; the bank account gets +transaction amount.
import {AppError, tx} from '../db.mjs';
import {audit} from '../audit.mjs';
import {requireCap} from '../auth/auth.mjs';
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';
import {contentHash} from '../invoices/engine.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';
import {roleAccounts, postEntry} from '../ledger/ledger.mjs';
import {fold, normalizeName, normalizeIban, numberKey} from '../extraction/ids.mjs';
import {rateFor, toEur} from '../fx/rates.mjs';

export const PROCESSORS = /(stripe|paypal|paysera|montonio|adyen|klix|braintree|mollie|checkout\.com|makecommerce|neopay)/i;
const FEE_RE = /(komisin|aptarnavimo mokest|aptarnavim|saskaitos mokest|banko mokest|\bfee\b|charge|commission)/;
// Taxes and contributions are never bank fees, whatever the wording ("gyventojų pajamų mokestis už 09").
const TAX_RE = /(pajamu mokest|\bgpm\b|\bpvm\b|sodra|socialinio draudimo|mokesciu inspekcij|\bvmi\b|imokos kodas|pelno mokest)/;

/** Normalized number keys found in a payment purpose: one per word ("2026-10-25" stays one key, so it never matches
 * invoice No. 1025), plus a letters-only word joined with the next word ("PP 000012" → PP12). */
export function referenceKeys(text) {
  const words = fold(String(text || '')).toUpperCase().split(/[\s,;:()]+/).map((w) => w.replace(/[^A-Z0-9]/g, '').replace(/^NR(?=[A-Z0-9])/, '')).filter((w) => w && w !== 'NR');
  const keys = new Set();
  words.forEach((w, i) => {
    keys.add(numberKey('', w));
    if (/^[A-Z]+$/.test(w) && words[i + 1]) keys.add(numberKey('', w + words[i + 1]));
  });
  return keys;
}
const KINDS = ['invoice', 'fee', 'own_transfer', 'advance', 'overpayment', 'other'];

export function cashEffect(a, invRegister) {
  if (a.kind === 'invoice') return invRegister === 'sales' ? money.norm(a.amount) : money.neg(a.amount);
  if (a.kind === 'fee') return money.neg(a.amount);
  return money.norm(a.amount);
}

async function openInvoicesFor(db, t) {
  const incoming = money.sign(t.amount) > 0;
  const all = await invoiceBalances(db, {openOnly: true, limit: 2000});
  // Incoming: sales invoices (positive balance) or supplier credit notes (negative purchase balance). Outgoing: the reverse.
  // A EUR payment may settle an invoice in another currency (the bank converts); a foreign-currency account only its own currency.
  return all.filter((i) => (i.currency === t.currency || t.currency === 'EUR') && (incoming
    ? (i.register === 'sales' && money.sign(i.outstanding) > 0) || (i.register === 'purchase' && money.sign(i.outstanding) < 0)
    : (i.register === 'purchase' && money.sign(i.outstanding) > 0) || (i.register === 'sales' && money.sign(i.outstanding) < 0)));
}

function scoreInvoice(t, inv, cp) {
  const ev = [];
  let score = 0;
  const keys = referenceKeys(`${t.reference} ${t.description}`);
  const ref = fold(`${t.reference} ${t.description}`).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nk = numberKey(inv.series, inv.number);
  const nkNoSeries = numberKey('', inv.number);
  if (nk.length >= 3 && keys.has(nk)) { score += 50; ev.push(`Mokėjimo paskirtyje nurodytas sąskaitos numeris ${inv.series} ${inv.number}.`); }
  else if (nkNoSeries.length >= 4 && keys.has(nkNoSeries)) { score += 35; ev.push(`Paskirtyje rastas numeris ${inv.number} (be serijos).`); }
  if (inv.payment_reference && fold(t.reference).includes(fold(inv.payment_reference)) && inv.payment_reference.length > 4) { score += 20; ev.push('Sutampa mokėjimo paskirtis.'); }
  if (inv.order_reference && ref.includes(inv.order_reference.toUpperCase().replace(/[^A-Z0-9]/g, '')) && inv.order_reference.length >= 3) { score += 25; ev.push(`Paskirtyje nurodytas užsakymas ${inv.order_reference}.`); }
  if (cp) {
    if (cp.iban && t.counterparty_iban && normalizeIban(cp.iban) === t.counterparty_iban) { score += 30; ev.push(`Mokėtojo/gavėjo sąskaita ${t.counterparty_iban} sutampa su kontrahento.`); }
    else if (t.counterparty_name && normalizeName(cp.name) && (normalizeName(t.counterparty_name) === normalizeName(cp.name) || normalizeName(t.counterparty_name).includes(normalizeName(cp.name)))) { score += 20; ev.push(`Mokėtojo pavadinimas atitinka „${cp.name}“.`); }
  }
  const amt = money.abs(t.amount), out = money.abs(inv.outstanding);
  if (money.eq(amt, out)) { score += 25; ev.push(`Suma ${amt} lygi neapmokėtam likučiui.`); }
  else if (money.cmp(amt, out) < 0) { score += 3; ev.push(`Suma ${amt} mažesnė už likutį ${out} (dalinis mokėjimas?).`); }
  return {score, evidence: ev};
}

/** Build a suggestion for one transaction (never posts). */
export async function suggest(db, t) {
  const roles = await roleAccounts(db);
  const own = (await db.query('SELECT id, iban, name FROM bank_accounts WHERE id<>$1', [t.bank_account_id])).rows;
  const incoming = money.sign(t.amount) > 0;
  const text = fold(`${t.counterparty_name} ${t.reference} ${t.description}`);
  const base = {kind: 'none', status: 'none', allocations: [], candidates: [], explanation: ''};
  if (t.counterparty_iban && own.some((o) => o.iban === t.counterparty_iban)) {
    const o = own.find((x) => x.iban === t.counterparty_iban);
    return {...base, kind: 'own_transfer', status: 'proposed', explanation: `Kita sandorio pusė – jūsų sąskaita ${o.name} (${o.iban}). Pervedimas tarp savų sąskaitų per tarpinę sąskaitą ${roles.transfer_clearing}.`,
      allocations: [{kind: 'own_transfer', amount: money.norm(t.amount), accountCode: roles.transfer_clearing, note: `Vidinis pervedimas ${o.iban}`, evidence: ['Sąskaita priklauso įmonei.']}]};
  }
  // Bank fee: small, described as a fee, not a tax, and not a payment to someone (no counterparty account, or the bank).
  const toSomeone = !!t.counterparty_iban && !/bank|banka/.test(fold(t.counterparty_name || ''));
  if (!incoming && FEE_RE.test(text) && !TAX_RE.test(text) && !toSomeone && money.cmp(money.abs(t.amount), '100') <= 0) {
    return {...base, kind: 'fee', status: 'proposed', explanation: 'Banko paslaugų mokestis (pagal aprašymą). Banko mokesčiams PVM netaikomas; išrašas nėra PVM sąskaita.',
      allocations: [{kind: 'fee', amount: money.abs(t.amount), accountCode: roles.bank_fees, note: 'Banko mokestis', evidence: [`Aprašyme: „${(t.reference || t.description).slice(0, 80)}“.`]}]};
  }
  const open = await openInvoicesFor(db, t);
  const cps = new Map((await db.query('SELECT id, name, iban, company_code FROM counterparties WHERE id = ANY($1::bigint[])', [[...new Set(open.map((i) => i.counterparty_id))]])).rows.map((c) => [String(c.id), c]));
  const scored = open.map((inv) => ({inv, ...scoreInvoice(t, inv, cps.get(String(inv.counterparty_id)))})).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (a.inv.issue_date < b.inv.issue_date ? -1 : 1));
  const candidates = scored.slice(0, 10).map((x) => ({invoiceId: String(x.inv.id), label: `${x.inv.series} ${x.inv.number}`.trim(), counterparty: x.inv.counterparty_name, register: x.inv.register, issueDate: x.inv.issue_date, outstanding: x.inv.outstanding, score: x.score, evidence: x.evidence}));
  const amount = money.abs(t.amount);
  // Processor payouts: settlement net of fees.
  if (incoming && PROCESSORS.test(t.counterparty_name || '')) {
    const byNumber = scored.filter((x) => x.evidence.some((e) => /numeris|užsakymas/.test(e)));
    const pool = byNumber.length ? byNumber : scored.length ? scored : open.filter((i) => i.register === 'sales' && i.store_id).map((inv) => ({inv, score: 0, evidence: []}));
    const fit = pool.filter((x) => money.cmp(x.inv.outstanding, amount) >= 0 && money.cmp(money.sub(x.inv.outstanding, amount), money.vat(x.inv.outstanding, '10')) <= 0);
    if (fit.length === 1) {
      const inv = fit[0].inv, fee = money.sub(inv.outstanding, amount);
      return {...base, kind: 'processor_payout', status: 'proposed', candidates,
        explanation: `Mokėjimų tarpininko išmoka: sąskaita ${inv.series} ${inv.number} (${inv.outstanding}) atėmus tarpininko mokestį ${fee}.`,
        allocations: [{kind: 'invoice', invoiceId: String(inv.id), label: `${inv.series} ${inv.number}`.trim(), amount: inv.outstanding, evidence: [...fit[0].evidence, 'Vienintelė sąskaita, kurios likutis atitinka išmoką atėmus ≤10 % mokestį.']},
          ...(money.isZero(fee) ? [] : [{kind: 'fee', amount: fee, accountCode: roles.processor_fees, note: 'Mokėjimų tarpininko mokestis', evidence: ['Skirtumas tarp sąskaitos likučio ir išmokos.']}])]};
    }
    return {...base, kind: 'processor_payout', status: fit.length > 1 ? 'ambiguous' : 'none', candidates, explanation: fit.length > 1 ? 'Kelios sąskaitos tinka išmokai – pasirinkite rankiniu būdu.' : 'Tarpininko išmoka: nepavyko automatiškai susieti su sąskaitomis. Pasirinkite sąskaitas ir mokestį.'};
  }
  if (!scored.length) return {...base, explanation: incoming ? 'Atitinkančių neapmokėtų sąskaitų nerasta. Palikite nesuderintą, kol gausite sąskaitą, arba pažymėkite kaip avansą (tarpinė sąskaita).' : 'Atitinkančių neapmokėtų sąskaitų nerasta. Jei tai išlaidos be sąskaitos – paprašykite patvirtinančio dokumento.'};
  // 1) Explicit invoice numbers in the payment reference → allocate in order.
  const numbered = scored.filter((x) => x.evidence.some((e) => /numeris/.test(e)));
  const allocate = (list) => {
    let left = amount;
    const out = [];
    for (const x of list) {
      if (money.isZero(left)) break;
      const take = money.min(left, money.abs(x.inv.outstanding));
      const signed = money.sign(x.inv.outstanding) < 0 ? money.neg(take) : take;
      out.push({kind: 'invoice', invoiceId: String(x.inv.id), label: `${x.inv.series} ${x.inv.number}`.trim(), amount: signed, evidence: x.evidence});
      left = money.sub(left, take);
    }
    if (!money.isZero(left)) out.push({kind: 'overpayment', amount: incoming ? left : money.neg(left), accountCode: incoming ? roles.advances_received : roles.advances_paid, note: 'Permoka – lieka kaip avansas', evidence: ['Suma viršija nurodytų sąskaitų likučius.']});
    return out;
  };
  if (numbered.length) {
    const sameTop = numbered.filter((x) => x.score === numbered[0].score);
    const distinctNumbers = new Set(numbered.map((x) => numberKey(x.inv.series, x.inv.number)));
    if (distinctNumbers.size < numbered.length && sameTop.length > 1) return {...base, kind: 'invoice', status: 'ambiguous', candidates, explanation: 'Paskirtyje nurodytas numeris atitinka kelias sąskaitas – pasirinkite.'};
    return {...base, kind: 'invoice', status: 'proposed', candidates, allocations: allocate(numbered), explanation: `Susieta pagal paskirtyje nurodytus numerius (${numbered.length}).`};
  }
  // 2) Counterparty identified: exact single amount match, or all open invoices summing to the amount.
  const top = scored[0];
  const identified = scored.filter((x) => x.evidence.some((e) => /sąskaita .* sutampa|pavadinimas atitinka/.test(e)));
  const exact = scored.filter((x) => money.eq(money.abs(x.inv.outstanding), amount));
  const exactIdentified = exact.filter((x) => identified.includes(x));
  if (exactIdentified.length === 1) return {...base, kind: 'invoice', status: 'proposed', candidates, allocations: allocate(exactIdentified), explanation: 'Sutampa kontrahentas ir suma.'};
  if (exactIdentified.length > 1 || (exact.length > 1 && !identified.length)) return {...base, kind: 'invoice', status: 'ambiguous', candidates, explanation: `Kelios sąskaitos (${Math.max(exactIdentified.length, exact.length)}) turi tokią pačią sumą ir nėra papildomų įrodymų – pasirinkite, kurią apmoka šis mokėjimas.`};
  if (identified.length > 1 && identified.length <= 10) {
    const sum = money.sum(identified.map((x) => money.abs(x.inv.outstanding)));
    if (money.eq(sum, amount)) return {...base, kind: 'invoice', status: 'proposed', candidates, allocations: allocate(identified), explanation: `Suma lygi visų ${identified.length} kontrahento neapmokėtų sąskaitų sumai.`};
  }
  if (identified.length === 1 && money.cmp(amount, money.abs(identified[0].inv.outstanding)) < 0) return {...base, kind: 'invoice', status: 'proposed', candidates, allocations: allocate(identified), explanation: 'Dalinis mokėjimas vienintelei kontrahento neapmokėtai sąskaitai.'};
  return {...base, kind: 'invoice', status: top.score >= 25 ? 'ambiguous' : 'none', candidates, explanation: 'Yra galimų sąskaitų, bet įrodymų nepakanka – pasirinkite rankiniu būdu.'};
}

/** Server-side validation and journal lines for a reconciliation proposal. */
export async function computeRecon(db, t, data) {
  const issues = [];
  const err = (m, code) => issues.push({level: 'error', message: m, code});
  const info = (m, code) => issues.push({level: 'info', message: m, code});
  const roles = await roleAccounts(db);
  const acct = (await db.query('SELECT * FROM bank_accounts WHERE id=$1', [t.bank_account_id])).rows[0];
  const stmt = (await db.query(`SELECT s.* FROM bank_statements s JOIN statement_coverage c ON c.statement_id=s.id WHERE c.transaction_id=$1 ORDER BY s.id`, [t.id])).rows;
  const company = (await db.query('SELECT locked_through FROM company_settings WHERE id=1')).rows[0];
  if (t.status === 'approved' && data.kind !== 'advance_application') err('Operacija jau suderinta.', 'approved');
  if (t.status === 'ignored') err('Operacija pažymėta kaip dublikatas/ignoruojama.', 'ignored');
  if (t.duplicate_review) err(`Neišspręsta dublikato peržiūra: ${t.duplicate_note || ''}`, 'duplicate_review');
  for (const s of stmt) if (s.balance_status !== 'ok' && !s.resolved_at) err(`Išrašo #${s.id} likučiai neatitinka arba trūksta (${s.balance_status === 'missing' ? 'nėra likučių' : 'neatitikimas'}). Pataisykite arba įgaliotas naudotojas turi patvirtinti su pastaba.`, 'statement_unresolved');
  if (company.locked_through && t.booking_date <= company.locked_through) err(`Operacijos data patenka į užrakintą laikotarpį (iki ${company.locked_through}).`, 'period_locked');
  if (data.status === 'ambiguous' && !data.userChosen) err('Atitikmuo neaiškus – pasirinkite sąskaitas rankiniu būdu.', 'ambiguous');
  const allocs = data.allocations || [];
  if (!allocs.length) err('Nėra paskirstymo. Pasirinkite sąskaitą(-as) arba operacijos tipą.', 'empty');
  const invIds = allocs.filter((a) => a.kind === 'invoice').map((a) => a.invoiceId);
  const balances = invIds.length ? await invoiceBalances(db, {ids: invIds}) : [];
  const byId = new Map(balances.map((b) => [String(b.id), b]));
  // Foreign-currency account: the ledger is in EUR at the rate of the booking date.
  let txRate = null;
  if (t.currency !== 'EUR') {
    const r = await rateFor(db, t.currency, String(t.booking_date instanceof Date ? t.booking_date.toISOString() : t.booking_date).slice(0, 10));
    if (!r) err(`Nėra ${t.currency} kurso ${t.booking_date} datai – atnaujinkite valiutų kursus.`, 'fx_rate'); else txRate = r.rate;
  }
  const eur = (v) => (txRate ? toEur(v, txRate) : money.norm(v));
  const tEur = t.currency === 'EUR' ? money.norm(t.amount) : (txRate ? eur(t.amount) : money.norm(t.amount));
  const lines = [{account: acct.ledger_account, debit: money.sign(tEur) > 0 ? tEur : '0', credit: money.sign(tEur) < 0 ? money.abs(tEur) : '0', description: `Banko operacija ${t.booking_date}${txRate ? ` (${money.norm(t.amount)} ${t.currency}, kursas ${txRate})` : ''}`}];
  let effect = '0.00', eurPosted = '0.00', fxDiff = '0.00';
  const results = [];
  const seen = new Set();
  for (const [i, a] of allocs.entries()) {
    const n = i + 1;
    if (!KINDS.includes(a.kind)) { err(`${n}: netinkamas paskirstymo tipas.`, 'kind'); continue; }
    if (!/^-?\d+(\.\d{1,2})?$/.test(String(a.amount || '')) || money.isZero(a.amount)) { err(`${n}: netinkama suma.`, 'amount'); continue; }
    let account, cpId = null, reg = null;
    if (a.kind === 'invoice') {
      const b = byId.get(String(a.invoiceId));
      if (!b) { err(`${n}: sąskaita nerasta (galbūt pasikeitė).`, 'invoice'); continue; }
      if (seen.has(String(a.invoiceId))) err(`${n}: ta pati sąskaita nurodyta du kartus.`, 'dup_invoice');
      seen.add(String(a.invoiceId));
      reg = b.register; cpId = b.counterparty_id;
      account = reg === 'sales' ? roles.receivable : roles.payable;
      if (b.currency !== 'EUR') {
        // Invoice in another currency: settle a part of its own-currency balance, clear the matching part of its EUR
        // balance, the difference to the EUR actually paid is an exchange difference (5803 gain / 6803 loss).
        if (t.currency !== 'EUR' && t.currency !== b.currency) { err(`${n}: valiuta nesutampa (${t.currency} ir ${b.currency}).`, 'currency'); continue; }
        const orig = t.currency === b.currency ? money.norm(a.amount) : money.norm(a.origAmount || b.orig_outstanding);
        if (money.sign(orig) !== money.sign(b.orig_outstanding) || money.cmp(money.abs(orig), money.abs(b.orig_outstanding)) > 0) err(`${n}: ${orig} ${b.currency} viršija sąskaitos ${b.series} ${b.number} likutį ${money.norm(b.orig_outstanding)} ${b.currency}.`, 'exceeds');
        if (money.sign(a.amount) !== money.sign(b.outstanding)) err(`${n}: sumos ženklas neatitinka sąskaitos likučio.`, 'exceeds');
        const cleared = money.eq(orig, b.orig_outstanding) ? money.norm(b.outstanding)
          : fromUnits(divRound(toUnits(b.outstanding, 2) * toUnits(orig, 2), toUnits(b.orig_outstanding, 2) || 1n), 2);
        const eff = cashEffect(a, reg), effEur = eur(eff);
        const clearedEffect = reg === 'sales' ? cleared : money.neg(cleared);
        effect = money.add(effect, eff); eurPosted = money.add(eurPosted, effEur);
        fxDiff = money.add(fxDiff, money.sub(effEur, clearedEffect));
        const amt = money.neg(clearedEffect);
        lines.push({account, debit: money.sign(amt) > 0 ? amt : '0', credit: money.sign(amt) < 0 ? money.abs(amt) : '0', counterpartyId: cpId, description: `${b.series || ''} ${b.number} (${orig} ${b.currency})`.trim()});
        results.push({cleared, origAmount: orig});
        info(`${b.series || ''} ${b.number}: apmokama ${orig} ${b.currency}, iš skolos nurašoma ${cleared} EUR; kursų skirtumas ${money.sub(effEur, clearedEffect)} EUR.`, 'fx_settlement');
        continue;
      }
      if (b.currency !== t.currency) err(`${n}: valiuta nesutampa.`, 'currency');
      if (money.sign(a.amount) !== money.sign(b.outstanding) || money.cmp(money.abs(a.amount), money.abs(b.outstanding)) > 0) err(`${n}: suma ${a.amount} viršija sąskaitos ${b.series} ${b.number} likutį ${b.outstanding} arba yra priešingo ženklo. Perteklių priskirkite permokai.`, 'exceeds');
    } else if (a.kind === 'fee') {
      if (money.sign(a.amount) < 0) err(`${n}: mokestis turi būti teigiamas.`, 'fee');
      account = a.accountCode || roles.bank_fees;
    } else if (a.kind === 'own_transfer') account = roles.transfer_clearing;
    else if (a.kind === 'advance' || a.kind === 'overpayment') account = money.sign(a.amount) > 0 ? roles.advances_received : roles.advances_paid;
    else if (a.kind === 'other') {
      account = a.accountCode;
      if (!account) err(`${n}: pasirinkite sąskaitą.`, 'account');
      if (!String(a.note || '').trim()) err(`${n}: kitoms operacijoms būtina pastaba (kas tai per operacija).`, 'note');
      info('Banko išrašas nėra PVM sąskaita faktūra: PVM neatskaitomas, sąnaudoms reikalingas patvirtinantis dokumentas.', 'no_vat');
    }
    if (['advance', 'overpayment', 'own_transfer', 'other'].includes(a.kind) && money.sign(a.amount) !== money.sign(t.amount)) err(`${n}: sumos ženklas turi sutapti su operacijos kryptimi.`, 'sign');
    if (a.kind === 'advance' && !a.counterpartyId) info('Avansas be nurodyto kontrahento – vėliau jį pritaikant teks pasirinkti kontrahentą.', 'advance_cp');
    const eff = cashEffect(a, reg), effEur = eur(eff);
    effect = money.add(effect, eff); eurPosted = money.add(eurPosted, effEur);
    const amt = money.neg(effEur);
    lines.push({account, debit: money.sign(amt) > 0 ? amt : '0', credit: money.sign(amt) < 0 ? money.abs(amt) : '0', counterpartyId: cpId || a.counterpartyId || null, description: a.note || a.label || a.kind});
    results.push({cleared: a.kind === 'invoice' ? money.norm(a.amount) : null, origAmount: null});
  }
  if (!money.eq(effect, t.amount)) err(`Paskirstyta ${effect}, o operacijos suma ${t.amount} (skirtumas ${money.sub(t.amount, effect)}).`, 'unallocated');
  // Exchange differences (and cent rounding of a foreign-currency account) to 5803 / 6803.
  if (txRate) fxDiff = money.add(fxDiff, money.sub(tEur, eurPosted));
  if (!money.isZero(fxDiff)) {
    // Like every allocation the difference posts −effect: a credit is a gain (5803), a debit a loss (6803).
    const amt = money.neg(fxDiff), gain = money.sign(amt) < 0;
    lines.push({account: gain ? (roles.fx_gain || '5803') : (roles.fx_loss || '6803'), debit: gain ? '0' : money.abs(amt), credit: gain ? money.abs(amt) : '0', description: 'Valiutų kursų skirtumas'});
  }
  if (allocs.some((a) => a.kind === 'invoice')) info('Apmokėjimas mažina pirkėjų/tiekėjų skolą – naujų pajamų, sąnaudų ar PVM įrašų nekuria.', 'settlement');
  if (data.kind === 'advance' || allocs.some((a) => a.kind === 'advance')) info(`Avansas registruojamas tarpinėje sąskaitoje; gavus sąskaitą jį pritaikysite be naujo pinigų judėjimo.`, 'advance');
  return {issues, blocking: issues.some((i) => i.level === 'error'), entries: lines, results, txRate, tEur};
}

async function createReconVersion(db, t, data, userId) {
  const prev = (await db.query('SELECT max(version) AS v FROM reconciliation_proposals WHERE transaction_id=$1', [t.id])).rows[0];
  await db.query(`UPDATE reconciliation_proposals SET status='superseded' WHERE transaction_id=$1 AND status='open'`, [t.id]);
  const c = await computeRecon(db, t, data);
  const row = (await db.query(`INSERT INTO reconciliation_proposals(transaction_id, version, data, validation, blocking, content_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [t.id, Number(prev.v || 0) + 1, data, {issues: c.issues, entries: c.entries}, c.blocking, contentHash(data), userId])).rows[0];
  if (t.status !== 'approved' && t.status !== 'ignored') {
    const status = !data.allocations?.length ? 'unmatched' : c.blocking ? 'needs_review' : 'proposed';
    await db.query('UPDATE bank_transactions SET status=$2 WHERE id=$1', [t.id, status]);
  }
  return row;
}

export async function proposeForTransaction(db, t, {userId = null} = {}) {
  const s = await suggest(db, t);
  return createReconVersion(db, t, {...s, source: 'suggestion'}, userId);
}

function sanitizeAllocations(list) {
  if (!Array.isArray(list) || list.length > 50) throw new AppError(400, 'bad_allocations', 'Netinkamas paskirstymas.');
  return list.map((a) => ({kind: String(a.kind), invoiceId: a.invoiceId ? String(a.invoiceId) : undefined, amount: String(a.amount || '').replace(',', '.').trim(),
    accountCode: a.accountCode ? String(a.accountCode).slice(0, 8) : undefined, counterpartyId: a.counterpartyId ? String(a.counterpartyId) : undefined,
    origAmount: a.origAmount ? String(a.origAmount).replace(',', '.').trim() : undefined, note: String(a.note || '').slice(0, 300), label: a.label ? String(a.label).slice(0, 100) : undefined, evidence: Array.isArray(a.evidence) ? a.evidence.slice(0, 10).map((e) => String(e).slice(0, 300)) : ['Pasirinkta naudotojo.']}));
}

export async function editRecon(pool, user, txId, {contentHash: base, allocations, kind}) {
  requireCap(user, 'write');
  return tx(pool, async (db) => {
    const t = (await db.query('SELECT * FROM bank_transactions WHERE id=$1 FOR UPDATE', [txId])).rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Operacija nerasta.');
    const cur = (await db.query(`SELECT * FROM reconciliation_proposals WHERE transaction_id=$1 AND status='open'`, [txId])).rows[0];
    if (cur && cur.content_hash !== base) throw new AppError(409, 'stale', 'Pasiūlymas pasikeitė. Atnaujinkite.');
    const data = {...(cur?.data || {}), kind: kind || cur?.data?.kind || 'invoice', allocations: sanitizeAllocations(allocations), userChosen: true, source: 'user', status: 'user'};
    const row = await createReconVersion(db, t, data, user.id);
    await audit(db, {userId: user.id, action: 'recon.edit', entityType: 'bank_transaction', entityId: txId, details: {proposalId: row.id, version: row.version}});
    return row;
  });
}

export async function approveRecon(pool, user, txId, {contentHash: hash}) {
  requireCap(user, 'approve');
  return tx(pool, async (db) => {
    const t = (await db.query('SELECT * FROM bank_transactions WHERE id=$1 FOR UPDATE', [txId])).rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Operacija nerasta.');
    const p = (await db.query(`SELECT * FROM reconciliation_proposals WHERE transaction_id=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE`, [txId])).rows[0];
    if (p?.status === 'approved' && p.content_hash === hash) return {alreadyApproved: true, proposalId: p.id};
    if (!p || p.status !== 'open' || p.content_hash !== hash) throw new AppError(409, 'stale', 'Peržiūrėta versija nebegalioja. Atnaujinkite.');
    const c = await computeRecon(db, t, p.data);
    if (c.blocking) throw new AppError(422, 'validation', 'Suderinimas turi neišspręstų klaidų.', {issues: c.issues.filter((i) => i.level === 'error')});
    const entry = await postEntry(db, {date: t.booking_date, description: `Bankas: ${t.counterparty_name || ''} ${t.reference || ''}`.trim().slice(0, 300), sourceType: 'bank', sourceId: t.id, idempotencyKey: `recon:${p.id}`, userId: user.id, lines: c.entries});
    for (const [i, a] of p.data.allocations.entries()) {
      const inv = a.kind === 'invoice' ? (await db.query('SELECT counterparty_id FROM invoices WHERE id=$1', [a.invoiceId])).rows[0] : null;
      const r = c.results[i] || {};
      // Invoice allocations record the EUR amount cleared from the invoice (and, for another currency, the part settled in it).
      const amount = a.kind === 'invoice' && r.cleared ? r.cleared : (c.txRate ? toEur(a.amount, c.txRate) : a.amount);
      await db.query(`INSERT INTO allocations(transaction_id, proposal_id, kind, invoice_id, counterparty_id, account_code, amount, orig_amount, journal_entry_id, note, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [t.id, p.id, a.kind, a.invoiceId || null, inv?.counterparty_id || a.counterpartyId || null, a.accountCode || null, amount, r.origAmount || null, entry.id, a.note || '', user.id]);
    }
    if (c.txRate) await db.query('UPDATE bank_transactions SET eur_amount=$2, fx_rate=$3 WHERE id=$1', [t.id, c.tEur, c.txRate]);
    await db.query(`UPDATE reconciliation_proposals SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`, [p.id, user.id]);
    await db.query(`UPDATE bank_transactions SET status='approved' WHERE id=$1`, [t.id]);
    await audit(db, {userId: user.id, action: 'recon.approve', entityType: 'bank_transaction', entityId: t.id, details: {proposalId: p.id, version: p.version, journalEntryId: entry.id, allocations: p.data.allocations.map((a) => ({kind: a.kind, invoiceId: a.invoiceId, amount: a.amount}))}});
    return {journalEntryId: entry.id, proposalId: p.id};
  });
}

/** Apply an approved advance to an invoice that arrived later: no new cash movement. */
export async function applyAdvance(pool, user, allocationId, {invoiceId, amount}) {
  requireCap(user, 'approve');
  return tx(pool, async (db) => {
    const adv = (await db.query(`SELECT a.*, t.booking_date FROM allocations a JOIN bank_transactions t ON t.id=a.transaction_id WHERE a.id=$1 AND a.kind IN ('advance','overpayment') FOR UPDATE OF a`, [allocationId])).rows[0];
    if (!adv) throw new AppError(404, 'not_found', 'Avansas nerastas.');
    const used = (await db.query(`SELECT coalesce(sum(amount),0) AS v FROM allocations WHERE source_allocation_id=$1`, [adv.id])).rows[0].v;
    const remaining = money.sub(money.abs(adv.amount), money.abs(used));
    const b = (await invoiceBalances(db, {ids: [invoiceId]}))[0];
    if (!b) throw new AppError(404, 'not_found', 'Sąskaita nerasta.');
    const incoming = money.sign(adv.amount) > 0;
    if ((incoming && b.register !== 'sales') || (!incoming && b.register !== 'purchase')) throw new AppError(422, 'register', 'Avanso kryptis neatitinka sąskaitos registro.');
    const amt = money.norm(String(amount || remaining).replace(',', '.'));
    if (money.sign(amt) <= 0 || money.cmp(amt, remaining) > 0 || money.cmp(amt, b.outstanding) > 0) throw new AppError(422, 'amount', `Suma turi būti teigiama ir neviršyti avanso likučio ${remaining} bei sąskaitos likučio ${b.outstanding}.`);
    const roles = await roleAccounts(db);
    const company = (await db.query('SELECT locked_through FROM company_settings WHERE id=1')).rows[0];
    const date = b.issue_date > adv.booking_date ? b.issue_date : adv.booking_date;
    if (company.locked_through && date <= company.locked_through) throw new AppError(409, 'period_locked', 'Laikotarpis užrakintas.');
    const lines = incoming
      ? [{account: roles.advances_received, debit: amt, credit: '0', counterpartyId: b.counterparty_id}, {account: roles.receivable, debit: '0', credit: amt, counterpartyId: b.counterparty_id}]
      : [{account: roles.payable, debit: amt, credit: '0', counterpartyId: b.counterparty_id}, {account: roles.advances_paid, debit: '0', credit: amt, counterpartyId: b.counterparty_id}];
    const n = (await db.query('SELECT count(*) AS n FROM allocations WHERE source_allocation_id=$1', [adv.id])).rows[0].n;
    const p = (await db.query(`INSERT INTO reconciliation_proposals(transaction_id, version, status, data, validation, blocking, content_hash, created_by, decided_by, decided_at)
      SELECT $1, coalesce(max(version),0)+1, 'approved', $2, '{}'::jsonb, false, $3, $4, $4, now() FROM reconciliation_proposals WHERE transaction_id=$1 RETURNING id`,
    [adv.transaction_id, {kind: 'advance_application', allocationId, invoiceId, amount: amt}, contentHash({allocationId, invoiceId, amount: amt, n}), user.id])).rows[0];
    const entry = await postEntry(db, {date, description: `Avanso pritaikymas sąskaitai ${b.series} ${b.number}`, sourceType: 'bank', sourceId: adv.transaction_id, idempotencyKey: `advance:${adv.id}:${n}`, userId: user.id, lines});
    await db.query(`INSERT INTO allocations(transaction_id, source_allocation_id, proposal_id, kind, invoice_id, counterparty_id, amount, journal_entry_id, note, approved_by) VALUES ($1,$2,$3,'advance_application',$4,$5,$6,$7,$8,$9)`,
      [adv.transaction_id, adv.id, p.id, invoiceId, b.counterparty_id, amt, entry.id, 'Avanso pritaikymas', user.id]);
    await audit(db, {userId: user.id, action: 'advance.apply', entityType: 'allocation', entityId: adv.id, details: {invoiceId, amount: amt, journalEntryId: entry.id}});
    return {journalEntryId: entry.id, remaining: money.sub(remaining, amt)};
  });
}
