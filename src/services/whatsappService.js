'use strict';

/**
 * WhatsApp Notification Service
 *
 * Production: Uses Meta WhatsApp Business API (via 360Dialog or direct Graph API)
 * with HSM (pre-approved) templates for outgoing messages.
 *
 * Env vars required:
 *   WHATSAPP_API_TOKEN   — 360Dialog API key OR Meta Bearer token
 *   WHATSAPP_PHONE_ID    — Meta WABA Phone Number ID (for Graph API)
 *   WHATSAPP_PROVIDER    — 'meta' | '360dialog' (default: '360dialog')
 *
 * The notification_log table tracks every outgoing message for delivery tracking.
 */

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');

// ── HSM Template definitions (must match pre-approved names in Meta WABA) ────
const TEMPLATES = {
  checkin_confirm: {
    name: 'dormbook_checkin_confirm',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.name },
        { type: 'text', text: data.bed },
        { type: 'text', text: data.checkin },
        { type: 'text', text: `₹${data.rent}` },
      ]},
    ]),
  },
  payment_receipt: {
    name: 'dormbook_payment_receipt',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.name },
        { type: 'text', text: `₹${data.amount.toFixed(2)}` },
        { type: 'text', text: data.receipt_no },
        { type: 'text', text: data.month },
      ]},
    ]),
  },
  rent_reminder_3d: {
    name: 'dormbook_rent_reminder_3d',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.name },
        { type: 'text', text: `₹${data.amount.toFixed(2)}` },
        { type: 'text', text: data.due_date },
      ]},
    ]),
  },
  rent_due_today: {
    name: 'dormbook_rent_due_today',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.name },
        { type: 'text', text: `₹${data.amount.toFixed(2)}` },
      ]},
    ]),
  },
  rent_overdue_3d: {
    name: 'dormbook_rent_overdue_3d',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.name },
        { type: 'text', text: `₹${data.amount.toFixed(2)}` },
        { type: 'text', text: data.days_overdue.toString() },
      ]},
    ]),
  },
  rent_overdue_7d: {
    name: 'dormbook_rent_overdue_7d',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.name },
        { type: 'text', text: `₹${data.amount.toFixed(2)}` },
        { type: 'text', text: data.days_overdue.toString() },
      ]},
    ]),
  },
  eod_report: {
    name: 'dormbook_eod_report',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.date },
        { type: 'text', text: `₹${data.collection.toFixed(2)}` },
        { type: 'text', text: data.occupied.toString() },
        { type: 'text', text: data.available.toString() },
      ]},
    ]),
  },
  refund_approval_request: {
    name: 'dormbook_refund_approval',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.resident },
        { type: 'text', text: `₹${parseFloat(data.amount).toFixed(2)}` },
      ]},
    ]),
  },
  cash_discrepancy_alert: {
    name: 'dormbook_cash_discrepancy',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.date },
        { type: 'text', text: `₹${data.drawer}` },
        { type: 'text', text: `₹${data.system}` },
        { type: 'text', text: `₹${data.delta}` },
      ]},
    ]),
  },
  // OTP password reset — called by authController.forgotPassword()
  otp_password_reset: {
    name: 'dormbook_otp_password_reset',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.name || 'User' },
        { type: 'text', text: data.otp },
      ]},
    ]),
  },
  overstay_alert: {
    name: 'dormbook_overstay_alert',
    language: 'en',
    components: (data) => ([
      { type: 'body', parameters: [
        { type: 'text', text: data.name },
        { type: 'text', text: data.expected_checkout },
        { type: 'text', text: data.days_overdue.toString() },
      ]},
    ]),
  },
};

async function sendViaProvider(to, template, components) {
  const token    = process.env.WHATSAPP_API_TOKEN;
  const provider = process.env.WHATSAPP_PROVIDER || '360dialog';

  if (!token) {
    console.warn(`[WHATSAPP] WHATSAPP_API_TOKEN not set — skipping send to ${to}`);
    return { status: 'skipped', reason: 'no_token' };
  }

  let url, body, headers;

  if (provider === 'meta') {
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    if (!phoneId) throw new Error('WHATSAPP_PHONE_ID required for Meta provider');
    url  = `https://graph.facebook.com/v19.0/${phoneId}/messages`;
    body = {
      messaging_product: 'whatsapp',
      to: to.replace(/\D/g, ''),
      type: 'template',
      template: { name: template.name, language: { code: template.language }, components },
    };
    headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  } else {
    // 360Dialog
    url  = 'https://waba.360dialog.io/v1/messages';
    body = {
      to: to.replace(/\D/g, ''),
      type: 'template',
      template: { namespace: process.env.WHATSAPP_NAMESPACE || '', name: template.name,
        language: { policy: 'deterministic', code: template.language }, components },
    };
    headers = { 'D360-API-KEY': token, 'Content-Type': 'application/json' };
  }

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`WhatsApp API error ${resp.status}: ${errText}`);
  }
  return resp.json();
}

/**
 * Schedule and send a WhatsApp notification.
 * Logs every attempt to notification_log.
 * Non-blocking — errors are caught and logged.
 */
async function scheduleWhatsApp({ propertyId, residentId, recipientMobile, recipientType, eventType, templateData }) {
  // WhatsApp is switched off until WHATSAPP_API_TOKEN is set: do nothing, quietly.
  if (!process.env.WHATSAPP_API_TOKEN) return;
  const db = getDb();
  const logId = uuidv4();
  const now   = new Date().toISOString();

  // Resolve owner mobile if recipientType is 'owner'
  let mobile = recipientMobile;
  if (recipientType === 'owner' || !mobile) {
    const prop = db.prepare('SELECT whatsapp_number FROM properties WHERE id = ?').get(propertyId);
    mobile = prop?.whatsapp_number || mobile;
  }

  if (!mobile) {
    console.warn(`[WHATSAPP] No mobile for event ${eventType} property ${propertyId}`);
    return;
  }

  const template = TEMPLATES[eventType];
  if (!template) {
    console.warn(`[WHATSAPP] Unknown event type: ${eventType}`);
    return;
  }

  const bodyText = JSON.stringify({ event: eventType, data: templateData });

  db.prepare(`
    INSERT INTO notification_log
      (id, property_id, resident_id, recipient_mobile, recipient_type, event_type, message_body, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(logId, propertyId, residentId || null, mobile, recipientType, eventType, bodyText, now);

  try {
    const components = template.components(templateData);
    const result     = await sendViaProvider(mobile, template, components);
    const msgId      = result?.messages?.[0]?.id || result?.id || null;

    db.prepare(`UPDATE notification_log SET status='sent', provider_msg_id=?, sent_at=datetime('now') WHERE id=?`)
      .run(msgId, logId);
  } catch (err) {
    console.error(`[WHATSAPP] Failed to send ${eventType} to ${mobile}:`, err.message);
    db.prepare(`UPDATE notification_log SET status='failed' WHERE id=?`).run(logId);
  }
}

module.exports = { scheduleWhatsApp, TEMPLATES };
