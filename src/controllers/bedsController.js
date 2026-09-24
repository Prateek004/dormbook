'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }       = require('../db/connection');
const { writeAudit }  = require('../middleware/auditLog');

// Ensure new columns exist — runs once, idempotent
let _migrated = false;
function ensureBedColumns(db) {
  if (_migrated) return;
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('beds')").all().map(c => c.name);
    if (!cols.includes('daily_rate_paise')) db.exec("ALTER TABLE beds ADD COLUMN daily_rate_paise INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes('base_rate_paise')) db.exec("ALTER TABLE beds ADD COLUMN base_rate_paise INTEGER NOT NULL DEFAULT 0");
  } catch(e) { console.warn('[MIGRATION] Bed columns:', e.message); }
  _migrated = true;
}

/** GET /api/v1/beds — flat list with resident + hierarchy info */
function listBeds(req, res) {
  const db = getDb();
  ensureBedColumns(db);
  const { status, floor_id, room_id } = req.query;
  let q = `
    SELECT b.*, r.full_name as resident_name, r.id as resident_id,
           r.monthly_rent_paise, r.rate_paise, r.rate_type,
           r.deposit_paise, r.expected_checkout, r.check_in_date,
           rm.room_number, rm.room_type, f.label as floor_label, f.floor_number
    FROM beds b
    LEFT JOIN residents r ON r.bed_id = b.id AND r.status = 'active'
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE b.property_id = ? AND b.removed_at IS NULL
  `;
  const params = [req.user.property_id];
  if (status)   { q += ' AND b.status = ?'; params.push(status); }
  if (floor_id) { q += ' AND rm.floor_id = ?'; params.push(floor_id); }
  if (room_id)  { q += ' AND b.room_id = ?'; params.push(room_id); }
  q += ' ORDER BY f.floor_number, length(rm.room_number), rm.room_number, b.bed_label';
  return res.json(db.prepare(q).all(...params));
}

/** GET /api/v1/beds/:id — single bed with resident detail */
function getBed(req, res) {
  const db = getDb();
  const bed = db.prepare(`
    SELECT b.*, rm.room_number, rm.room_type, f.label as floor_label, f.floor_number,
           r.id as resident_id, r.full_name as resident_name, r.mobile as resident_mobile,
           r.monthly_rent_paise, r.rate_paise, r.rate_type, r.deposit_paise,
           r.check_in_date, r.expected_checkout
    FROM beds b
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    LEFT JOIN residents r ON r.bed_id = b.id AND r.status = 'active'
    WHERE b.id = ? AND b.property_id = ?
  `).get(req.params.id, req.user.property_id);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  return res.json(bed);
}

/**
 * PATCH /api/v1/beds/:id/status
 *
 * FIX L-02: 'occupied' is no longer an allowed target status through this endpoint.
 * The 'occupied' status is exclusively managed by checkIn(). Allowing manual setting
 * of 'occupied' with no resident attached corrupts occupancy data and capacity reporting.
 * If a bed is mis-tagged as occupied (e.g., after a data migration issue), an owner
 * should set it to 'available' or 'cleaning' to recover it.
 */
function updateBedStatus(req, res) {
  const db = getDb();
  const { status, notes } = req.body;
  // FIX L-02: 'occupied' removed from valid manual transitions
  const VALID = ['available', 'cleaning', 'reserved', 'pending'];
  if (!VALID.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')} — 'occupied' is set automatically on check-in` });
  }
  const bed = db.prepare('SELECT * FROM beds WHERE id = ? AND property_id = ? AND removed_at IS NULL')
    .get(req.params.id, req.user.property_id);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  if (bed.status === 'occupied') {
    const hasActive = db.prepare(
      "SELECT COUNT(*) as c FROM residents WHERE bed_id = ? AND status = 'active'"
    ).get(req.params.id);
    if (hasActive.c > 0) {
      return res.status(409).json({ error: 'Cannot change occupied bed with active resident. Use checkout.' });
    }
  }
  const cleaningAt = status === 'cleaning' ? "datetime('now')" : 'NULL';
  db.prepare(`UPDATE beds SET status=?, cleaning_started_at=${cleaningAt}, updated_at=datetime('now') WHERE id=?`)
    .run(status, req.params.id);
  writeAudit({ propertyId: req.user.property_id, userId: req.user.id,
    action: 'BED_STATUS_UPDATE', entityType: 'beds', entityId: req.params.id,
    snapshot: { from: bed.status, to: status, notes }, ip: req.ip });
  return res.json(db.prepare('SELECT * FROM beds WHERE id = ?').get(req.params.id));
}

