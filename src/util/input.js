'use strict';

/**
 * Input parsing helpers.
 * Staff types rupees. The DB stores paise. All money goes through paise().
 */

/** Parse rupees string/number → integer paise. Returns null if not a valid positive number. */
function paise(val) {
  const n = parseFloat(val);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Parse an integer field. Returns null if not a valid non-negative integer. */
function int(val) {
  const n = parseInt(val, 10);
  if (!isFinite(n) || n < 0) return null;
  return n;
}

/** Trim a string field. Returns null if empty/missing. */
function text(val, maxLen = 500) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (s.length > maxLen) return null;
  return s;
}

/** Sanitise a value for CSV export — strip commas and quotes. */
function csvCell(val) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[",\r\n]/g, ' ').trim();
}

module.exports = { paise, int, text, csvCell };
