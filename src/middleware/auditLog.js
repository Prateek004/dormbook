'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');

/**
 * Write a row to audit_log (insert-only table).
 * Called directly from controllers for precision.
 */
function writeAudit(opts) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log
      (id, property_id, actor_id, action, entity_type, entity_id,
       amount_paise, snapshot, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    uuidv4(),
    opts.propertyId,
    opts.userId,
    opts.action,
    opts.entityType,
    opts.entityId,
    opts.amountPaise || null,
    opts.snapshot ? JSON.stringify(opts.snapshot) : null,
    opts.ip || null,
  );
}

/**
 * Write to document_access_log for DPDP compliance.
 * Must be called within the same transaction as the read.
 */
function logDocumentAccess(db, { residentId, accessedBy, documentType, ip }) {
  db.prepare(`
    INSERT INTO document_access_log
      (id, resident_id, accessed_by, document_type, ip_address, accessed_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(uuidv4(), residentId, accessedBy, documentType, ip || null);
}

// FIX L-03: Removed auditMiddleware — it was exported but never registered
// on any route in the codebase, making it dead code. Keeping it would invite
// future confusion ("is this actually used?") and increases the module's
// surface area for no benefit. writeAudit() and logDocumentAccess() are the
// only audit paths in use and are called explicitly from controllers.

module.exports = { writeAudit, logDocumentAccess };
