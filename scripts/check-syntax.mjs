// Syntax check for all JS modules (node --check) and PHP extension files (php -l when available).
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => fs.readdirSync(d, {withFileTypes: true}).flatMap((e) => (e.name === 'node_modules' || e.name === 'var' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(root);
let n = 0, failed = 0;
for (const f of files.filter((x) => /\.(mjs|js)$/.test(x))) {
  try { execFileSync(process.execPath, ['--check', f], {stdio: 'pipe'}); n++; } catch (e) { failed++; console.error(`✗ ${path.relative(root, f)}\n${e.stderr}`); }
}
let php = 0;
const phpFiles = files.filter((x) => x.endsWith('.php'));
if (phpFiles.length) {
  try { execFileSync('php', ['-v'], {stdio: 'pipe'}); for (const f of phpFiles) { try { execFileSync('php', ['-l', f], {stdio: 'pipe'}); php++; } catch (e) { failed++; console.error(`✗ ${path.relative(root, f)}\n${e.stdout}`); } } } catch { console.log('php nerastas – PHP failai netikrinti'); }
}
console.log(`Syntax OK: ${n} JS${php ? `, ${php} PHP` : ''} files${failed ? `, ${failed} FAILED` : ''}`);
if (failed) process.exit(1);
