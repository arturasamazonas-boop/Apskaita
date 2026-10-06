// First-start administrator from environment and the public health endpoint (used by Render).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';
import {bootstrapAdmin} from '../src/bootstrap.mjs';

let t;
before(async () => { t = await startTestApp(); });
after(async () => t.close());

test('health endpoint is public and checks the database', async () => {
  const r = await fetch(`${t.base}/api/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {ok: true});
});

test('bootstrap admin is created only when there are no users, never twice', async () => {
  const quiet = {info() {}, error() {}};
  const env = {BOOTSTRAP_ADMIN_EMAIL: 'pirmas@imone.lt', BOOTSTRAP_ADMIN_PASSWORD: 'labai-slaptas-1'};
  assert.equal((await bootstrapAdmin(t.app.pool, {}, quiet)).reason, 'not_configured');
  assert.equal((await bootstrapAdmin(t.app.pool, env, quiet)).reason, 'users_exist', 'test users already exist');
  await t.app.pool.query('TRUNCATE sessions, login_attempts');
  await t.app.pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
  await t.app.pool.query('DELETE FROM audit_log');
  await t.app.pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
  await t.app.pool.query('DELETE FROM users');
  const [a, b] = await Promise.all([bootstrapAdmin(t.app.pool, env, quiet), bootstrapAdmin(t.app.pool, env, quiet)]);
  assert.equal([a, b].filter((x) => x.created).length, 1);
  const login = await fetch(`${t.base}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'pirmas@imone.lt', password: 'labai-slaptas-1'})});
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.role, 'admin');
  assert.equal((await bootstrapAdmin(t.app.pool, {...env, BOOTSTRAP_ADMIN_EMAIL: 'kitas@imone.lt'}, quiet)).reason, 'users_exist');
});
