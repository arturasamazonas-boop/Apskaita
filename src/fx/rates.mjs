// Euro foreign exchange rates from Lietuvos bankas (FxRates web service, type EU: ECB reference rates and the bank's own
// rates for other currencies), stored by publication date. A rate is "units of the currency for 1 EUR".
import {AppError} from '../db.mjs';
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';

let DEFAULT_URL = '';
/** Set once at start-up from the configuration (FX_URL). */
export const configureFx = (url) => { DEFAULT_URL = url || ''; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const CCY = /^[A-Z]{3}$/;

/** <FxRates><FxRate><Dt>…</Dt><CcyAmt><Ccy>EUR</Ccy><Amt>1</Amt></CcyAmt><CcyAmt><Ccy>USD</Ccy><Amt>1.12</Amt></CcyAmt></FxRate>… */
export function parseLbRates(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<FxRate>([\s\S]*?)<\/FxRate>/g)) {
    const date = (m[1].match(/<Dt>(\d{4}-\d{2}-\d{2})<\/Dt>/) || [])[1];
    for (const c of m[1].matchAll(/<Ccy>([A-Z]{3})<\/Ccy>\s*<Amt>([\d.]+)<\/Amt>/g)) {
      if (c[1] !== 'EUR' && date && Number(c[2]) > 0) out.push({currency: c[1], date, rate: c[2]});
    }
  }
  if (!out.length && /<OprlErr>/.test(xml)) throw new AppError(502, 'lb_error', `Lietuvos bankas: ${(xml.match(/<Desc>([^<]*)<\/Desc>/) || [])[1] || 'klaida'}`);
  return out;
}

async function store(db, rows, source = 'LB') {
  let n = 0;
  for (const r of rows) {
    const res = await db.query(`INSERT INTO fx_rates(currency, rate_date, rate, source) VALUES ($1,$2,$3,$4)
      ON CONFLICT (currency, rate_date) DO UPDATE SET rate=EXCLUDED.rate, source=EXCLUDED.source, fetched_at=now() WHERE fx_rates.source <> 'manual'`, [r.currency, r.date, r.rate, source]);
    n += res.rowCount;
  }
  return n;
}

async function lbGet(baseUrl, path) {
  if (!baseUrl) throw new AppError(503, 'fx_offline', 'Kursų gavimas iš Lietuvos banko išjungtas (FX_URL). Įveskite kursą ranka.');
  let res;
  try { res = await fetch(`${baseUrl}/${path}`, {signal: AbortSignal.timeout(20000)}); } catch (e) { throw new AppError(502, 'fx_unreachable', `Lietuvos banko kursų paslauga nepasiekiama: ${e.message}`); }
  if (!res.ok) throw new AppError(502, 'fx_http', `Lietuvos banko kursų paslauga grąžino ${res.status}.`);
  return parseLbRates(await res.text());
}

/** All currencies for a date (LB returns the latest published rate of each currency up to that date). */
export async function fetchRatesForDate(db, baseUrl, date) {
  if (!isDate(date)) throw new AppError(400, 'date', 'Netinkama data.');
  const rows = await lbGet(baseUrl, `getFxRates?tp=EU&dt=${date}`);
  return {fetched: rows.length, stored: await store(db, rows)};
}

/** One currency over a period. */
export async function fetchCurrencyHistory(db, baseUrl, currency, from, to) {
  if (!CCY.test(currency) || !isDate(from) || !isDate(to) || from > to) throw new AppError(400, 'period', 'Nurodykite valiutą ir laikotarpį.');
  const rows = (await lbGet(baseUrl, `getFxRatesForCurrency?tp=EU&ccy=${currency}&dtFrom=${from}&dtTo=${to}`)).filter((r) => r.currency === currency);
  return {fetched: rows.length, stored: await store(db, rows)};
}

export async function setManualRate(db, {currency, date, rate}) {
  if (!CCY.test(currency) || currency === 'EUR') throw new AppError(400, 'currency', 'Valiutos kodas – 3 raidės (ne EUR).');
  if (!isDate(date)) throw new AppError(400, 'date', 'Netinkama data.');
  const r = String(rate).replace(',', '.').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(r) || Number(r) <= 0) throw new AppError(400, 'rate', 'Kursas – teigiamas skaičius (valiutos vienetų už 1 EUR).');
  await db.query(`INSERT INTO fx_rates(currency, rate_date, rate, source) VALUES ($1,$2,$3,'manual') ON CONFLICT (currency, rate_date) DO UPDATE SET rate=EXCLUDED.rate, source='manual', fetched_at=now()`, [currency, date, r]);
}

/**
 * Rate for a currency on a date: the latest rate published on or before it (weekends and holidays use the last
 * working day, as in accounting practice). If missing (or older than 7 days) and fetching is enabled, asks LB first.
 */
export async function rateFor(db, currency, date, {baseUrl = DEFAULT_URL, fetchMissing = true} = {}) {
  if (!currency || currency === 'EUR') return {rate: '1', date, source: 'EUR'};
  const q = async () => (await db.query(`SELECT rate, rate_date, source FROM fx_rates WHERE currency=$1 AND rate_date <= $2 ORDER BY rate_date DESC LIMIT 1`, [currency, date])).rows[0];
  let row = await q();
  const stale = (r) => !r || (Date.parse(date) - Date.parse(r.rate_date)) / 86400000 > 7;
  if (stale(row) && fetchMissing && baseUrl) {
    try { await fetchRatesForDate(db, baseUrl, date); row = await q(); } catch { /* keep what we have */ }
  }
  if (!row) return null;
  return {rate: String(Number(row.rate)), date: String(row.rate_date instanceof Date ? row.rate_date.toISOString() : row.rate_date).slice(0, 10), source: row.source};
}

/** amount in the currency → EUR at `rate` (units per 1 EUR), rounded to cents. */
export function toEur(amount, rate) {
  return fromUnits(divRound(toUnits(amount, 2) * 1000000n, toUnits(rate, 6)), 2);
}
export const fromEur = (eur, rate) => fromUnits(divRound(toUnits(eur, 2) * toUnits(rate, 6), 1000000n), 2);
export {money};
