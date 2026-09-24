'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/connection');
const ledger = require('../services/ledger');
const { istMonth } = require('../util/time');
const { writeAudit } = require('../middleware/auditLog');

const MAX_PRICE_PAISE = 10000000; // ₹1,00,000 per item — stops typing mistakes like 1000000
const CATEGORIES = ['Food & drinks', 'Laundry', 'Services', 'Items', 'Other'];

/** GST rate from the request: basis points (500 = 5%). undefined = not sent. null = invalid. */
function gstRate(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return ledger.GST_RATES_BP.includes(n) ? n : null;
}
function gstOn(db, propertyId) {
  const p = db.prepare('SELECT gst_enabled FROM properties WHERE id = ?').get(propertyId);
  return !!(p && p.gst_enabled);
}

function cleanText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function pricePaise(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_PRICE_PAISE ? n : null;
}

/** GET /api/v1/addons/catalog  (?all=1 also returns hidden items, for Settings) */
function getCatalog(req, res) {
  const db = getDb();
  const all = req.query.all === '1';
  const rows = db.prepare(
    `SELECT * FROM addon_catalog WHERE property_id = ? ${all ? '' : 'AND is_active = 1'} ORDER BY is_active DESC, category, name`
  ).all(req.user.property_id);
  return res.json(rows);
}

