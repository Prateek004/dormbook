'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit, logDocumentAccess } = require('../middleware/auditLog');
const { encrypt, decrypt } = require('../services/encryption');
const { scheduleWhatsApp } = require('../services/whatsappService');

const { int, text } = require('../util/input');
const ledger = require('../services/ledger');
const { istDate, isValidDate } = require('../util/time');
const { validateId, idDisplay } = require('../util/idproof');
const { hasPermission } = require('../middleware/permissions');

// MONEY CONTRACT: the frontend already converts rupees → integer paise
// (Math.round(rupees * 100)) before sending. The backend must PRESERVE that
// value, never multiply by 100 again. (util/input.paise multiplies ×100 and
// is for raw-rupee inputs — using it here caused a 100× overcharge.)
//
// paisePreserve: strict — returns null on a non-numeric value so the caller
// can answer 400 instead of binding NaN and turning the request into a 500.
function paisePreserve(val) {
  const n = parseFloat(val);
  if (!isFinite(n)) return null;
  return Math.round(n);
}
// paise: lenient — absent/empty means zero (the field is optional); a
// present-but-unusable value still returns null so the caller can 400.
function paise(val) {
  if (val === undefined || val === null || val === '') return 0;
  return paisePreserve(val);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Ensure new columns exist before first use — runs once, idempotent
let _migrated = false;
function ensureColumns(db) {
  if (_migrated) return;
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('residents')").all().map(c => c.name);
    if (!cols.includes('rate_type')) db.exec("ALTER TABLE residents ADD COLUMN rate_type TEXT NOT NULL DEFAULT 'daily'");
    if (!cols.includes('rate_paise')) db.exec("ALTER TABLE residents ADD COLUMN rate_paise INTEGER NOT NULL DEFAULT 0");
    const bedCols = db.prepare("SELECT name FROM pragma_table_info('beds')").all().map(c => c.name);
    if (!bedCols.includes('daily_rate_paise')) db.exec("ALTER TABLE beds ADD COLUMN daily_rate_paise INTEGER NOT NULL DEFAULT 0");
    if (!bedCols.includes('base_rate_paise')) db.exec("ALTER TABLE beds ADD COLUMN base_rate_paise INTEGER NOT NULL DEFAULT 0");
  } catch(e) { console.warn('[MIGRATION] Column check:', e.message); }
  _migrated = true;
}

/**
 * POST /api/v1/residents — Simplified check-in
 *
 * Mandatory: full_name, mobile, bed_id, check_in_date, expected_checkout, aadhaar_consent
 * Rate: auto-fills from bed.daily_rate_paise, staff picks rate_type (daily/weekly/monthly)
 */
