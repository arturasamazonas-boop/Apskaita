// HTTP(S) server entry point. Runs the job worker in-process unless WORKER_IN_PROCESS=false.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import {loadConfig} from './config.mjs';
import {createApp} from './app.mjs';
import {startScheduler} from './scheduler.mjs';

const config = loadConfig();
const app = await createApp(config);
const server = config.tlsCert && config.tlsKey
  ? https.createServer({cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey)}, app.handle)
  : http.createServer(app.handle);
server.requestTimeout = 120000;
server.listen(config.port, config.host, () => console.log(`Apskaita: ${config.tlsCert ? 'https' : 'http'}://${config.host}:${config.port}`));
if (config.runWorkerInProcess) { app.worker.start(); startScheduler(app.pool); }
const stop = async () => { server.close(); await app.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
