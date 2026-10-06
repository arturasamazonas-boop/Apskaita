// Exact decimal money arithmetic using BigInt scaled integers.
// Amounts are strings with up to `scale` decimals. Rounding: ROUND_HALF_UP
// (half away from zero), applied only where documented in docs/ROUNDING.md.

const DEC_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

export function toUnits(value, scale = 2) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') throw new Error('Sumos reikšmė tuščia');
  const s = typeof value === 'number' ? numberToString(value) : String(value).trim();
  const m = DEC_RE.exec(s);
  if (!m) throw new Error(`Netinkama skaičiaus reikšmė: ${s}`);
  const [, sign, int, frac = ''] = m;
  let units;
  if (frac.length <= scale) {
    units = BigInt(int + frac.padEnd(scale, '0'));
  } else {
    // Rounding beyond scale: half up away from zero.
    const keep = BigInt(int + frac.slice(0, scale));
    const rest = frac.slice(scale);
    units = rest[0] >= '5' ? keep + 1n : keep;
  }
  return sign === '-' ? -units : units;
}

function numberToString(n) {
  if (!Number.isFinite(n)) throw new Error('Netinkamas skaičius');
  // Avoid exponent notation; numbers should only come from trusted literals.
  return n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

export function fromUnits(units, scale = 2) {
  const neg = units < 0n;
  let s = (neg ? -units : units).toString().padStart(scale + 1, '0');
  const out = scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
  return (neg ? '-' : '') + out;
}

/** Divide BigInt a by b rounding half away from zero. */
export function divRound(a, b) {
  if (b === 0n) throw new Error('Dalyba iš nulio');
  const neg = (a < 0n) !== (b < 0n);
  const aa = a < 0n ? -a : a, bb = b < 0n ? -b : b;
  let q = aa / bb;
  const r = aa % bb;
  if (r * 2n >= bb) q += 1n;
  return neg ? -q : q;
}

export const money = {
  norm: (v) => fromUnits(toUnits(v, 2), 2),
  add: (...vals) => fromUnits(vals.reduce((s, v) => s + toUnits(v, 2), 0n), 2),
  sub: (a, b) => fromUnits(toUnits(a, 2) - toUnits(b, 2), 2),
  neg: (a) => fromUnits(-toUnits(a, 2), 2),
  cmp: (a, b) => { const d = toUnits(a, 2) - toUnits(b, 2); return d < 0n ? -1 : d > 0n ? 1 : 0; },
  eq: (a, b) => toUnits(a, 2) === toUnits(b, 2),
  isZero: (a) => toUnits(a, 2) === 0n,
  abs: (a) => { const u = toUnits(a, 2); return fromUnits(u < 0n ? -u : u, 2); },
  sign: (a) => { const u = toUnits(a, 2); return u < 0n ? -1 : u > 0n ? 1 : 0; },
  min: (a, b) => (money.cmp(a, b) <= 0 ? money.norm(a) : money.norm(b)),
  max: (a, b) => (money.cmp(a, b) >= 0 ? money.norm(a) : money.norm(b)),
  sum: (vals) => fromUnits(vals.reduce((s, v) => s + toUnits(v, 2), 0n), 2),
  /** qty (4dp) × unit price (4dp) → amount rounded half-up to cents. */
  lineNet(quantity, unitPrice, discount = '0') {
    const q = toUnits(quantity, 4), p = toUnits(unitPrice, 4);
    const gross = divRound(q * p, 1000000n); // 4+4 decimals → 2 decimals
    return fromUnits(gross - toUnits(discount, 2), 2);
  },
  /** VAT = taxable × rate% rounded half-up to cents. rate has up to 2 decimals. */
  vat(taxable, rate) {
    return fromUnits(divRound(toUnits(taxable, 2) * toUnits(rate, 2), 10000n), 2);
  },
  /** Proportional split of `total` by non-negative weights, largest remainder; sums exactly. */
  allocate(total, weights) {
    const t0 = toUnits(total, 2), neg = t0 < 0n, t = neg ? -t0 : t0;
    const w = weights.map((x) => { const u = toUnits(x, 2); return u < 0n ? -u : u; });
    const W = w.reduce((s, x) => s + x, 0n);
    if (W === 0n) return weights.map(() => '0.00');
    const raw = w.map((x) => (t * x) / W);
    const rem = w.map((x, i) => [(t * x) % W, i]).sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : b[0] > a[0] ? 1 : -1));
    let rest = t - raw.reduce((s, x) => s + x, 0n);
    for (const [, i] of rem) { if (rest === 0n) break; raw[i] += 1n; rest -= 1n; }
    return raw.map((x) => fromUnits(neg ? -x : x, 2));
  },

};

export function qty(v) { return fromUnits(toUnits(v, 4), 4); }

/** Parse human-entered amounts: "1 234,56", "1.234,56", "1,234.56", "-12.5", "12,50 €". */
export function parseAmount(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).replace(/[\s  ]/g, '').replace(/(EUR|€|Eur|eur)/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (!/^[\d.,']+$/.test(s)) return null;
  s = s.replace(/'/g, '');
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    // "1,234" with 3 trailing digits and multiple groups is ambiguous; treat single comma as decimal.
    if (parts.length > 2) s = parts.join(''); else s = s.replace(',', '.');
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length > 2) s = parts.join('');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  if (f.length > 4) return null;
  return (neg ? '-' : '') + String(BigInt(i)) + (f ? '.' + f : '');
}