function checkIn(req, res) {
  const db = getDb();
  ensureColumns(db); // ensure rate_type + rate_paise columns exist
  const propertyId = req.user.property_id;

  const {
    rate_type = 'daily', rate_paise: ratePaiseRaw,
    deposit_paise: depositPaiseRaw,
    amount_paid_paise: paidPaiseRaw, payment_mode, gateway_txn_id,
  } = req.body;

  // Every free-text field is normalised first: a non-string here used to reach
  // .trim() or the SQLite binding and turn a check-in into a 500.
  const full_name                = text(req.body.full_name, 100);
  const mobile                   = text(req.body.mobile, 20);
  const bed_id                   = text(req.body.bed_id, 64);
  const check_in_date            = text(req.body.check_in_date, 10);
  const expected_checkout        = text(req.body.expected_checkout, 10);
  const aadhaar_number           = text(req.body.aadhaar_number, 20);
  const aadhaar_mobile           = text(req.body.aadhaar_mobile, 20);
  const aadhaar_photo_path       = text(req.body.aadhaar_photo_path, 300);
  const coming_from              = text(req.body.coming_from, 120);
  const purpose_of_visit         = text(req.body.purpose_of_visit, 120);
  const permanent_address        = text(req.body.permanent_address, 400);
  const emergency_contact_name   = text(req.body.emergency_contact_name, 100);
  const emergency_contact_mobile = text(req.body.emergency_contact_mobile, 20);
  const photo_path               = text(req.body.photo_path, 300);
  const notes                    = text(req.body.notes, 500);

  // Required fields
  const required = { full_name, mobile, bed_id, check_in_date, expected_checkout };
  for (const [f, v] of Object.entries(required)) {
    if (!v) return res.status(400).json({ error: `'${f}' is required` });
  }
  // Consent to store the ID (DPDP Act). Older app versions send aadhaar_consent.
  if (!req.body.id_consent && !req.body.aadhaar_consent) {
    return res.status(400).json({ error: 'Tick the consent box: the resident must agree to their ID being stored' });
  }
  // Any government ID: Aadhaar is no longer compulsory. Older clients send aadhaar_number only.
  const idTypeIn = text(req.body.id_type, 30) || (req.body.aadhaar_number ? 'aadhaar' : null);
  const idNumberIn = text(req.body.id_number, 40) || text(req.body.aadhaar_number, 20);
  if (!idTypeIn) return res.status(400).json({ error: 'Choose the ID proof type (Aadhaar, Driving Licence, Passport, ...)' });
  const idCheck = validateId(idTypeIn, idNumberIn);
  if (idCheck.error) return res.status(400).json({ error: idCheck.error });

  const mobileClean = mobile.replace(/\D/g, '');
  if (mobileClean.length < 10 || mobileClean.length > 12) return res.status(400).json({ error: 'Invalid mobile' });
  if (!isValidDate(check_in_date)) return res.status(400).json({ error: 'check_in_date: YYYY-MM-DD' });
  if (!isValidDate(expected_checkout)) return res.status(400).json({ error: 'expected_checkout: YYYY-MM-DD' });
  if (expected_checkout <= check_in_date) return res.status(400).json({ error: 'checkout must be after check-in' });

  const RATE_TYPES = ['daily', 'weekly', 'monthly'];
  if (!RATE_TYPES.includes(rate_type)) return res.status(400).json({ error: `rate_type must be: ${RATE_TYPES.join(', ')}` });

  const MODES = ['cash', 'upi', 'card', 'bank_transfer'];
  const mode  = MODES.includes(payment_mode) ? payment_mode : 'cash';

  // rent_due_day drives every future rent reminder; an out-of-range value would
  // silently schedule reminders on a day that does not exist in short months.
  const rent_due_day = int(req.body.rent_due_day) ?? 1;
  if (rent_due_day < 1 || rent_due_day > 28) {
    return res.status(400).json({ error: 'rent_due_day must be between 1 and 28' });
  }

  // Bed check
  const bed = db.prepare('SELECT * FROM beds WHERE id = ? AND property_id = ?').get(bed_id, propertyId);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  if (bed.status !== 'available' && bed.status !== 'reserved') {
    return res.status(409).json({ error: `Bed is '${bed.status}' — only available or reserved beds` });
  }

  // Rate: use provided rate, else derive from bed daily rate
  let ratePaise = paise(ratePaiseRaw);
  const depositPaise = paise(depositPaiseRaw);
  const paidPaise = paise(paidPaiseRaw);

  for (const [field, val] of [['rate_paise', ratePaise], ['deposit_paise', depositPaise], ['amount_paid_paise', paidPaise]]) {
    if (val === null) return res.status(400).json({ error: `${field} must be a number` });
    if (val < 0)      return res.status(400).json({ error: `${field} must be ≥ 0` });
  }

  if (!ratePaise && bed.daily_rate_paise) {
    if (rate_type === 'daily') ratePaise = bed.daily_rate_paise;
    else if (rate_type === 'weekly') ratePaise = bed.daily_rate_paise * 7;
    else ratePaise = bed.daily_rate_paise * 30;
  }

  // Calculate monthly_rent_paise for backward compat
  let monthlyRent = ratePaise;
  if (rate_type === 'daily') monthlyRent = ratePaise * 30;
  else if (rate_type === 'weekly') monthlyRent = ratePaise * 4;

  // ID number is stored encrypted; only the last 4 characters are kept in clear.
  const idEncrypted = encrypt(idCheck.number);
  const idLast4 = idCheck.number.slice(-4);
  // Keep the legacy Aadhaar columns filled for Aadhaar IDs (older screens read them).
  const aadhaarEncrypted = idCheck.type === 'aadhaar' ? idEncrypted : null;
  const aadhaarLast4 = idCheck.type === 'aadhaar' ? idLast4 : null;

  const now = new Date().toISOString();
  const residentId = uuidv4();
  const billingMonth = check_in_date.substring(0, 7);

  const runCheckIn = () => {
    db.prepare(`
      INSERT INTO residents
        (id, property_id, bed_id, full_name, mobile,
         aadhaar_number_encrypted, aadhaar_last4, aadhaar_mobile, aadhaar_photo_path,
         aadhaar_consent, aadhaar_consent_at,
         coming_from, permanent_address, purpose_of_visit,
         emergency_contact_name, emergency_contact_mobile,
         photo_path, check_in_date, expected_checkout, rent_due_day,
         monthly_rent_paise, rate_type, rate_paise, deposit_paise, status,
         notes, checkin_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,  'active',?,?,?,?)
    `).run(
      residentId, propertyId, bed_id, full_name, mobileClean,
      aadhaarEncrypted, aadhaarLast4, aadhaar_mobile, aadhaar_photo_path,
      now,
      coming_from, permanent_address, purpose_of_visit,
      emergency_contact_name, emergency_contact_mobile,
      photo_path, check_in_date, expected_checkout, rent_due_day,
      monthlyRent, rate_type, ratePaise, depositPaise,
      notes, req.user.id, now, now
    );

    if (depositPaise > 0) {
      const depId = uuidv4();
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,gateway_txn_id,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','deposit',?,?,?,0,'not_required',?,?,?)
      `).run(depId, propertyId, residentId, billingMonth, depositPaise,
        mode, text(gateway_txn_id, 64), now, 'Deposit on check-in', req.user.id, now);
      ledger.depositIn({ propertyId, residentId, amountPaise: depositPaise, mode, userId: req.user.id,
        sourceTable: 'payment_ledger', sourceId: depId, reason: 'Deposit on check-in' });
    }

    if (paidPaise > 0) {
      const advId = uuidv4();
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,gateway_txn_id,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','advance',?,?,?,0,'not_required',?,?,?)
      `).run(advId, propertyId, residentId, billingMonth, paidPaise,
        mode, text(gateway_txn_id, 64), now, 'Advance on check-in', req.user.id, now);
      ledger.payment({ propertyId, residentId, amountPaise: paidPaise, mode, userId: req.user.id,
        sourceTable: 'payment_ledger', sourceId: advId, category: 'rent', reason: 'Advance on check-in' });
    }

    db.prepare('UPDATE residents SET id_type = ?, id_number_encrypted = ?, id_last4 = ? WHERE id = ?')
      .run(idCheck.type, idEncrypted, idLast4, residentId);

    // Claim the bed conditionally on it still being free. The status was read
    // before the transaction opened; re-asserting it here means the bed is won
    // by exactly one check-in even if two arrive together, instead of relying
    // on nothing yielding between the read and the write.
    const claimed = db.prepare(`
      UPDATE beds SET status='occupied', cleaning_started_at=NULL, booking_request_id=NULL,
                      updated_at=datetime('now')
      WHERE id=? AND status IN ('available','reserved')
    `).run(bed_id);
    if (claimed.changes === 0) {
      bedTaken = true;
      throw new Error('BED_TAKEN');   // rolls the whole check-in back
    }

    if (bed.status === 'reserved' && bed.booking_request_id) {
      db.prepare(`UPDATE booking_requests SET status='confirmed', converted_to_resident_id=? WHERE id=? AND status IN ('pending','confirmed')`)
        .run(residentId, bed.booking_request_id);
    }

    // Charge the first rent cycle now (and any past cycles if the check-in is back-dated).
    ledger.billNow(residentId);
  };

  let bedTaken = false;
  try {
    db.transaction(runCheckIn)();
  } catch (err) {
    if (bedTaken) {
      return res.status(409).json({ error: 'Bed was just taken by another check-in' });
    }
    throw err;
  }

  writeAudit({ propertyId, userId: req.user.id, action: 'CHECKIN',
    entityType: 'resident', entityId: residentId,
    amountPaise: depositPaise + paidPaise,
    snapshot: { resident: full_name, bed_id, check_in_date, rate_type, rate_paise: ratePaise, deposit: depositPaise },
    ip: req.ip });

  scheduleWhatsApp({ propertyId, residentId, recipientMobile: mobileClean, recipientType: 'tenant',
    eventType: 'checkin_confirm',
    templateData: { name: full_name, bed: bed.bed_label, checkin: check_in_date, rate: ratePaise / 100, rate_type } });

  const resident = db.prepare('SELECT * FROM residents WHERE id = ?').get(residentId);
  resident.aadhaar_number_encrypted = undefined;
  resident.id_number_encrypted = undefined;
  resident.aadhaar_display = aadhaarLast4 ? `XXXX XXXX ${aadhaarLast4}` : null;
  resident.id_display = idDisplay(resident.id_type, resident.id_last4);
  return res.status(201).json({ message: 'Check-in successful', resident });
}