/** PATCH /api/v1/beds/:id/rate — owner sets price for ONE bed */
function updateBedRate(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { daily_rate_paise } = req.body;
  if (daily_rate_paise === undefined || daily_rate_paise === null) {
    return res.status(400).json({ error: 'daily_rate_paise is required' });
  }
  const rateNum = parseFloat(daily_rate_paise);
  if (!isFinite(rateNum) || rateNum < 0) {
    return res.status(400).json({ error: 'daily_rate_paise must be a number ≥ 0' });
  }
  const rate = Math.round(rateNum);
  const bed = db.prepare('SELECT * FROM beds WHERE id = ? AND property_id = ? AND removed_at IS NULL')
    .get(req.params.id, propertyId);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });

  db.prepare(`UPDATE beds SET daily_rate_paise=?, base_rate_paise=?, updated_at=datetime('now') WHERE id=?`)
    .run(rate, rate, req.params.id);
  writeAudit({ propertyId, userId: req.user.id,
    action: 'BED_RATE_UPDATE', entityType: 'beds', entityId: req.params.id,
    amountPaise: rate, snapshot: { old: bed.daily_rate_paise, new: rate }, ip: req.ip });
  return res.json(db.prepare('SELECT * FROM beds WHERE id = ?').get(req.params.id));
}

/** PATCH /api/v1/beds/bulk-rate — owner sets rate for multiple beds at once */
function bulkUpdateBedRate(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { bed_ids, daily_rate_paise } = req.body;
  if (!Array.isArray(bed_ids) || bed_ids.length === 0) {
    return res.status(400).json({ error: 'bed_ids must be a non-empty array' });
  }
  const rateNum = parseFloat(daily_rate_paise);
  if (!isFinite(rateNum) || rateNum < 0) {
    return res.status(400).json({ error: 'daily_rate_paise must be a number ≥ 0' });
  }
  const rate = Math.round(rateNum);

  const placeholders = bed_ids.map(() => '?').join(',');
  const beds = db.prepare(
    `SELECT id FROM beds WHERE id IN (${placeholders}) AND property_id = ?`
  ).all(...bed_ids, propertyId);
  if (beds.length === 0) return res.status(404).json({ error: 'No matching beds found' });

  db.transaction(() => {
    beds.forEach(b => {
      db.prepare(`UPDATE beds SET daily_rate_paise=?, base_rate_paise=?, updated_at=datetime('now') WHERE id=?`)
        .run(rate, rate, b.id);
    });
  })();
  writeAudit({ propertyId, userId: req.user.id,
    action: 'BED_RATE_BULK_UPDATE', entityType: 'beds', entityId: beds.map(b=>b.id).join(','),
    amountPaise: rate, snapshot: { count: beds.length, rate }, ip: req.ip });
  return res.json({ message: `Rate updated for ${beds.length} bed(s)`, updated: beds.length, daily_rate_paise: rate });
}

