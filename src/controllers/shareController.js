'use strict';
/**
 * Send a guest their bill on WhatsApp.
 *
 * POST /api/v1/residents/:id/bill-link → a private link (random, 43 characters) + a ready WhatsApp message.
 * GET  /b/:token                        → the bill page the guest opens (no sign-in).
 *
 * Only a SHA-256 hash of the link is stored, so the database alone can't be used to open bills.
 * Links stop working after 90 days. The guest page shows no ID proof and no home address,
 * and hides most of the mobile number. It is never cached and never indexed by search engines.
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');
const { randomToken, sha256, mobile10 } = require('../util/security');
const { buildBill } = require('./summaryController');

const LINK_DAYS = 90;

function baseUrl(req) {
  const env = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(env)) return env;
  if (process.env.RAILWAY_PUBLIC_DOMAIN && /^[a-z0-9.-]+$/i.test(process.env.RAILWAY_PUBLIC_DOMAIN)) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  const host = String(req.get('host') || '').replace(/[^a-z0-9.:-]/gi, '');
  return `${req.protocol}://${host}`;
}

const inr = (p) => '₹' + (Math.round(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** POST /api/v1/residents/:id/bill-link */
function createBillLink(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const bill = buildBill(db, pid, req.params.id);
  if (!bill) return res.status(404).json({ error: 'Guest not found' });

  const token = randomToken();
  const expires = new Date(Date.now() + LINK_DAYS * 86400000).toISOString();
  db.prepare(`INSERT INTO bill_links (id, property_id, resident_id, token_hash, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), pid, req.params.id, sha256(token), req.user.id, new Date().toISOString(), expires);
  writeAudit({ propertyId: pid, userId: req.user.id, action: 'BILL_LINK_CREATED', entityType: 'residents', entityId: req.params.id,
    snapshot: { bill_no: bill.bill_no }, ip: req.ip });

  const url = `${baseUrl(req)}/b/${token}`;
  const g = bill.guest;
  const firstName = String(g.name || '').split(/\s+/)[0] || 'there';
  const lines = [
    `Hello ${firstName},`,
    `Thank you for staying at ${bill.company.property_name || bill.company.business_name}.`,
    `${bill.title} ${bill.bill_no}: Total ${inr(bill.totals.amount)}, Paid ${inr(bill.paid)}.`,
    bill.balance > 0 ? `Balance to pay: ${inr(bill.balance)}.` : bill.balance < 0 ? `Advance with us: ${inr(-bill.balance)}.` : 'Fully paid. ✅',
    bill.balance > 0 && bill.pay && bill.pay.upi ? `Pay by UPI: ${bill.pay.upi.id}` : null,
    `View / download your bill: ${url}`,
  ].filter(Boolean);
  const message = lines.join('\n');
  const m = mobile10(g.mobile);
  const whatsapp_url = `https://wa.me/${m ? '91' + m : ''}?text=${encodeURIComponent(message)}`;
  return res.status(201).json({ url, whatsapp_url, message, expires_at: expires, mobile: m || null });
}

// ── Guest page ─────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtD = (d) => { if (!d) return ''; const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd}/${m}/${y}`; };

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
:root{--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--bad:#b91c1c;--good:#047857;--brand:#4f46e5}
*{box-sizing:border-box}body{margin:0;background:#f3f4f6;color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:16px}.doc{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.head{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:12px;flex-wrap:wrap}
.name{font-size:20px;font-weight:700}.sub,.muted{color:var(--muted);font-size:13px}.ttl{font-size:18px;font-weight:700;text-align:right}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:14px 0}
table{width:100%;border-collapse:collapse;margin:8px 0}th,td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}.num{text-align:right;white-space:nowrap}
.sum{margin-left:auto;max-width:340px}.sum div{display:flex;justify-content:space-between;padding:4px 0}
.bal{border-top:2px solid var(--ink);margin-top:6px;padding-top:8px!important;font-size:17px;font-weight:700}.bal.owes{color:var(--bad)}
.pay{display:flex;gap:18px;align-items:center;border:2px dashed var(--brand);border-radius:12px;padding:14px;margin-top:18px;flex-wrap:wrap}
.pay svg{width:170px;height:170px}.pay h3{margin:0 0 4px}.btn{display:inline-block;background:var(--brand);color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:16px;text-decoration:none;cursor:pointer;margin:0 8px 12px 0}
.btn.out{background:#fff;color:var(--brand);border:1px solid var(--brand)}
.foot{margin-top:18px;text-align:center;color:var(--muted);font-size:12px}
@media (max-width:560px){.two{grid-template-columns:1fr}.ttl{text-align:left}}
@media print{body{background:#fff}.wrap{padding:0}.doc{box-shadow:none;padding:0}.noprint{display:none!important}}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function renderBill(b) {
  const c = b.company, g = b.guest;
  const hasGst = b.totals.gst > 0;
  const lines = b.lines.length ? b.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td>
    ${hasGst ? `<td class="num">${l.rate ? esc(l.rate) + '%' : '—'}</td><td class="num">${inr(l.gst)}</td>` : ''}<td class="num">${inr(l.amount)}</td></tr>`).join('')
    : `<tr><td colspan="${hasGst ? 5 : 3}" class="muted">Nothing billed</td></tr>`;
  const owes = b.balance > 0;
  const m = String(g.mobile || '').replace(/\D/g, '');
  const pay = b.pay;
  const payBox = pay && owes ? `
    <div class="pay">
      ${pay.upi ? `<div>${pay.upi.qr_svg}</div>` : ''}
      <div>
        <h3>${owes ? `Pay ${inr(b.balance)}` : 'Payment details'} to ${esc(c.property_name || c.business_name)}</h3>
        <div class="muted">${[c.address && esc(c.address), c.phone && `Ph: ${esc(c.phone)}`].filter(Boolean).join(' · ')}</div>
        ${pay.upi ? `<div>Scan with any UPI app (GPay, PhonePe, Paytm, BHIM)</div><div><b>UPI ID:</b> ${esc(pay.upi.id)}</div>
          ${owes ? `<a class="btn noprint" href="${esc(pay.upi.link)}">Pay with UPI app</a>` : ''}` : ''}
        ${pay.bank ? `<div class="muted" style="margin-top:6px"><b>Bank transfer:</b> ${esc(pay.bank.holder)}${pay.bank.name ? ` · ${esc(pay.bank.name)}` : ''}<br>
          A/c ${esc(pay.bank.account)} · IFSC ${esc(pay.bank.ifsc)}${pay.bank.branch ? ` · ${esc(pay.bank.branch)}` : ''}</div>` : ''}
      </div>
    </div>` : '';
  return page(`${b.title} ${b.bill_no} · ${c.property_name || c.business_name}`, `
  <div class="noprint" style="margin-bottom:12px"><button class="btn" onclick="window.print()">🖨 Print / Save PDF</button></div>
  <article class="doc">
    <div class="head">
      <div><div class="name">${esc(c.property_name || c.business_name)}</div>
        ${c.property_name && c.business_name && c.property_name !== c.business_name ? `<div class="sub">A unit of ${esc(c.business_name)}</div>` : ''}
        ${c.address ? `<div class="sub">${esc(c.address)}</div>` : ''}
        <div class="sub">${[c.phone && `Ph: ${esc(c.phone)}`, c.email && esc(c.email), c.gstin && `GSTIN: ${esc(c.gstin)}`].filter(Boolean).join(' · ')}</div></div>
      <div><div class="ttl">${esc(b.title)}</div><div class="sub" style="text-align:right">No. ${esc(b.bill_no)} · ${fmtD(b.date)}</div></div>
    </div>
    <div class="two">
      <div><div class="muted">Bill to</div><b>${esc(g.name)}</b><div class="muted">${m ? 'Mobile ••••••' + esc(m.slice(-4)) : ''}</div></div>
      <div><div class="muted">Stay</div><b>Bed ${esc(g.bed)}</b><div>${fmtD(g.check_in)} → ${fmtD(g.check_out)}</div></div>
    </div>
    <table><thead><tr><th>#</th><th>Description</th>${hasGst ? '<th class="num">GST</th><th class="num">GST amt</th>' : ''}<th class="num">Amount</th></tr></thead>
      <tbody>${lines}</tbody></table>
    ${hasGst ? `<div class="muted">Taxable value ${inr(b.totals.taxable)} · CGST ${inr(b.totals.cgst)} + SGST ${inr(b.totals.sgst)}</div>` : ''}
    <div class="sum">
      <div><span>Total billed</span><b>${inr(b.totals.amount)}</b></div>
      ${b.discount ? `<div><span>Discount</span><b>− ${inr(b.discount)}</b></div>` : ''}
      <div><span>Paid</span><b>− ${inr(b.paid)}</b></div>
      ${b.deposit.adjusted ? `<div><span>Adjusted from deposit</span><b>− ${inr(b.deposit.adjusted)}</b></div>` : ''}
      <div class="bal ${owes ? 'owes' : ''}"><span>${owes ? 'Balance due' : b.balance < 0 ? 'Advance with us' : 'Balance'}</span><b>${inr(Math.abs(b.balance))}</b></div>
    </div>
    ${b.payments.length ? `<h4 style="margin:16px 0 4px">Payments</h4><table><tbody>${b.payments.map((p) =>
      `<tr><td>${fmtD(p.date)}</td><td>${esc(p.what)}</td><td>${esc(p.mode)}</td><td class="num">${inr(p.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${payBox}
    <div class="foot">This is a computer-generated ${esc(b.title.toLowerCase())}.</div>
  </article>`);
}

function notFound(res) {
  res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(page('Link not valid', `<div class="doc"><h2>This bill link is not valid</h2>
    <p>It may be old or typed wrong. Please ask the hostel to send the bill again.</p></div>`));
}

/** GET /b/:token — public, no sign-in. */
function viewBill(req, res) {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return notFound(res);
  const db = getDb();
  const link = db.prepare('SELECT * FROM bill_links WHERE token_hash = ?').get(sha256(token));
  if (!link || link.revoked_at || link.expires_at < new Date().toISOString()) return notFound(res);
  const bill = buildBill(db, link.property_id, link.resident_id);
  if (!bill) return notFound(res);
  try { db.prepare("UPDATE bill_links SET views = views + 1, last_viewed_at = ? WHERE id = ?").run(new Date().toISOString(), link.id); }
  catch (_) { /* a view counter must never break the page */ }
  return res.set('Content-Type', 'text/html; charset=utf-8').send(renderBill(bill));
}

module.exports = { createBillLink, viewBill };
