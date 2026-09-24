'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/connection');
const ledger = require('../services/ledger');
const { istMonth } = require('../util/time');
const { writeAudit } = require('../middleware/auditLog');

/** GET /api/v1/addons/catalog */
function getCatalog(req, res) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM addon_catalog WHERE property_id = ? AND is_active = 1 ORDER BY category, name'
  ).all(req.user.property_id);
  return res.json(rows);
}

/** POST /api/v1/addons/catalog */
function createCatalogItem(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { name, category, default_price_paise = 0, is_assignable = 0 } = req.body;

  if (!name || !category) return res.status(400).json({ error: 'name and category are required' });

  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO addon_catalog (id, property_id, name, category, default_price_paise, is_assignable, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, propertyId, name.trim(), category.trim(),
    Math.round(parseFloat(default_price_paise)), is_assignable ? 1 : 0, now);

  return res.status(201).json(db.prepare('SELECT * FROM addon_catalog WHERE id = ?').get(id));
}

/** PATCH /api/v1/addons/catalog/:id */
function updateCatalogItem(req, res) {
  const db = getDb();
  const item = db.prepare('SELECT * FROM addon_catalog WHERE id = ? AND property_id = ?')
    .get(req.params.id, req.user.property_id);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });

  const { name, category, default_price_paise, is_assignable, is_active } = req.body;
  db.prepare(`
    UPDATE addon_catalog SET name=COALESCE(?,name), category=COALESCE(?,category),
    default_price_paise=COALESCE(?,default_price_paise),
    is_assignable=COALESCE(?,is_assignable), is_active=COALESCE(?,is_active)
    WHERE id=?
  `).run(
    name || null, category || null,
    default_price_paise !== undefined ? Math.round(parseFloat(default_price_paise)) : null,
    is_assignable !== undefined ? (is_assignable ? 1 : 0) : null,
    is_active !== undefined ? (is_active ? 1 : 0) : null,
    req.params.id
  );
  return res.json(db.prepare('SELECT * FROM addon_catalog WHERE id = ?').get(req.params.id));
}

/**
 * POST /api/v1/residents/:id/addons
 *
 * FIX: Accepts payment_mode from request body instead of hardcoding 'cash'.
 * If tenant paid addon by UPI, the ledger now reflects that correctly.
 */
function addAddonCharge(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const residentId = req.params.id;
  const {
    catalog_item_id, name: customName, amount_paise,
    billing_mode = 'immediate', custom_reason, billing_month,
    payment_mode = 'cash',
  } = req.body;

  const VALID_MODES = ['cash', 'upi', 'card', 'bank_transfer'];
  const mode = VALID_MODES.includes(payment_mode) ? payment_mode : 'cash';
  if (!['immediate', 'monthly_bill'].includes(billing_mode)) {
    return res.status(400).json({ error: "billing_mode must be 'immediate' or 'monthly_bill'" });
  }

  const resident = db.prepare(
    "SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = 'active'"
  ).get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Active resident not found' });

  let itemName = customName;
  let itemPrice = Math.round(parseFloat(amount_paise || 0));
  let isCustom = 1;

  if (catalog_item_id) {
    const catalogItem = db.prepare('SELECT * FROM addon_catalog WHERE id = ? AND property_id = ? AND is_active = 1')
      .get(catalog_item_id, propertyId);
    if (!catalogItem) return res.status(404).json({ error: 'Catalog item not found or inactive' });
    itemName  = customName || catalogItem.name;
    itemPrice = amount_paise !== undefined ? Math.round(parseFloat(amount_paise)) : catalogItem.default_price_paise;
    isCustom  = 0;
  }

  if (!itemName) return res.status(400).json({ error: 'name is required if no catalog_item_id' });
  if (!itemPrice || itemPrice <= 0) return res.status(400).json({ error: 'amount_paise must be > 0' });

  const id  = uuidv4();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO addon_charges
        (id,resident_id,property_id,catalog_item_id,name,amount_paise,billing_mode,
         is_custom_entry,custom_reason,billing_month,recorded_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, residentId, propertyId, catalog_item_id || null, itemName, itemPrice,
      billing_mode, isCustom, custom_reason || null,
      billing_month || istMonth(), req.user.id, now);

    // Every add-on is owed by the resident…
    ledger.charge({ propertyId, residentId, amountPaise: itemPrice, category: 'addon',
      reason: `Add-on: ${itemName}`, userId: req.user.id, sourceTable: 'addon_charges', sourceId: id });

    // …and 'immediate' means it was also paid right now. 'monthly_bill' stays in
    // dues until paid (previously it was recorded nowhere and never collected).
    if (billing_mode === 'immediate') {
      const payId = uuidv4();
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','extra_charge',?,?,0,'not_required',?,?,?)
      `).run(payId, propertyId, residentId,
        billing_month || istMonth(), itemPrice, mode, now,
        `Add-on: ${itemName}`, req.user.id, now);
      ledger.payment({ propertyId, residentId, amountPaise: itemPrice, mode, category: 'addon',
        userId: req.user.id, sourceTable: 'payment_ledger', sourceId: payId });
    }
  })();

  writeAudit({
    propertyId, userId: req.user.id, action: 'ADDON_CHARGED',
    entityType: 'addon_charges', entityId: id,
    amountPaise: itemPrice,
    snapshot: { name: itemName, billing_mode, payment_mode: mode, resident_id: residentId },
    ip: req.ip,
  });

  return res.status(201).json(db.prepare('SELECT * FROM addon_charges WHERE id = ?').get(id));
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

module.exports = { getCatalog, createCatalogItem, updateCatalogItem, addAddonCharge, getResidentAddons };
