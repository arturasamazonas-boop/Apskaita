// First-start administrator from environment (for hosts without a shell, e.g. Render).
// Runs only while the users table is empty; afterwards the variables are ignored and can be removed.
import {createUser} from './auth/auth.mjs';

export async function bootstrapAdmin(pool, env = process.env, log = console) {
  const email = (env.BOOTSTRAP_ADMIN_EMAIL || '').trim();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD || '';
  if (!email || !password) return {created: false, reason: 'not_configured'};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727002)');
    if ((await client.query('SELECT 1 FROM users LIMIT 1')).rowCount) { await client.query('ROLLBACK'); return {created: false, reason: 'users_exist'}; }
    const u = await createUser(client, {email, name: (env.BOOTSTRAP_ADMIN_NAME || 'Administratorius').trim(), role: 'admin', password});
    await client.query('COMMIT');
    log.info?.(`[bootstrap] sukurtas pirmasis administratorius ${u.email}`);
    return {created: true, email: u.email};
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error?.(`[bootstrap] administratoriaus sukurti nepavyko: ${e.message}`);
    return {created: false, reason: e.message};
  } finally { client.release(); }
}
