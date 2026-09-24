'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/connection');

/**
 * POST /api/v1/feedback/rate — called by WhatsApp webhook
 *
 * FIX (Security — IDOR): Previously accepted property_id from req.body and used it
 * to attribute the feedback. An attacker knowing any resident_id could inject feedback
 * for any property. Fix: property_id is ALWAYS derived from the resident record in DB.
 * Client-supplied property_id is ignored entirely.
 */
function rateFeedback(req, res) {
  const db = getDb();
  const { resident_id, invoice_id, rating } = req.body;

  const VALID_RATINGS = ['good', 'average', 'needs_help'];
  if (!resident_id || !invoice_id || !rating) {
    return res.status(400).json({ error: 'resident_id, invoice_id, rating are required' });
  }
  // These are bound into SQL params; a non-string (object/array) would throw at
  // bind time and 500. Reject anything that isn't a plain string.
  if (typeof resident_id !== 'string' || typeof invoice_id !== 'string') {
    return res.status(400).json({ error: 'resident_id and invoice_id must be strings' });
  }
  if (!VALID_RATINGS.includes(rating)) {
    return res.status(400).json({ error: `rating must be one of: ${VALID_RATINGS.join(', ')}` });
  }

  // Idempotency guard — one feedback per invoice
  const existing = db.prepare('SELECT id FROM tenant_feedback WHERE invoice_id = ?').get(invoice_id);
  if (existing) return res.status(409).json({ error: 'Feedback already recorded for this invoice', id: existing.id });

  // FIX: Always derive property_id from DB. Never trust client body.
  const residentRow = db.prepare('SELECT id, property_id FROM residents WHERE id = ?').get(resident_id);
  if (!residentRow) return res.status(404).json({ error: 'Resident not found' });
  const propertyId = residentRow.property_id;

  const id  = uuidv4();
  const now = new Date().toISOString();
  const isFlagged = rating === 'needs_help' ? 1 : 0;

  db.prepare(`
    INSERT INTO tenant_feedback (id, resident_id, property_id, invoice_id, rating, is_flagged, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, resident_id, propertyId, invoice_id, rating, isFlagged, now);

  return res.status(201).json({ id, rating, is_flagged: isFlagged });
}

/** GET /api/v1/feedback */
function listFeedback(req, res) {
  const db = getDb();
  const { from, to, flagged_only } = req.query;
  let q = `
    SELECT tf.*, r.full_name as resident_name, r.mobile as resident_mobile
    FROM tenant_feedback tf JOIN residents r ON r.id = tf.resident_id
    WHERE tf.property_id = ?
  `;
  const params = [req.user.property_id];
  if (from)         { q += ' AND date(tf.created_at) >= ?'; params.push(from); }
  if (to)           { q += ' AND date(tf.created_at) <= ?'; params.push(to); }
  if (flagged_only) { q += ' AND tf.is_flagged = 1'; }
  q += ' ORDER BY tf.created_at DESC';

  const rows = db.prepare(q).all(...params);
  const summary = {
    total: rows.length,
    good:       rows.filter(r => r.rating === 'good').length,
    average:    rows.filter(r => r.rating === 'average').length,
    needs_help: rows.filter(r => r.rating === 'needs_help').length,
    flagged:    rows.filter(r => r.is_flagged).length,
  };
  return res.json({ summary, feedback: rows });
}

/** PATCH /api/v1/feedback/:id/resolve */
function resolveFeedback(req, res) {
  const db = getDb();
  const { notes } = req.body;
  const row = db.prepare('SELECT * FROM tenant_feedback WHERE id = ? AND property_id = ?')
    .get(req.params.id, req.user.property_id);
  if (!row) return res.status(404).json({ error: 'Feedback not found' });

  db.prepare(`
    UPDATE tenant_feedback SET is_flagged=0, followup_notes=?, resolved_at=datetime('now') WHERE id=?
  `).run(notes || null, req.params.id);

  return res.json({ message: 'Feedback resolved', id: req.params.id });
}

module.exports = { rateFeedback, listFeedback, resolveFeedback };
