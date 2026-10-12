// Valiutų kursai (Lietuvos bankas) ir valiutinių straipsnių perkainojimas.
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {readJson} from '../http.mjs';
import {audit} from '../audit.mjs';
import {todayVilnius} from '../invoices/context.mjs';
import {fetchRatesForDate, fetchCurrencyHistory, setManualRate, rateFor} from '../fx/rates.mjs';
import {revaluationPreview, postRevaluation, cancelRevaluation} from '../fx/revaluation.mjs';

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

export function register(r, {pool, config}) {
  r.get('/api/fx/rates', async ({user, query}) => {
    requireCap(user, 'read');
    const to = isDate(query.to) ? query.to : todayVilnius(), from = isDate(query.from) ? query.from : to;
    const ccy = /^[A-Z]{3}$/.test(query.currency || '') ? query.currency : null;
    const rows = (await pool.query(`SELECT currency, rate_date, rate, source FROM fx_rates WHERE rate_date BETWEEN $1 AND $2 ${ccy ? 'AND currency=$3' : ''} ORDER BY rate_date DESC, currency LIMIT 3000`, ccy ? [from, to, ccy] : [from, to])).rows;
    // Currencies in use: invoices and bank accounts in a currency other than EUR.
    const used = (await pool.query(`SELECT DISTINCT currency FROM invoices WHERE currency <> 'EUR' UNION SELECT DISTINCT currency FROM bank_accounts WHERE currency <> 'EUR' ORDER BY 1`)).rows.map((x) => x.currency.trim());
    return {from, to, rows: rows.map((x) => ({...x, rate: String(Number(x.rate)), rate_date: String(x.rate_date instanceof Date ? x.rate_date.toISOString() : x.rate_date).slice(0, 10)})), used, online: !!config.fxUrl};
  });
  r.get('/api/fx/rate', async ({user, query}) => {
    requireCap(user, 'read');
    if (!/^[A-Z]{3}$/.test(query.currency || '') || !isDate(query.date)) throw new AppError(400, 'params', 'Nurodykite valiutą ir datą.');
    const x = await rateFor(pool, query.currency, query.date);
    if (!x) throw new AppError(404, 'not_found', `Nėra ${query.currency} kurso ${query.date} datai.`);
    return x;
  });
  r.post('/api/fx/fetch', async ({req, user}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    const res = b.currency && b.from ? await fetchCurrencyHistory(pool, config.fxUrl, String(b.currency), b.from, b.to || b.from) : await fetchRatesForDate(pool, config.fxUrl, isDate(b.date) ? b.date : todayVilnius());
    await audit(pool, {userId: user.id, action: 'fx.fetch', entityType: 'fx_rates', entityId: b.currency || b.date || 'today', details: res});
    return res;
  });
  r.put('/api/fx/rates', async ({req, user}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    await setManualRate(pool, {currency: String(b.currency || '').toUpperCase(), date: b.date, rate: b.rate});
    await audit(pool, {userId: user.id, action: 'fx.manual_rate', entityType: 'fx_rates', entityId: `${b.currency}:${b.date}`, details: {rate: b.rate}});
    return {ok: true};
  });
  r.get('/api/fx/revaluation', async ({user, query}) => {
    requireCap(user, 'read');
    if (!isDate(query.asOf)) throw new AppError(400, 'date', 'Nurodykite datą.');
    return revaluationPreview(pool, query.asOf);
  });
  r.get('/api/fx/revaluations', async ({user}) => {
    requireCap(user, 'read');
    return (await pool.query(`SELECT id, as_of, status, gain, loss, journal_entry_id, jsonb_array_length(lines) AS items, created_at FROM fx_revaluations ORDER BY as_of DESC, id DESC LIMIT 200`)).rows;
  });
  r.post('/api/fx/revaluations', async ({req, user}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    if (!isDate(b.asOf)) throw new AppError(400, 'date', 'Nurodykite datą.');
    return tx(pool, async (db) => {
      const res = await postRevaluation(db, user, b.asOf);
      await audit(db, {userId: user.id, action: 'fx.revaluation', entityType: 'fx_revaluation', entityId: res.id, details: {asOf: b.asOf, gain: res.gain, loss: res.loss}});
      return res;
    });
  });
  r.post('/api/fx/revaluations/:id/cancel', async ({req, user, params}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    if (String(b.reason || '').trim().length < 5) throw new AppError(400, 'reason', 'Nurodykite priežastį.');
    return tx(pool, async (db) => {
      const res = await cancelRevaluation(db, user, params.id, String(b.reason).slice(0, 200));
      await audit(db, {userId: user.id, action: 'fx.revaluation_cancel', entityType: 'fx_revaluation', entityId: params.id, details: {reason: b.reason}});
      return res;
    });
  });
}
