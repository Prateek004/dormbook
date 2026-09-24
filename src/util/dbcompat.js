'use strict';
// Schema-version tolerant inserts.
//
// Production databases may have been created by an older schema.sql (e.g.
// accounts.owner_name NOT NULL, properties.owner_id NOT NULL) or the current
// one (those columns don't exist). insertAdaptive() writes only the columns the
// table really has, so the same code works on every database version.

const _cache = new Map();

function tableColumns(db, table) {
  const key = table;
  if (!_cache.has(key)) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);
    _cache.set(key, new Set(cols));
  }
  return _cache.get(key);
}

function clearColumnCache() { _cache.clear(); }

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

function insertAdaptive(db, table, row) {
  if (!SAFE_IDENT.test(table)) throw new Error(`insertAdaptive: bad table ${table}`);
  const cols = tableColumns(db, table);
  const keys = Object.keys(row).filter((k) => cols.has(k) && row[k] !== undefined);
  if (!keys.length) throw new Error(`insertAdaptive: no known columns for ${table}`);
  keys.forEach((k) => { if (!SAFE_IDENT.test(k)) throw new Error(`insertAdaptive: bad column ${k}`); });
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...keys.map((k) => row[k]));
}

module.exports = { tableColumns, insertAdaptive, clearColumnCache };
