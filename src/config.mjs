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
  };
  if (production && cfg.secretKey.length < 32) throw new Error('APP_SECRET_KEY must be set (>= 32 chars) in production');
  return cfg;
}
