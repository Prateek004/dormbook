'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');
const { scheduleWhatsApp } = require('../services/whatsappService');
const { generateReceipt } = require('../services/receiptService');
const ledger = require('../services/ledger');
const moneyLedger = ledger;
const { istMonth, istDate } = require('../util/time');

/**
 * Integer paise from the request, or null. Strict: "12abc", "", arrays, NaN and
 * fractions of a paisa are rejected instead of being silently rounded/truncated.
 */
function parsePaise(v) {
  if (typeof v === 'string') v = v.trim();
  if (v === '' || v === null || v === undefined || typeof v === 'boolean' || Array.isArray(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n) || n > 1e11) return null;
  return n;
}

const VALID_PAYMENT_MODES = ['cash', 'upi', 'card', 'bank_transfer'];

/**
 * POST /api/v1/payments
 * Record a rent/advance/extra_charge payment.
 */
function recordPayment(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;

  const {
    resident_id, amount_paise, type = 'rent', payment_mode = 'cash',
    billing_month, gateway_txn_id, due_date, notes,
  } = req.body;

  if (!resident_id) return res.status(400).json({ error: 'resident_id is required' });
  const amtPaise = parsePaise(amount_paise);
  if (amtPaise === null) return res.status(400).json({ error: 'amount_paise must be a positive number' });

  const VALID_TYPES = ['rent', 'advance', 'extra_charge', 'deposit'];
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  if (!VALID_PAYMENT_MODES.includes(payment_mode)) {
    return res.status(400).json({ error: `payment_mode must be one of: ${VALID_PAYMENT_MODES.join(', ')}` });
  }

  if (billing_month && !/^\d{4}-\d{2}$/.test(billing_month)) {
    return res.status(400).json({ error: 'billing_month must be in YYYY-MM format' });
  }

  // Residents who already left can still clear their dues; only a new deposit
  // needs an active stay.
  const resident = db.prepare(
    'SELECT * FROM residents WHERE id = ? AND property_id = ?'
  ).get(String(resident_id), propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });
  if (type === 'deposit' && resident.status !== 'active') {
    return res.status(409).json({ error: 'Deposit can only be collected from an active resident' });
  }

  const now = new Date().toISOString();
  const paymentId = uuidv4();
  const gatewayTxn = gateway_txn_id ? String(gateway_txn_id).trim().slice(0, 100) : null;
  const clientKey = req.get('Idempotency-Key') ? String(req.get('Idempotency-Key')).slice(0, 100) : null;

  // Same request retried (network drop, refresh) → return the payment already saved.
  if (clientKey) {
    const prior = db.prepare(`SELECT source_id FROM ledger_entries WHERE idem_key = ?`).get(`api:${propertyId}:${clientKey}`);
    if (prior) {
      return res.status(200).json({ message: 'Payment already recorded', duplicate: true,
        payment: db.prepare('SELECT * FROM payment_ledger WHERE id = ?').get(prior.source_id) });
    }
  }
  // Double-click guard: identical payment by the same person in the last 60 seconds.
  const recentSame = db.prepare(`SELECT id FROM payment_ledger WHERE resident_id = ? AND amount_paise = ? AND type = ?
      AND payment_mode = ? AND recorded_by = ? AND julianday(created_at) > julianday('now', '-60 seconds')`)
    .get(resident.id, amtPaise, type, payment_mode, req.user.id);
  if (recentSame && !req.body.confirm_duplicate) {
    return res.status(409).json({ error: 'The same payment was recorded less than a minute ago. Check the resident\'s payments before recording it again.',
      code: 'POSSIBLE_DUPLICATE', existing_payment_id: recentSame.id });
  }

  // payment_ledger (receipts/UI) and the money ledger are written together:
  // either both succeed or neither does.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO payment_ledger
        (id,property_id,resident_id,billing_month,amount_paise,direction,type,
         payment_mode,gateway_txn_id,due_date,paid_at,requires_approval,
         approval_status,notes,recorded_by,created_at)
      VALUES (?,?,?,?,?,'credit',?,?,?,?,?,0,'not_required',?,?,?)
    `).run(
      paymentId, propertyId, resident.id,
      billing_month || istMonth(),
      amtPaise, type, payment_mode, gatewayTxn,
      due_date || null, now, notes || null, req.user.id, now
    );

    const common = { propertyId, residentId: resident.id, amountPaise: amtPaise, userId: req.user.id,
      sourceTable: 'payment_ledger', sourceId: paymentId, reason: notes || null,
      // a gateway transaction id can only ever be recorded once
      idemKey: gatewayTxn ? `gw:${propertyId}:${gatewayTxn}` : clientKey ? `api:${propertyId}:${clientKey}` : null };
    if (type === 'deposit') {
      ledger.depositIn({ ...common, mode: payment_mode });
    } else if (type === 'extra_charge') {
      // An extra charge paid on the spot: the resident owes it AND paid it.
      ledger.charge({ ...common, idemKey: null, category: 'other', reason: notes || 'Extra charge' });
      ledger.payment({ ...common, mode: payment_mode, category: 'other' });
    } else {
      ledger.payment({ ...common, mode: payment_mode, category: 'rent' });
    }
  })();

  writeAudit({
    propertyId, userId: req.user.id, action: 'PAYMENT_RECORDED',
    entityType: 'payment_ledger', entityId: paymentId,
    amountPaise: amtPaise,
    snapshot: { resident_id, type, mode: payment_mode, billing_month },
    ip: req.ip,
  });

  // Generate receipt async
  generateReceipt({ db, paymentId, propertyId, residentId: resident_id, actorId: req.user.id })
    .then(receipt => {
      if (receipt && resident.mobile) {
        scheduleWhatsApp({
          propertyId, residentId: resident_id,
          recipientMobile: resident.mobile, recipientType: 'tenant',
          eventType: 'payment_receipt',
          templateData: {
            name: resident.full_name,
            amount: amtPaise / 100,
            receipt_no: receipt.receipt_number,
            month: billing_month || istMonth(),
          },
        });
      }
    })
    .catch(err => console.error('[RECEIPT]', err.message));

  const payment = db.prepare('SELECT * FROM payment_ledger WHERE id = ?').get(paymentId);
  return res.status(201).json({ message: 'Payment recorded', payment });
}

/** GET /api/v1/residents/:id/ledger */
function getResidentLedger(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const residentId = req.params.id;

  const resident = db.prepare(
    'SELECT id, full_name, mobile, monthly_rent_paise, deposit_paise, status FROM residents WHERE id = ? AND property_id = ?'
  ).get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  const ledger = db.prepare(
    'SELECT * FROM payment_ledger WHERE resident_id = ? ORDER BY created_at DESC'
  ).all(residentId);

  // Rejected / still-pending refunds were never paid out — don't subtract them.
  const totalPaid      = ledger.filter(l => l.direction === 'credit').reduce((s, l) => s + l.amount_paise, 0);
  const totalRefunded  = ledger.filter(l => l.direction === 'debit' && ['approved', 'not_required'].includes(l.approval_status))
    .reduce((s, l) => s + l.amount_paise, 0);
  const balance        = totalPaid - totalRefunded;
  const pendingApproval= ledger.filter(l => l.approval_status === 'pending');
  const money          = moneyLedger.balances(residentId);

  return res.json({
    resident,
    ledger,
    summary: {
      total_paid_paise:     totalPaid,
      total_refunded_paise: totalRefunded,
      balance_paise:        balance,
      pending_approval:     pendingApproval.length,
      dues_paise:           money.dues_paise,      // what the resident owes now (negative = advance)
      deposit_held_paise:   money.deposit_paise,   // deposit you are holding
    },
  });
}

/** GET /api/v1/payments/pending-approvals */
function pendingApprovals(req, res) {
  const db = getDb();
  const list = db.prepare(`
    SELECT pl.*, r.full_name as resident_name, r.mobile as resident_mobile
    FROM payment_ledger pl
    JOIN residents r ON r.id = pl.resident_id
    WHERE pl.property_id = ? AND pl.approval_status = 'pending'
    ORDER BY pl.created_at ASC
  `).all(req.user.property_id);
  return res.json(list);
}

/** POST /api/v1/payments/:id/approve */
function approvePayment(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { decision, notes } = req.body;

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }

  const payment = db.prepare(
    "SELECT * FROM payment_ledger WHERE id = ? AND property_id = ? AND approval_status = 'pending'"
  ).get(req.params.id, propertyId);
  if (!payment) return res.status(404).json({ error: 'Pending payment not found' });

  // A pending deposit refund IS a checkout waiting for approval. Approving it
  // here must finish the checkout too (free the bed, pay out, settle dues) —
  // previously the resident stayed 'active' and the bed stayed occupied.
  if (payment.type === 'deposit_refund') {
    const { applyRefundDecision } = require('./checkinController');
    applyRefundDecision(db, { refund: payment, decision, userId: req.user.id, notes });
  } else {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE payment_ledger
      SET approval_status=?, approved_by=?, approved_at=?, notes=COALESCE(?,notes)
      WHERE id=? AND approval_status='pending'
    `).run(decision, req.user.id, now, notes || null, req.params.id);
  }

  writeAudit({
    propertyId, userId: req.user.id,
    action: `PAYMENT_${decision.toUpperCase()}`,
    entityType: 'payment_ledger', entityId: req.params.id,
    amountPaise: payment.amount_paise,
    snapshot: { decision, type: payment.type },
    ip: req.ip,
  });

  return res.json({ message: `Payment ${decision}`, decision });
}

