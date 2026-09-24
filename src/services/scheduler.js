'use strict';

/**
 * DormBook Cron Scheduler
 *
 * All jobs run in APP_TZ (default Asia/Kolkata), NOT the server's UTC clock.
 * (Previously they ran in UTC: the 22:00 EOD report went out at 03:30 IST.)
 * Former note: For production use Railway cron
 * or an external scheduler (e.g. Render Cron Jobs) to invoke the API
 * endpoints directly — that allows stateless horizontal scaling.
 *
 * Jobs defined here as in-process fallback for single-instance deploys.
 */

const cron = require('node-cron');
const { getDb } = require('../db/connection');
const { scheduleWhatsApp } = require('./whatsappService');
const { istDate, daysBetween, APP_TZ } = require('../util/time');
const ledger = require('./ledger');

let isStarted = false;

// Wrap a job so a synchronous throw (e.g. a DB error) is logged and swallowed
// instead of propagating out of the cron tick and crashing the process.
function safe(name, fn) {
  return () => {
    try {
      fn();
    } catch (err) {
      console.error(`[SCHEDULER] Job '${name}' failed:`, err && err.stack ? err.stack : err);
    }
  };
}

function startScheduler() {
  if (isStarted) return;
  if (process.env.DISABLE_SCHEDULER === 'true') {
    console.log('[SCHEDULER] Disabled via DISABLE_SCHEDULER=true');
    return;
  }
  isStarted = true;
  console.log('[SCHEDULER] Starting all cron jobs');

  // ── 0. Rent billing — 00:05 every day, plus once now (catches up after downtime) ──
  cron.schedule('5 0 * * *', safe('rent-billing', runDailyBilling), { name: 'rent-billing', timezone: APP_TZ });

  // Nightly database backup (DB_DIR/backups, newest 14 kept)
  cron.schedule('15 3 * * *', safe('db-backup', () => {
    const { dbPath } = require('../db/init');
    require('../db/backup').backupDb(getDb(), dbPath, 'daily');
  }), { name: 'db-backup', timezone: APP_TZ });
  setTimeout(safe('rent-billing-boot', runDailyBilling), 5000);

  // ── 1. Rent reminders — daily at 09:00 ──────────────────
  cron.schedule('0 9 * * *', safe('rent-reminders', sendTieredRentReminders), { name: 'rent-reminders', timezone: APP_TZ });

  // ── 2. EOD report — daily at 22:00 ───────────────────────
  cron.schedule('0 22 * * *', safe('eod-report', sendEodReport), { name: 'eod-report', timezone: APP_TZ });

  // ── 3. Cleaning timeout — every 30 min ───────────────────
  cron.schedule('*/30 * * * *', safe('cleaning-timeout', revertCleanedBeds), { name: 'cleaning-timeout', timezone: APP_TZ });

  // ── 4. Booking expiry — every 15 min ─────────────────────
  cron.schedule('*/15 * * * *', safe('booking-expiry', releaseExpiredBookings), { name: 'booking-expiry', timezone: APP_TZ });

  // ── 5. Overstay alert — daily at 10:00 ───────────────────
  cron.schedule('0 10 * * *', safe('overstay-alerts', sendOverstayAlerts), { name: 'overstay-alerts', timezone: APP_TZ });

  // NOTE: Removed generateMonthlyInvoices cron job.
  // It was creating ₹0 phantom ledger entries (type='rent', amount=0, direction='credit')
  // that corrupted revenue reports and blocked real invoice generation.
  // Billing obligations are derived from residents.monthly_rent_paise — no synthetic entries needed.
}

// ── Rent billing — daily at 00:05 IST (and once at boot) ────────────────────
function runDailyBilling() {
  const { posted, failed } = ledger.runBilling({ asOf: istDate() });
  console.log(`[SCHEDULER] Billing: ${posted} rent charge(s) posted${failed ? `, ${failed} resident(s) FAILED` : ''}`);
}