/** GET /api/v1/residents */
function listResidents(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { status = 'active', search: rawSearch } = req.query;
  const search = rawSearch ? String(rawSearch).trim().substring(0, 100) : null;
  let query = `
    SELECT r.id, r.full_name, r.mobile, r.aadhaar_last4,
      r.check_in_date, r.expected_checkout, r.actual_checkout,
      r.monthly_rent_paise, r.rate_type, r.rate_paise,
      r.deposit_paise, r.status, r.rent_due_day, r.created_at, r.checkin_by,
      b.bed_label, b.status as bed_status, b.daily_rate_paise,
      rm.room_number, f.label as floor_label,
      COALESCE((SELECT ${ledger.SQL.dues} FROM ledger_entries le WHERE le.resident_id = r.id), 0) as dues_paise,
      COALESCE((SELECT ${ledger.SQL.deposit} FROM ledger_entries le WHERE le.resident_id = r.id), 0) as deposit_held_paise,
      (SELECT MAX(le.biz_date) FROM ledger_entries le WHERE le.resident_id = r.id AND le.kind = 'PAYMENT') as last_payment_date
    FROM residents r
    LEFT JOIN beds b ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE r.property_id = ?
  `;
  const params = [propertyId];
  if (status !== 'all') { query += ' AND r.status = ?'; params.push(status); }
  if (search) { query += ' AND (r.full_name LIKE ? OR r.mobile LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  query += ' ORDER BY r.created_at DESC';

  // Badge from real dues (ledger), not "paid this calendar month >= monthly rent".
  const recent = istDate(Date.now() - 35 * 86400000);
  const residents = db.prepare(query).all(...params).map(r => {
    const dues = r.dues_paise || 0;
    const badge = dues <= 0 ? 'paid' : (r.last_payment_date && r.last_payment_date >= recent) ? 'partial' : 'pending';
    return { ...r, payment_badge: badge, pending_rent_paise: Math.max(0, dues),
      advance_credit_paise: Math.max(0, -dues),
      aadhaar_display: r.aadhaar_last4 ? `XXXX XXXX ${r.aadhaar_last4}` : null };
  });
  return res.json(residents);
}

/** GET /api/v1/residents/:id */
function getResident(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const resident = db.prepare(`
    SELECT r.*, b.bed_label, b.daily_rate_paise as bed_daily_rate, rm.room_number, f.label as floor_label
    FROM residents r LEFT JOIN beds b ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE r.id = ? AND r.property_id = ?
  `).get(req.params.id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  if (resident.aadhaar_number_encrypted && ['owner','manager'].includes(req.user.role)) {
    // Audit logging is a side-effect — it must never break the resident view.
    try {
      logDocumentAccess(db, { residentId: resident.id, accessedBy: req.user.id, documentType: 'aadhaar_number', ip: req.ip });
    } catch (e) {
      console.error('[AUDIT] logDocumentAccess failed:', e.message);
    }
  }
  resident.aadhaar_number_encrypted = undefined;
  resident.id_number_encrypted = undefined;
  resident.aadhaar_display = resident.aadhaar_last4 ? `XXXX XXXX ${resident.aadhaar_last4}` : null;
  resident.id_display = idDisplay(resident.id_type, resident.id_last4);
  resident.documents = db.prepare('SELECT id, doc_type, mime_type, size_bytes, created_at FROM resident_documents WHERE resident_id = ? ORDER BY created_at').all(resident.id);

  const payments = db.prepare('SELECT * FROM payment_ledger WHERE resident_id = ? ORDER BY created_at DESC').all(req.params.id);
  if (resident.status === 'active') ledger.billNow(resident.id);
  const balance = ledger.balances(resident.id); // { dues_paise, deposit_paise } from the money ledger
  return res.json({ ...resident, payments, balance });
}

/** POST /api/v1/residents/:id/checkout */
function checkOut(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { id: residentId } = req.params;
  const { extra_charges_note, payment_mode, gateway_txn_id, notes } = req.body;
  const checkout_date = text(req.body.checkout_date, 10);
  if (!checkout_date) return res.status(400).json({ error: 'checkout_date required' });
  if (!isValidDate(checkout_date)) return res.status(400).json({ error: 'checkout_date: YYYY-MM-DD' });

  const refundPaiseIn = paise(req.body.deposit_refund_paise);
  const extraPaiseIn  = paise(req.body.extra_charges_paise);
  const collectPaise  = paise(req.body.collect_paise);   // balance paid by the resident at checkout
  for (const [field, val] of [['deposit_refund_paise', refundPaiseIn], ['extra_charges_paise', extraPaiseIn], ['collect_paise', collectPaise]]) {
    if (val === null) return res.status(400).json({ error: `${field} must be a number` });
    if (val < 0)      return res.status(400).json({ error: `${field} must be ≥ 0` });
  }
  const MODES = ['cash', 'upi', 'card', 'bank_transfer'];
  const mode  = MODES.includes(payment_mode) ? payment_mode : 'cash';

  const resident = db.prepare('SELECT * FROM residents WHERE id = ? AND property_id = ?').get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });
  if (resident.status === 'checked_out') return res.status(409).json({ error: 'Already checked out' });
  if (resident.check_in_date && checkout_date < resident.check_in_date) {
    return res.status(400).json({ error: 'checkout_date cannot be before the check-in date' });
  }
  const pendingRefund = db.prepare(
    "SELECT id FROM payment_ledger WHERE resident_id = ? AND type = 'deposit_refund' AND approval_status = 'pending'"
  ).get(residentId);
  if (pendingRefund) return res.status(409).json({ error: 'A checkout for this resident is already waiting for approval' });

  const now = new Date().toISOString();
  const refundPaise = refundPaiseIn;
  const extraPaise  = extraPaiseIn;

  // The refund can't exceed deposit + advance credit. That is checked inside the
  // transaction below, after rent is settled to the checkout date.

  const prop = db.prepare('SELECT refund_approval_threshold_paise FROM properties WHERE id = ?').get(propertyId);
  const threshold = prop?.refund_approval_threshold_paise ?? 0;
  // Staff who can approve refunds (owner, or anyone given 'approvals') don't wait for themselves.
  const needsApproval = refundPaise > threshold && !hasPermission(req, 'approvals');
  let refundPaymentId = null;
  let settlement = null;

  db.transaction(() => {
    // Rent for exactly the days stayed: bill up to the checkout date, cut the last cycle short.
    ledger.settleRentAtCheckout(resident, checkout_date, req.user.id);

    if (extraPaise > 0) {
      const extraId = uuidv4();
      db.prepare(`INSERT INTO payment_ledger (id,property_id,resident_id,billing_month,amount_paise,direction,type,payment_mode,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','extra_charge',?,?,0,'not_required',?,?,?)`)
        .run(extraId, propertyId, residentId, checkout_date.substring(0,7), extraPaise, mode, now, extra_charges_note||'Extra charges at checkout', req.user.id, now);
      // Checkout extra charges are OWED (recovered from the deposit), not cash received.
      ledger.charge({ propertyId, residentId, amountPaise: extraPaise, category: 'damage',
        reason: extra_charges_note || 'Extra charges at checkout', userId: req.user.id,
        sourceTable: 'payment_ledger', sourceId: extraId });
    }
    if (collectPaise > 0) {
      const colId = uuidv4();
      db.prepare(`INSERT INTO payment_ledger (id,property_id,resident_id,billing_month,amount_paise,direction,type,payment_mode,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','rent',?,?,0,'not_required',?,?,?)`)
        .run(colId, propertyId, residentId, checkout_date.substring(0,7), collectPaise, mode, now, 'Balance paid at checkout', req.user.id, now);
      ledger.payment({ propertyId, residentId, amountPaise: collectPaise, mode, userId: req.user.id,
        sourceTable: 'payment_ledger', sourceId: colId, category: 'rent', reason: 'Balance paid at checkout' });
    }
    if (refundPaise > 0) {
      refundPaymentId = uuidv4();
      // due_date carries the staff-recorded checkout_date so approveCheckout
      // can restore it as actual_checkout instead of using the approval time.
      db.prepare(`INSERT INTO payment_ledger (id,property_id,resident_id,billing_month,amount_paise,direction,type,payment_mode,gateway_txn_id,due_date,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'debit','deposit_refund',?,?,?,?,?,?,?,?,?)`)
        .run(refundPaymentId, propertyId, residentId, checkout_date.substring(0,7), refundPaise, mode, gateway_txn_id||null, checkout_date, now, needsApproval?1:0, needsApproval?'pending':'not_required', notes||'Deposit refund', req.user.id, now);
    }
    if (needsApproval) {
      // make sure the requested refund is possible once rent is settled
      const b = ledger.balances(residentId);
      const dues = Math.max(0, b.dues_paise);
      const refundable = Math.max(0, b.deposit_paise - dues) + Math.max(0, -b.dues_paise);
      if (refundPaise > refundable) {
        throw new ledger.LedgerError('REFUND_TOO_HIGH', `Refund is more than what the resident is owed (₹${(refundable / 100).toFixed(2)})`, 409);
      }
    }
    if (!needsApproval) {
      settlement = ledger.settleDepositAtCheckout({ propertyId, residentId, refundPaise, mode,
        userId: req.user.id, sourceId: refundPaymentId });
      db.prepare(`UPDATE residents SET status='checked_out', actual_checkout=?, updated_at=datetime('now') WHERE id=?`).run(checkout_date, residentId);
      if (resident.bed_id) db.prepare(`UPDATE beds SET status='cleaning', cleaning_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(resident.bed_id);
    }
  })();

  writeAudit({ propertyId, userId: req.user.id, action: 'CHECKOUT_INITIATED',
    entityType: 'resident', entityId: residentId, amountPaise: refundPaise,
    snapshot: { checkout_date, extra: extraPaise, refund: refundPaise, needs_approval: needsApproval, settlement }, ip: req.ip });

  return res.status(needsApproval ? 202 : 200).json({
    message: needsApproval ? 'Checkout pending refund approval' : 'Checkout complete',
    refund_pending_approval: needsApproval, refund_payment_id: refundPaymentId,
    settlement, // { refunded_paise, applied_paise, dues_after_paise, deposit_left_paise }
  });
}

/**
 * GET /api/v1/residents/:id/checkout-preview?date=YYYY-MM-DD&extra_paise=0
 * Runs the real checkout settlement inside a transaction and rolls it back,
 * so the numbers shown are exactly what "Confirm check-out" will do.
 */
function checkoutPreview(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const resident = db.prepare('SELECT * FROM residents WHERE id = ? AND property_id = ?').get(req.params.id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });
  if (resident.status !== 'active') return res.status(409).json({ error: 'Resident has already checked out' });
  const date = req.query.date ? String(req.query.date) : istDate();
  if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (resident.check_in_date && date < resident.check_in_date) return res.status(400).json({ error: 'Checkout date is before the check-in date' });
  const extra = req.query.extra_paise ? Number(req.query.extra_paise) : 0;
  if (!Number.isInteger(extra) || extra < 0) return res.status(400).json({ error: 'extra_paise must be a whole number ≥ 0' });

  const ROLLBACK = new Error('preview-rollback');
  let out = null;
  try {
    db.transaction(() => {
      const before = ledger.balances(resident.id);
      ledger.settleRentAtCheckout(resident, date, req.user.id);
      const rent = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries WHERE resident_id = ?
        AND kind = 'CHARGE' AND category = 'rent'`).get(resident.id).t;
      const paid = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries WHERE resident_id = ?
        AND kind IN ('PAYMENT','WAIVER')`).get(resident.id).t;
      const other = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries WHERE resident_id = ?
        AND ((kind = 'CHARGE' AND category <> 'rent') OR kind = 'OPENING_DUES')`).get(resident.id).t;
      if (extra > 0) ledger.charge({ propertyId, residentId: resident.id, amountPaise: extra, category: 'damage', reason: 'preview' });
      const after = ledger.balances(resident.id);
      const dues = Math.max(0, after.dues_paise);
      out = {
        resident: { id: resident.id, name: resident.full_name, check_in_date: resident.check_in_date, checkout_date: date,
          nights: Math.max(1, Math.round((Date.parse(date) - Date.parse(resident.check_in_date)) / 86400000)),
          rate_type: resident.rate_type, rate_paise: resident.rate_paise },
        rent_total_paise: rent,
        other_charges_paise: other,
        extra_charges_paise: extra,
        paid_paise: paid,
        dues_before_deposit_paise: after.dues_paise,
        deposit_held_paise: after.deposit_paise,
        // what the checkout will do:
        advance_credit_paise: Math.max(0, -after.dues_paise),
        // deposit left after clearing dues + any advance rent paid for days not stayed
        refund_paise: Math.max(0, after.deposit_paise - dues) + Math.max(0, -after.dues_paise),
        to_collect_paise: Math.max(0, dues - after.deposit_paise),
        dues_now_paise: before.dues_paise,
      };
      throw ROLLBACK;
    })();
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  const prop = db.prepare('SELECT refund_approval_threshold_paise FROM properties WHERE id = ?').get(propertyId);
  out.needs_approval = out.refund_paise > (prop?.refund_approval_threshold_paise ?? 0) && !hasPermission(req, 'approvals');
  return res.json(out);
}

