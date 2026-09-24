'use strict';

const { getDb } = require('../db/connection');
const { generateReceipt, generateReceiptPdf } = require('../services/receiptService');
const { scheduleWhatsApp } = require('../services/whatsappService');

/** GET /api/v1/receipts/:receipt_number */
function getReceipt(req, res) {
  const db = getDb();
  const receipt = db.prepare(`
    SELECT rc.*, r.full_name as resident_name, r.mobile as resident_mobile,
           pl.type as payment_type, pl.payment_mode
    FROM receipts rc
    JOIN residents r ON r.id = rc.resident_id
    JOIN payment_ledger pl ON pl.id = rc.payment_ledger_id
    WHERE rc.receipt_number = ? AND rc.property_id = ?
  `).get(req.params.receipt_number, req.user.property_id);

  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
  // A corrupt line_items string must not 500 the receipt view — fall back to [].
  let lineItems = [];
  try { lineItems = JSON.parse(receipt.line_items || '[]'); } catch { lineItems = []; }
  return res.json({ ...receipt, line_items: lineItems });
}

/** POST /api/v1/receipts/:receipt_number/resend */
function resendReceipt(req, res) {
  const db = getDb();
  const receipt = db.prepare(`
    SELECT rc.*, r.full_name as resident_name, r.mobile as resident_mobile,
           pl.amount_paise, pl.billing_month
    FROM receipts rc
    JOIN residents r ON r.id = rc.resident_id
    JOIN payment_ledger pl ON pl.id = rc.payment_ledger_id
    WHERE rc.receipt_number = ? AND rc.property_id = ?
  `).get(req.params.receipt_number, req.user.property_id);

  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

  scheduleWhatsApp({
    propertyId: receipt.property_id, residentId: receipt.resident_id,
    recipientMobile: receipt.resident_mobile, recipientType: 'tenant',
    eventType: 'payment_receipt',
    templateData: {
      name: receipt.resident_name, amount: receipt.amount_paise / 100,
      receipt_no: receipt.receipt_number, month: receipt.billing_month,
    },
  });

  db.prepare("UPDATE receipts SET wa_delivered=0 WHERE id=?").run(receipt.id);
  return res.json({ message: 'Receipt re-sent to WhatsApp', receipt_number: receipt.receipt_number });
}

/** GET /api/v1/receipts/:receipt_number/pdf */
async function downloadReceiptPdf(req, res) {
  try {
    const db = getDb();
    const receipt = db.prepare(`
      SELECT rc.*, r.full_name as resident_name, r.mobile as resident_mobile,
             p.name as property_name, p.address as property_address
      FROM receipts rc
      JOIN residents r ON r.id = rc.resident_id
      JOIN properties p ON p.id = rc.property_id
      WHERE rc.receipt_number = ? AND rc.property_id = ?
    `).get(req.params.receipt_number, req.user.property_id);

    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

    const pdfBuf = await generateReceiptPdf(receipt);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${receipt.receipt_number}.pdf"`);
    return res.send(pdfBuf);
  } catch (err) {
    console.error('[RECEIPT PDF]', err.message);
    return res.status(500).json({ error: 'Failed to generate PDF' });
  }
}

module.exports = { getReceipt, resendReceipt, downloadReceiptPdf };
