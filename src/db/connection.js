'use strict';

let _db = null;

function setDb(db) { _db = db; }

function getDb() {
  if (!_db) throw new Error('Database not initialized. Call setDb(db) from server.js first.');
  return _db;
}

module.exports = { setDb, getDb };