/**
 * Approve / reject a pending deposit refund (= a checkout waiting for approval).
 * Shared by POST /residents/:id/checkout/approve and POST /payments/:id/approve.
 */
function applyRefundDecision(db, { refund, decision, userId, notes }) {
  const now = new Date().toISOString();
  let settlement = null;
  db.transaction(() => {
    const upd = db.prepare(`UPDATE payment_ledger SET approval_status=?, approved_by=?, approved_at=?, notes=COALESCE(?,notes)
      WHERE id=? AND approval_status='pending'`).run(decision, userId, now, notes||null, refund.id);
    if (upd.changes === 0) {
      throw new ledger.LedgerError('ALREADY_DECIDED', 'This refund was already approved or rejected', 409);
    }
    if (decision === 'approved') {
      const resident = db.prepare('SELECT * FROM residents WHERE id = ?').get(refund.resident_id);
      settlement = ledger.settleDepositAtCheckout({ propertyId: refund.property_id, residentId: refund.resident_id,
        refundPaise: refund.amount_paise, mode: refund.payment_mode, userId, sourceId: refund.id });
      // Use the checkout_date the staff recorded at checkout time (stored in
      // due_date), not the approval timestamp — they can be days apart.
      const actualCheckout = refund.due_date || istDate();
      db.prepare(`UPDATE residents SET status='checked_out', actual_checkout=?, updated_at=datetime('now') WHERE id=?`).run(actualCheckout, refund.resident_id);
      if (resident && resident.bed_id) db.prepare(`UPDATE beds SET status='cleaning', cleaning_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(resident.bed_id);
    }
  })();
  return settlement;
}

/** POST /api/v1/residents/:id/checkout/approve */
function approveCheckout(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { id: residentId } = req.params;
  const { decision, notes } = req.body;
  if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: "decision: 'approved' or 'rejected'" });

  const resident = db.prepare('SELECT * FROM residents WHERE id = ? AND property_id = ?').get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });
  const refund = db.prepare(`SELECT * FROM payment_ledger WHERE resident_id = ? AND type = 'deposit_refund' AND approval_status = 'pending' ORDER BY created_at DESC LIMIT 1`).get(residentId);
  if (!refund) return res.status(404).json({ error: 'No pending refund' });

  const settlement = applyRefundDecision(db, { refund, decision, userId: req.user.id, notes });
  writeAudit({ propertyId, userId: req.user.id, action: decision==='approved'?'CHECKOUT_APPROVED':'CHECKOUT_REJECTED',
    entityType: 'resident', entityId: residentId, amountPaise: refund.amount_paise, snapshot: { decision, settlement }, ip: req.ip });
  return res.json({ message: `Checkout ${decision}`, decision, settlement });
}

/** POST /api/v1/residents/:id/extend */
function extendStay(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { id } = req.params;
  const { new_expected_checkout, new_rate_paise, new_rate_type, notes } = req.body;
  if (!new_expected_checkout) return res.status(400).json({ error: 'new_expected_checkout required' });
  if (!isValidDate(new_expected_checkout)) return res.status(400).json({ error: 'new_expected_checkout: YYYY-MM-DD' });
  if (new_rate_type !== undefined && !['daily','weekly','monthly'].includes(new_rate_type)) {
    return res.status(400).json({ error: 'new_rate_type must be daily, weekly or monthly' });
  }

  const resident = db.prepare("SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = 'active'").get(id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Active resident not found' });
  if (new_expected_checkout <= resident.expected_checkout) return res.status(400).json({ error: 'New date must be after current' });

  const now = new Date().toISOString();
  let newRate = resident.rate_paise;
  if (new_rate_paise !== undefined) {
    newRate = paisePreserve(new_rate_paise);
    if (newRate === null) return res.status(400).json({ error: 'new_rate_paise must be a number' });
    if (newRate < 0)      return res.status(400).json({ error: 'new_rate_paise must be ≥ 0' });
  }
  const newType = new_rate_type || resident.rate_type;

  db.transaction(() => {
    db.prepare(`INSERT INTO stay_extensions (id,resident_id,property_id,old_checkout,new_checkout,old_rent_paise,new_rent_paise,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(uuidv4(), id, propertyId, resident.expected_checkout, new_expected_checkout, resident.rate_paise, newRate, notes||null, req.user.id, now);
    db.prepare(`UPDATE residents SET expected_checkout=?, rate_paise=?, rate_type=?, monthly_rent_paise=?, updated_at=datetime('now') WHERE id=?`)
      .run(new_expected_checkout, newRate, newType, newType==='daily'?newRate*30:newType==='weekly'?newRate*4:newRate, id);
  })();

  writeAudit({ propertyId, userId: req.user.id, action: 'STAY_EXTENDED', entityType: 'resident', entityId: id,
    snapshot: { old_checkout: resident.expected_checkout, new: new_expected_checkout, old_rate: resident.rate_paise, new_rate: newRate }, ip: req.ip });
  const updated = db.prepare('SELECT * FROM residents WHERE id = ?').get(id);
  updated.aadhaar_number_encrypted = undefined;
  return res.json({ message: 'Stay extended', resident: updated });
}

/** PATCH /api/v1/residents/:id/rent — change rate without extending */
function updateResidentRent(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { id } = req.params;
  const { rate_paise, rate_type, notes } = req.body;
  if (rate_paise === undefined) return res.status(400).json({ error: 'rate_paise required' });
  if (rate_type !== undefined && !['daily','weekly','monthly'].includes(rate_type)) {
    return res.status(400).json({ error: 'rate_type must be daily, weekly or monthly' });
  }

  const resident = db.prepare("SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = 'active'").get(id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Active resident not found' });

  const newRate = paisePreserve(rate_paise);
  if (newRate === null) return res.status(400).json({ error: 'rate_paise must be a number' });
  if (newRate < 0)      return res.status(400).json({ error: 'rate_paise must be ≥ 0' });
  const newType = rate_type || resident.rate_type;
  const monthlyRent = newType==='daily'?newRate*30:newType==='weekly'?newRate*4:newRate;

  db.prepare(`UPDATE residents SET rate_paise=?, rate_type=?, monthly_rent_paise=?, updated_at=datetime('now') WHERE id=?`)
    .run(newRate, newType, monthlyRent, id);
  writeAudit({ propertyId, userId: req.user.id, action: 'RENT_UPDATED', entityType: 'resident', entityId: id,
    snapshot: { old_rate: resident.rate_paise, new_rate: newRate, type: newType, notes }, ip: req.ip });
  return res.json({ message: 'Rate updated', old_rate_paise: resident.rate_paise, new_rate_paise: newRate, rate_type: newType });
}

module.exports = { checkIn, listResidents, getResident, checkOut, checkoutPreview, approveCheckout, applyRefundDecision, extendStay, updateResidentRent };
