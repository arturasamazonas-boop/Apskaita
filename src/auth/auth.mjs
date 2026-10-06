// Authentication (scrypt passwords, DB sessions, CSRF tokens) and role checks.
import crypto from 'node:crypto';
import {AppError} from '../db.mjs';
import {audit} from '../audit.mjs';

const SCRYPT = {N: 16384, r: 8, p: 1, keylen: 64};

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw new AppError(400, 'weak_password', 'Slaptažodis turi būti bent 10 simbolių.');
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p});
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, n, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, {N: Number(n), r: SCRYPT.r, p: SCRYPT.p});
  return crypto.timingSafeEqual(expected, got);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const OPEN_ACCESS_EMAIL = 'testas@apskaita.local';
export const ROLES = ['admin', 'accountant', 'readonly'];
// Capability matrix enforced on every API route (see docs/SECURITY.md).
const CAPS = {
  admin: ['read', 'write', 'approve', 'rules', 'settings', 'users', 'restricted', 'admin_only', 'lock', 'resolve'],
  accountant: ['read', 'write', 'approve', 'rules', 'restricted', 'lock', 'resolve'],
  readonly: ['read'],
};
export function can(user, cap) { return !!user && user.active !== false && (CAPS[user.role] || []).includes(cap); }
export function requireCap(user, cap) {
  if (!user) throw new AppError(401, 'unauthenticated', 'Prisijunkite.');
  if (!can(user, cap)) throw new AppError(403, 'forbidden', 'Neturite teisės atlikti šio veiksmo.');
}

export function createAuth({pool, sessionHours = 12, now = () => new Date()}) {
  async function login(email, password, ip = '') {
    const key = `${String(email).toLowerCase()}|${ip}`;
    const att = (await pool.query('SELECT * FROM login_attempts WHERE key=$1', [key])).rows[0];
    if (att?.blocked_until && new Date(att.blocked_until) > now()) throw new AppError(429, 'locked_out', 'Per daug nesėkmingų bandymų. Pabandykite vėliau.');
    const user = (await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email])).rows[0];
    const ok = user && user.active && verifyPassword(password, user.password_hash);
    if (!ok) {
      const failures = (att?.failures || 0) + 1;
      const blocked = failures >= 5 ? new Date(now().getTime() + 15 * 60000) : null;
      await pool.query(`INSERT INTO login_attempts(key, failures, blocked_until) VALUES ($1,$2,$3)
        ON CONFLICT (key) DO UPDATE SET failures=$2, blocked_until=$3`, [key, failures >= 5 ? 0 : failures, blocked]);
      throw new AppError(401, 'bad_credentials', 'Neteisingas el. paštas arba slaptažodis.');
    }
    await pool.query('DELETE FROM login_attempts WHERE key=$1', [key]);
    return startSession(user, 'login');
  }

  async function startSession(user, action) {
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(24).toString('hex');
    await pool.query('INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1,$2,$3,$4)',
      [sha(token), user.id, csrf, new Date(now().getTime() + sessionHours * 3600000)]);
    await audit(pool, {userId: user.id, action, entityType: 'user', entityId: user.id});
    return {token, csrf, user: publicUser(user)};
  }

  // OPEN_ACCESS=true (test deployments): sign in as a built-in admin without a password.
  // The account gets a random password nobody knows, so it cannot be used through /api/login.
  async function openLogin() {
    await pool.query(`INSERT INTO users(email, name, role, password_hash) VALUES ($1,$2,'admin',$3) ON CONFLICT (email) DO NOTHING`,
      [OPEN_ACCESS_EMAIL, 'Testas', hashPassword(crypto.randomBytes(24).toString('hex'))]);
    const user = (await pool.query('SELECT * FROM users WHERE email=$1 AND active', [OPEN_ACCESS_EMAIL])).rows[0];
    if (!user) throw new AppError(403, 'forbidden', 'Atviros prieigos naudotojas išjungtas.');
    return startSession(user, 'login.open_access');
  }

  async function session(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const r = (await pool.query(`SELECT s.csrf_token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at > $2 AND u.active`, [sha(token), now()])).rows[0];
    if (!r) return null;
    return {user: publicUser(r), csrf: r.csrf_token};
  }

  async function logout(token) {
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha(token)]);
  }

  return {login, openLogin, session, logout};
}

export function publicUser(u) {
  return {id: String(u.id), email: u.email, name: u.name, role: u.role, active: u.active};
}

export async function createUser(db, {email, name = '', role, password}, actorId = null) {
  if (!ROLES.includes(role)) throw new AppError(400, 'bad_role', 'Netinkamas vaidmuo.');
  if (!/^[^@\s]+@[^@\s]+$/.test(String(email))) throw new AppError(400, 'bad_email', 'Netinkamas el. pašto adresas.');
  const r = await db.query('INSERT INTO users(email, name, role, password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING RETURNING *',
    [email.toLowerCase(), name, role, hashPassword(password)]);
  if (!r.rows[0]) throw new AppError(409, 'exists', 'Toks naudotojas jau yra.');
  await audit(db, {userId: actorId, action: 'user.create', entityType: 'user', entityId: r.rows[0].id, details: {email, role}});
  return publicUser(r.rows[0]);
}
