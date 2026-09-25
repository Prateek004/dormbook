'use strict';
/**
 * The 5 daily-operations reports + resident statement + ledger actions.
 * All money comes from ledger_entries; beds/residents from their own tables.
 */
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');
const ledger = require('../services/ledger');
const { istDate, isValidDate, addDays, daysBetween } = require('../util/time');

const { SQL } = ledger;

function dateParam(req, res) {
  const d = req.query.date ? String(req.query.date) : istDate();
  if (!isValidDate(d)) { res.status(400).json({ error: 'date must be YYYY-MM-DD' }); return null; }
  return d;
}

function balancesByResident(db, propertyId) {
  const m = new Map();
  db.prepare(`SELECT resident_id, ${SQL.dues} AS dues_paise, ${SQL.deposit} AS deposit_paise
    FROM ledger_entries WHERE property_id = ? AND resident_id IS NOT NULL GROUP BY resident_id`)
    .all(propertyId).forEach((r) => m.set(r.resident_id, r));
  return m;
}

/**
 * FIFO ageing: a resident's outstanding balance is made of their NEWEST charges;
 * walk back from the newest until the balance is covered. The oldest charge
 * touched is the oldest unpaid one (drives "days overdue").
 */
function ageing(db, propertyId, asOf) {
  const bal = balancesByResident(db, propertyId);
  const out = new Map();
  const rows = db.prepare(`SELECT resident_id, ref_date, amount_paise FROM ledger_entries
    WHERE property_id = ? AND kind IN ('CHARGE','OPENING_DUES') AND ${SQL.live}
    ORDER BY resident_id, ref_date DESC, rowid DESC`).all(propertyId);
  let cur = null, remaining = 0, acc = null;
  for (const c of rows) {
    if (c.resident_id !== cur) {
      cur = c.resident_id;
      remaining = Math.max(0, (bal.get(cur) || {}).dues_paise || 0);
      acc = { oldest_unpaid_date: null, d0_7: 0, d8_30: 0, d31_60: 0, d60_plus: 0 };
      out.set(cur, acc);
    }
    if (remaining <= 0) continue;
    const part = Math.min(remaining, c.amount_paise);
    remaining -= part;
    const age = Math.max(0, daysBetween(c.ref_date, asOf));
    if (age <= 7) acc.d0_7 += part; else if (age <= 30) acc.d8_30 += part;
    else if (age <= 60) acc.d31_60 += part; else acc.d60_plus += part;
    acc.oldest_unpaid_date = c.ref_date;
  }
  return { bal, ageMap: out };
}

