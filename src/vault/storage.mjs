// Private, content-addressed, write-once file storage on the server filesystem.
// Files are never served directly; access goes through authorized API routes.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createStorage(baseDir) {
  const objects = path.join(baseDir, 'objects');
  const tmp = path.join(baseDir, 'tmp');

  function keyPath(key) {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) throw new Error('bad storage key');
    return path.join(objects, key);
  }

  async function put(buffer) {
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const key = `${sha256.slice(0, 2)}/${sha256}`;
    const dest = keyPath(key);
    await fs.mkdir(path.dirname(dest), {recursive: true});
    try {
      const existing = await fs.readFile(dest);
      const h = crypto.createHash('sha256').update(existing).digest('hex');
      if (h !== sha256) throw new Error(`Storage corruption detected for ${key}`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await fs.mkdir(tmp, {recursive: true});
      const t = path.join(tmp, `${sha256}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
      await fs.writeFile(t, buffer, {mode: 0o440});
      await fs.rename(t, dest);
    }
    return {sha256, key, size: buffer.length};
  }

  const read = (key) => fs.readFile(keyPath(key));
  const stream = (key) => createReadStream(keyPath(key));
  const exists = async (key) => !!(await fs.stat(keyPath(key)).catch(() => null));

  async function verify(key, sha256) {
    const buf = await read(key);
    return crypto.createHash('sha256').update(buf).digest('hex') === sha256;
  }

  async function tempDir(prefix = 'job') {
    await fs.mkdir(tmp, {recursive: true});
    return fs.mkdtemp(path.join(tmp, `${prefix}-`));
  }

  return {put, read, stream, exists, verify, tempDir, baseDir};
}
