// Standalone job worker (use with WORKER_IN_PROCESS=false on the web process).
import {loadConfig} from './config.mjs';
import {createApp} from './app.mjs';
import {startScheduler} from './scheduler.mjs';

const app = await createApp(loadConfig());
app.worker.start();
startScheduler(app.pool);
console.log('Apskaita worker started');
const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
