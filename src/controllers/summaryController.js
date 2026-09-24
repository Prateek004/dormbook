'use strict';
/**
 * Database backups — so real data is never lost.
 *
 *  - On every boot, BEFORE any migration runs, the existing database is copied
 *    to DB_DIR/backups/dormbook-<IST date-time>-boot.db (skipped for a brand-new, empty DB).
 *  - Every night at 03:15 IST the scheduler makes another copy (…-daily.db).
 *  - The newest KEEP copies of each kind are kept; older ones are deleted.
 *
 * Uses SQLite "VACUUM INTO": a complete, consistent copy (WAL included) taken
 * while the app keeps running. A failed backup is logged and never stops the app.
 * To restore: stop the service, copy a backup over DB_DIR/dormbook.db, start again.
 */
const fs = require('fs');
const path = require('path');

const KEEP = 14;

function stamp() {
  // 2026-09-25T03-10-00 in India time
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 19).replace(/:/g, '-');
}

function hasData(db) {
  try {
    const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
    return !!t && db.prepare('SELECT COUNT(*) n FROM users').get().n > 0;
  } catch (_) { return false; }
}

function backupDb(db, dbPath, kind = 'manual') {
  try {
    if (!dbPath || dbPath === ':memory:' || !hasData(db)) return null;
    const dir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `dormbook-${stamp()}-${kind}.db`);
    if (fs.existsSync(file)) return file;
    db.prepare('VACUUM INTO ?').run(file);
    // keep the newest KEEP of this kind
    const mine = fs.readdirSync(dir).filter((f) => f.startsWith('dormbook-') && f.endsWith(`-${kind}.db`)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP))) {
      try { fs.unlinkSync(path.join(dir, old)); } catch (_) { /* ignore */ }
    }
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`[BACKUP] Saved ${path.basename(file)} (${kb} KB)`);
    return file;
  } catch (e) {
    console.error('[BACKUP] Failed (app keeps running):', e.message);
    return null;
  }
}

module.exports = { backupDb };
