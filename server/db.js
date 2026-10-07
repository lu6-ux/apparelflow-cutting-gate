// Thin async DB adapter: PostgreSQL (production) or SQLite via node:sqlite (local/tests).
// All SQL in the app uses "?" placeholders; they are rewritten to $1..$n for Postgres.
import pg from 'pg';

// Loaded via getBuiltinModule so bundlers (Vitest/Vite) don't try to resolve it.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

class SqliteDB {
  dialect = 'sqlite';
  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.txChain = Promise.resolve(); // serialises transactions
    this.inTx = false;
  }
  // node:sqlite is synchronous, so a transaction that awaits could otherwise interleave
  // with other requests' statements. Non-tx queries wait until the open tx finishes.
  async _idle() { while (this.inTx) await this.txChain.catch(() => {}); }
  _exec(sql, p = []) {
    const st = this.raw.prepare(sql);
    if (/^\s*(select|with)/i.test(sql) || /returning/i.test(sql)) return { rows: st.all(...p), changes: 0 };
    const r = st.run(...p);
    return { rows: [], changes: Number(r.changes) };
  }
  async query(sql, p) { await this._idle(); return this._exec(sql, p); }
  async exec(sql) { await this._idle(); this.raw.exec(sql); }
  async tx(fn) {
    const prev = this.txChain;
    let release;
    this.txChain = new Promise((r) => (release = r));
    await prev.catch(() => {});
    this.inTx = true;
    this.raw.exec('BEGIN');
    const t = { query: async (s, p) => this._exec(s, p) };
    try {
      const out = await fn(t);
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
      release();
    }
  }
  async close() { this.raw.close(); }
}

class PgDB {
  dialect = 'pg';
  constructor(url) {
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  }
  async query(sql, p = []) {
    const r = await this.pool.query(toPg(sql), p);
    return { rows: r.rows, changes: r.rowCount };
  }
  async exec(sql) { await this.pool.query(sql); }
  async tx(fn) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const t = { query: async (s, p = []) => { const r = await c.query(toPg(s), p); return { rows: r.rows, changes: r.rowCount }; } };
      const out = await fn(t);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release(); }
  }
  async close() { await this.pool.end(); }
}

export function openDb({ databaseUrl = process.env.DATABASE_URL, sqlitePath = process.env.SQLITE_PATH || './apparelflow.db' } = {}) {
  return databaseUrl ? new PgDB(databaseUrl) : new SqliteDB(sqlitePath);
}
