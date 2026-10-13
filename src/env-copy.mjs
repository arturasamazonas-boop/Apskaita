// Copy all data of one environment's database into another (main → /ieva). Same code, so both have the same
// schema after migrations; only columns present in both are copied. Runs in one transaction on the target:
// foreign keys are made deferrable for the load (cycles such as proposals ↔ invoices), user triggers
// (immutability, period lock, balance) are disabled while rows are loaded unchanged, then everything is checked
// and restored before commit. Sessions and background jobs are not copied; sequences continue after the copied ids.
const SKIP = new Set(['schema_migrations', 'environment_copies', 'sessions', 'jobs']);
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

export async function copyDatabase(src, dst, {log = console, chunk = 500, blobChunk = 10, tag = null} = {}) {
  const tables = (await dst.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows.map((r) => r.tablename);
  const srcTables = new Set((await src.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map((r) => r.tablename));
  const cols = async (db, t) => (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [t])).rows.map((r) => r.column_name);
  const c = await dst.connect();
  let total = 0, copied = 0;
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL lock_timeout = '60s'`);
    const fks = (await c.query(`SELECT con.conname, con.conrelid::regclass::text AS tbl, con.condeferrable, con.condeferred FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace
      WHERE con.contype='f' AND n.nspname='public'`)).rows;
    for (const f of fks.filter((x) => !x.condeferrable)) await c.query(`ALTER TABLE ${f.tbl} ALTER CONSTRAINT ${q(f.conname)} DEFERRABLE INITIALLY DEFERRED`);
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    const load = tables.filter((t) => !SKIP.has(t));
    for (const t of load) await c.query(`ALTER TABLE ${q(t)} DISABLE TRIGGER USER`);
    await c.query(`TRUNCATE ${[...load, 'sessions', 'jobs'].filter((t) => tables.includes(t)).map(q).join(', ')}`);
    for (const t of load) {
      if (!srcTables.has(t)) continue;
      const dc = new Set(await cols(c, t));
      const common = (await cols(src, t)).filter((x) => dc.has(x));
      if (!common.length) continue;
      const list = common.map(q).join(', ');
      const size = t === 'file_blobs' ? blobChunk : chunk;
      for (let off = 0; ; off += size) {
        // row_to_json renders bytea as \x… hex, which json_populate_recordset reads back as bytea.
        const rows = (await src.query(`SELECT row_to_json(x)::text AS j FROM (SELECT ${list} FROM ${q(t)} ORDER BY ${list.split(', ')[0]}, ctid LIMIT ${size} OFFSET ${off}) x`)).rows;
        if (!rows.length) break;
        await c.query(`INSERT INTO ${q(t)} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${q(t)}, $1::json)`, [`[${rows.map((r) => r.j).join(',')}]`]);
        total += rows.length;
        if (rows.length < size) break;
      }
      copied++;
    }
    // Sequences continue after the copied ids.
    const seqs = (await c.query(`SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col FROM pg_class s JOIN pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i')
      JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid JOIN pg_namespace n ON n.oid=s.relnamespace WHERE s.relkind='S' AND n.nspname='public'`)).rows;
    for (const s of seqs) await c.query(`SELECT setval('${q(s.seq)}', coalesce((SELECT max(${q(s.col)}) FROM ${q(s.tbl)}), 0) + 1, false)`);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE'); // every foreign key is checked here
    for (const t of load) await c.query(`ALTER TABLE ${q(t)} ENABLE TRIGGER USER`);
    for (const f of fks) if (!f.condeferrable) await c.query(`ALTER TABLE ${f.tbl} ALTER CONSTRAINT ${q(f.conname)} NOT DEFERRABLE`);
    if (tag) await c.query(`INSERT INTO environment_copies(tag, tables, rows) VALUES ($1,$2,$3)`, [tag, copied, total]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
  log.info?.(`[aplinkos] nukopijuota: ${copied} lentelių, ${total} eilučių`);
  return {tables: copied, rows: total};
}
