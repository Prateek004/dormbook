'use strict';
/**
 * Formal report registers: every report comes back in one shape
 *   { title, company, period, columns, rows, totals, summary }
 * so the app renders them all as the same letterhead + table, ready to print
 * or export. Money is integer paise.
 */
const { getDb } = require('../db/connection');
const ledger = require('../services/ledger');
const { istDate, istMonthStart, isValidDate, addDays, daysBetween } = require('../util/time');
const { hasPermission } = require('../middleware/permissions');
const { idDisplay } = require('../util/idproof');
const { ageing } = require('./dailyReportsController');

const { SQL } = ledger;
const col = (key, label, type = 'text') => ({ key, label, type });

const LABEL = { rent: 'Rent', other: 'Other charges', addon: 'Add-ons', damage: 'Damages / deductions', food: 'Food',
  electricity: 'Electricity' };
const KIND_LABEL = { PAYMENT: 'Payment', DEPOSIT_IN: 'Deposit received', DEPOSIT_REFUND: 'Deposit refunded', CREDIT_REFUND: 'Advance refunded' };
const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer' };

function company(db, propertyId) {
  const p = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId) || {};
  const acc = p.account_id ? db.prepare('SELECT business_name FROM accounts WHERE id = ?').get(p.account_id) : null;
  const out = {
    business_name: acc ? acc.business_name : (p.name || ''), property_name: p.name || '',
    address: [p.address, p.city, p.state, p.pincode].filter(Boolean).join(', '),
    phone: p.contact_phone || p.whatsapp_number || '', email: p.contact_email || '',
    // GSTIN is printed whenever the business has one (registered businesses must show it even on 0% bills).
    gstin: p.gstin || '',
  };
  // What is still empty in Business & GST (shown to staff above a bill, never printed).
  out.missing = [!p.address && 'address', !out.phone && 'phone', p.gst_enabled && !p.gstin && 'GSTIN'].filter(Boolean);
  return out;
}

