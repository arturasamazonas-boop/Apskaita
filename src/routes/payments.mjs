// Mokėjimų ruošimas: SEPA payment files (pain.001) for open supplier invoices and approved payroll sheets.
import {AppError} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {readJson, SECURITY_HEADERS} from '../http.mjs';
import {audit} from '../audit.mjs';
import {money} from '../lib/money.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';
import {todayVilnius} from '../invoices/context.mjs';
import {buildPain001, checkPayments} from '../bank/sepa.mjs';
import {normalizeIban} from '../extraction/ids.mjs';

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** Open purchase invoices with what is still owed and the supplier's IBAN (card, else the invoice). */
async function payableInvoices(db, ids = null) {
  const open = (await invoiceBalances(db, {register: 'purchase', openOnly: true, ids, limit: 2000})).filter((r) => money.cmp(r.outstanding, '0') > 0);
  if (!open.length) return [];
  const extra = new Map((await db.query(`SELECT i.id, coalesce(nullif(c.iban,''), i.counterparty_snapshot->>'iban', '') AS iban, c.name AS cp_name
    FROM invoices i LEFT JOIN counterparties c ON c.id=i.counterparty_id WHERE i.id = ANY($1::bigint[])`, [open.map((r) => r.id)])).rows.map((r) => [String(r.id), r]));
  return open.map((r) => {
    const x = extra.get(String(r.id)) || {};
    return {id: String(r.id), label: `${r.series || ''} ${r.number}`.trim(), counterparty: r.counterparty_name || x.cp_name || '', iban: normalizeIban(x.iban || ''), due_date: r.due_date, issue_date: r.issue_date,
      outstanding: money.norm(r.outstanding), payment_reference: r.payment_reference || ''};
  });
}

export function register(r, {pool}) {
  r.get('/api/payments/payables', async ({user}) => { requireCap(user, 'read'); return payableInvoices(pool); });
  r.post('/api/payments/sepa', async ({req, user, res}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    const exec = isDate(b.executionDate) ? b.executionDate : todayVilnius();
    if (exec < todayVilnius()) throw new AppError(400, 'date', 'Mokėjimo data negali būti praeityje.');
    const acct = (await pool.query('SELECT * FROM bank_accounts WHERE id=$1 AND active', [b.bankAccountId])).rows[0];
    if (!acct) throw new AppError(400, 'bank_account', 'Pasirinkite banko sąskaitą, iš kurios mokama.');
    const company = (await pool.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
    let payments = [], kind;
    if (b.source === 'payroll') {
      kind = 'payroll';
      const run = (await pool.query('SELECT * FROM payroll_runs WHERE id=$1', [b.runId])).rows[0];
      if (!run) throw new AppError(404, 'not_found', 'Žiniaraštis nerastas.');
      if (run.status !== 'approved') throw new AppError(409, 'draft', 'Mokėjimus galima ruošti tik patvirtintam žiniaraščiui.');
      // Leavers paid on their own (earlier) pay date – their final pay is already settled – are left out.
      const lines = (await pool.query(`SELECT l.to_pay, e.id AS employee_id, e.first_name, e.last_name, e.iban FROM payroll_lines l JOIN employees e ON e.id=l.employee_id
        WHERE l.run_id=$1 AND l.to_pay > 0 AND (l.payment_date IS NULL OR l.payment_date >= $2::date) ORDER BY e.last_name`, [run.id, exec])).rows;
      payments = lines.map((l) => ({name: `${l.first_name} ${l.last_name}`, label: `${l.first_name} ${l.last_name}`, iban: l.iban, amount: money.norm(l.to_pay), endToEndId: `DU${run.period}E${l.employee_id}`, remittance: `Darbo užmokestis ${run.period}`}));
    } else {
      kind = 'invoices';
      const want = new Map((b.items || []).map((x) => [String(x.id), x]));
      if (!want.size) throw new AppError(400, 'items', 'Pasirinkite apmokamas sąskaitas.');
      const open = await payableInvoices(pool, [...want.keys()]);
      for (const id of want.keys()) if (!open.some((o) => o.id === id)) throw new AppError(409, 'not_open', `Sąskaita #${id} jau apmokėta arba nerasta.`);
      payments = open.map((o) => {
        const amount = want.get(o.id).amount ? String(want.get(o.id).amount).replace(',', '.') : o.outstanding;
        if (money.cmp(amount, o.outstanding) > 0) throw new AppError(400, 'amount', `${o.label}: mokama suma ${amount} viršija likutį ${o.outstanding}.`);
        return {name: o.counterparty, label: o.label, iban: want.get(o.id).iban || o.iban, amount, endToEndId: `INV${o.id}`, remittance: o.payment_reference ? `${o.payment_reference} ${o.label}` : `Saskaita ${o.label}`};
      });
    }
    if (!payments.length) throw new AppError(422, 'empty', 'Nėra ką mokėti.');
    const chk = checkPayments({iban: acct.iban}, payments);
    if (!chk.ok) throw new AppError(422, 'sepa_invalid', chk.errors.map((e) => e.message).join(' '), {errors: chk.errors});
    const created = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Vilnius', dateStyle: 'short', timeStyle: 'medium'}).format(new Date()).replace(' ', 'T');
    const msgId = `APS${created.replace(/\D/g, '')}`;
    const xml = buildPain001({msgId, created, debtor: {name: company.name, iban: acct.iban, companyCode: company.company_code}, executionDate: exec, payments, categoryPurpose: kind === 'payroll' ? 'SALA' : null});
    await audit(pool, {userId: user.id, action: 'payments.sepa', entityType: kind === 'payroll' ? 'payroll_run' : 'invoice', entityId: kind === 'payroll' ? String(b.runId) : payments.map((p) => p.endToEndId).join(','),
      details: {msgId, count: payments.length, total: money.sum(payments.map((p) => p.amount)), executionDate: exec, bankAccount: acct.iban}});
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="mokejimai_${kind}_${exec}.xml"`, 'Cache-Control': 'no-store'});
    res.end(xml);
  });
}
