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

test('open access (OPEN_ACCESS=true) signs in without a password; off by default', async () => {
  const off = await fetch(`${t.base}/api/open-login`, {method: 'POST'});
  assert.equal(off.status, 404);
  assert.equal((await (await fetch(`${t.base}/api/bootstrap-status`)).json()).openAccess, false);
  const o = await startTestApp({config: {openAccess: true}});
  try {
    assert.equal((await (await fetch(`${o.base}/api/bootstrap-status`)).json()).openAccess, true);
    const r = await fetch(`${o.base}/api/open-login`, {method: 'POST'});
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.user.role, 'admin');
    const sid = r.headers.get('set-cookie').match(/sid=([a-f0-9]{64})/)[1];
    const me = await fetch(`${o.base}/api/me`, {headers: {cookie: `sid=${sid}`}});
    assert.equal(me.status, 200);
    const again = await fetch(`${o.base}/api/open-login`, {method: 'POST'});
    assert.equal((await again.json()).user.id, body.user.id, 'same built-in user, not a new one each time');
    const cross = await fetch(`${o.base}/api/open-login`, {method: 'POST', headers: {origin: 'https://kitas.example'}});
    assert.equal(cross.status, 403);
  } finally { await o.close(); }
});
