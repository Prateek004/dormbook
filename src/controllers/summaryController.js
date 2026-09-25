'use strict';
/**
 * Owner-friendly reports:
 *   GET /residents/:id/bill     — one printable bill / tax invoice for a guest
 *   GET /reports/monthly?month= — one-page monthly summary with a 6-month trend
 * Everything is read from the money ledger (integer paise), so the numbers
 * always match dues, checkout and the registers.
 */
const { getDb } = require('../db/connection');
const { SQL } = require('../services/ledger');
const { istDate, istMonth, addDays, daysBetween } = require('../util/time');
const { idDisplay } = require('../util/idproof');
const { company, billNo, cleanReason } = require('./registersController');
const { payInfo } = require('./accountController');

const MODE = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer' };
const CAT = { rent: 'Room rent', addon: 'Items', damage: 'Damages', other: 'Other charges', food: 'Food', electricity: 'Electricity' };
const PLAN = { daily: 'day', weekly: 'week', monthly: 'month' };

function fmtD(d) {
  if (!d) return '';
  const [y, m, dd] = d.split('-');
  return `${dd}/${m}/${y}`;
}

/** GET /api/v1/residents/:id/bill */
function guestBill(req, res) {
  const bill = buildBill(getDb(), req.user.property_id, req.params.id);
  if (!bill) return res.status(404).json({ error: 'Guest not found' });
  return res.json(bill);
}

/**
 * The bill for one guest, from the money ledger. Used by the app and by the
 * private link sent to the guest. Returns null if the guest is not in this property.
 */
function buildBill(db, pid, residentId) {
  const r = db.prepare(`SELECT r.rowid rno, r.*, b.bed_label FROM residents r LEFT JOIN beds b ON b.id = r.bed_id
    WHERE r.id = ? AND r.property_id = ?`).get(residentId, pid);
  if (!r) return null;

  const rows = db.prepare(`SELECT * FROM ledger_entries WHERE resident_id = ? AND property_id = ? ORDER BY ref_date, created_at, rowid`)
    .all(r.id, pid);
  // A charge and its reversal cancel out — show neither, so the bill only lists what the guest really owes.
  const reversed = new Set(rows.filter((e) => e.reversal_of).map((e) => e.reversal_of));
  const live = rows.filter((e) => !e.reversal_of && !reversed.has(e.id));

  const lines = live.filter((e) => e.kind === 'CHARGE' || e.kind === 'OPENING_DUES').map((e) => {
    const tax = e.tax_paise || 0;
    let description;
    if (e.kind === 'OPENING_DUES') description = 'Previous balance';
    else if (e.category === 'rent') {
      const days = e.period_start && e.period_end ? daysBetween(e.period_start, e.period_end) : 0;
      description = `Room rent ${fmtD(e.period_start)} – ${fmtD(addDays(e.period_end, -1))}` +
        (days ? ` (${days} ${days === 1 ? 'night' : 'nights'})` : '');
    } else description = cleanReason(e.reason) || CAT[e.category] || 'Charge';
    return { date: e.ref_date, description, rate: (e.tax_rate_bp || 0) / 100, taxable: e.amount_paise - tax, gst: tax, amount: e.amount_paise };
  });
  const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
  const gst = sum(lines, 'gst');
  const cgst = Math.round(gst / 2);

  const payments = live.filter((e) => ['PAYMENT', 'CREDIT_REFUND'].includes(e.kind)).map((e) => ({
    date: e.biz_date, what: e.kind === 'CREDIT_REFUND' ? 'Advance refunded' : 'Payment received',
    mode: MODE[e.mode] || e.mode || '', amount: e.kind === 'CREDIT_REFUND' ? -e.amount_paise : e.amount_paise,
  }));
  const discounts = live.filter((e) => e.kind === 'WAIVER').map((e) => ({ date: e.biz_date, reason: e.reason || 'Discount', amount: e.amount_paise }));
  const bal = db.prepare(`SELECT ${SQL.dues} dues, ${SQL.deposit} deposit FROM ledger_entries WHERE resident_id = ?`).get(r.id);
  const depIn = live.filter((e) => ['DEPOSIT_IN', 'OPENING_DEPOSIT'].includes(e.kind)).reduce((a, e) => a + e.amount_paise, 0);
  const depUsed = live.filter((e) => e.kind === 'DEPOSIT_APPLY').reduce((a, e) => a + e.amount_paise, 0);
  const depBack = live.filter((e) => e.kind === 'DEPOSIT_REFUND').reduce((a, e) => a + e.amount_paise, 0);

  const co = company(db, pid);
  const no = billNo(r.rno);
  let pay = null;
  try { pay = payInfo(db, pid, { amountPaise: Math.max(0, bal.dues), note: `Bill ${no}` }); }
  catch (e) { console.error('[BILL] payment QR failed:', e.message); }   // a QR problem must never hide the bill
  return {
    company: co,
    title: co.gstin && gst > 0 ? 'Tax Invoice' : 'Bill',
    bill_no: no, date: istDate(),
    guest: {
      name: r.full_name, mobile: r.mobile, bed: r.bed_label || '—', check_in: r.check_in_date,
      check_out: r.actual_checkout || r.expected_checkout, status: r.status === 'active' ? 'Staying' : 'Left',
      id_proof: idDisplay(r.id_type, r.id_last4) || '', rate: r.rate_paise, rate_per: PLAN[r.rate_type] || 'month',
      address: r.permanent_address || '',
    },
    lines,
    totals: { taxable: sum(lines, 'taxable'), cgst, sgst: gst - cgst, gst, amount: sum(lines, 'amount') },
    payments, paid: sum(payments, 'amount'),
    discounts, discount: sum(discounts, 'amount'),
    deposit: { received: depIn, adjusted: depUsed, refunded: depBack, held: bal.deposit },
    balance: bal.dues,   // > 0 = guest owes, < 0 = advance with us
    pay,                 // UPI QR + bank details for the end of the bill (null if not set up)
  };
}

