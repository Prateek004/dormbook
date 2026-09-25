'use strict';
/**
 * My Account → how guests pay you: UPI (QR) and bank details.
 * Shown at the end of every bill so the guest can scan and pay.
 * The bank account number is stored encrypted (AES-256-GCM) and only its last 4 digits are kept in clear.
 */
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');
const { encrypt, decrypt } = require('../services/encryption');
const qrcode = require('../vendor/qrcode');

const UPI_ID = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Read a scanned UPI QR text (upi://pay?pa=...&pn=...). Returns { pa, pn, signed, uri } or null. */
function parseUpiUri(text) {
  const t = String(text || '').trim();
  if (!/^upi:\/\/pay\?/i.test(t) || t.length > 1000) return null;
  let q;
  try { q = new URLSearchParams(t.slice(t.indexOf('?') + 1)); } catch (_) { return null; }
  const pa = (q.get('pa') || '').trim();
  if (!UPI_ID.test(pa)) return null;
  return { pa, pn: (q.get('pn') || '').trim().slice(0, 100), signed: q.has('sign'), uri: t };
}

function svgQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'UPI QR code' });
}

function rupeesPlain(paise) { return (Math.round(paise) / 100).toFixed(2); }

/**
 * What to print at the end of a bill. amountPaise > 0 fills the amount in the QR.
 * Returns null when nothing is set up or the owner turned it off.
 */
function payInfo(db, propertyId, { amountPaise = 0, note = '' } = {}) {
  const p = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  if (!p || p.show_pay_on_bill === 0) return null;
  const hasUpi = !!p.upi_id;
  const hasBank = !!(p.bank_account_enc && p.bank_ifsc);
  if (!hasUpi && !hasBank) return null;
  let upi = null;
  if (hasUpi) {
    const scanned = parseUpiUri(p.upi_uri);
    let link;
    if (scanned && scanned.signed && scanned.pa === p.upi_id) {
      link = scanned.uri;                     // signed shop QR: must not be changed
    } else {
      const q = new URLSearchParams({ pa: p.upi_id, pn: p.upi_name || p.name || 'Payee', cu: 'INR' });   // name defaults to the dormitory
      if (amountPaise > 0) q.set('am', rupeesPlain(amountPaise));
      if (note) q.set('tn', String(note).slice(0, 50));
      link = `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
    }
    upi = { id: p.upi_id, name: p.upi_name || '', link, qr_svg: svgQr(link),
      amount_paise: scanned && scanned.signed ? 0 : Math.max(0, amountPaise) };
  }
  let bank = null;
  if (hasBank) {
    let account = '';
    try { account = decrypt(p.bank_account_enc) || ''; } catch (_) { account = ''; }
    bank = { holder: p.bank_holder || '', name: p.bank_name || '', account: account || `••••${p.bank_account_last4 || ''}`,
      ifsc: p.bank_ifsc, branch: p.bank_branch || '' };
  }
  return { upi, bank };
}

/** GET /api/v1/account/payment */
function getPayment(req, res) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.user.property_id);
  if (!p) return res.status(404).json({ error: 'Property not found' });
  let account = '';
  try { account = p.bank_account_enc ? decrypt(p.bank_account_enc) || '' : ''; } catch (_) { account = ''; }
  const preview = payInfo(db, req.user.property_id, { amountPaise: 0 });
  return res.json({
    upi_id: p.upi_id || '', upi_name: p.upi_name || '', upi_signed: !!(parseUpiUri(p.upi_uri) || {}).signed,
    bank_holder: p.bank_holder || '', bank_name: p.bank_name || '', bank_account: account,
    bank_ifsc: p.bank_ifsc || '', bank_branch: p.bank_branch || '',
    show_pay_on_bill: p.show_pay_on_bill !== 0,
    qr_svg: preview && preview.upi ? preview.upi.qr_svg : null,
  });
}

/**
 * PATCH /api/v1/account/payment
 * Only sent fields change; "" clears a field. Checked first: nothing is saved if anything is wrong.
 */
function updatePayment(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const b = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined && b[k] !== null;
  const txt = (k, max) => String(b[k]).replace(/\s+/g, ' ').trim().slice(0, max);
  const set = {};
  const cur = db.prepare('SELECT * FROM properties WHERE id = ?').get(pid);
  if (!cur) return res.status(404).json({ error: 'Property not found' });

  if (has('upi_uri') && String(b.upi_uri).trim()) {
    // Scanned QR: the UPI ID comes from the QR itself.
    const parsed = parseUpiUri(b.upi_uri);
    if (!parsed) return res.status(400).json({ error: 'This QR is not a UPI payment QR. Scan your shop / UPI QR, or type your UPI ID.' });
    set.upi_uri = parsed.uri; set.upi_id = parsed.pa;
    if (!has('upi_name') && parsed.pn) set.upi_name = parsed.pn;
  } else if (has('upi_id')) {
    const v = txt('upi_id', 300).replace(/\s/g, '');
    if (v && !UPI_ID.test(v)) return res.status(400).json({ error: 'UPI ID looks wrong. It is like name@okhdfcbank or 98xxxxxx@ybl' });
    if ((v || null) !== (cur.upi_id || null)) { set.upi_id = v || null; set.upi_uri = null; }   // new typed ID: forget the old scanned QR
  }
  if (has('upi_name')) set.upi_name = txt('upi_name', 100) || null;
  if (has('bank_holder')) set.bank_holder = txt('bank_holder', 100) || null;
  if (has('bank_name')) set.bank_name = txt('bank_name', 100) || null;
  if (has('bank_branch')) set.bank_branch = txt('bank_branch', 100) || null;
  if (has('bank_ifsc')) {
    const v = txt('bank_ifsc', 11).toUpperCase().replace(/\s/g, '');
    if (v && !IFSC.test(v)) return res.status(400).json({ error: 'IFSC is 11 characters, like SBIN0001234' });
    set.bank_ifsc = v || null;
  }
  if (has('bank_account')) {
    const v = String(b.bank_account).replace(/[\s-]/g, '');
    if (v && !/^\d{6,18}$/.test(v)) return res.status(400).json({ error: 'Account number must be 6 to 18 digits' });
    set.bank_account_enc = v ? encrypt(v) : null;
    set.bank_account_last4 = v ? v.slice(-4) : null;
  }
  if (has('show_pay_on_bill')) set.show_pay_on_bill = b.show_pay_on_bill ? 1 : 0;

  // Bank details go together: account without IFSC (or the reverse) is no use on a bill.
  const after = { ...cur, ...set };
  if (!!after.bank_account_enc !== !!after.bank_ifsc) {
    return res.status(400).json({ error: 'Type both the account number and the IFSC (or leave both empty)' });
  }

  const keys = Object.keys(set);
  if (keys.length) {
    db.prepare(`UPDATE properties SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => set[k]), pid);
    writeAudit({ propertyId: pid, userId: req.user.id, action: 'PAYMENT_DETAILS_UPDATED', entityType: 'properties', entityId: pid,
      snapshot: { changed: keys.filter((k) => k !== 'bank_account_enc'), upi_id: after.upi_id || null,
        bank_account: after.bank_account_last4 ? `••••${after.bank_account_last4}` : null }, ip: req.ip });
  }
  return getPayment(req, res);
}

module.exports = { getPayment, updatePayment, payInfo, parseUpiUri };
