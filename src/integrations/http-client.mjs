// Outbound HTTP helpers for adapters: rate limiting, timeouts, 429/5xx handling as retryable errors.

export function rateLimiter(perSecond = 4) {
  const gap = 1000 / Math.max(perSecond, 0.1);
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + gap;
    if (wait) await new Promise((r) => setTimeout(r, wait));
  };
}

export async function httpJson(fetchImpl, url, opts = {}) {
  let res;
  try {
    res = await fetchImpl(url, {...opts, signal: AbortSignal.timeout(opts.timeoutMs || 30000)});
  } catch (e) {
    throw Object.assign(new Error(`Ryšio klaida: ${e.message}`), {retryable: true});
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after')) || 60;
    throw Object.assign(new Error('Parduotuvės API ribojimas (429).'), {retryAfterSec: ra, status: 429});
  }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Prieiga atmesta (${res.status}). Patikrinkite raktą ir teises.`), {permanent: true, status: res.status});
  if (res.status >= 500) throw Object.assign(new Error(`Parduotuvės serverio klaida ${res.status}.`), {status: 503});
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), {permanent: true, status: res.status});
  const text = await res.text();
  if (text.length > 20 * 1024 * 1024) throw Object.assign(new Error('Atsakymas per didelis.'), {permanent: true});
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Atsakymas nėra JSON.'), {permanent: true}); }
}
