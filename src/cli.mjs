// CLI: migrate | create-admin <email> <name> (password from APSKAITA_ADMIN_PASSWORD or prompt) | demo-seed
import readline from 'node:readline/promises';
import {loadConfig} from './config.mjs';
import {createPool, migrate} from './db.mjs';
import {createUser} from './auth/auth.mjs';

const [cmd, ...args] = process.argv.slice(2);
const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  await migrate(pool, console.log);
  if (cmd === 'create-admin') {
    const [email, name = 'Administratorius'] = args;
    if (!email) throw new Error('Naudojimas: npm run create-admin -- el@pastas.lt "Vardas"');
    let password = process.env.APSKAITA_ADMIN_PASSWORD;
    if (!password) { const rl = readline.createInterface({input: process.stdin, output: process.stdout}); password = await rl.question('Slaptažodis (≥10 simbolių): '); rl.close(); }
    const u = await createUser(pool, {email, name, role: 'admin', password});
    console.log('Sukurtas administratorius', u.email);
  } else if (cmd === 'demo-seed') {
    const {seedDemo} = await import('./demo.mjs');
    await seedDemo(pool, config);
  } else if (cmd !== 'migrate') {
    console.log('Komandos: migrate | create-admin <email> [vardas] | demo-seed');
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
