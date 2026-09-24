'use strict';

const ExcelJS  = require('exceljs');
const PDFKit   = require('pdfkit');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');
const ledger = require('../services/ledger');
const { istDate, istMonth, istMonthStart, isValidDate, sqlIstDate, addDays } = require('../util/time');

const EXPENSE_MODES = ['cash', 'upi', 'card', 'bank_transfer'];
function strictPaise(v) {
  if (typeof v === 'string') v = v.trim();
  if (v === '' || v === null || v === undefined || typeof v === 'boolean' || Array.isArray(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= 1e11 ? n : null;
}

function getDashboard(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const today      = istDate();
  const thisMonth  = istMonth();

  const occupancy = db.prepare(`
    SELECT
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN status='occupied'  THEN 1 ELSE 0 END) as occupied,
      SUM(CASE WHEN status='cleaning'  THEN 1 ELSE 0 END) as cleaning,
      SUM(CASE WHEN status='reserved'  THEN 1 ELSE 0 END) as reserved,
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) as pending,
      COUNT(*)                                              as total
    FROM beds WHERE property_id = ?
  `).get(propertyId);

  const activeResidents = db.prepare(
    "SELECT COUNT(*) as count FROM residents WHERE property_id = ? AND status = 'active'"
  ).get(propertyId);

  const pendingRefunds = db.prepare(
    "SELECT COUNT(*) as count, COALESCE(SUM(amount_paise),0) as total_paise FROM payment_ledger WHERE property_id = ? AND approval_status = 'pending'"
  ).get(propertyId);

  let financial = null;
  if (require('../middleware/permissions').hasPermission(req, 'reports_finance')) {
    // All money figures come from the ledger, in India time.
    // Revenue = rent/other money received. Deposits are NOT revenue (you owe them back).
    const t = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN kind IN ('PAYMENT','DEPOSIT_IN') AND biz_date = @today THEN amount_paise END),0) AS today_collection,
        COALESCE(SUM(CASE WHEN kind = 'PAYMENT' AND biz_date >= @mstart AND biz_date <= @today THEN amount_paise END),0) AS month_revenue,
        COALESCE(SUM(CASE WHEN kind = 'EXPENSE' AND ref_date >= @mstart AND ref_date <= @mend THEN amount_paise END),0) AS month_expenses
      FROM ledger_entries WHERE property_id = @pid`).get({ pid: propertyId, today, mstart: thisMonth + '-01', mend: thisMonth + '-31' });

    const dues = db.prepare(`SELECT r.status, x.dues, x.dep FROM residents r
        JOIN (SELECT resident_id, ${ledger.SQL.dues} dues, ${ledger.SQL.deposit} dep FROM ledger_entries
              WHERE property_id = ? AND resident_id IS NOT NULL GROUP BY resident_id) x ON x.resident_id = r.id
        WHERE r.property_id = ?`).all(propertyId, propertyId);

    financial = {
      today_collection_paise:    t.today_collection,
      monthly_revenue_paise:     t.month_revenue,
      monthly_expenses_paise:    t.month_expenses,
      monthly_net_paise:         t.month_revenue - t.month_expenses,
      overdue_residents:         dues.filter(d => d.status === 'active' && d.dues > 0).length,
      total_dues_paise:          dues.reduce((s, d) => s + Math.max(0, d.dues), 0),
      deposits_held_paise:       dues.reduce((s, d) => s + d.dep, 0),
    };
  }

  return res.json({
    occupancy,
    active_residents: activeResidents.count,
    pending_refunds:  pendingRefunds.count,
    pending_refunds_total_paise: pendingRefunds.total_paise,
    ...(financial || { note: 'Financial data restricted to manager and above' }),
  });
}

function listExpenses(req, res) {
  const db = getDb();
  const { from, to, category } = req.query;
  if ((from && !isValidDate(String(from))) || (to && !isValidDate(String(to)))) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  }
  let q = 'SELECT e.*, u.name as recorded_by_name FROM expenses e JOIN users u ON u.id=e.recorded_by WHERE e.property_id=?';
  const params = [req.user.property_id];
  if (from)     { q += ' AND e.expense_date >= ?'; params.push(from); }
  if (to)       { q += ' AND e.expense_date <= ?'; params.push(to); }
  if (category) { q += ' AND e.category = ?'; params.push(category); }
  q += ' ORDER BY e.expense_date DESC';
  return res.json(db.prepare(q).all(...params));
}

function addExpense(req, res) {
  const { v4: uuidv4 } = require('uuid');
  const db = getDb();
  const propertyId = req.user.property_id;
  const { category, description, amount_paise, expense_date, payment_mode = 'cash', receipt_path } = req.body;

  if (!category || !amount_paise || !expense_date) {
    return res.status(400).json({ error: 'category, amount_paise, expense_date are required' });
  }
  const amtPaise = strictPaise(amount_paise);
  if (amtPaise === null) return res.status(400).json({ error: 'amount_paise must be a positive whole number' });
  if (!isValidDate(String(expense_date))) return res.status(400).json({ error: 'expense_date must be YYYY-MM-DD' });
  if (!EXPENSE_MODES.includes(payment_mode)) return res.status(400).json({ error: `payment_mode must be one of: ${EXPENSE_MODES.join(', ')}` });
  const cat = String(category).trim().slice(0, 40);
  if (!cat) return res.status(400).json({ error: 'category is required' });

  const id  = uuidv4();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO expenses (id,property_id,category,description,amount_paise,expense_date,payment_mode,receipt_path,recorded_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, propertyId, cat, description || null, amtPaise, expense_date,
      payment_mode, receipt_path || null, req.user.id, now);
    // Cash expenses reduce the drawer — the cash close now accounts for them.
    ledger.expense({ propertyId, amountPaise: amtPaise, mode: payment_mode, category: cat, refDate: expense_date,
      reason: description || null, userId: req.user.id, sourceTable: 'expenses', sourceId: id });
  })();

  writeAudit({
    propertyId, userId: req.user.id, action: 'EXPENSE_RECORDED',
    entityType: 'expenses', entityId: id,
    amountPaise: amtPaise,
    snapshot: { category: cat, expense_date, mode: payment_mode },
    ip: req.ip,
  });

  return res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id=?').get(id));
}

function updateExpense(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ? AND property_id = ?')
    .get(req.params.id, propertyId);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });

  const { category, description, amount_paise, expense_date, payment_mode } = req.body;
  const newAmount = amount_paise !== undefined ? strictPaise(amount_paise) : expense.amount_paise;
  if (newAmount === null) return res.status(400).json({ error: 'amount_paise must be a positive whole number' });
  if (expense_date !== undefined && !isValidDate(String(expense_date))) return res.status(400).json({ error: 'expense_date must be YYYY-MM-DD' });
  if (payment_mode !== undefined && !EXPENSE_MODES.includes(payment_mode)) return res.status(400).json({ error: 'invalid payment_mode' });

  db.transaction(() => {
    db.prepare(`
      UPDATE expenses SET category=COALESCE(?,category), description=COALESCE(?,description),
      amount_paise=?, expense_date=COALESCE(?,expense_date), payment_mode=COALESCE(?,payment_mode)
      WHERE id=?
    `).run(
      category ? String(category).trim().slice(0, 40) : null, description !== undefined ? description : null,
      newAmount, expense_date || null, payment_mode || null, req.params.id
    );
    // Ledger rows are never edited: reverse the old amount, post the new one.
    const e = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
    ledger.reverseSource('expenses', e.id, 'Expense edited', req.user.id);
    ledger.expense({ propertyId, amountPaise: e.amount_paise, mode: e.payment_mode, category: e.category,
      refDate: e.expense_date, reason: e.description || null, userId: req.user.id, sourceTable: 'expenses', sourceId: e.id });
  })();

  writeAudit({
    propertyId, userId: req.user.id, action: 'EXPENSE_UPDATED',
    entityType: 'expenses', entityId: req.params.id,
    amountPaise: newAmount,
    snapshot: { old: expense, updated_fields: req.body },
    ip: req.ip,
  });

  return res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id));
}

function deleteExpense(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ? AND property_id = ?')
    .get(req.params.id, propertyId);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });

  db.transaction(() => {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    ledger.reverseSource('expenses', expense.id, 'Expense deleted', req.user.id);
  })();

  writeAudit({
    propertyId, userId: req.user.id, action: 'EXPENSE_DELETED',
    entityType: 'expenses', entityId: req.params.id,
    amountPaise: expense.amount_paise,
    snapshot: expense,
    ip: req.ip,
  });

  return res.json({ message: 'Expense deleted' });
}

/** GET /api/v1/properties/settings — read current property config */
function getPropertySettings(req, res) {
  const db = getDb();
  const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.user.property_id);
  if (!prop) return res.status(404).json({ error: 'Property not found' });
  return res.json(prop);
}

function updatePropertySettings(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;

  const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  if (!prop) return res.status(404).json({ error: 'Property not found' });

  const {
    name, address, city, state, pincode, whatsapp_number,
    cleaning_timeout_minutes, refund_approval_threshold_paise,
    daily_summary_time, eod_report_time, timezone,
    cash_reconciliation_tolerance_paise, booking_lock_hours, property_code,
    contact_phone, contact_email, gstin,
  } = req.body;

  db.prepare(`
    UPDATE properties SET
      name=COALESCE(?,name), address=COALESCE(?,address), city=COALESCE(?,city),
      state=COALESCE(?,state), pincode=COALESCE(?,pincode),
      whatsapp_number=COALESCE(?,whatsapp_number),
      cleaning_timeout_minutes=COALESCE(?,cleaning_timeout_minutes),
      refund_approval_threshold_paise=COALESCE(?,refund_approval_threshold_paise),
      daily_summary_time=COALESCE(?,daily_summary_time),
      eod_report_time=COALESCE(?,eod_report_time),
      timezone=COALESCE(?,timezone),
      cash_reconciliation_tolerance_paise=COALESCE(?,cash_reconciliation_tolerance_paise),
      booking_lock_hours=COALESCE(?,booking_lock_hours),
      property_code=COALESCE(?,property_code),
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    name || null, address || null, city || null, state || null, pincode || null,
    whatsapp_number || null,
    cleaning_timeout_minutes !== undefined ? cleaning_timeout_minutes : null,
    refund_approval_threshold_paise !== undefined ? refund_approval_threshold_paise : null,
    daily_summary_time || null, eod_report_time || null, timezone || null,
    cash_reconciliation_tolerance_paise !== undefined ? cash_reconciliation_tolerance_paise : null,
    booking_lock_hours !== undefined ? booking_lock_hours : null,
    property_code || null,
    propertyId
  );

  writeAudit({
    propertyId, userId: req.user.id, action: 'PROPERTY_SETTINGS_UPDATED',
    entityType: 'properties', entityId: propertyId,
    snapshot: { updated_fields: req.body },
    ip: req.ip,
  });

  // Letterhead fields (added by migration; may be absent on very old databases)
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('properties')").all().map(c => c.name));
  const clip = (v, n) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, n));
  for (const [col, val] of [['contact_phone', clip(contact_phone, 20)], ['contact_email', clip(contact_email, 120)],
    ['gstin', clip(gstin, 15) === undefined ? undefined : clip(gstin, 15).toUpperCase()]]) {
    if (val !== undefined && cols.has(col)) db.prepare(`UPDATE properties SET ${col} = ? WHERE id = ?`).run(val || null, propertyId);
  }

  return res.json(db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId));
}