/** POST /api/v1/addons/catalog */
function createCatalogItem(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const name = cleanText(req.body.name, 60);
  const category = cleanText(req.body.category, 40) || 'Other';
  const price = pricePaise(req.body.default_price_paise === undefined ? 0 : req.body.default_price_paise);
  if (!name) return res.status(400).json({ error: 'Item name is required' });
  if (price === null) return res.status(400).json({ error: 'Price must be between ₹0 and ₹1,00,000' });
  const rate = gstRate(req.body.gst_rate_bp);
  if (rate === null) return res.status(400).json({ error: 'GST must be 0, 5, 12, 18, 28 or 40%' });
  const same = db.prepare('SELECT id FROM addon_catalog WHERE property_id = ? AND lower(name) = lower(?) AND is_active = 1').get(propertyId, name);
  if (same) return res.status(409).json({ error: `"${name}" is already in your price list` });

  const id  = uuidv4();
  db.prepare(`
    INSERT INTO addon_catalog (id, property_id, name, category, default_price_paise, is_assignable, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, propertyId, name, category, price, req.body.is_assignable ? 1 : 0, new Date().toISOString());
  db.prepare('UPDATE addon_catalog SET gst_rate_bp = ?, gst_inclusive = ? WHERE id = ?')
    .run(rate || 0, req.body.gst_inclusive === false || req.body.gst_inclusive === 0 ? 0 : 1, id);
  return res.status(201).json(db.prepare('SELECT * FROM addon_catalog WHERE id = ?').get(id));
}

/** POST /api/v1/addons/catalog/samples — one click to add common items (skips ones already there). */
function addSampleItems(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const samples = [
    ['Tea', 'Food & drinks', 1000], ['Coffee', 'Food & drinks', 2000], ['Water bottle', 'Food & drinks', 2000],
    ['Breakfast', 'Food & drinks', 6000], ['Maggi', 'Food & drinks', 4000],
    ['Laundry (per kg)', 'Laundry', 5000], ['Towel', 'Items', 3000], ['Locker', 'Services', 5000],
  ];
  const have = new Set(db.prepare('SELECT lower(name) n FROM addon_catalog WHERE property_id = ? AND is_active = 1').all(propertyId).map((r) => r.n));
  let added = 0;
  db.transaction(() => {
    const now = new Date().toISOString();
    for (const [name, cat, price] of samples) {
      if (have.has(name.toLowerCase())) continue;
      db.prepare(`INSERT INTO addon_catalog (id, property_id, name, category, default_price_paise, is_assignable, is_active, created_at)
        VALUES (?,?,?,?,?,0,1,?)`).run(uuidv4(), propertyId, name, cat, price, now);
      added++;
    }
  })();
  return res.status(201).json({ added });
}

/** PATCH /api/v1/addons/catalog/:id */
function updateCatalogItem(req, res) {
  const db = getDb();
  const item = db.prepare('SELECT * FROM addon_catalog WHERE id = ? AND property_id = ?')
    .get(req.params.id, req.user.property_id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const b = req.body;
  const name = b.name !== undefined ? cleanText(b.name, 60) : item.name;
  const category = b.category !== undefined ? (cleanText(b.category, 40) || 'Other') : item.category;
  const price = b.default_price_paise !== undefined ? pricePaise(b.default_price_paise) : item.default_price_paise;
  const active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : item.is_active;
  if (!name) return res.status(400).json({ error: 'Item name is required' });
  if (price === null) return res.status(400).json({ error: 'Price must be between ₹0 and ₹1,00,000' });
  const rate = gstRate(b.gst_rate_bp);
  if (rate === null) return res.status(400).json({ error: 'GST must be 0, 5, 12, 18, 28 or 40%' });
  if (active) {
    const same = db.prepare('SELECT id FROM addon_catalog WHERE property_id = ? AND lower(name) = lower(?) AND is_active = 1 AND id != ?')
      .get(req.user.property_id, name, item.id);
    if (same) return res.status(409).json({ error: `"${name}" is already in your price list` });
  }
  db.prepare('UPDATE addon_catalog SET name = ?, category = ?, default_price_paise = ?, is_active = ?, is_assignable = COALESCE(?, is_assignable) WHERE id = ?')
    .run(name, category, price, active, b.is_assignable !== undefined ? (b.is_assignable ? 1 : 0) : null, item.id);
  if (rate !== undefined) db.prepare('UPDATE addon_catalog SET gst_rate_bp = ? WHERE id = ?').run(rate, item.id);
  if (b.gst_inclusive !== undefined) db.prepare('UPDATE addon_catalog SET gst_inclusive = ? WHERE id = ?').run(b.gst_inclusive ? 1 : 0, item.id);
  return res.json(db.prepare('SELECT * FROM addon_catalog WHERE id = ?').get(item.id));
}

/**
 * POST /api/v1/residents/:id/addons — put items (tea, coffee, laundry…) on a guest's bill.
 *
 * New shape: { items: [{ catalog_item_id | name, unit_price_paise?, quantity }],
 *              billing_mode: 'monthly_bill' (add to bill) | 'immediate' (paid now),
 *              payment_mode }
 * Old shape (still accepted): { catalog_item_id | name, amount_paise, billing_mode, payment_mode }
 *
 * Everything is saved in one transaction: either all items are added or none.
 * A retried request with the same Idempotency-Key is not charged twice.
 */
function addAddonCharge(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const residentId = req.params.id;
  const body = req.body || {};
  const billing_mode = body.billing_mode === undefined ? 'immediate' : body.billing_mode;
  const VALID_MODES = ['cash', 'upi', 'card', 'bank_transfer'];
  const mode = VALID_MODES.includes(body.payment_mode) ? body.payment_mode : 'cash';
  if (!['immediate', 'monthly_bill'].includes(billing_mode)) {
    return res.status(400).json({ error: "billing_mode must be 'immediate' or 'monthly_bill'" });
  }

  const resident = db.prepare(
    "SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = 'active'"
  ).get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'This guest is not staying now' });

  const rawItems = Array.isArray(body.items)
    ? body.items
    : [{ catalog_item_id: body.catalog_item_id, name: body.name, unit_price_paise: body.amount_paise, quantity: 1 }];
  if (!rawItems.length) return res.status(400).json({ error: 'Choose at least one item' });
  if (rawItems.length > 50) return res.status(400).json({ error: 'Too many items at once (max 50)' });

  // Check every item before saving anything.
  const gstEnabled = gstOn(db, propertyId);
  const lines = [];
  for (const it of rawItems) {
    const qty = it.quantity === undefined ? 1 : Number(it.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return res.status(400).json({ error: 'Quantity must be 1 to 99' });
    let name = cleanText(it.name, 60);
    let unit = it.unit_price_paise === undefined || it.unit_price_paise === null || it.unit_price_paise === '' ? undefined : Number(it.unit_price_paise);
    let catalogId = null;
    let rateBp = gstRate(it.gst_rate_bp);
    if (rateBp === null) return res.status(400).json({ error: 'GST must be 0, 5, 12, 18, 28 or 40%' });
    let inclusive = !(it.gst_inclusive === false || it.gst_inclusive === 0);
    if (it.catalog_item_id) {
      const c = db.prepare('SELECT * FROM addon_catalog WHERE id = ? AND property_id = ? AND is_active = 1').get(String(it.catalog_item_id), propertyId);
      if (!c) return res.status(404).json({ error: 'Item not found in price list (it may have been removed)' });
      catalogId = c.id;
      name = name || c.name;
      if (unit === undefined) unit = c.default_price_paise;
      if (rateBp === undefined) { rateBp = Number(c.gst_rate_bp) || 0; inclusive = c.gst_inclusive !== 0; }
    }
    if (!gstEnabled) rateBp = 0;   // GST switched off in Settings → no GST on anything
    if (!name) return res.status(400).json({ error: 'name is required if no catalog_item_id' });
    if (!Number.isInteger(unit) || unit <= 0) return res.status(400).json({ error: `Price for "${name}" must be more than ₹0 (amount_paise must be > 0)` });
    if (unit > MAX_PRICE_PAISE) return res.status(400).json({ error: `Price for "${name}" is too high` });
    const g = ledger.gstSplit(unit * qty, rateBp || 0, inclusive);
    lines.push({ catalogId, name, unit, qty, amount: g.gross, tax: g.tax, taxable: g.taxable, rateBp: rateBp || 0,
      label: qty > 1 ? `${name} × ${qty}` : name });
  }
  const total = lines.reduce((a, l) => a + l.amount, 0);

  const clientKey = req.get('Idempotency-Key') ? String(req.get('Idempotency-Key')).slice(0, 100) : null;
  const idemBase = clientKey ? `addon:${propertyId}:${clientKey}` : null;
  if (idemBase && db.prepare('SELECT 1 FROM ledger_entries WHERE idem_key = ?').get(`${idemBase}:0`)) {
    return res.status(200).json({ duplicate: true, message: 'Already added', total_paise: total });
  }

  const now = new Date().toISOString();
  const month = cleanText(body.billing_month, 7) || istMonth();
  const reason = cleanText(body.custom_reason, 200) || null;
  const ids = [];

  db.transaction(() => {
    lines.forEach((l, i) => {
      const id = uuidv4();
      ids.push(id);
      db.prepare(`
        INSERT INTO addon_charges
          (id,resident_id,property_id,catalog_item_id,name,amount_paise,billing_mode,
           is_custom_entry,custom_reason,billing_month,recorded_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, residentId, propertyId, l.catalogId, l.label, l.amount, billing_mode,
        l.catalogId ? 0 : 1, reason, month, req.user.id, now);
      db.prepare('UPDATE addon_charges SET taxable_paise = ?, gst_paise = ?, gst_rate_bp = ? WHERE id = ?')
        .run(l.taxable, l.tax, l.rateBp, id);
      // Every item is owed by the guest (shows in dues and at checkout)…
      ledger.charge({ propertyId, residentId, amountPaise: l.amount, category: 'addon',
        reason: `Add-on: ${l.label}`, userId: req.user.id, sourceTable: 'addon_charges', sourceId: id,
        taxRateBp: l.rateBp, taxPaise: l.tax,
        idemKey: idemBase ? `${idemBase}:${i}` : null });
    });

    // …and 'immediate' means it was also paid right now.
    if (billing_mode === 'immediate') {
      const payId = uuidv4();
      const note = `Add-on: ${lines.map((l) => l.label).join(', ')}`.slice(0, 200);
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','extra_charge',?,?,0,'not_required',?,?,?)
      `).run(payId, propertyId, residentId, month, total, mode, now, note, req.user.id, now);
      ledger.payment({ propertyId, residentId, amountPaise: total, mode, category: 'addon',
        userId: req.user.id, sourceTable: 'payment_ledger', sourceId: payId });
    }
  })();

  try {
    writeAudit({
      propertyId, userId: req.user.id, action: 'ADDON_CHARGED',
      entityType: 'addon_charges', entityId: ids[0], amountPaise: total,
      snapshot: { items: lines.map((l) => ({ name: l.name, qty: l.qty, unit_paise: l.unit })), billing_mode, payment_mode: mode, resident_id: residentId },
      ip: req.ip,
    });
  } catch (e) { console.error('[AUDIT] addon:', e.message); }

  const charges = db.prepare(`SELECT * FROM addon_charges WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  // Old callers expect the single saved row; new callers get the full list.
  const gstTotal = lines.reduce((a, l) => a + l.tax, 0);
  return res.status(201).json(Array.isArray(body.items) ? { charges, total_paise: total, gst_paise: gstTotal } : charges[0]);
}

/** GET /api/v1/residents/:id/addons */
function getResidentAddons(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const rows = db.prepare(`
    SELECT ac.*, u.name as recorded_by_name
    FROM addon_charges ac JOIN users u ON u.id = ac.recorded_by
    WHERE ac.resident_id = ? AND ac.property_id = ?
    ORDER BY ac.created_at DESC
  `).all(req.params.id, propertyId);
  return res.json(rows);
}

module.exports = { getCatalog, createCatalogItem, addSampleItems, updateCatalogItem, addAddonCharge, getResidentAddons, CATEGORIES };
