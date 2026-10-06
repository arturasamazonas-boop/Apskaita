// Durable PostgreSQL job queue: FOR UPDATE SKIP LOCKED, retries with backoff, idempotency keys.
import os from 'node:os';

export async function enqueue(db, type, payload = {}, {idempotencyKey = null, runAt = null, maxAttempts = 5} = {}) {
  const r = await db.query(`INSERT INTO jobs(type, payload, idempotency_key, run_at, max_attempts) VALUES ($1,$2,$3,COALESCE($4, now()),$5)
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [type, payload, idempotencyKey, runAt, maxAttempts]);
  if (r.rows[0]) return {id: r.rows[0].id, created: true};
  const ex = await db.query('SELECT id FROM jobs WHERE idempotency_key=$1', [idempotencyKey]);
  return {id: ex.rows[0]?.id, created: false};
}

export function createWorker({pool, handlers, onDead = {}, log = console, concurrency = 2, pollMs = 500, staleMinutes = 15}) {
  const id = `${os.hostname()}:${process.pid}`;
  let stopped = false, active = 0;
  const timers = new Set();

  async function claim() {
    const r = await pool.query(`UPDATE jobs SET status='running', locked_by=$1, locked_at=now(), attempts=attempts+1
      WHERE id = (SELECT id FROM jobs WHERE (status='queued' AND run_at <= now())
                    OR (status='running' AND locked_at < now() - make_interval(mins => $2::int))
                  ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`, [id, staleMinutes]);
    return r.rows[0];
  }

  async function runOne(job) {
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      const result = await handler(job.payload, job);
      await pool.query(`UPDATE jobs SET status='done', finished_at=now(), last_error=NULL, progress=$2 WHERE id=$1`, [job.id, result ? JSON.stringify(result).slice(0, 4000) : null]);
    } catch (e) {
      const permanent = e.permanent === true || (e.status && e.status < 500 && e.status !== 429);
      const dead = permanent || job.attempts >= job.max_attempts;
      const delaySec = e.retryAfterSec || Math.min(3600, 5 * 2 ** (job.attempts - 1));
      await pool.query(`UPDATE jobs SET status=$2, last_error=$3, run_at=now() + ($4 || ' seconds')::interval, locked_by=NULL WHERE id=$1`,
        [job.id, dead ? 'dead' : 'queued', String(e.message || e).slice(0, 2000), String(delaySec)]);
      log.warn?.(`[job ${job.id} ${job.type}] attempt ${job.attempts} failed: ${e.message}${dead ? ' (dead)' : ''}`);
      if (dead && onDead[job.type]) await onDead[job.type](job.payload, e).catch((err) => log.error?.('onDead failed', err));
    }
  }

  async function loop() {
    while (!stopped) {
      if (active >= concurrency) { await sleep(pollMs); continue; }
      let job;
      try { job = await claim(); } catch (e) { log.error?.('[worker] claim failed', e.message); await sleep(2000); continue; }
      if (!job) { await sleep(pollMs); continue; }
      active++;
      runOne(job).finally(() => { active--; });
    }
  }
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(() => { timers.delete(t); r(); }, ms); timers.add(t); });

  /** Process jobs until the queue is empty (tests and CLI). */
  async function drain({maxJobs = 1000} = {}) {
    let n = 0;
    for (;;) {
      const job = await claim();
      if (!job) {
        const pending = await pool.query(`SELECT 1 FROM jobs WHERE status='queued' AND run_at <= now() LIMIT 1`);
        if (!pending.rowCount) return n;
        continue;
      }
      await runOne(job);
      if (++n >= maxJobs) return n;
    }
  }

  return {
    start() { for (let i = 0; i < 1; i++) loop(); return this; },
    async stop() { stopped = true; for (const t of timers) clearTimeout(t); while (active) await new Promise((r) => setTimeout(r, 50)); },
    drain,
  };
}
