'use strict';
// India business-time helpers.
//
// The server (Railway) runs in UTC. Using new Date().toISOString().substring(0,10)
// gives the UTC date, which is still "yesterday" in India until 05:30 IST — so
// a 2 AM payment landed in the previous day's cash close and reports.
// Always use these helpers for "today", "this month" and day grouping.

const IST_OFFSET_MIN = 330; // India has no DST
const IST_OFFSET_MS = IST_OFFSET_MIN * 60 * 1000;
const APP_TZ = process.env.APP_TZ || 'Asia/Kolkata';

/** 'YYYY-MM-DD' in IST for an instant (Date, ms or ISO string). Default: now. */
function istDate(at = Date.now()) {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : at;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM' in IST. */
function istMonth(at = Date.now()) {
  const d = istDate(at);
  return d ? d.slice(0, 7) : null;
}

/** First day of the IST month: 'YYYY-MM-01'. */
function istMonthStart(at = Date.now()) {
  return istMonth(at) + '-01';
}

/**
 * SQL expression converting a stored UTC timestamp column to its IST date.
 * Works for both 'YYYY-MM-DD HH:MM:SS' (datetime('now')) and ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'.
 *   `... WHERE ${sqlIstDate('paid_at')} = ?`
 */
function sqlIstDate(col) {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(col)) throw new Error('sqlIstDate: bad column');
  return `date(${col}, '+${IST_OFFSET_MIN} minutes')`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** True for a real calendar date 'YYYY-MM-DD' (rejects 2026-02-30). */
function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function addDays(d, n) {
  return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

module.exports = {
  IST_OFFSET_MIN, APP_TZ, istDate, istMonth, istMonthStart, sqlIstDate, isValidDate, addDays, daysBetween,
};
