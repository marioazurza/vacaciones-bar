// Acceso a datos con SQLite (módulo node:sqlite, incluido en Node 22, sin dependencias nativas).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA, JSON_COLUMNS } from '../shared/schema.js';

const q = (name) => `"${name}"`;

export function openRepo(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  for (const [table, cols] of Object.entries(SCHEMA)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${q(table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols.map((c) => `${q(c)}`).join(', ')})`);
    // Columnas añadidas en versiones posteriores
    const existing = new Set(db.prepare(`PRAGMA table_info(${q(table)})`).all().map((r) => r.name));
    for (const c of cols) if (!existing.has(c)) db.exec(`ALTER TABLE ${q(table)} ADD COLUMN ${q(c)}`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username);
    CREATE INDEX IF NOT EXISTS sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS vacations_year ON vacations(year);
    CREATE INDEX IF NOT EXISTS staff_year ON staff(year);
    CREATE INDEX IF NOT EXISTS requests_year ON requests(year);
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id);
  `);

  const jsonCols = (t) => JSON_COLUMNS[t] || [];
  const decode = (t, row) => {
    if (!row) return row;
    const o = { ...row };
    for (const c of jsonCols(t)) if (o[c] != null) o[c] = JSON.parse(o[c]);
    return o;
  };
  const encode = (t, obj) => {
    const o = {};
    for (const c of SCHEMA[t]) {
      if (!(c in obj)) continue;
      let v = obj[c];
      if (jsonCols(t).includes(c) && v != null) v = JSON.stringify(v);
      if (typeof v === 'boolean') v = v ? 1 : 0;
      o[c] = v === undefined ? null : v;
    }
    return o;
  };
  const where = (t, filter) => {
    const keys = Object.keys(filter || {}).filter((k) => SCHEMA[t].includes(k) || k === 'id');
    if (!keys.length) return { sql: '', args: [] };
    return {
      sql: ' WHERE ' + keys.map((k) => (filter[k] === null ? `${q(k)} IS NULL` : `${q(k)} = ?`)).join(' AND '),
      args: keys.filter((k) => filter[k] !== null).map((k) => filter[k]),
    };
  };

  let depth = 0;
  return {
    db,
    all(t, filter) {
      const w = where(t, filter);
      return db.prepare(`SELECT * FROM ${q(t)}${w.sql} ORDER BY id`).all(...w.args).map((r) => decode(t, r));
    },
    get(t, id) {
      return decode(t, db.prepare(`SELECT * FROM ${q(t)} WHERE id = ?`).get(id));
    },
    insert(t, obj) {
      const o = encode(t, obj);
      const keys = Object.keys(o);
      const info = db.prepare(`INSERT INTO ${q(t)} (${keys.map(q).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => o[k]));
      return this.get(t, Number(info.lastInsertRowid));
    },
    update(t, id, patch) {
      const o = encode(t, patch);
      const keys = Object.keys(o);
      if (!keys.length) return this.get(t, id);
      db.prepare(`UPDATE ${q(t)} SET ${keys.map((k) => `${q(k)} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => o[k]), id);
      return this.get(t, id);
    },
    remove(t, id) {
      db.prepare(`DELETE FROM ${q(t)} WHERE id = ?`).run(id);
    },
    removeWhere(t, filter) {
      const w = where(t, filter);
      if (!w.sql) throw new Error('removeWhere sin filtro');
      db.prepare(`DELETE FROM ${q(t)}${w.sql}`).run(...w.args);
    },
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
  };
}