function billNo(rowid) { return `B-${String(rowid || 0).padStart(5, '0')}`; }
function cleanReason(r) { return String(r || '').replace(/^Add-on:\s*/, '').replace(/^Reversal:\s*/, '').trim(); }
function rupeesText(p) { return '₹' + (Math.round(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

const REPORTS = {
  collections: {
    title: 'Collections Register', perm: 'reports_finance',
    build(db, pid, from, to) {
      const rows = db.prepare(`SELECT e.biz_date date, e.kind, e.category, e.mode, e.amount_paise amount, e.reason,
          r.full_name resident, b.bed_label bed, u.name staff
        FROM ledger_entries e LEFT JOIN residents r ON r.id = e.resident_id LEFT JOIN beds b ON b.id = r.bed_id
        LEFT JOIN users u ON u.id = e.user_id
        WHERE e.property_id = ? AND e.biz_date BETWEEN ? AND ? AND e.kind IN ('PAYMENT','DEPOSIT_IN','DEPOSIT_REFUND','CREDIT_REFUND')
        ORDER BY e.biz_date, e.created_at`).all(pid, from, to).map((x) => ({
        date: x.date, resident: x.resident || '—', bed: x.bed || '—',
        type: x.amount < 0 ? `${KIND_LABEL[x.kind]} (reversed)` : x.kind === 'PAYMENT' ? (LABEL[x.category] || 'Payment') : KIND_LABEL[x.kind],
        mode: MODE_LABEL[x.mode] || x.mode, staff: x.staff || '—',
        amount: (x.kind === 'DEPOSIT_REFUND' || x.kind === 'CREDIT_REFUND') ? -x.amount : x.amount,
      }));
      const byMode = {};
      rows.forEach((r) => { byMode[r.mode] = (byMode[r.mode] || 0) + r.amount; });
      return {
        columns: [col('date', 'Date', 'date'), col('resident', 'Resident'), col('bed', 'Bed'), col('type', 'Type'),
          col('mode', 'Mode'), col('staff', 'Received by'), col('amount', 'Amount', 'money')],
        rows, totals: { amount: rows.reduce((s, r) => s + r.amount, 0) },
        summary: Object.entries(byMode).map(([k, v]) => ({ label: k, value: v, type: 'money' })),
      };
    },
  },

  modes: {
    title: 'Cash & Online Payments', perm: 'reports_finance',
    build(db, pid, from, to) {
      // Money received (payments + deposits) per day, split by how it was paid.
      const got = db.prepare(`SELECT biz_date d, mode, SUM(amount_paise) amt FROM ledger_entries
        WHERE property_id = ? AND biz_date BETWEEN ? AND ? AND kind IN ('PAYMENT','DEPOSIT_IN')
        GROUP BY biz_date, mode ORDER BY biz_date`).all(pid, from, to);
      const back = db.prepare(`SELECT mode, SUM(amount_paise) amt FROM ledger_entries
        WHERE property_id = ? AND biz_date BETWEEN ? AND ? AND kind IN ('DEPOSIT_REFUND','CREDIT_REFUND')
        GROUP BY mode`).all(pid, from, to);
      const days = new Map();
      for (const g of got) {
        const r = days.get(g.d) || { date: g.d, cash: 0, upi: 0, card: 0, bank: 0 };
        const k = g.mode === 'bank_transfer' ? 'bank' : (['cash', 'upi', 'card'].includes(g.mode) ? g.mode : 'cash');
        r[k] += g.amt;
        days.set(g.d, r);
      }
      const rows = [...days.values()].map((r) => ({ ...r, online: r.upi + r.card + r.bank, total: r.cash + r.upi + r.card + r.bank }));
      const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
      const cashBack = back.filter((x) => x.mode === 'cash').reduce((a, x) => a + x.amt, 0);
      const onlineBack = back.filter((x) => x.mode !== 'cash').reduce((a, x) => a + x.amt, 0);
      return {
        columns: [col('date', 'Date', 'date'), col('cash', 'Cash', 'money'), col('upi', 'UPI', 'money'), col('card', 'Card', 'money'),
          col('bank', 'Bank transfer', 'money'), col('online', 'Online total', 'money'), col('total', 'Total received', 'money')],
        rows,
        totals: { cash: sum('cash'), upi: sum('upi'), card: sum('card'), bank: sum('bank'), online: sum('online'), total: sum('total') },
        summary: [
          { label: 'Cash received', value: sum('cash'), type: 'money' },
          { label: 'Online received (UPI + card + bank)', value: sum('online'), type: 'money' },
          { label: 'Total received', value: sum('total'), type: 'money' },
          { label: 'Given back in cash (refunds)', value: cashBack, type: 'money' },
          { label: 'Given back online (refunds)', value: onlineBack, type: 'money' },
        ],
        notes: 'Received = rent, items and deposits taken from guests. Refunds are shown separately. Expenses are not included.',
      };
    },
  },

  expenses: {
    title: 'Expense Register', perm: 'reports_finance',
    build(db, pid, from, to) {
      const rows = db.prepare(`SELECT x.expense_date date, x.category, x.description, x.payment_mode mode, x.amount_paise amount, u.name staff
        FROM expenses x LEFT JOIN users u ON u.id = x.recorded_by
        WHERE x.property_id = ? AND x.expense_date BETWEEN ? AND ? ORDER BY x.expense_date, x.created_at`).all(pid, from, to)
        .map((x) => ({ ...x, mode: MODE_LABEL[x.mode] || x.mode, description: x.description || '—', staff: x.staff || '—' }));
      const byCat = {};
      rows.forEach((r) => { byCat[r.category] = (byCat[r.category] || 0) + r.amount; });
      return {
        columns: [col('date', 'Date', 'date'), col('category', 'Category'), col('description', 'Description'),
          col('mode', 'Mode'), col('staff', 'Recorded by'), col('amount', 'Amount', 'money')],
        rows, totals: { amount: rows.reduce((s, r) => s + r.amount, 0) },
        summary: Object.entries(byCat).map(([k, v]) => ({ label: k, value: v, type: 'money' })),
      };
    },
  },

  pnl: {
    title: 'Profit & Loss Statement', perm: 'reports_finance',
    build(db, pid, from, to) {
      const income = db.prepare(`SELECT COALESCE(category,'rent') head, SUM(amount_paise) amount FROM ledger_entries
        WHERE property_id = ? AND kind = 'PAYMENT' AND biz_date BETWEEN ? AND ? GROUP BY COALESCE(category,'rent')
        HAVING amount <> 0`).all(pid, from, to);
      const exp = db.prepare(`SELECT category head, SUM(amount_paise) amount FROM ledger_entries
        WHERE property_id = ? AND kind = 'EXPENSE' AND ref_date BETWEEN ? AND ? GROUP BY category HAVING amount <> 0`).all(pid, from, to);
      const disc = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries WHERE property_id = ? AND kind = 'WAIVER'
        AND biz_date BETWEEN ? AND ?`).get(pid, from, to).t;
      const ti = income.reduce((s, r) => s + r.amount, 0);
      const te = exp.reduce((s, r) => s + r.amount, 0);
      const rows = [
        { section: 'Income', head: '', amount: null, bold: true },
        ...income.map((r) => ({ section: '', head: LABEL[r.head] || r.head, amount: r.amount })),
        { section: '', head: 'Total income', amount: ti, bold: true },
        { section: 'Expenses', head: '', amount: null, bold: true },
        ...exp.map((r) => ({ section: '', head: r.head, amount: r.amount })),
        { section: '', head: 'Total expenses', amount: te, bold: true },
        { section: ti - te >= 0 ? 'Net profit' : 'Net loss', head: '', amount: ti - te, bold: true },
      ];
      return {
        columns: [col('section', ''), col('head', 'Head'), col('amount', 'Amount', 'money')],
        rows, totals: null,
        summary: [{ label: 'Discounts given', value: disc, type: 'money' }],
        notes: 'Income = money received in the period (deposits are not income). Expenses by expense date.',
      };
    },
  },

  dues: {
    title: 'Outstanding Dues', perm: 'reports_finance', asOf: true,
    build(db, pid, from, to) {
      const { bal, ageMap } = ageing(db, pid, to);
      const people = new Map(db.prepare(`SELECT r.id, r.full_name, r.mobile, r.status, b.bed_label FROM residents r
        LEFT JOIN beds b ON b.id = r.bed_id WHERE r.property_id = ?`).all(pid).map((r) => [r.id, r]));
      const rows = [];
      for (const [rid, b] of bal) {
        if (b.dues_paise <= 0) continue;
        const p = people.get(rid) || {};
        const oldest = (ageMap.get(rid) || {}).oldest_unpaid_date || null;
        rows.push({ resident: p.full_name || '—', mobile: p.mobile || '', bed: p.bed_label || '—',
          status: p.status === 'active' ? 'Staying' : 'Left', since: oldest,
          days: oldest ? Math.max(0, daysBetween(oldest, to)) : 0, deposit: b.deposit_paise, dues: b.dues_paise });
      }
      rows.sort((a, b) => b.days - a.days || b.dues - a.dues);
      return {
        columns: [col('resident', 'Resident'), col('mobile', 'Mobile'), col('bed', 'Bed'), col('status', 'Status'),
          col('since', 'Unpaid since', 'date'), col('days', 'Days overdue', 'number'), col('deposit', 'Deposit held', 'money'),
          col('dues', 'Amount due', 'money')],
        rows, totals: { deposit: rows.reduce((s, r) => s + r.deposit, 0), dues: rows.reduce((s, r) => s + r.dues, 0) },
      };
    },
  },

  guests: {
    title: 'Guest Register', perm: 'reports_daily',
    build(db, pid, from, to) {
      const rows = db.prepare(`SELECT r.full_name, r.mobile, r.id_type, r.id_last4, r.aadhaar_last4, r.permanent_address,
          r.coming_from, r.check_in_date, COALESCE(r.actual_checkout, r.expected_checkout) out_date, r.status, b.bed_label
        FROM residents r LEFT JOIN beds b ON b.id = r.bed_id
        WHERE r.property_id = ? AND r.check_in_date <= ? AND (r.status = 'active' OR COALESCE(r.actual_checkout, r.expected_checkout) >= ?)
        ORDER BY r.check_in_date, r.full_name`).all(pid, to, from).map((r) => ({
        name: r.full_name, mobile: r.mobile,
        id_proof: idDisplay(r.id_type, r.id_last4) || idDisplay('aadhaar', r.aadhaar_last4) || '—',
        address: r.permanent_address || r.coming_from || '—', bed: r.bed_label || '—',
        check_in: r.check_in_date, check_out: r.out_date, status: r.status === 'active' ? 'Staying' : 'Left',
      }));
      return {
        columns: [col('name', 'Name'), col('mobile', 'Mobile'), col('id_proof', 'ID proof'), col('address', 'Address'),
          col('bed', 'Bed'), col('check_in', 'Check-in', 'date'), col('check_out', 'Check-out', 'date'), col('status', 'Status')],
        rows, totals: null, summary: [{ label: 'Guests', value: rows.length, type: 'number' }],
      };
    },
  },

  occupancy: {
    title: 'Occupancy Report', perm: 'reports_daily',
    build(db, pid, from, to) {
      const totalBeds = db.prepare('SELECT COUNT(*) n FROM beds WHERE property_id = ? AND removed_at IS NULL').get(pid).n;
      const stays = db.prepare(`SELECT check_in_date ci, COALESCE(actual_checkout, CASE WHEN status='active' THEN '9999-12-31' ELSE expected_checkout END) co
        FROM residents WHERE property_id = ? AND check_in_date <= ?`).all(pid, to);
      const rows = [];
      for (let d = from, g = 0; d <= to && g < 400; d = addDays(d, 1), g++) {
        const occ = stays.filter((s) => s.ci <= d && s.co > d).length;
        rows.push({ date: d, occupied: occ, vacant: Math.max(0, totalBeds - occ), total: totalBeds,
          pct: totalBeds ? Math.round((occ * 1000) / totalBeds) / 10 : 0 });
      }
      const avg = rows.length ? Math.round((rows.reduce((s, r) => s + r.pct, 0) / rows.length) * 10) / 10 : 0;
      return {
        columns: [col('date', 'Date', 'date'), col('occupied', 'Occupied', 'number'), col('vacant', 'Vacant', 'number'),
          col('total', 'Total beds', 'number'), col('pct', 'Occupancy %', 'pct')],
        rows, totals: null, summary: [{ label: 'Average occupancy', value: avg, type: 'pct' }],
        notes: 'Total beds is today\'s bed count.',
      };
    },
  },

  cash: {
    title: 'Cash Book (Day Closes)', perm: 'reports_daily',
    build(db, pid, from, to) {
      const rows = db.prepare(`SELECT d.biz_date date, d.from_date, d.opening_cash_paise opening, d.cash_in_paise cash_in,
          d.cash_out_paise cash_out, d.expected_cash_paise expected, d.counted_cash_paise counted, d.variance_paise variance,
          u.name closed_by
        FROM day_closes d LEFT JOIN users u ON u.id = d.closed_by
        WHERE d.property_id = ? AND d.biz_date BETWEEN ? AND ? ORDER BY d.biz_date`).all(pid, from, to)
        .map((r) => ({ ...r, closed_by: r.closed_by || '—' }));
      return {
        columns: [col('date', 'Date', 'date'), col('opening', 'Opening', 'money'), col('cash_in', 'Cash in', 'money'),
          col('cash_out', 'Cash out', 'money'), col('expected', 'Expected', 'money'), col('counted', 'Counted', 'money'),
          col('variance', 'Short / over', 'money'), col('closed_by', 'Closed by')],
        rows, totals: { cash_in: rows.reduce((s, r) => s + r.cash_in, 0), cash_out: rows.reduce((s, r) => s + r.cash_out, 0),
          variance: rows.reduce((s, r) => s + r.variance, 0) },
      };
    },
  },

  gst: {
    title: 'GST Register (Sales)', perm: 'reports_finance',
    build(db, pid, from, to) {
      const rows = db.prepare(`SELECT e.biz_date date, e.category, e.reason, e.amount_paise amount, e.tax_rate_bp rate,
          COALESCE(e.tax_paise,0) tax, e.reversal_of, r.full_name guest, r.rowid rno, b.bed_label bed
        FROM ledger_entries e JOIN residents r ON r.id = e.resident_id LEFT JOIN beds b ON b.id = r.bed_id
        WHERE e.property_id = ? AND e.kind = 'CHARGE' AND e.biz_date BETWEEN ? AND ?
        ORDER BY e.biz_date, e.created_at`).all(pid, from, to).map((x) => {
        const cgst = Math.round(x.tax / 2);
        return {
          date: x.date, bill: billNo(x.rno), guest: x.guest || '—', bed: x.bed || '—',
          item: (x.category === 'rent' ? 'Room rent' : cleanReason(x.reason) || LABEL[x.category] || 'Charge') + (x.reversal_of ? ' (reversed)' : ''),
          rate: (x.rate || 0) / 100, taxable: x.amount - x.tax, cgst, sgst: x.tax - cgst, amount: x.amount,
        };
      });
      const byRate = {};
      rows.forEach((r) => {
        const k = r.rate;
        byRate[k] = byRate[k] || { taxable: 0, gst: 0 };
        byRate[k].taxable += r.taxable; byRate[k].gst += r.cgst + r.sgst;
      });
      const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
      return {
        columns: [col('date', 'Date', 'date'), col('bill', 'Bill no'), col('guest', 'Guest'), col('bed', 'Bed'), col('item', 'Item'),
          col('rate', 'GST %', 'number'), col('taxable', 'Taxable value', 'money'), col('cgst', 'CGST', 'money'),
          col('sgst', 'SGST', 'money'), col('amount', 'Total', 'money')],
        rows, totals: { taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), amount: sum('amount') },
        summary: [
          { label: 'Taxable value', value: sum('taxable'), type: 'money' },
          { label: 'CGST', value: sum('cgst'), type: 'money' },
          { label: 'SGST', value: sum('sgst'), type: 'money' },
          ...Object.keys(byRate).sort((a, b) => a - b).map((k) => ({ label: `GST @ ${k}% (on ${rupeesText(byRate[k].taxable)})`, value: byRate[k].gst, type: 'money' })),
        ],
        notes: 'Charges billed in the period (by bill date). CGST + SGST are for sales inside your state; for IGST ask your CA. Check rates with your CA.',
      };
    },
  },

  deposits: {
    title: 'Security Deposit Register', perm: 'reports_finance', asOf: true,
    build(db, pid, from, to) {
      const rows = db.prepare(`SELECT r.full_name resident, b.bed_label bed, r.status,
          COALESCE(SUM(CASE WHEN e.kind IN ('DEPOSIT_IN','OPENING_DEPOSIT') THEN e.amount_paise END),0) received,
          COALESCE(SUM(CASE WHEN e.kind = 'DEPOSIT_APPLY' THEN e.amount_paise END),0) adjusted,
          COALESCE(SUM(CASE WHEN e.kind = 'DEPOSIT_REFUND' THEN e.amount_paise END),0) refunded,
          ${SQL.deposit} held
        FROM ledger_entries e JOIN residents r ON r.id = e.resident_id LEFT JOIN beds b ON b.id = r.bed_id
        WHERE e.property_id = ? AND e.biz_date <= ? AND e.kind IN ('DEPOSIT_IN','OPENING_DEPOSIT','DEPOSIT_APPLY','DEPOSIT_REFUND')
        GROUP BY r.id ORDER BY held DESC, r.full_name`).all(pid, to)
        .map((r) => ({ ...r, bed: r.bed || '—', status: r.status === 'active' ? 'Staying' : 'Left' }));
      const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
      return {
        columns: [col('resident', 'Resident'), col('bed', 'Bed'), col('status', 'Status'), col('received', 'Received', 'money'),
          col('adjusted', 'Adjusted to dues', 'money'), col('refunded', 'Refunded', 'money'), col('held', 'Held now', 'money')],
        rows, totals: { received: sum('received'), adjusted: sum('adjusted'), refunded: sum('refunded'), held: sum('held') },
      };
    },
  },
};

function listRegisters(req, res) {
  return res.json(Object.entries(REPORTS)
    .filter(([, r]) => hasPermission(req, r.perm))
    .map(([id, r]) => ({ id, title: r.title, as_of: !!r.asOf })));
}

function getRegister(req, res) {
  const r = REPORTS[req.params.type];
  if (!r) return res.status(404).json({ error: 'Unknown report' });
  if (!hasPermission(req, r.perm)) return res.status(403).json({ error: 'You don\'t have permission for this report', code: 'NO_PERMISSION' });
  const to = req.query.to ? String(req.query.to) : istDate();
  const from = req.query.from ? String(req.query.from) : istMonthStart();
  if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  if (from > to) return res.status(400).json({ error: '"From" must be on or before "To"' });
  if (daysBetween(from, to) > 366) return res.status(400).json({ error: 'Choose a period of one year or less' });
  const db = getDb();
  const out = r.build(db, req.user.property_id, from, to);
  return res.json({
    id: req.params.type, title: r.title, company: company(db, req.user.property_id),
    period: r.asOf ? { as_of: to } : { from, to },
    generated_at: new Date().toISOString(), generated_by: req.user.name,
    ...out,
  });
}

module.exports = { listRegisters, getRegister, REPORTS, company, billNo, cleanReason };
