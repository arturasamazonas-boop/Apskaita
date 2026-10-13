// Server configuration. Secrets come only from the environment; see .env.example.
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const cfg = {
    production,
    port: Number(env.PORT || 3100),
    host: env.HOST || '127.0.0.1',
    databaseUrl: env.DATABASE_URL || 'postgres://apskaita:apskaita@127.0.0.1:5432/apskaita_dev',
    storageBackend: env.STORAGE_BACKEND === 'postgres' ? 'postgres' : 'disk',
    storageDir: path.resolve(env.STORAGE_DIR || path.join(ROOT, 'var', 'storage')),
    secretKey: env.APP_SECRET_KEY || (production ? '' : 'dev-only-secret-key-change-me-0123456789abcdef'),
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : production,
    tlsCert: env.TLS_CERT || '',
    tlsKey: env.TLS_KEY || '',
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
    sessionHours: Number(env.SESSION_HOURS || 12),
    // Test deployments only: anyone opening the site is signed in as the built-in admin, no password.
    openAccess: env.OPEN_ACCESS === 'true',
    jobStaleMinutes: Math.max(5, Number(env.JOB_STALE_MINUTES || 15)),
    jobConcurrency: Math.max(1, Number(env.JOB_CONCURRENCY || 2)),
    runWorkerInProcess: env.WORKER_IN_PROCESS !== 'false',
    ocrLanguages: env.OCR_LANGUAGES || 'lit+eng',
    clamscanPath: env.CLAMSCAN_PATH || '',
    llmProvider: env.LLM_PROVIDER || 'none',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || '',
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    // Lietuvos bankas FxRates web service; empty = rates only from the database (entered by hand).
    fxUrl: (env.FX_URL ?? 'https://www.lb.lt/webservices/FxRates/FxRates.asmx').replace(/\/$/, ''),
    viesUrl: (env.VIES_URL || 'https://ec.europa.eu/taxation_customs/vies/rest-api').replace(/\/$/, ''),
    // Separate test environments served by the same process under /<name>/, each with its own database
    // (DATABASE_URL_<NAME>, or the main database name + "_<name>"). Production default: /ieva, /sonata and /test.
    tenants: String(env.TENANTS ?? (production ? 'ieva,sonata,test' : '')).split(',').map((t) => t.trim().toLowerCase()).filter((t) => /^[a-z][a-z0-9-]{1,30}$/.test(t)),
    // Set per environment by src/tenants.mjs; empty for the main one.
    // One-time copies of the main environment's data into a test environment: "ieva:<tag>" copies once per tag
    // (the tag is remembered in that environment's database). Production default: the copy requested on 2026-10-13.
    copyMainTo: String(env.COPY_MAIN_TO ?? (production ? 'ieva:2026-10-13' : '')).split(',').map((x) => x.trim()).filter((x) => /^[a-z][a-z0-9-]{1,30}:[\w.-]{1,40}$/.test(x))
      .map((x) => ({tenant: x.split(':')[0], tag: x.split(':')[1]})),
    // Fictional demo data generated once into a test environment: "test:<tag>" (SEED_DEMO). Production default: /test.
    seedDemo: String(env.SEED_DEMO ?? (production ? 'test:gamyba-v1' : '')).split(',').map((x) => x.trim()).filter((x) => /^[a-z][a-z0-9-]{1,30}:[\w.-]{1,40}$/.test(x))
      .map((x) => ({tenant: x.split(':')[0], tag: x.split(':')[1]})),
    basePath: '',
    envLabel: '',
    cookieName: 'sid',
    dbPoolMax: Number(env.DB_POOL_MAX || 10),
  };
  if (production && cfg.secretKey.length < 32) throw new Error('APP_SECRET_KEY must be set (>= 32 chars) in production');
  return cfg;
}