// ── Rent Reminders (3 days before, due day, 3 and 7 days overdue) ───────────
// Based on real dues in the ledger: a resident who paid is never reminded, and
// "days overdue" counts from the oldest unpaid charge.
function sendTieredRentReminders() {
  const db    = getDb();
  const today = istDate();
  const { ageing } = require('../controllers/dailyReportsController');
  let sent = 0;

  for (const prop of db.prepare('SELECT id FROM properties').all()) {
    const { bal, ageMap } = ageing(db, prop.id, today);
    const residents = db.prepare("SELECT * FROM residents WHERE property_id = ? AND status = 'active'").all(prop.id);
    for (const r of residents) {
      const b = bal.get(r.id);
      const dues = b ? b.dues_paise : 0;
      let eventType = null, data = null;

      if (dues > 0) {
        const oldest = (ageMap.get(r.id) || {}).oldest_unpaid_date;
        const diffDays = oldest ? daysBetween(oldest, today) : 0;
        if (diffDays === 0) eventType = 'rent_due_today';
        else if (diffDays === 3) eventType = 'rent_overdue_3d';
        else if (diffDays === 7) eventType = 'rent_overdue_7d';
        data = { name: r.full_name, amount: dues / 100, due_date: oldest, days_overdue: Math.max(0, diffDays) };
      } else if (r.rate_type !== 'daily' && r.check_in_date) {
        // heads-up 3 days before the next rent cycle starts
        const lastEnd = db.prepare(`SELECT MAX(period_end) e FROM ledger_entries WHERE resident_id = ?
          AND kind='CHARGE' AND category='rent' AND reversal_of IS NULL`).get(r.id).e;
        if (lastEnd && daysBetween(today, lastEnd) === 3 && (!r.expected_checkout || r.expected_checkout > lastEnd)) {
          eventType = 'rent_reminder_3d';
          data = { name: r.full_name, amount: (r.rate_paise || 0) / 100, due_date: lastEnd, days_overdue: 0 };
        }
      }
      if (!eventType) continue;
      sent++;
      scheduleWhatsApp({ propertyId: r.property_id, residentId: r.id, recipientMobile: r.mobile, recipientType: 'tenant', eventType, templateData: data })
        .catch(err => console.error('[SCHEDULER] Reminder error:', err.message));
      if (eventType === 'rent_overdue_7d') {
        scheduleWhatsApp({ propertyId: r.property_id, residentId: r.id, recipientMobile: '', recipientType: 'owner', eventType: 'rent_overdue_7d', templateData: { ...data, mobile: r.mobile } })
          .catch(err => console.error('[SCHEDULER] Owner alert error:', err.message));
      }
    }
  }
  console.log(`[SCHEDULER] Rent reminders: ${sent} sent`);
}

// ── EOD Report (22:00 IST) ──────────────────────────────────────────────────
function sendEodReport() {
  const db    = getDb();
  const today = istDate();

  const properties = db.prepare('SELECT * FROM properties').all();
  properties.forEach(prop => {
    const collection = db.prepare(`
      SELECT COALESCE(SUM(amount_paise),0) as total FROM ledger_entries
      WHERE property_id=? AND kind IN ('PAYMENT','DEPOSIT_IN') AND biz_date=?
    `).get(prop.id, today);

    const occupancy = db.prepare(`
      SELECT
        SUM(CASE WHEN status='occupied'  THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) as available,
        COUNT(*) as total
      FROM beds WHERE property_id=? AND removed_at IS NULL
    `).get(prop.id);

    const overdue = db.prepare(`
      SELECT COUNT(*) as count FROM residents r
      WHERE r.property_id=? AND r.status='active'
        AND (SELECT ${ledger.SQL.dues} FROM ledger_entries le WHERE le.resident_id = r.id) > 0
    `).get(prop.id);

    const problems = ledger.integrityCheck(prop.id);
    if (problems.length) console.error(`[INTEGRITY] Property ${prop.id}: ${problems.length} problem(s)`, JSON.stringify(problems.slice(0, 10)));

    scheduleWhatsApp({
      propertyId: prop.id, residentId: null,
      recipientMobile: prop.whatsapp_number || '', recipientType: 'owner',
      eventType: 'eod_report',
      templateData: {
        date: today, collection: collection.total / 100,
        occupied: occupancy.occupied || 0, available: occupancy.available || 0,
        overdue: overdue.count,
      },
    }).catch(err => console.error('[SCHEDULER] EOD error:', err.message));
  });
}