/** GET /api/v1/properties/profile — letterhead for reports (any signed-in user). */
function getPropertyProfile(req, res) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.user.property_id);
  if (!p) return res.status(404).json({ error: 'Property not found' });
  const acc = p.account_id ? db.prepare('SELECT business_name FROM accounts WHERE id = ?').get(p.account_id) : null;
  return res.json({
    business_name: acc ? acc.business_name : p.name, property_name: p.name,
    address: p.address || '', city: p.city || '', state: p.state || '', pincode: p.pincode || '',
    phone: p.contact_phone || p.whatsapp_number || '', email: p.contact_email || '', gstin: p.gstin || '',
  });
}

function reportRange(q) {
  const from = q.from ? String(q.from) : istMonthStart();
  const to   = q.to   ? String(q.to)   : istDate();
  if (!isValidDate(from) || !isValidDate(to)) return { error: 'from/to must be YYYY-MM-DD' };
  if (from > to) return { error: 'from must be on or before to' };
  return { from, to };
}

function reportSummary(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const range = reportRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { from, to } = range;

  // Money received by category (IST days). Deposits are shown separately — they are
  // a liability, not revenue.
  const revenue = db.prepare(`
    SELECT COALESCE(category,'rent') AS type, COALESCE(SUM(amount_paise),0) AS total_paise
    FROM ledger_entries WHERE property_id=? AND kind='PAYMENT' AND biz_date BETWEEN ? AND ?
    GROUP BY COALESCE(category,'rent') HAVING total_paise <> 0
  `).all(propertyId, from, to);

  const expenses = db.prepare(`
    SELECT category, COALESCE(SUM(amount_paise),0) AS total_paise
    FROM ledger_entries WHERE property_id=? AND kind='EXPENSE' AND ref_date BETWEEN ? AND ?
    GROUP BY category HAVING total_paise <> 0
  `).all(propertyId, from, to);

  const other = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='DEPOSIT_IN' THEN amount_paise END),0) AS deposits_in,
      COALESCE(SUM(CASE WHEN kind='DEPOSIT_REFUND' THEN amount_paise END),0) AS deposits_out,
      COALESCE(SUM(CASE WHEN kind='CHARGE' THEN amount_paise END),0) AS billed,
      COALESCE(SUM(CASE WHEN kind='WAIVER' THEN amount_paise END),0) AS discounts
    FROM ledger_entries WHERE property_id=? AND biz_date BETWEEN ? AND ?`).get(propertyId, from, to);

  const totalRevenue  = revenue.reduce((s, r) => s + r.total_paise, 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.total_paise, 0);

  const payments = db.prepare(`
    SELECT pl.*, r.full_name as resident_name
    FROM payment_ledger pl JOIN residents r ON r.id=pl.resident_id
    WHERE pl.property_id=? AND direction='credit' AND ${sqlIstDate('pl.paid_at')} BETWEEN ? AND ?
    ORDER BY pl.paid_at DESC
  `).all(propertyId, from, to);

  return res.json({
    from, to,
    total_revenue_paise:  totalRevenue,
    total_expenses_paise: totalExpenses,
    net_paise:            totalRevenue - totalExpenses,
    revenue_by_type:      revenue,
    expenses_by_category: expenses,
    deposits_received_paise: other.deposits_in,
    deposits_refunded_paise: other.deposits_out,
    billed_paise:            other.billed,
    discounts_paise:         other.discounts,
    payments,
  });
}

async function reportExport(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const range = reportRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { from, to } = range;
  const format = req.query.format || 'xlsx';

  const payments = db.prepare(`
    SELECT pl.paid_at, pl.type, pl.direction, pl.amount_paise, pl.payment_mode,
           pl.billing_month, pl.approval_status, pl.notes,
           r.full_name as resident_name, r.mobile as resident_mobile,
           b.bed_label, rm.room_number, f.label as floor_label
    FROM payment_ledger pl
    JOIN residents r ON r.id = pl.resident_id
    LEFT JOIN beds b  ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE pl.property_id=? AND ${sqlIstDate('pl.paid_at')} BETWEEN ? AND ?
    ORDER BY pl.paid_at DESC
  `).all(propertyId, from, to);

  const expenses = db.prepare(`
    SELECT expense_date, category, description, amount_paise, payment_mode
    FROM expenses WHERE property_id=? AND expense_date BETWEEN ? AND ?
    ORDER BY expense_date DESC
  `).all(propertyId, from, to);

  const filename = `dormbook-report-${from}-to-${to}`;

  if (format === 'csv') {
    const header = 'Date,Resident,Room/Bed,Type,Direction,Amount (₹),Mode,Billing Month,Notes\n';
    const rows = payments.map(p =>
      [istDate(p.paid_at), p.resident_name, `${p.room_number||''} ${p.bed_label||''}`.trim(),
       p.type, p.direction, (p.amount_paise/100).toFixed(2), p.payment_mode, p.billing_month||'', p.notes||'']
      .map(v => `"${String(v).replace(/"/g,'""')}"`)
      .join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(header + rows);
  }

  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'DormBook';
    const ws = wb.addWorksheet('Payments');
    ws.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Resident', key: 'resident', width: 22 },
      { header: 'Bed', key: 'bed', width: 14 },
      { header: 'Type', key: 'type', width: 14 },
      { header: 'Direction', key: 'direction', width: 10 },
      { header: 'Amount (₹)', key: 'amount', width: 14 },
      { header: 'Mode', key: 'mode', width: 12 },
      { header: 'Billing Month', key: 'billing_month', width: 14 },
      { header: 'Approval', key: 'approval', width: 14 },
      { header: 'Notes', key: 'notes', width: 30 },
    ];
    payments.forEach(p => ws.addRow({
      date: istDate(p.paid_at), resident: p.resident_name,
      bed: `${p.room_number||''} ${p.bed_label||''}`.trim(),
      type: p.type, direction: p.direction, amount: p.amount_paise / 100,
      mode: p.payment_mode, billing_month: p.billing_month || '',
      approval: p.approval_status, notes: p.notes || '',
    }));

    const ws2 = wb.addWorksheet('Expenses');
    ws2.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Description', key: 'description', width: 30 },
      { header: 'Amount (₹)', key: 'amount', width: 14 },
      { header: 'Mode', key: 'mode', width: 12 },
    ];
    expenses.forEach(e => ws2.addRow({
      date: e.expense_date, category: e.category,
      description: e.description || '', amount: e.amount_paise / 100, mode: e.payment_mode,
    }));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    const buf = await wb.xlsx.writeBuffer();
    return res.send(buf);
  }

  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    const doc = new PDFKit({ margin: 40 });
    doc.pipe(res);
    doc.fontSize(16).text('DormBook — Financial Report', { align: 'center' });
    doc.fontSize(10).text(`Period: ${from} to ${to}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('Payments', { underline: true });
    doc.moveDown(0.5);
    payments.forEach(p => {
      doc.fontSize(9).text(
        `${istDate(p.paid_at)} | ${p.resident_name} | ${p.type} | ${p.direction} | ₹${(p.amount_paise/100).toFixed(2)} | ${p.payment_mode}`
      );
    });
    doc.moveDown();
    doc.fontSize(12).text('Expenses', { underline: true });
    doc.moveDown(0.5);
    expenses.forEach(e => {
      doc.fontSize(9).text(
        `${e.expense_date} | ${e.category} | ₹${(e.amount_paise/100).toFixed(2)} | ${e.description || ''}`
      );
    });
    // Revenue excludes deposits (a liability) and checkout extra charges (recovered from the deposit).
    const totalRev = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries
      WHERE property_id=? AND kind='PAYMENT' AND biz_date BETWEEN ? AND ?`).get(propertyId, from, to).t;
    const totalExp = expenses.reduce((s, e) => s + e.amount_paise, 0);
    doc.moveDown().fontSize(12).text(`Total Revenue: ₹${(totalRev/100).toFixed(2)}`);
    doc.text(`Total Expenses: ₹${(totalExp/100).toFixed(2)}`);
    doc.text(`Net: ₹${((totalRev - totalExp)/100).toFixed(2)}`);
    doc.end();
    return;
  }

  return res.status(400).json({ error: 'format must be csv, xlsx, or pdf' });
}

function getAuditLog(req, res) {
  const db = getDb();
  const { from, to, actor, entity_type } = req.query;
  let q = `
    SELECT al.*, u.name as actor_name
    FROM audit_log al JOIN users u ON u.id = al.actor_id
    WHERE al.property_id = ?
  `;
  const params = [req.user.property_id];
  if (from)        { q += ` AND ${sqlIstDate('al.created_at')} >= ?`; params.push(from); }
  if (to)          { q += ` AND ${sqlIstDate('al.created_at')} <= ?`; params.push(to); }
  if (actor)       { q += ' AND al.actor_id = ?';          params.push(actor); }
  if (entity_type) { q += ' AND al.entity_type = ?';       params.push(entity_type); }
  q += ' ORDER BY al.created_at DESC LIMIT 1000';
  return res.json(db.prepare(q).all(...params));
}

module.exports = {
  getDashboard, listExpenses, addExpense, updateExpense, deleteExpense,
  getPropertySettings, updatePropertySettings, getPropertyProfile,
  reportSummary, reportExport, getAuditLog,
};
