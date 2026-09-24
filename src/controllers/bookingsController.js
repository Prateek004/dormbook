'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }       = require('../db/connection');
const { writeAudit }  = require('../middleware/auditLog');

/** POST /api/v1/bookings — lock a bed for up to BOOKING_LOCK_HOURS */
function createBooking(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { bed_id, prospect_name, prospect_phone, advance_deposit_paise = 0 } = req.body;

  if (!bed_id || !prospect_name || !prospect_phone) {
    return res.status(400).json({ error: 'bed_id, prospect_name, prospect_phone are required' });
  }

  const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  const lockHours = prop?.booking_lock_hours || 24;
  const lockExpires = new Date(Date.now() + lockHours * 3600 * 1000).toISOString();

  const bed = db.prepare("SELECT * FROM beds WHERE id = ? AND property_id = ?").get(bed_id, propertyId);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  if (bed.status !== 'available') {
    return res.status(409).json({ error: `Bed is '${bed.status}' — only available beds can be booked` });
  }

  const bookingId = uuidv4();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO booking_requests
        (id, property_id, bed_id, prospect_name, prospect_phone, status,
         advance_deposit_paise, lock_expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(bookingId, propertyId, bed_id, prospect_name.trim(),
      String(prospect_phone).replace(/\D/g,''), advance_deposit_paise,
      lockExpires, req.user.id, now);

    db.prepare("UPDATE beds SET status='reserved', booking_request_id=?, updated_at=datetime('now') WHERE id=?")
      .run(bookingId, bed_id);
  })();

  writeAudit({
    propertyId, userId: req.user.id, action: 'BOOKING_CREATED',
    entityType: 'booking_requests', entityId: bookingId,
    amountPaise: advance_deposit_paise,
    snapshot: { bed_id, prospect_name, lock_expires: lockExpires },
    ip: req.ip,
  });

  return res.status(201).json({
    id: bookingId, bed_id, prospect_name, lock_expires_at: lockExpires,
    status: 'pending',
  });
}

/** GET /api/v1/bookings */
function listBookings(req, res) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT br.*, b.bed_label, rm.room_number, f.label as floor_label
    FROM booking_requests br
    JOIN beds b ON b.id = br.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE br.property_id = ? AND br.status = 'pending'
    ORDER BY br.created_at DESC
  `).all(req.user.property_id);
  return res.json(rows);
}

/** POST /api/v1/bookings/:id/confirm */
function confirmBooking(req, res) {
  const db = getDb();
  const booking = db.prepare(
    "SELECT * FROM booking_requests WHERE id = ? AND property_id = ? AND status = 'pending'"
  ).get(req.params.id, req.user.property_id);
  if (!booking) return res.status(404).json({ error: 'Pending booking not found' });

  if (new Date(booking.lock_expires_at) < new Date()) {
    db.prepare("UPDATE booking_requests SET status='expired' WHERE id=?").run(req.params.id);
    db.prepare("UPDATE beds SET status='available', booking_request_id=NULL, updated_at=datetime('now') WHERE id=?")
      .run(booking.bed_id);
    return res.status(410).json({ error: 'Booking lock has expired' });
  }

  db.prepare("UPDATE booking_requests SET status='confirmed' WHERE id=?").run(req.params.id);
  // Bed stays 'reserved' until actual check-in converts it to 'occupied'
  writeAudit({
    propertyId: req.user.property_id, userId: req.user.id,
    action: 'BOOKING_CONFIRMED', entityType: 'booking_requests', entityId: req.params.id,
    snapshot: { bed_id: booking.bed_id }, ip: req.ip,
  });
  return res.json({ message: 'Booking confirmed', booking_id: req.params.id });
}

/** POST /api/v1/bookings/:id/cancel */
function cancelBooking(req, res) {
  const db = getDb();
  const booking = db.prepare(
    "SELECT * FROM booking_requests WHERE id = ? AND property_id = ? AND status IN ('pending','confirmed')"
  ).get(req.params.id, req.user.property_id);
  if (!booking) return res.status(404).json({ error: 'Active booking not found' });

  db.transaction(() => {
    db.prepare("UPDATE booking_requests SET status='cancelled' WHERE id=?").run(req.params.id);
    db.prepare("UPDATE beds SET status='available', booking_request_id=NULL, updated_at=datetime('now') WHERE id=?")
      .run(booking.bed_id);
  })();

  writeAudit({
    propertyId: req.user.property_id, userId: req.user.id,
    action: 'BOOKING_CANCELLED', entityType: 'booking_requests', entityId: req.params.id,
    snapshot: { bed_id: booking.bed_id }, ip: req.ip,
  });
  return res.json({ message: 'Booking cancelled, bed released' });
}

/**
 * POST /api/v1/bookings/release-expired — called by cron or manager
 *
 * FIX M-02: Previously only released bookings with status='pending'.
 * A booking moves to status='confirmed' after confirmBooking() is called,
 * but the bed stays 'reserved'. If the prospect never checks in and the
 * lock_expires_at passes, the bed would be stuck as 'reserved' forever.
 * Fix: include status='confirmed' in the expiry query.
 */
function releaseExpired(req, res) {
  const db = getDb();
  const expired = db.prepare(`
    SELECT * FROM booking_requests
    WHERE status IN ('pending', 'confirmed') AND julianday(lock_expires_at) < julianday('now')
  `).all();

  let released = 0;
  db.transaction(() => {
    expired.forEach(b => {
      db.prepare("UPDATE booking_requests SET status='expired' WHERE id=?").run(b.id);
      db.prepare("UPDATE beds SET status='available', booking_request_id=NULL, updated_at=datetime('now') WHERE id=?")
        .run(b.bed_id);
      released++;
    });
  })();

  return res.json({ released, message: `${released} expired booking(s) released` });
}

module.exports = { createBooking, listBookings, confirmBooking, cancelBooking, releaseExpired };