/** POST /api/v1/residents/:id/refund-deductions */
function addRefundDeduction(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const residentId = req.params.id;
  const { amount_paise, reason } = req.body;

  const amtPaise = parsePaise(amount_paise);
  if (!amtPaise || amtPaise <= 0) return res.status(400).json({ error: 'amount_paise must be > 0' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason is required' });

  const resident = db.prepare(
    'SELECT id FROM residents WHERE id = ? AND property_id = ?'
  ).get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  const id = uuidv4();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO refund_deductions (id, resident_id, amount_paise, reason, logged_by, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(id, residentId, amtPaise, reason.trim(), req.user.id);
    // The deduction is money the resident owes; it is recovered from the deposit at checkout.
    ledger.charge({ propertyId, residentId, amountPaise: amtPaise, category: 'damage', reason: reason.trim(),
      userId: req.user.id, sourceTable: 'refund_deductions', sourceId: id });
  })();

  return res.status(201).json({ id, resident_id: residentId, amount_paise: amtPaise, reason: reason.trim() });
}

/**
 * GET /api/v1/residents/:id/refund-summary
 *
 * Uses the money ledger: dues = everything charged (rent for the real stay,
 * extra charges, deductions) minus everything paid/discounted. The old version
 * assumed a full monthly_rent for every calendar month, so a 3-day daily-rate
 * guest or a mid-month joiner showed a whole month of dues.
 */
function getRefundSummary(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const residentId = req.params.id;

  const resident = db.prepare(
    'SELECT * FROM residents WHERE id = ? AND property_id = ?'
  ).get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  ledger.billNow(residentId); // make sure every started rent cycle is charged
  const deductions = db.prepare('SELECT * FROM refund_deductions WHERE resident_id = ?').all(residentId);
  const { dues_paise: dues, deposit_paise: deposit } = ledger.balances(residentId);
  const pendingDues = Math.max(0, dues);

  const netRefund = Math.max(0, deposit - pendingDues);
  const isBlocked = pendingDues > deposit;

  return res.json({
    deposit_paise:          deposit,
    total_deductions_paise: deductions.reduce((s, d) => s + d.amount_paise, 0), // already inside pending dues
    pending_dues_paise:     pendingDues,
    advance_credit_paise:   Math.max(0, -dues),
    net_refund_paise:       netRefund,
    is_blocked:             isBlocked,
    block_reason:           isBlocked ? 'Dues exceed deposit amount — resident must clear balance before checkout' : null,
    deductions,
  });
}

module.exports = {
  recordPayment, getResidentLedger, pendingApprovals,
  approvePayment, addRefundDeduction, getRefundSummary,
};
