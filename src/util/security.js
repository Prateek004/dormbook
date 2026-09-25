'use strict';
/**
 * Small security helpers used by login, codes and share links.
 * Everything random here comes from crypto (never Math.random).
 */
const crypto = require('crypto');

/** Compare two secrets in constant time (no timing leak). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x); // same work either way
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/** n random digits, e.g. a 6-digit code "048213". */
function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10);
  return s;
}

/** Long secret for links: 32 random bytes, URL-safe (43 chars). */
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** Indian mobile → 10 digits ("+91 98765-43210" → "9876543210"). Returns '' if not 10 digits. */
function mobile10(m) {
  let d = String(m ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? d : '';
}

/** MPIN rules: 4 or 6 digits, not easy to guess. Returns an error message or null. */
function mpinProblem(pin, mobile) {
  const p = String(pin ?? '');
  if (!/^(\d{4}|\d{6})$/.test(p)) return 'MPIN must be 4 or 6 digits';
  if (/^(\d)\1+$/.test(p)) return 'MPIN cannot be the same digit repeated (like 1111)';
  const up = '01234567890', down = '09876543210';
  if (up.includes(p) || down.includes(p)) return 'MPIN cannot be a simple series (like 1234)';
  const m = String(mobile || '').replace(/\D/g, '');
  if (m && m.endsWith(p)) return 'MPIN cannot be the end of your mobile number';
  if (['1212', '2580', '0852', '1004', '2000', '6969', '121212', '112233', '123123'].includes(p)) return 'MPIN is too easy to guess — choose another';
  return null;
}

module.exports = { safeEqual, randomDigits, randomToken, sha256, mobile10, mpinProblem };