/** GET /api/v1/reports/monthly?month=YYYY-MM */
function monthly(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const month = req.query.month ? String(req.query.month) : istMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const from = `${month}-01`;
  const nextMonth = (m) => { const [y, mm] = m.split('-').map(Number); return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`; };
  const to = addDays(`${nextMonth(month)}-01`, -1);
  const today = istDate();
  const upto = to < today ? to : today;           // occupancy only counts days that have happened

  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const received = db.prepare(`SELECT COALESCE(category,'rent') head, SUM(amount_paise) amount FROM ledger_entries
    WHERE property_id = ? AND kind = 'PAYMENT' AND biz_date BETWEEN ? AND ? GROUP BY head HAVING amount <> 0`).all(pid, from, to);
  const creditRefunds = one(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries WHERE property_id = ? AND kind = 'CREDIT_REFUND'
    AND biz_date BETWEEN ? AND ?`, pid, from, to).t;
  const billed = db.prepare(`SELECT category head, SUM(amount_paise) amount, SUM(COALESCE(tax_paise,0)) gst FROM ledger_entries
    WHERE property_id = ? AND kind = 'CHARGE' AND biz_date BETWEEN ? AND ? GROUP BY category HAVING amount <> 0`).all(pid, from, to);
  const expenses = db.prepare(`SELECT category head, SUM(amount_paise) amount FROM ledger_entries
    WHERE property_id = ? AND kind = 'EXPENSE' AND ref_date BETWEEN ? AND ? GROUP BY category HAVING amount <> 0 ORDER BY amount DESC`).all(pid, from, to);
  const discount = one(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries WHERE property_id = ? AND kind = 'WAIVER'
    AND biz_date BETWEEN ? AND ?`, pid, from, to).t;
  const depIn = one(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries WHERE property_id = ? AND kind = 'DEPOSIT_IN'
    AND biz_date BETWEEN ? AND ?`, pid, from, to).t;
  const depOut = one(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries WHERE property_id = ? AND kind = 'DEPOSIT_REFUND'
    AND biz_date BETWEEN ? AND ?`, pid, from, to).t;
  const duesNow = one(`SELECT COALESCE(SUM(d),0) t FROM (SELECT ${SQL.dues} d FROM ledger_entries WHERE property_id = ?
    AND biz_date <= ? GROUP BY resident_id) WHERE d > 0`, pid, to).t;

  const byMode = one(`SELECT COALESCE(SUM(CASE WHEN mode='cash' THEN amount_paise END),0) cash,
      COALESCE(SUM(CASE WHEN mode<>'cash' THEN amount_paise END),0) online
    FROM ledger_entries WHERE property_id = ? AND kind IN ('PAYMENT','DEPOSIT_IN') AND biz_date BETWEEN ? AND ?`, pid, from, to);
  const totalReceived = received.reduce((a, r) => a + r.amount, 0) - creditRefunds;
  const totalExpenses = expenses.reduce((a, r) => a + r.amount, 0);
  const totalBilled = billed.reduce((a, r) => a + r.amount, 0);
  const gstBilled = billed.reduce((a, r) => a + r.gst, 0);

  // Occupancy: average of occupied beds per day, over the days of the month so far.
  const totalBeds = one('SELECT COUNT(*) n FROM beds WHERE property_id = ? AND removed_at IS NULL', pid).n;
  const stays = db.prepare(`SELECT check_in_date ci, COALESCE(actual_checkout, CASE WHEN status='active' THEN '9999-12-31' ELSE expected_checkout END) co
    FROM residents WHERE property_id = ? AND check_in_date <= ?`).all(pid, upto);
  let occDays = 0, days = 0;
  if (from <= upto) {
    for (let d = from; d <= upto && days < 31; d = addDays(d, 1), days++) occDays += stays.filter((s) => s.ci <= d && s.co > d).length;
  }
  const occupancy = totalBeds && days ? Math.round((occDays * 1000) / (totalBeds * days)) / 10 : 0;
  const checkIns = one(`SELECT COUNT(*) n FROM residents WHERE property_id = ? AND check_in_date BETWEEN ? AND ?`, pid, from, to).n;
  const checkOuts = one(`SELECT COUNT(*) n FROM residents WHERE property_id = ? AND actual_checkout BETWEEN ? AND ?`, pid, from, to).n;

  // 6-month trend (this month and the 5 before it).
  const trend = [];
  let m = month;
  for (let i = 0; i < 6; i++) {
    const f = `${m}-01`, t = addDays(`${nextMonth(m)}-01`, -1);
    const inc = one(`SELECT COALESCE(SUM(CASE WHEN kind='PAYMENT' THEN amount_paise WHEN kind='CREDIT_REFUND' THEN -amount_paise END),0) t
      FROM ledger_entries WHERE property_id = ? AND kind IN ('PAYMENT','CREDIT_REFUND') AND biz_date BETWEEN ? AND ?`, pid, f, t).t;
    const exp = one(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries WHERE property_id = ? AND kind = 'EXPENSE'
      AND ref_date BETWEEN ? AND ?`, pid, f, t).t;
    trend.unshift({ month: m, income: inc, expenses: exp, profit: inc - exp });
    const [y, mm] = m.split('-').map(Number);
    m = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
  }

  return res.json({
    company: company(db, pid), month, from, to,
    kpis: {
      received: totalReceived, expenses: totalExpenses, profit: totalReceived - totalExpenses,
      billed: totalBilled, gst_billed: gstBilled, discount, dues_outstanding: duesNow,
      occupancy_pct: occupancy, beds: totalBeds, check_ins: checkIns, check_outs: checkOuts,
      deposits_received: depIn, deposits_refunded: depOut,
      cash_in: byMode.cash, online_in: byMode.online,   // money in (payments + deposits) by how it was paid
    },
    income: received.map((r) => ({ head: CAT[r.head] || r.head, amount: r.amount }))
      .concat(creditRefunds ? [{ head: 'Advance refunded', amount: -creditRefunds }] : []),
    billed: billed.map((r) => ({ head: CAT[r.head] || r.head, amount: r.amount, gst: r.gst })),
    expenses: expenses.map((r) => ({ head: r.head, amount: r.amount })),
    trend,
    notes: 'Money received = cash, UPI, card and bank payments (deposits are not income). Billed = rent and items charged in the month.',
  });
}

module.exports = { guestBill, monthly, buildBill };