// ── Report 1: Today's Snapshot ───────────────────────────────────────────────
function snapshot(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const d = dateParam(req, res); if (!d) return;

  const beds = db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN status='occupied' THEN 1 ELSE 0 END) occupied,
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) available,
      SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END) reserved,
      SUM(CASE WHEN status='cleaning' THEN 1 ELSE 0 END) cleaning,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending
    FROM beds WHERE property_id = ? AND removed_at IS NULL`).get(pid);
  const total = beds.total || 0;

  const moves = db.prepare(`SELECT
      SUM(CASE WHEN check_in_date = @d THEN 1 ELSE 0 END) check_ins,
      SUM(CASE WHEN actual_checkout = @d THEN 1 ELSE 0 END) check_outs,
      SUM(CASE WHEN status='active' AND expected_checkout = @d THEN 1 ELSE 0 END) due_out
    FROM residents WHERE property_id = @pid`).get({ pid, d });

  const collections = db.prepare(`SELECT mode,
      COALESCE(SUM(CASE WHEN kind='PAYMENT' THEN amount_paise END),0) payments_paise,
      COALESCE(SUM(CASE WHEN kind='DEPOSIT_IN' THEN amount_paise END),0) deposits_paise
    FROM ledger_entries WHERE property_id = ? AND biz_date = ? AND kind IN ('PAYMENT','DEPOSIT_IN')
    GROUP BY mode`).all(pid, d);

  const bal = [...balancesByResident(db, pid).values()];
  const cash = ledger.cashPosition(pid, d);

  const out = {
    date: d,
    beds: {
      total, occupied: beds.occupied || 0, available: beds.available || 0, reserved: beds.reserved || 0,
      cleaning: beds.cleaning || 0, pending: beds.pending || 0,
      occupancy_pct: total ? Math.round(((beds.occupied || 0) * 1000) / total) / 10 : 0,
    },
    today: { check_ins: moves.check_ins || 0, check_outs: moves.check_outs || 0, due_to_leave: moves.due_out || 0 },
    collected: {
      total_paise: collections.reduce((s, r) => s + r.payments_paise + r.deposits_paise, 0),
      by_mode: collections,
    },
    outstanding: {
      total_dues_paise: bal.reduce((s, r) => s + Math.max(0, r.dues_paise), 0),
      residents_with_dues: bal.filter((r) => r.dues_paise > 0).length,
      advance_credit_paise: bal.reduce((s, r) => s + Math.max(0, -r.dues_paise), 0),
      deposits_held_paise: bal.reduce((s, r) => s + r.deposit_paise, 0),
    },
    cash_drawer: {
      is_closed: cash.is_closed, closed_through: cash.closed_through,
      expected_cash_paise: cash.is_closed ? null : cash.expected_cash_paise,
    },
  };
  if (req.user.role === 'reception') { // reception sees operations, not money totals
    delete out.outstanding; delete out.collected;
  }
  return res.json(out);
}

// ── Report 2: Bed Status Map ─────────────────────────────────────────────────
function bedMap(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const rows = db.prepare(`
    SELECT b.id bed_id, b.bed_label bed, b.status, b.daily_rate_paise, b.updated_at,
           rm.id room_id, rm.room_number room, f.id floor_id, f.label floor, f.floor_number,
           r.id resident_id, r.full_name resident, r.mobile, r.check_in_date, r.expected_checkout,
           r.rate_type, r.rate_paise
    FROM beds b
    JOIN rooms rm ON rm.id = b.room_id
    JOIN floors f ON f.id = rm.floor_id
    LEFT JOIN residents r ON r.bed_id = b.id AND r.status = 'active'
    WHERE b.property_id = ? AND b.removed_at IS NULL
    ORDER BY f.floor_number, rm.room_number, b.bed_label`).all(pid);
  const bal = req.user.role === 'reception' ? new Map() : balancesByResident(db, pid);
  const today = istDate();
  const floors = new Map();
  for (const x of rows) {
    const bed = { bed_id: x.bed_id, bed: x.bed, status: x.status };
    if (x.resident_id) {
      const b = bal.get(x.resident_id);
      Object.assign(bed, {
        resident_id: x.resident_id, resident: x.resident, mobile: x.mobile, since: x.check_in_date,
        leaving_on: x.expected_checkout, overstay: !!(x.expected_checkout && x.expected_checkout < today),
        rate_type: x.rate_type, rate_paise: x.rate_paise,
        ...(b ? { dues_paise: b.dues_paise, deposit_paise: b.deposit_paise } : {}),
      });
    } else if (x.status === 'available') {
      bed.vacant_since = x.updated_at ? String(x.updated_at).slice(0, 10) : null;
    }
    if (!floors.has(x.floor_id)) floors.set(x.floor_id, { floor_id: x.floor_id, floor: x.floor, rooms: new Map() });
    const f = floors.get(x.floor_id);
    if (!f.rooms.has(x.room_id)) f.rooms.set(x.room_id, { room_id: x.room_id, room: x.room, beds: [] });
    f.rooms.get(x.room_id).beds.push(bed);
  }
  return res.json({ date: today, floors: [...floors.values()].map((f) => ({ ...f, rooms: [...f.rooms.values()] })) });
}

// ── Report 3: Dues Follow-up (with ageing) ───────────────────────────────────
function dues(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const d = dateParam(req, res); if (!d) return;
  const { bal, ageMap } = ageing(db, pid, d);
  const people = new Map(db.prepare(`SELECT r.id, r.full_name, r.mobile, r.status, b.bed_label, rm.room_number
    FROM residents r LEFT JOIN beds b ON b.id = r.bed_id LEFT JOIN rooms rm ON rm.id = b.room_id
    WHERE r.property_id = ?`).all(pid).map((r) => [r.id, r]));
  const lastPaid = new Map(db.prepare(`SELECT resident_id, MAX(biz_date) d FROM ledger_entries
    WHERE property_id = ? AND kind = 'PAYMENT' AND ${SQL.live} GROUP BY resident_id`).all(pid).map((r) => [r.resident_id, r.d]));
  const lastReminder = new Map(db.prepare(`SELECT resident_id, MAX(created_at) at FROM notification_log
    WHERE property_id = ? AND event_type LIKE 'rent_%' GROUP BY resident_id`).all(pid).map((r) => [r.resident_id, r.at]));

  const rows = [];
  for (const [rid, b] of bal) {
    if (b.dues_paise <= 0) continue;
    const a = ageMap.get(rid) || {};
    const p = people.get(rid) || {};
    rows.push({
      resident_id: rid, resident: p.full_name || '(unknown)', mobile: p.mobile || null, status: p.status || null,
      bed: [p.room_number, p.bed_label].filter(Boolean).join(' / ') || null,
      dues_paise: b.dues_paise, deposit_held_paise: b.deposit_paise,
      oldest_unpaid_date: a.oldest_unpaid_date || null,
      days_overdue: a.oldest_unpaid_date ? Math.max(0, daysBetween(a.oldest_unpaid_date, d)) : 0,
      last_payment_date: lastPaid.get(rid) || null,
      last_reminder_at: lastReminder.get(rid) || null,
      ageing: { d0_7: a.d0_7 || 0, d8_30: a.d8_30 || 0, d31_60: a.d31_60 || 0, d60_plus: a.d60_plus || 0 },
      risk: p.status === 'checked_out' ? 'LEFT_WITH_DUES' : b.dues_paise > b.deposit_paise ? 'DUES_EXCEED_DEPOSIT' : null,
    });
  }
  rows.sort((x, y) => y.days_overdue - x.days_overdue || y.dues_paise - x.dues_paise);
  const totals = rows.reduce((s, r) => {
    s.dues_paise += r.dues_paise; s.d0_7 += r.ageing.d0_7; s.d8_30 += r.ageing.d8_30;
    s.d31_60 += r.ageing.d31_60; s.d60_plus += r.ageing.d60_plus; return s;
  }, { dues_paise: 0, d0_7: 0, d8_30: 0, d31_60: 0, d60_plus: 0 });
  return res.json({ date: d, count: rows.length, totals, rows });
}

// ── Report 4: Daily Cash Book ────────────────────────────────────────────────
function cashBook(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const d = dateParam(req, res); if (!d) return;
  const entries = db.prepare(`
    SELECT e.id, e.created_at, e.kind, e.category, e.mode, e.amount_paise, e.reason, e.reversal_of,
           e.resident_id, r.full_name resident, u.name recorded_by,
           EXISTS (SELECT 1 FROM ledger_entries x WHERE x.reversal_of = e.id) is_reversed
    FROM ledger_entries e
    LEFT JOIN residents r ON r.id = e.resident_id
    LEFT JOIN users u ON u.id = e.user_id
    WHERE e.property_id = ? AND e.biz_date = ? AND e.kind IN ('PAYMENT','DEPOSIT_IN','DEPOSIT_REFUND','CREDIT_REFUND','EXPENSE','BANK_DEPOSIT')
    ORDER BY e.created_at, e.rowid`).all(pid, d);
  const byMode = {};
  for (const e of entries) {
    const m = e.mode || 'cash';
    byMode[m] = byMode[m] || { in_paise: 0, out_paise: 0 };
    if (e.kind === 'PAYMENT' || e.kind === 'DEPOSIT_IN') byMode[m].in_paise += e.amount_paise;
    else byMode[m].out_paise += e.amount_paise;
  }
  const byStaff = db.prepare(`SELECT COALESCE(u.name,'—') staff, e.mode, SUM(e.amount_paise) collected_paise
    FROM ledger_entries e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.property_id = ? AND e.biz_date = ? AND e.kind IN ('PAYMENT','DEPOSIT_IN')
    GROUP BY u.name, e.mode`).all(pid, d);
  const close = db.prepare('SELECT * FROM day_closes WHERE property_id = ? AND biz_date = ?').get(pid, d);
  return res.json({
    date: d,
    entries: entries.map((e) => ({ ...e, is_reversed: !!e.is_reversed })),
    by_mode: byMode, by_staff: byStaff,
    drawer: ledger.cashPosition(pid, d),
    close: close || null,
  });
}

// ── Report 5: Movement Register ──────────────────────────────────────────────
function movements(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const d = dateParam(req, res); if (!d) return;
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 0 || days > 60) return res.status(400).json({ error: 'days must be 0–60' });
  const to = addDays(d, days);
  const bal = req.user.role === 'reception' ? new Map() : balancesByResident(db, pid);
  const base = `SELECT r.id resident_id, r.full_name resident, r.mobile, r.status, r.check_in_date, r.expected_checkout,
      r.actual_checkout, b.bed_label bed, rm.room_number room
    FROM residents r LEFT JOIN beds b ON b.id = r.bed_id LEFT JOIN rooms rm ON rm.id = b.room_id
    WHERE r.property_id = @pid`;
  const money = (r) => {
    const b = bal.get(r.resident_id);
    if (!b) return {};
    return { dues_paise: b.dues_paise, deposit_paise: b.deposit_paise,
      refund_due_paise: b.deposit_paise - Math.max(0, b.dues_paise) };
  };
  const q = (extra, p) => db.prepare(`${base} AND ${extra}`).all({ pid, ...p }).map((r) => ({ ...r, ...money(r) }));
  return res.json({
    from: d, to,
    check_ins: q('r.check_in_date BETWEEN @d AND @to ORDER BY r.check_in_date', { d, to }),
    check_outs: q("r.status = 'checked_out' AND r.actual_checkout BETWEEN @d AND @to ORDER BY r.actual_checkout", { d, to }),
    due_to_leave: q("r.status = 'active' AND r.expected_checkout BETWEEN @d AND @to ORDER BY r.expected_checkout", { d, to }),
    overstaying: q("r.status = 'active' AND r.expected_checkout < @d ORDER BY r.expected_checkout", { d }),
    arriving_bookings: db.prepare(`SELECT br.id booking_id, br.prospect_name, br.prospect_phone, br.advance_deposit_paise,
        br.lock_expires_at, b.bed_label bed FROM booking_requests br LEFT JOIN beds b ON b.id = br.bed_id
      WHERE br.property_id = ? AND br.status IN ('pending','confirmed') ORDER BY br.lock_expires_at`).all(pid),
  });
}

// ── Resident statement (running balance) ─────────────────────────────────────
function residentStatement(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const r = db.prepare('SELECT id, full_name, status FROM residents WHERE id = ? AND property_id = ?').get(req.params.id, pid);
  if (!r) return res.status(404).json({ error: 'Resident not found' });
  if (r.status === 'active') ledger.billNow(r.id);
  const rows = db.prepare(`SELECT e.id, e.biz_date, e.ref_date, e.kind, e.category, e.mode, e.amount_paise, e.reason,
      e.reversal_of, e.period_start, e.period_end, e.origin, u.name recorded_by
    FROM ledger_entries e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.property_id = ? AND e.resident_id = ? ORDER BY e.biz_date, e.rowid`).all(pid, r.id);
  let dues = 0, deposit = 0;
  const entries = rows.map((e) => {
    const a = e.amount_paise;
    if (e.kind === 'CHARGE' || e.kind === 'OPENING_DUES' || e.kind === 'CREDIT_REFUND') dues += a;
    if (e.kind === 'PAYMENT' || e.kind === 'WAIVER' || e.kind === 'DEPOSIT_APPLY') dues -= a;
    if (e.kind === 'DEPOSIT_IN' || e.kind === 'OPENING_DEPOSIT') deposit += a;
    if (e.kind === 'DEPOSIT_APPLY' || e.kind === 'DEPOSIT_REFUND') deposit -= a;
    return { ...e, dues_after_paise: dues, deposit_after_paise: deposit };
  });
  return res.json({ resident: r, balance: ledger.balances(r.id), entries });
}

// ── Actions ──────────────────────────────────────────────────────────────────
function addWaiver(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const amount = Number(req.body.amount_paise);
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount_paise must be a positive whole number' });
  const reason = req.body.reason ? String(req.body.reason).trim().slice(0, 300) : '';
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const row = ledger.waive({ propertyId: pid, residentId: req.params.id, amountPaise: amount, reason,
    category: req.body.category || 'rent', userId: req.user.id }, db);
  writeAudit({ propertyId: pid, userId: req.user.id, action: 'DISCOUNT_GIVEN', entityType: 'resident',
    entityId: req.params.id, amountPaise: amount, snapshot: { reason }, ip: req.ip });
  return res.status(201).json({ entry: row, balance: ledger.balances(req.params.id) });
}

function reverseEntry(req, res) {
  const pid = req.user.property_id;
  const reason = req.body.reason ? String(req.body.reason).trim().slice(0, 300) : '';
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const entry = getDb().prepare('SELECT * FROM ledger_entries WHERE id = ? AND property_id = ?').get(req.params.id, pid);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (entry.source_table) {
    // Entries created from a payment/expense must be undone from that screen, so both records stay in step.
    return res.status(409).json({ error: `This entry belongs to a ${entry.source_table.replace('_', ' ')} record — correct it there` });
  }
  const row = ledger.reverse({ propertyId: pid, entryId: entry.id, reason, userId: req.user.id });
  writeAudit({ propertyId: pid, userId: req.user.id, action: 'LEDGER_REVERSED', entityType: 'ledger_entries',
    entityId: entry.id, amountPaise: entry.amount_paise, snapshot: { reason, kind: entry.kind }, ip: req.ip });
  return res.status(201).json({ reversal: row });
}

function integrity(req, res) {
  const problems = ledger.integrityCheck(req.user.property_id);
  return res.json({ ok: problems.length === 0, problems });
}

// ── Dashboard: today's work, in the order staff do it ───────────────────────
function today(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const d = istDate();
  const { hasPermission } = require('../middleware/permissions');
  const money = hasPermission(req, 'reports_finance');
  const base = `SELECT r.id, r.full_name, r.mobile, r.check_in_date, r.expected_checkout, b.bed_label bed
    FROM residents r LEFT JOIN beds b ON b.id = r.bed_id WHERE r.property_id = ? AND r.status = 'active'`;

  const beds = db.prepare(`SELECT COUNT(*) total,
      SUM(status='occupied') occupied, SUM(status='available') available, SUM(status='cleaning') cleaning,
      SUM(status='reserved') reserved FROM beds WHERE property_id = ? AND removed_at IS NULL`).get(pid);
  const leavingToday = db.prepare(`${base} AND r.expected_checkout = ? ORDER BY b.bed_label`).all(pid, d);
  const overstaying = db.prepare(`${base} AND r.expected_checkout < ? ORDER BY r.expected_checkout`).all(pid, d);
  const cleaning = db.prepare(`SELECT id, bed_label bed, cleaning_started_at FROM beds WHERE property_id = ? AND status = 'cleaning' AND removed_at IS NULL ORDER BY bed_label`).all(pid);
  const arrivals = db.prepare(`SELECT br.id, br.prospect_name, br.prospect_phone, br.lock_expires_at, b.bed_label bed
    FROM booking_requests br LEFT JOIN beds b ON b.id = br.bed_id
    WHERE br.property_id = ? AND br.status IN ('pending','confirmed') ORDER BY br.lock_expires_at`).all(pid);
  const approvals = db.prepare(`SELECT pl.id, pl.amount_paise, pl.type, r.full_name FROM payment_ledger pl
    JOIN residents r ON r.id = pl.resident_id WHERE pl.property_id = ? AND pl.approval_status = 'pending'`).all(pid);
  const cash = ledger.cashPosition(pid, addDays(d, -1));
  const yesterdayOpen = !cash.is_closed && (cash.cash_in_paise !== 0 || cash.cash_out_paise !== 0);
  const collectedToday = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries
    WHERE property_id = ? AND biz_date = ? AND kind IN ('PAYMENT','DEPOSIT_IN')`).get(pid, d).t;
  const collectedCash = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries
    WHERE property_id = ? AND biz_date = ? AND kind IN ('PAYMENT','DEPOSIT_IN') AND mode = 'cash'`).get(pid, d).t;
  // Guests who left today — so their bill is one tap away after check-out.
  const leftToday = db.prepare(`SELECT r.id, r.full_name, r.mobile, b.bed_label bed FROM residents r LEFT JOIN beds b ON b.id = r.bed_id
    WHERE r.property_id = ? AND r.status = 'checked_out' AND r.actual_checkout = ? ORDER BY r.updated_at DESC LIMIT 20`).all(pid, d);

  let duesList = [], duesTotal = 0;
  if (money) {
    const { bal, ageMap } = ageing(db, pid, d);
    const names = new Map(db.prepare(`SELECT r.id, r.full_name, r.mobile, r.status, b.bed_label FROM residents r
      LEFT JOIN beds b ON b.id = r.bed_id WHERE r.property_id = ?`).all(pid).map((r) => [r.id, r]));
    for (const [rid, b] of bal) {
      if (b.dues_paise <= 0) continue;
      duesTotal += b.dues_paise;
      const p = names.get(rid) || {};
      const oldest = (ageMap.get(rid) || {}).oldest_unpaid_date;
      duesList.push({ id: rid, full_name: p.full_name, mobile: p.mobile, bed: p.bed_label, status: p.status,
        dues_paise: b.dues_paise, days_overdue: oldest ? Math.max(0, daysBetween(oldest, d)) : 0 });
    }
    duesList.sort((a, b) => b.days_overdue - a.days_overdue || b.dues_paise - a.dues_paise);
  }

  return res.json({
    date: d,
    beds: { total: beds.total || 0, occupied: beds.occupied || 0, available: beds.available || 0,
      cleaning: beds.cleaning || 0, reserved: beds.reserved || 0 },
    collected_today_paise: money ? collectedToday : undefined,
    collected_today_cash_paise: money ? collectedCash : undefined,
    collected_today_online_paise: money ? collectedToday - collectedCash : undefined,
    left_today: leftToday,
    tasks: {
      collect_dues: money ? { count: duesList.length, total_paise: duesTotal, items: duesList.slice(0, 8) } : null,
      leaving_today: { count: leavingToday.length, items: leavingToday },
      overstaying: { count: overstaying.length, items: overstaying.slice(0, 8) },
      beds_to_clean: { count: cleaning.length, items: cleaning },
      arrivals: { count: arrivals.length, items: arrivals.slice(0, 8) },
      approvals: { count: approvals.length, items: approvals },
      close_cash: { yesterday_open: yesterdayOpen, closed_through: cash.closed_through },
    },
  });
}

module.exports = { today, snapshot, bedMap, dues, cashBook, movements, residentStatement, addWaiver, reverseEntry, integrity, ageing };
