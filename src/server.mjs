// HTTP(S) server entry point. Runs the job worker in-process unless WORKER_IN_PROCESS=false.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import {loadConfig} from './config.mjs';
import {createEnvironments} from './tenants.mjs';
import {startScheduler} from './scheduler.mjs';
import {bootstrapAdmin} from './bootstrap.mjs';

const config = loadConfig();
// The main app at "/" plus the test environments (TENANTS, e.g. /ieva and /sonata), each with its own database.
const envs = await createEnvironments(config, {onApp: async (a) => { await bootstrapAdmin(a.pool); }});
const server = config.tlsCert && config.tlsKey
  ? https.createServer({cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey)}, envs.handle)
  : http.createServer(envs.handle);
server.requestTimeout = 120000;
server.listen(config.port, config.host, () => console.log(`Apskaita: ${config.tlsCert ? 'https' : 'http'}://${config.host}:${config.port}${envs.tenants.length ? ` (+ ${envs.tenants.map((t) => `/${t.name}/`).join(', ')})` : ''}`));
if (config.runWorkerInProcess) {
  for (const app of envs.all()) {
    // Single-instance hosts that may be stopped abruptly (e.g. Render free sleeping): jobs left 'running'
    // by the previous process are requeued immediately instead of waiting for the stale-lock timeout.
    if (process.env.RECOVER_RUNNING_JOBS_ON_START === 'true') {
      const r = await app.pool.query(`UPDATE jobs SET status='queued', locked_by=NULL, run_at=now() WHERE status='running'`);
      if (r.rowCount) console.log(`[jobs] ${app.config.basePath || '/'}: grąžinta į eilę nutrauktų užduočių: ${r.rowCount}`);
    }
    app.worker.start(); startScheduler(app.pool, {fxUrl: app.config?.fxUrl || ''});
  }
}
const stop = async () => { server.close(); await envs.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