// ── Cleaning Timeout — revert beds that have been cleaning too long ─────────
function revertCleanedBeds() {
  const db = getDb();
  const properties = db.prepare('SELECT id, cleaning_timeout_minutes FROM properties').all();

  properties.forEach(prop => {
    const timeoutMins = prop.cleaning_timeout_minutes || 120;
    const cutoff = new Date(Date.now() - timeoutMins * 60 * 1000).toISOString();

    const { changes } = db.prepare(`
      UPDATE beds SET status='available', cleaning_started_at=NULL, updated_at=datetime('now')
      WHERE property_id=? AND status='cleaning' AND julianday(cleaning_started_at) < julianday(?)
    `).run(prop.id, cutoff);

    if (changes > 0) console.log(`[SCHEDULER] Reverted ${changes} bed(s) to available for property ${prop.id}`);
  });
}

// ── Booking Expiry ──────────────────────────────────────────────────────────
/**
 * FIX M-02 (scheduler): Include status='confirmed' bookings in expiry query.
 * bookingsController.confirmBooking() sets status='confirmed' but bed remains 'reserved'.
 * If the prospect never checks in and lock_expires_at passes, the bed would be stuck
 * as 'reserved' forever. The same fix was applied to bookingsController.releaseExpired().
 */
function releaseExpiredBookings() {
  const db = getDb();
  const expired = db.prepare(
    "SELECT * FROM booking_requests WHERE status IN ('pending', 'confirmed') AND julianday(lock_expires_at) < julianday('now')"
  ).all();

  if (!expired.length) return;

  db.transaction(() => {
    expired.forEach(b => {
      db.prepare("UPDATE booking_requests SET status='expired' WHERE id=?").run(b.id);
      db.prepare("UPDATE beds SET status='available', booking_request_id=NULL, updated_at=datetime('now') WHERE id=?").run(b.bed_id);
    });
  })();

  console.log(`[SCHEDULER] Released ${expired.length} expired booking(s)`);
}

// ── Overstay Alerts ─────────────────────────────────────────────────────────
/**
 * FIX: Uses distinct 'overstay_alert' event type instead of reusing 'rent_overdue_7d'.
 * The owner gets a clear message about checkout being overdue, not a confusing rent reminder.
 */
function sendOverstayAlerts() {
  const db    = getDb();
  const today = istDate();

  const overstayers = db.prepare(`
    SELECT r.id, r.full_name, r.mobile, r.expected_checkout, r.property_id
    FROM residents r
    WHERE r.status='active' AND r.expected_checkout < ?
  `).all(today);

  overstayers.forEach(r => {
    const days = Math.floor((new Date(today) - new Date(r.expected_checkout)) / 86400000);
    console.warn(`[SCHEDULER] Overstay: ${r.full_name} (${days} days past checkout ${r.expected_checkout})`);
    scheduleWhatsApp({
      propertyId: r.property_id, residentId: r.id,
      recipientMobile: '', recipientType: 'owner',
      eventType: 'overstay_alert',
      templateData: { name: r.full_name, expected_checkout: r.expected_checkout, days_overdue: days },
    }).catch(() => {});
  });

  if (overstayers.length) console.log(`[SCHEDULER] Overstay alerts sent for ${overstayers.length} resident(s)`);
}

module.exports = { startScheduler, runDailyBilling, sendTieredRentReminders, sendEodReport };
