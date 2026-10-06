// Restore a backup into an EMPTY database and an EMPTY storage directory, then verify integrity:
// checksums from the manifest, every stored file present with matching SHA-256, ledger balanced.
// Usage: node scripts/restore.mjs <backupDir>   (env: DATABASE_URL = target db, STORAGE_DIR = target dir)
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {loadConfig} from '../src/config.mjs';

const run = promisify(execFile);
const sha = (file) => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });

export async function restore({backupDir, databaseUrl, storageDir}) {
  const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  const dump = path.join(backupDir, manifest.database.file), files = path.join(backupDir, manifest.files.file);
  if (await sha(dump) !== manifest.database.sha256) throw new Error('Duomenų bazės kopijos kontrolinė suma nesutampa.');
  if (await sha(files) !== manifest.files.sha256) throw new Error('Failų archyvo kontrolinė suma nesutampa.');
  const client = new pg.Client({connectionString: databaseUrl});
  await client.connect();
  const tables = (await client.query(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n;
  await client.end();
  if (Number(tables) > 0) throw new Error('Tikslinė duomenų bazė nėra tuščia – atkūrimas atšauktas.');
  await fs.mkdir(storageDir, {recursive: true});
  const existing = await fs.readdir(path.join(storageDir, 'objects')).catch(() => []);
  if (existing.length) throw new Error('Tikslinis failų katalogas nėra tuščias – atkūrimas atšauktas.');
  await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', databaseUrl, dump], {maxBuffer: 1 << 26});
  await run('tar', ['-xzf', files, '-C', storageDir]);
  return verify({databaseUrl, storageDir});
}

export async function verify({databaseUrl, storageDir}) {
  const client = new pg.Client({connectionString: databaseUrl});
  await client.connect();
  try {
    const rows = (await client.query('SELECT id, storage_key, sha256 FROM stored_files ORDER BY id')).rows;
    const problems = [];
    for (const r of rows) {
      const f = path.join(storageDir, 'objects', r.storage_key);
      let digest = null;
      try { digest = await sha(f); } catch {
        // STORAGE_BACKEND=postgres: the file lives in the database (included in the dump).
        const blob = (await client.query(`SELECT data FROM file_blobs WHERE storage_key=$1`, [r.storage_key]).catch(() => ({rows: []}))).rows[0];
        if (blob) digest = crypto.createHash('sha256').update(blob.data).digest('hex');
      }
      if (digest === null) problems.push(`Failas #${r.id}: nerastas`);
      else if (digest !== r.sha256) problems.push(`Failas #${r.id}: kontrolinė suma nesutampa`);
    }
    const unbalanced = (await client.query(`SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING sum(debit) <> sum(credit)`)).rows;
    if (unbalanced.length) problems.push(`Nesubalansuoti įrašai: ${unbalanced.map((x) => x.entry_id).join(', ')}`);
    const counts = Object.fromEntries(await Promise.all(['documents', 'stored_files', 'journal_entries', 'invoices', 'bank_transactions', 'audit_log'].map(async (t) => [t, Number((await client.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n)])));
    return {ok: problems.length === 0, problems, counts, filesChecked: rows.length};
  } finally { await client.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error('Naudojimas: node scripts/restore.mjs <atsarginės kopijos katalogas>'); process.exit(1); }
  const cfg = loadConfig();
  const r = await restore({backupDir: path.resolve(dir), databaseUrl: cfg.databaseUrl, storageDir: cfg.storageDir});
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(2);
}