/** POST /api/v1/beds */
function createBed(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { room_id, daily_rate_paise = 0 } = req.body;
  const bedLabel = req.body.bed_label != null ? String(req.body.bed_label).trim() : '';
  if (!room_id || !bedLabel) return res.status(400).json({ error: 'room_id and bed_label are required' });
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND property_id = ?').get(room_id, propertyId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const rateNum = parseFloat(daily_rate_paise);
  const rate = isFinite(rateNum) && rateNum >= 0 ? Math.round(rateNum) : 0;
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO beds (id, room_id, property_id, bed_label, daily_rate_paise, base_rate_paise, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)
  `).run(id, room_id, propertyId, bedLabel, rate, rate, now, now);
  return res.status(201).json(db.prepare('SELECT * FROM beds WHERE id = ?').get(id));
}

/** GET /api/v1/floors — hierarchy: floors → rooms → bed count */
function listFloors(req, res) {
  const db = getDb();
  const floors = db.prepare('SELECT * FROM floors WHERE property_id = ? AND removed_at IS NULL ORDER BY floor_number').all(req.user.property_id);
  const rooms  = db.prepare('SELECT * FROM rooms WHERE property_id = ? AND removed_at IS NULL ORDER BY length(room_number), room_number').all(req.user.property_id);
  const beds   = db.prepare(`
    SELECT b.id, b.room_id, b.bed_label, b.status, b.daily_rate_paise,
           r.full_name as resident_name, r.id as resident_id
    FROM beds b LEFT JOIN residents r ON r.bed_id = b.id AND r.status = 'active'
    WHERE b.property_id = ? AND b.removed_at IS NULL
    ORDER BY b.rowid
  `).all(req.user.property_id);

  const result = floors.map(f => ({
    ...f,
    rooms: rooms.filter(rm => rm.floor_id === f.id).map(rm => ({
      ...rm,
      beds: beds.filter(b => b.room_id === rm.id),
      total_beds: beds.filter(b => b.room_id === rm.id).length,
      occupied: beds.filter(b => b.room_id === rm.id && b.status === 'occupied').length,
    })),
  }));
  return res.json(result);
}

/** POST /api/v1/floors */
function addFloor(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  // floor_number can legitimately be 0 (ground floor), so test for presence,
  // not truthiness. Coerce label to a string before trim() so a numeric label
  // cannot throw and 500 the request.
  const floorNum = Number(req.body.floor_number);
  const label    = req.body.label != null ? String(req.body.label).trim() : '';
  if (!Number.isInteger(floorNum) || floorNum < 0) {
    return res.status(400).json({ error: 'floor_number must be a non-negative integer' });
  }
  if (!label) return res.status(400).json({ error: 'label is required' });

  const existing = db.prepare('SELECT id FROM floors WHERE property_id = ? AND floor_number = ? AND removed_at IS NULL').get(propertyId, floorNum);
  if (existing) return res.status(409).json({ error: `Floor ${floorNum} already exists` });

  const id = uuidv4();
  db.prepare("INSERT INTO floors (id, property_id, floor_number, label, created_at) VALUES (?,?,?,?,datetime('now'))")
    .run(id, propertyId, floorNum, label);
  writeAudit({ propertyId, userId: req.user.id, action: 'FLOOR_CREATED',
    entityType: 'floors', entityId: id, snapshot: { floor_number: floorNum, label }, ip: req.ip });
  return res.status(201).json(db.prepare('SELECT * FROM floors WHERE id = ?').get(id));
}

/** POST /api/v1/rooms */
function addRoom(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { floor_id, room_type = 'shared' } = req.body;
  // Coerce room_number to a string — clients often send it as a JSON number
  // (e.g. 101), and calling .trim() on a number would throw and 500.
  const roomNumber = req.body.room_number != null ? String(req.body.room_number).trim() : '';
  if (!floor_id || !roomNumber) return res.status(400).json({ error: 'floor_id and room_number are required' });

  const floor = db.prepare('SELECT * FROM floors WHERE id = ? AND property_id = ?').get(floor_id, propertyId);
  if (!floor) return res.status(404).json({ error: 'Floor not found' });

  const TYPES = ['shared', 'private', 'dormitory'];
  if (!TYPES.includes(room_type)) return res.status(400).json({ error: `room_type must be: ${TYPES.join(', ')}` });

  const existing = db.prepare('SELECT id FROM rooms WHERE property_id = ? AND room_number = ?').get(propertyId, roomNumber);
  if (existing) return res.status(409).json({ error: `Room ${roomNumber} already exists` });

  const id = uuidv4();
  db.prepare("INSERT INTO rooms (id, floor_id, property_id, room_number, room_type, created_at) VALUES (?,?,?,?,?,datetime('now'))")
    .run(id, floor_id, propertyId, roomNumber, room_type);
  writeAudit({ propertyId, userId: req.user.id, action: 'ROOM_CREATED',
    entityType: 'rooms', entityId: id, snapshot: { floor_id, room_number: roomNumber, room_type }, ip: req.ip });
  return res.status(201).json(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id));
}

/** A, B, ... Z, AA, AB, ... */
function bunkerLetter(i) {
  let s = '';
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/**
 * POST /api/v1/floors/:id/bunkers
 * Dormitory setup in one step: N bunkers × M beds on a floor.
 * Bunkers are named <floor><letter> (0A, 0B, ...) and beds <floor><letter><n>
 * (0A1, 0A2, 0B1, ...). New bunkers continue after the floor's existing letters.
 */
function addBunkers(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const floor = db.prepare('SELECT * FROM floors WHERE id = ? AND property_id = ? AND removed_at IS NULL').get(req.params.id, propertyId);
  if (!floor) return res.status(404).json({ error: 'Floor not found' });

  const count = Number(req.body.bunkers);
  const perBunker = req.body.beds_per_bunker === undefined ? 2 : Number(req.body.beds_per_bunker);
  const rate = req.body.daily_rate_paise === undefined ? 0 : Number(req.body.daily_rate_paise);
  if (!Number.isInteger(count) || count < 1 || count > 100) return res.status(400).json({ error: 'Number of bunkers must be 1–100' });
  if (!Number.isInteger(perBunker) || perBunker < 1 || perBunker > 6) return res.status(400).json({ error: 'Beds per bunker must be 1–6' });
  if (!Number.isInteger(rate) || rate < 0) return res.status(400).json({ error: 'Rate must be 0 or more' });

  const prefix = String(floor.floor_number);
  const existing = db.prepare('SELECT room_number FROM rooms WHERE floor_id = ? AND removed_at IS NULL').all(floor.id).map((r) => r.room_number);
  const taken = new Set(db.prepare('SELECT room_number FROM rooms WHERE property_id = ? AND removed_at IS NULL').all(propertyId).map((r) => r.room_number.toUpperCase()));
  // Beds may have been renamed by the owner (e.g. 0A1 -> 0B2), so an auto name
  // is skipped if ANY of its bed names is already used anywhere in the property.
  const bedTaken = new Set(db.prepare('SELECT bed_label FROM beds WHERE property_id = ? AND removed_at IS NULL').all(propertyId).map((b) => b.bed_label.toUpperCase()));
  const created = [];
  const now = new Date().toISOString();

  db.transaction(() => {
    let i = 0;
    while (created.length < count) {
      const name = prefix + bunkerLetter(i++);
      if (i > 2000) throw new Error('Could not find free bunker names');
      if (taken.has(name.toUpperCase()) || existing.includes(name)) continue;
      if (Array.from({ length: perBunker }, (_, k) => `${name}${k + 1}`.toUpperCase()).some((l) => bedTaken.has(l))) continue;
      const roomId = uuidv4();
      db.prepare("INSERT INTO rooms (id, floor_id, property_id, room_number, room_type, created_at) VALUES (?,?,?,?,'dormitory',?)")
        .run(roomId, floor.id, propertyId, name, now);
      const beds = [];
      for (let n = 1; n <= perBunker; n++) {
        const label = `${name}${n}`;
        db.prepare(`INSERT INTO beds (id, room_id, property_id, bed_label, daily_rate_paise, base_rate_paise, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,'available',?,?)`).run(uuidv4(), roomId, propertyId, label, rate, rate, now, now);
        beds.push(label);
      }
      taken.add(name.toUpperCase());
      beds.forEach((l) => bedTaken.add(l.toUpperCase()));
      created.push({ bunker: name, beds });
    }
  })();

  writeAudit({ propertyId, userId: req.user.id, action: 'BUNKERS_CREATED', entityType: 'floors', entityId: floor.id,
    snapshot: { bunkers: created.map((c) => c.bunker), beds_per_bunker: perBunker, rate }, ip: req.ip });
  return res.status(201).json({ floor: floor.label, created, total_beds: created.length * perBunker });
}

/**
 * PATCH /api/v1/beds/names — rename floors, bunkers and beds in one go.
 * Body: { floors: [{id, label}], rooms: [{id, name}], beds: [{id, label}] }
 * All-or-nothing: every name is checked first, then everything is saved in
 * one transaction. Bed names and bunker names must be unique in the property
 * (ignoring upper/lower case). Money records are linked by id, so renaming
 * never breaks bills or history — reports simply show the new name.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 \-_./#]{0,19}$/;
function cleanName(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

function renameNames(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const asList = (v) => (Array.isArray(v) ? v : []);
  const floorsIn = asList(req.body.floors), roomsIn = asList(req.body.rooms), bedsIn = asList(req.body.beds);
  if (!floorsIn.length && !roomsIn.length && !bedsIn.length) return res.status(400).json({ error: 'Nothing to rename' });
  if (floorsIn.length + roomsIn.length + bedsIn.length > 2000) return res.status(400).json({ error: 'Too many changes at once' });

  const bad = (msg) => res.status(400).json({ error: msg });

  // Load current names so we can check the final result for duplicates.
  const floors = new Map(db.prepare('SELECT id, label FROM floors WHERE property_id = ? AND removed_at IS NULL').all(propertyId).map((f) => [f.id, f]));
  const rooms  = new Map(db.prepare('SELECT id, room_number FROM rooms WHERE property_id = ? AND removed_at IS NULL').all(propertyId).map((r) => [r.id, { ...r }]));
  const beds   = new Map(db.prepare('SELECT id, bed_label FROM beds WHERE property_id = ? AND removed_at IS NULL').all(propertyId).map((b) => [b.id, { ...b }]));

  const floorChanges = [], roomChanges = [], bedChanges = [];
  for (const f of floorsIn) {
    const cur = floors.get(String(f && f.id));
    if (!cur) return bad('Floor not found');
    const label = cleanName(f.label);
    if (!label || label.length > 40) return bad('Floor name must be 1–40 characters');
    if (label !== cur.label) floorChanges.push({ id: cur.id, label });
  }
  for (const r of roomsIn) {
    const cur = rooms.get(String(r && r.id));
    if (!cur) return bad('Bunker not found');
    const name = cleanName(r.name);
    if (!NAME_RE.test(name)) return bad(`Bunker name "${name}" is not valid. Use 1–20 letters, numbers, space or - _ . / #`);
    if (name !== cur.room_number) { roomChanges.push({ id: cur.id, name }); cur.room_number = name; }
  }
  for (const b of bedsIn) {
    const cur = beds.get(String(b && b.id));
    if (!cur) return bad('Bed not found');
    const label = cleanName(b.label);
    if (!NAME_RE.test(label)) return bad(`Bed name "${label}" is not valid. Use 1–20 letters, numbers, space or - _ . / #`);
    if (label !== cur.bed_label) { bedChanges.push({ id: cur.id, label, old: cur.bed_label }); cur.bed_label = label; }
  }

  const dup = (values) => {
    const seen = new Set();
    for (const v of values) { const k = v.toUpperCase(); if (seen.has(k)) return v; seen.add(k); }
    return null;
  };
  const dupBed = dup([...beds.values()].map((b) => b.bed_label));
  if (dupBed) return res.status(409).json({ error: `Bed name "${dupBed}" is used twice. Every bed needs its own name.` });
  const dupRoom = dup([...rooms.values()].map((r) => r.room_number));
  if (dupRoom) return res.status(409).json({ error: `Bunker name "${dupRoom}" is used twice. Every bunker needs its own name.` });

  if (!floorChanges.length && !roomChanges.length && !bedChanges.length) return res.json({ changed: 0 });

  db.transaction(() => {
    const now = new Date().toISOString();
    for (const f of floorChanges) db.prepare('UPDATE floors SET label = ? WHERE id = ? AND property_id = ?').run(f.label, f.id, propertyId);
    for (const r of roomChanges)  db.prepare('UPDATE rooms SET room_number = ? WHERE id = ? AND property_id = ?').run(r.name, r.id, propertyId);
    for (const b of bedChanges)   db.prepare('UPDATE beds SET bed_label = ?, updated_at = ? WHERE id = ? AND property_id = ?').run(b.label, now, b.id, propertyId);
  })();

  try {
    writeAudit({ propertyId, userId: req.user.id, action: 'BED_NAMES_CHANGED', entityType: 'beds', entityId: propertyId,
      snapshot: { floors: floorChanges, rooms: roomChanges, beds: bedChanges.map((b) => ({ id: b.id, from: b.old, to: b.label })) }, ip: req.ip });
  } catch (e) { console.error('[AUDIT] rename:', e.message); }
  return res.json({ changed: floorChanges.length + roomChanges.length + bedChanges.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// Change the layout after setup: add one bed, remove a bed / bunker / floor.
// A bed can be removed only when it is free (no guest staying, not booked).
// Beds that never had a guest are deleted. Beds with past guests are only
// hidden (removed_at), so old bills and reports keep showing the right bed.
// ─────────────────────────────────────────────────────────────────────────────
function bedHasHistory(db, bedId) {
  return !!(db.prepare('SELECT 1 FROM residents WHERE bed_id = ? LIMIT 1').get(bedId) ||
            db.prepare('SELECT 1 FROM booking_requests WHERE bed_id = ? LIMIT 1').get(bedId));
}

/** Throws a 409-style error object if any bed is not free. */
function assertAllFree(db, beds) {
  for (const b of beds) {
    const guest = db.prepare("SELECT full_name FROM residents WHERE bed_id = ? AND status = 'active'").get(b.id);
    if (guest || b.status === 'occupied') return `Bed ${b.bed_label} has a guest (${guest ? guest.full_name : 'staying'}). Check them out or move them first.`;
    if (b.status === 'reserved') return `Bed ${b.bed_label} is booked. Cancel the booking first.`;
  }
  return null;
}

function removeBedRows(db, beds, now) {
  let deleted = 0, hidden = 0;
  for (const b of beds) {
    if (bedHasHistory(db, b.id)) {
      db.prepare("UPDATE beds SET removed_at = ?, status = 'pending', booking_request_id = NULL, updated_at = ? WHERE id = ?").run(now, now, b.id);
      hidden++;
    } else {
      db.prepare('DELETE FROM beds WHERE id = ?').run(b.id);
      deleted++;
    }
  }
  return { deleted, hidden };
}

function removeRoomRow(db, roomId, now) {
  const left = db.prepare('SELECT COUNT(*) n FROM beds WHERE room_id = ?').get(roomId).n;
  if (left) db.prepare('UPDATE rooms SET removed_at = ? WHERE id = ?').run(now, roomId);
  else db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
}

function auditSafe(req, action, entityType, entityId, snapshot) {
  try { writeAudit({ propertyId: req.user.property_id, userId: req.user.id, action, entityType, entityId, snapshot, ip: req.ip }); }
  catch (e) { console.error('[AUDIT]', action, e.message); }
}

/** DELETE /api/v1/beds/:id */
function removeBed(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const bed = db.prepare('SELECT * FROM beds WHERE id = ? AND property_id = ? AND removed_at IS NULL').get(req.params.id, pid);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  const busy = assertAllFree(db, [bed]);
  if (busy) return res.status(409).json({ error: busy });
  const now = new Date().toISOString();
  db.transaction(() => removeBedRows(db, [bed], now))();
  auditSafe(req, 'BED_REMOVED', 'beds', bed.id, { bed: bed.bed_label });
  return res.json({ removed: bed.bed_label });
}

/** POST /api/v1/rooms/:id/beds — add one more bed to a bunker (named next number, or a given name). */
function addBedToRoom(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND property_id = ? AND removed_at IS NULL').get(req.params.id, pid);
  if (!room) return res.status(404).json({ error: 'Bunker not found' });
  const live = db.prepare('SELECT * FROM beds WHERE room_id = ? AND removed_at IS NULL ORDER BY rowid').all(room.id);
  if (live.length >= 12) return res.status(400).json({ error: 'A bunker can have at most 12 beds' });
  const used = new Set(db.prepare('SELECT upper(bed_label) l FROM beds WHERE property_id = ? AND removed_at IS NULL').all(pid).map((r) => r.l));
  let label = cleanName(req.body && req.body.label);
  if (label) {
    if (!NAME_RE.test(label)) return res.status(400).json({ error: `Bed name "${label}" is not valid. Use 1–20 letters, numbers, space or - _ . / #` });
    if (used.has(label.toUpperCase())) return res.status(409).json({ error: `Bed name "${label}" is already used` });
  } else {
    for (let n = 1; n < 200; n++) { const l = `${room.room_number}${n}`; if (!used.has(l.toUpperCase())) { label = l; break; } }
    if (!label || label.length > 20) return res.status(400).json({ error: 'Type a name for the new bed' });
  }
  const rate = req.body && req.body.daily_rate_paise !== undefined ? Number(req.body.daily_rate_paise) : (live[0] ? live[0].daily_rate_paise : 0);
  if (!Number.isInteger(rate) || rate < 0) return res.status(400).json({ error: 'Rate must be 0 or more' });
  const id = uuidv4(); const now = new Date().toISOString();
  db.prepare(`INSERT INTO beds (id, room_id, property_id, bed_label, daily_rate_paise, base_rate_paise, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'available',?,?)`).run(id, room.id, pid, label, rate, rate, now, now);
  auditSafe(req, 'BED_ADDED', 'beds', id, { bed: label, bunker: room.room_number });
  return res.status(201).json(db.prepare('SELECT * FROM beds WHERE id = ?').get(id));
}

/** DELETE /api/v1/rooms/:id — remove a bunker and all its beds (all must be free). */
function removeRoom(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND property_id = ? AND removed_at IS NULL').get(req.params.id, pid);
  if (!room) return res.status(404).json({ error: 'Bunker not found' });
  const beds = db.prepare('SELECT * FROM beds WHERE room_id = ? AND removed_at IS NULL').all(room.id);
  const busy = assertAllFree(db, beds);
  if (busy) return res.status(409).json({ error: busy });
  const now = new Date().toISOString();
  db.transaction(() => { removeBedRows(db, beds, now); removeRoomRow(db, room.id, now); })();
  auditSafe(req, 'BUNKER_REMOVED', 'rooms', room.id, { bunker: room.room_number, beds: beds.map((b) => b.bed_label) });
  return res.json({ removed: room.room_number, beds: beds.length });
}

/** DELETE /api/v1/floors/:id — remove a floor with all its bunkers and beds (all must be free). */
function removeFloor(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const floor = db.prepare('SELECT * FROM floors WHERE id = ? AND property_id = ? AND removed_at IS NULL').get(req.params.id, pid);
  if (!floor) return res.status(404).json({ error: 'Floor not found' });
  const rooms = db.prepare('SELECT * FROM rooms WHERE floor_id = ? AND removed_at IS NULL').all(floor.id);
  const beds = rooms.length ? db.prepare(`SELECT * FROM beds WHERE removed_at IS NULL AND room_id IN (${rooms.map(() => '?').join(',')})`).all(...rooms.map((r) => r.id)) : [];
  const busy = assertAllFree(db, beds);
  if (busy) return res.status(409).json({ error: busy });
  const now = new Date().toISOString();
  db.transaction(() => {
    removeBedRows(db, beds, now);
    rooms.forEach((r) => removeRoomRow(db, r.id, now));
    const left = db.prepare('SELECT COUNT(*) n FROM rooms WHERE floor_id = ?').get(floor.id).n;
    if (left) db.prepare('UPDATE floors SET removed_at = ? WHERE id = ?').run(now, floor.id);
    else db.prepare('DELETE FROM floors WHERE id = ?').run(floor.id);
  })();
  auditSafe(req, 'FLOOR_REMOVED', 'floors', floor.id, { floor: floor.label, bunkers: rooms.length, beds: beds.length });
  return res.json({ removed: floor.label, bunkers: rooms.length, beds: beds.length });
}

module.exports = { removeBed, addBedToRoom, removeRoom, removeFloor, renameNames, listBeds, getBed, updateBedStatus, updateBedRate, bulkUpdateBedRate, createBed, listFloors, addFloor, addRoom, addBunkers, bunkerLetter };
