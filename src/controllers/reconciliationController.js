'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }       = require('../db/connection');
const { writeAudit }  = require('../middleware/auditLog');
const { scheduleWhatsApp } = require('../services/whatsappService');
const ledger = require('../services/ledger');
const { istDate, isValidDate } = require('../util/time');

/**
 * POST /api/v1/reconciliation/cash
 *
 * Expected cash now comes from the ledger:
 *   opening (last close's counted cash) + cash received − cash paid out
 * where "paid out" includes cash EXPENSES and cash refunds (previously expenses
 * were ignored, so every cash expense showed up as a shortage), and pending /
 * rejected refunds are not counted (no cash left the drawer).
 * Closing a day locks it: nothing can be back-dated into it afterwards. Any
 * earlier unclosed days are included, so a skipped day is never lost.
 */
function closeCashDrawer(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { date, drawer_amount_paise, opening_cash_paise } = req.body;

  if (!date || drawer_amount_paise === undefined || drawer_amount_paise === null || drawer_amount_paise === '') {
    return res.status(400).json({ error: 'date and drawer_amount_paise are required' });
  }
  if (!isValidDate(String(date))) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const drawerPaise = Number(drawer_amount_paise);
  if (!Number.isInteger(drawerPaise) || drawerPaise < 0) {
    return res.status(400).json({ error: 'drawer_amount_paise must be a whole number ≥ 0' });
  }
  let openingPaise;
  if (opening_cash_paise !== undefined && opening_cash_paise !== null && opening_cash_paise !== '') {
    openingPaise = Number(opening_cash_paise);
    if (!Number.isInteger(openingPaise) || openingPaise < 0) {
      return res.status(400).json({ error: 'opening_cash_paise must be a whole number ≥ 0' });
    }
  }

  const prop = db.prepare('SELECT cash_reconciliation_tolerance_paise FROM properties WHERE id = ?').get(propertyId);
  const tolerance = prop?.cash_reconciliation_tolerance_paise ?? 0;

  const id  = uuidv4();
  const now = new Date().toISOString();
  let close;
  db.transaction(() => {
    close = ledger.closeDay({ propertyId, date: String(date), countedPaise: drawerPaise, openingPaise,
      userId: req.user.id, reconciliationId: id });
    db.prepare(`
      INSERT INTO cash_reconciliations
        (id, property_id, date, drawer_amount_paise, system_amount_paise, delta_paise,
         is_discrepancy, submitted_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, propertyId, String(date), drawerPaise, close.expected_cash_paise, close.variance_paise,
      Math.abs(close.variance_paise) > tolerance ? 1 : 0, req.user.id, now);
  })();

  const deltaPaise = close.variance_paise;
  const isDiscrepancy = Math.abs(deltaPaise) > tolerance;

  writeAudit({
    propertyId, userId: req.user.id, action: 'CASH_RECONCILIATION',
    entityType: 'cash_reconciliations', entityId: id,
    amountPaise: deltaPaise,
    snapshot: { date, ...close, is_discrepancy: isDiscrepancy },
    ip: req.ip,
  });

  if (isDiscrepancy) {
    scheduleWhatsApp({
      propertyId, residentId: null,
      recipientMobile: '', recipientType: 'owner',
      eventType: 'cash_discrepancy_alert',
      templateData: {
        date, delta: (deltaPaise / 100).toFixed(2),
        drawer: (drawerPaise / 100).toFixed(2),
        system: (close.expected_cash_paise / 100).toFixed(2),
      },
    }).catch(err => console.error('[RECONCILE] alert failed:', err.message));
  }

  return res.status(201).json({
    id, date, drawer_amount_paise: drawerPaise, system_amount_paise: close.expected_cash_paise,
    delta_paise: deltaPaise, is_discrepancy: isDiscrepancy,
    opening_cash_paise: close.opening_cash_paise, cash_in_paise: close.cash_in_paise,
    cash_out_paise: close.cash_out_paise, covers_from: close.from_date,
  });
}

/** GET /api/v1/reconciliation/cash/preview?date= — what the system expects before counting. */
function previewCashDrawer(req, res) {
  const date = req.query.date ? String(req.query.date) : istDate();
  if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  return res.json({ date, ...ledger.cashPosition(req.user.property_id, date) });
}

/** GET /api/v1/reconciliation/cash */
function listReconciliations(req, res) {
  const db = getDb();
  const { from, to } = req.query;
  let q = `SELECT rc.*, u.name as submitted_by_name FROM cash_reconciliations rc
           JOIN users u ON u.id = rc.submitted_by WHERE rc.property_id = ?`;
  const params = [req.user.property_id];
  if (from) { q += ' AND rc.date >= ?'; params.push(from); }
  if (to)   { q += ' AND rc.date <= ?'; params.push(to); }
  q += ' ORDER BY rc.date DESC';
  return res.json(db.prepare(q).all(...params));
}

/** PATCH /api/v1/reconciliation/cash/:id/explain */
function explainDiscrepancy(req, res) {
  const db = getDb();
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'note is required' });

  const rec = db.prepare(
    'SELECT * FROM cash_reconciliations WHERE id = ? AND property_id = ?'
  ).get(req.params.id, req.user.property_id);
  if (!rec) return res.status(404).json({ error: 'Reconciliation not found' });

  db.prepare('UPDATE cash_reconciliations SET owner_note = ? WHERE id = ?').run(note.trim(), req.params.id);
  return res.json({ message: 'Note saved', id: req.params.id });
}

module.exports = { closeCashDrawer, previewCashDrawer, listReconciliations, explainDiscrepancy };
