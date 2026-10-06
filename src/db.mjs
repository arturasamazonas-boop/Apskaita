// PostgreSQL access, transactions and migrations.
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {ROOT} from './config.mjs';

// NUMERIC and DATE stay strings: no float conversion, no timezone shifts.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => v); // bigint as string

export function createPool(databaseUrl) {
  const pool = new pg.Pool({connectionString: databaseUrl, max: 10});
  pool.on('error', (e) => console.error('[db] idle client error', e.message));
  return pool;
}

/** Run fn inside a transaction. Retries serialization failures/deadlocks. */
export async function tx(pool, fn, {retries = 3} = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if ((e.code === '40001' || e.code === '40P01') && attempt < retries) continue;
      throw translateDbError(e);
    } finally {
      client.release();
    }
  }
}

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

export function translateDbError(e) {
  if (e instanceof AppError) return e;
  const msg = String(e.message || '');
  if (msg.includes('PERIOD_LOCKED')) return new AppError(409, 'period_locked', 'Laikotarpis užrakintas: įrašų data patenka į užrakintą laikotarpį.', {db: msg});
  if (msg.includes('UNBALANCED')) return new AppError(422, 'unbalanced', 'Įrašas nesubalansuotas: debetas turi būti lygus kreditui.', {db: msg});
  if (msg.includes('IMMUTABLE')) return new AppError(409, 'immutable', 'Patvirtintų įrašų keisti ar trinti negalima. Naudokite koregavimą.', {db: msg});
  return e;
}

export async function migrate(pool, log = () => {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = path.join(ROOT, 'migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await fs.readFile(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`migrated ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
