// Backup: PostgreSQL custom-format dump + file storage archive + manifest with checksums.
// Order matters: the database is dumped FIRST, then files. Stored files are write-once, so every file
// referenced by the dump is guaranteed to be in the archive (files added meanwhile are harmless extras).
// Usage: node scripts/backup.mjs [backupRootDir]   (env: DATABASE_URL, STORAGE_DIR)
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadConfig, ROOT} from '../src/config.mjs';

const run = promisify(execFile);
const sha = (file) => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });

export async function backup({databaseUrl, storageDir, backupRoot}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupRoot, `apskaita-${stamp}`);
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const dump = path.join(dir, 'database.dump');
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dump, databaseUrl], {maxBuffer: 1 << 26});
  const files = path.join(dir, 'files.tar.gz');
  await fs.mkdir(path.join(storageDir, 'objects'), {recursive: true});
  await run('tar', ['-czf', files, '-C', storageDir, 'objects']);
  const {stdout} = await run('tar', ['-tzf', files], {maxBuffer: 1 << 28});
  const manifest = {
    app: 'apskaita', createdAt: new Date().toISOString(), database: {file: 'database.dump', sha256: await sha(dump), bytes: (await fs.stat(dump)).size},
    files: {file: 'files.tar.gz', sha256: await sha(files), bytes: (await fs.stat(files)).size, objects: stdout.split('\n').filter((l) => /objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(l)).length},
    order: 'database dumped before files (write-once storage)',
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return {dir, manifest};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const root = path.resolve(process.argv[2] || process.env.BACKUP_DIR || path.join(ROOT, 'var', 'backups'));
  const r = await backup({databaseUrl: cfg.databaseUrl, storageDir: cfg.storageDir, backupRoot: root});
  console.log(`Atsarginė kopija: ${r.dir}\n${JSON.stringify(r.manifest, null, 2)}`);
}
