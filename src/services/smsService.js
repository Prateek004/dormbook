'use strict';
/**
 * SMS for login codes (MSG91).
 *
 * Works only when both Railway variables are set:
 *   MSG91_AUTH_KEY          — from MSG91 dashboard
 *   MSG91_OTP_TEMPLATE_ID   — DLT-approved OTP template (variable ##OTP##)
 * Without them nothing is sent and the owner sees the code on screen instead.
 * Never throws: an SMS problem must never break sign-in or adding a user.
 * The code itself is never written to the logs.
 */

function isConfigured() {
  return !!(process.env.MSG91_AUTH_KEY && process.env.MSG91_OTP_TEMPLATE_ID) && process.env.NODE_ENV !== 'test';
}

/** mobile: 10 digits. Resolves true if MSG91 accepted it. */
async function sendLoginCode(mobile, code) {
  if (!isConfigured()) return false;
  if (!/^\d{10}$/.test(String(mobile)) || !/^\d{4,8}$/.test(String(code))) return false;
  const url = new URL('https://control.msg91.com/api/v5/otp');
  url.searchParams.set('template_id', process.env.MSG91_OTP_TEMPLATE_ID);
  url.searchParams.set('mobile', `91${mobile}`);
  url.searchParams.set('otp', String(code));
  url.searchParams.set('otp_expiry', '15');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authkey: process.env.MSG91_AUTH_KEY, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.type === 'success';
    if (!ok) console.warn(`[SMS] MSG91 did not accept the message for ••••${String(mobile).slice(-4)}: ${res.status} ${data.message || ''}`);
    return ok;
  } catch (e) {
    console.warn(`[SMS] MSG91 not reachable: ${e.message}`);
    return false;
  }
}

module.exports = { isConfigured, sendLoginCode };
