// Application assembly: services, routes, request pipeline and job handlers.
import path from 'node:path';
import {ROOT} from './config.mjs';
import {createPool, migrate, AppError, translateDbError} from './db.mjs';
import {createStorage} from './vault/storage.mjs';
import {createAuth} from './auth/auth.mjs';
import {createRouter, parseCookies, send, serveStatic, sameOrigin} from './http.mjs';
import {createWorker} from './jobs.mjs';
import {processInvoiceDocument, extractText} from './invoices/service.mjs';
import {indexVaultDocument} from './vault/upload.mjs';
import {createLlmProvider} from './extraction/llm.mjs';
import * as coreRoutes from './routes/core.mjs';
import * as docRoutes from './routes/documents.mjs';
import * as bankRoutes from './routes/bank.mjs';
import * as reportRoutes from './routes/reports.mjs';
import * as salesRoutes from './routes/sales.mjs';
import * as integrationRoutes from './routes/integrations.mjs';
import {renderAndStorePdf} from './sales/service.mjs';
import {integrationJobHandlers} from './integrations/sync.mjs';

export async function createApp(config, {pool: givenPool, log = console} = {}) {
  const pool = givenPool || createPool(config.databaseUrl);
  await migrate(pool, (m) => log.info?.(`[db] ${m}`));
  const storage = createStorage(config.storageDir);
  const auth = createAuth({pool, sessionHours: config.sessionHours});
  const llm = createLlmProvider(config, pool);
  const deps = {pool, storage, config, auth, llm, log};
  const router = createRouter();
  for (const m of [coreRoutes, docRoutes, bankRoutes, reportRoutes, salesRoutes, integrationRoutes]) m.register(router, deps);

  const handlers = {
    extract_invoice: (p) => processInvoiceDocument(deps, p.documentId, {force: !!p.force}),
    index_document: (p) => indexVaultDocument(deps, p, extractText),
    render_invoice_pdf: (p) => renderAndStorePdf(deps, p.invoiceId),
    ...integrationJobHandlers(deps),
  };
  const onDead = {
    extract_invoice: async (p, e) => {
      await pool.query(`UPDATE documents SET processing_status='failed', processing_error=$2, updated_at=now() WHERE id=$1 AND processing_status IN ('uploaded','processing')`, [p.documentId, `Atpažinimas nepavyko: ${String(e.message).slice(0, 300)}. Galite bandyti iš naujo arba įvesti duomenis rankiniu būdu.`]);
    },
  };
  const worker = createWorker({pool, handlers, onDead, log});
  deps.worker = worker;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, path.join(ROOT, 'public'), url.pathname);
    const started = Date.now();
    try {
      const m = router.match(req.method, url.pathname);
      if (!m) throw new AppError(404, 'not_found', 'Maršrutas nerastas.');
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.sid || '';
      const session = await auth.session(token);
      const ctx = {req, res, url, params: m.params, query: Object.fromEntries(url.searchParams), user: session?.user || null, session, token, deps};
      if (!m.route.opts.public && !ctx.user) throw new AppError(401, 'unauthenticated', 'Prisijunkite.');
      if (req.method !== 'GET' && !m.route.opts.public) {
        if (!sameOrigin(req)) throw new AppError(403, 'csrf', 'Užklausa iš kitos svetainės atmesta.');
        if (req.headers['x-csrf-token'] !== session.csrf) throw new AppError(403, 'csrf', 'Saugumo žetonas netinkamas. Atnaujinkite puslapį.');
      }
      const result = await m.route.handler(ctx);
      if (res.writableEnded) return;
      send(res, 200, result ?? {ok: true});
    } catch (e0) {
      const e = translateDbError(e0);
      if (e instanceof AppError) {
        send(res, e.status, {error: e.message, code: e.code, ...(e.details?.issues ? {issues: e.details.issues} : {})});
      } else if (e.code === '23505') {
        send(res, 409, {error: 'Toks įrašas jau yra (unikalumo apribojimas).', code: 'conflict'});
      } else {
        log.error?.(`[http] ${req.method} ${url.pathname} failed:`, e.stack || e.message);
        send(res, 500, {error: 'Serverio klaida. Bandykite dar kartą.', code: 'internal'});
      }
    } finally {
      if (Date.now() - started > 3000) log.warn?.(`[http] slow ${req.method} ${url.pathname} ${Date.now() - started}ms`);
    }
  }

  return {handle, pool, storage, worker, deps, async close() { await worker.stop(); await pool.end(); }};
}
