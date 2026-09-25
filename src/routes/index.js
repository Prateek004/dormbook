'use strict';

const express = require('express');
const router  = express.Router();

const { authenticate, requireRole, requireSuperAdmin, sameProperty, assertOwnsResource } = require('../middleware/auth');

const auth       = require('../controllers/authController');
const admin      = require('../controllers/adminController');
const beds       = require('../controllers/bedsController');
const checkin    = require('../controllers/checkinController');
const payments   = require('../controllers/paymentsController');
const finance    = require('../controllers/financeController');
const staff      = require('../controllers/staffController');
const bookings   = require('../controllers/bookingsController');
const reconcile  = require('../controllers/reconciliationController');
const addons     = require('../controllers/addonsController');
const feedback   = require('../controllers/feedbackController');
const receipts   = require('../controllers/receiptsController');
const daily      = require('../controllers/dailyReportsController');
const docs       = require('../controllers/documentsController');
const registers  = require('../controllers/registersController');
const summary    = require('../controllers/summaryController');
const access     = require('../controllers/accessController');
const account    = require('../controllers/accountController');
const share      = require('../controllers/shareController');
const { can }    = require('../middleware/permissions');
const { safeEqual } = require('../util/security');

// Async handlers: send any error to the error handler instead of leaving the request hanging.
const aw = (fn) => (req, res, next) => { try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); } };

// ── Auth ──────────────────────────────────────────────────
router.post('/auth/login',           auth.login);
router.post('/auth/register',        auth.register);
router.post('/auth/forgot-password', aw(auth.forgotPassword));
router.post('/auth/reset-password',  auth.resetPassword);
router.get ('/auth/me',              authenticate, auth.me);
router.post('/auth/change-password', authenticate, auth.changePassword);
// Staff: mobile + login code → set MPIN; change MPIN
router.post('/auth/staff/request-code', aw(access.requestCode));
router.post('/auth/staff/set-mpin',     access.setMpin);
router.post('/auth/change-mpin',        authenticate, access.changeMpin);

// ── Super-admin ───────────────────────────────────────────
router.get  ('/admin/stats',                  authenticate, requireSuperAdmin, admin.adminStats);
router.get  ('/admin/accounts',               authenticate, requireSuperAdmin, admin.listAccounts);
router.get  ('/admin/accounts/:id',           authenticate, requireSuperAdmin, admin.getAccount);
router.patch('/admin/accounts/:id/suspend',   authenticate, requireSuperAdmin, admin.suspendAccount);
router.patch('/admin/accounts/:id/activate',  authenticate, requireSuperAdmin, admin.activateAccount);
router.post ('/admin/accounts/:id/reset-password', authenticate, requireSuperAdmin, admin.resetOwnerPassword);

// ── Dashboard ─────────────────────────────────────────────
router.get('/dashboard/summary', authenticate, sameProperty, finance.getDashboard);

// ── Property Setup (floors, rooms) ────────────────────────
router.get  ('/floors',          authenticate, sameProperty, beds.listFloors);
router.post ('/floors',          authenticate, sameProperty, can('beds_setup'), beds.addFloor);
router.post ('/floors/:id/bunkers', authenticate, sameProperty, can('beds_setup'), beds.addBunkers);
router.delete('/floors/:id',     authenticate, sameProperty, can('beds_setup'), beds.removeFloor);
router.post ('/rooms/:id/beds',  authenticate, sameProperty, can('beds_setup'), beds.addBedToRoom);
router.delete('/rooms/:id',      authenticate, sameProperty, can('beds_setup'), beds.removeRoom);
router.delete('/beds/:id',       authenticate, sameProperty, can('beds_setup'), beds.removeBed);
router.post ('/rooms',           authenticate, sameProperty, can('beds_setup'), beds.addRoom);

// ── Beds ──────────────────────────────────────────────────
router.get  ('/beds',            authenticate, sameProperty, beds.listBeds);
router.post ('/beds',            authenticate, sameProperty, can('beds_setup'), beds.createBed);
router.get  ('/beds/:id',        authenticate, sameProperty, beds.getBed);
router.patch('/beds/:id/status', authenticate, sameProperty, requireRole('reception'), beds.updateBedStatus);
router.patch('/beds/:id/rate',   authenticate, sameProperty, can('beds_setup'), beds.updateBedRate);
router.patch('/beds/names',     authenticate, sameProperty, can('beds_setup'), beds.renameNames);
router.patch('/beds/bulk-rate',  authenticate, sameProperty, can('beds_setup'), beds.bulkUpdateBedRate);

// ── Residents ─────────────────────────────────────────────
router.post('/residents',                        authenticate, sameProperty, can('checkin'), checkin.checkIn);
router.get ('/residents',                        authenticate, sameProperty, checkin.listResidents);
router.get ('/residents/:id',                    authenticate, sameProperty, assertOwnsResource('residents'), checkin.getResident);
router.get ('/residents/:id/checkout-preview',   authenticate, sameProperty, can('checkout'), assertOwnsResource('residents'), checkin.checkoutPreview);
router.post('/residents/:id/checkout',           authenticate, sameProperty, can('checkout'), assertOwnsResource('residents'), checkin.checkOut);
router.post('/residents/:id/checkout/approve',   authenticate, sameProperty, can('approvals'), assertOwnsResource('residents'), checkin.approveCheckout);
router.post('/residents/:id/extend',             authenticate, sameProperty, can('residents_edit'), assertOwnsResource('residents'), checkin.extendStay);
router.patch('/residents/:id/rent',              authenticate, sameProperty, can('residents_edit'), assertOwnsResource('residents'), checkin.updateResidentRent);

// ── Resident ID documents ─────────────────────────────────
router.post  ('/residents/:id/documents',        authenticate, sameProperty, can('checkin', 'view_id_docs'), assertOwnsResource('residents'), docs.uploadDocument);
router.get   ('/residents/:id/documents',        authenticate, sameProperty, assertOwnsResource('residents'), docs.listDocuments);
router.get   ('/residents/:id/documents/:docId', authenticate, sameProperty, can('view_id_docs'), assertOwnsResource('residents'), docs.getDocument);
router.delete('/residents/:id/documents/:docId', authenticate, sameProperty, can('view_id_docs'), assertOwnsResource('residents'), docs.deleteDocument);

// ── Resident ledger & refund ──────────────────────────────
router.get ('/residents/:id/ledger',             authenticate, sameProperty, assertOwnsResource('residents'), payments.getResidentLedger);
router.post('/residents/:id/refund-deductions',  authenticate, sameProperty, can('checkout'), assertOwnsResource('residents'), payments.addRefundDeduction);
router.get ('/residents/:id/refund-summary',     authenticate, sameProperty, assertOwnsResource('residents'), payments.getRefundSummary);
router.get ('/residents/:id/addons',             authenticate, sameProperty, addons.getResidentAddons);
router.post('/residents/:id/addons',             authenticate, sameProperty, can('addons'), addons.addAddonCharge);

// ── Payments ──────────────────────────────────────────────
router.post('/payments',                   authenticate, sameProperty, can('payments'), payments.recordPayment);
router.get ('/payments/pending-approvals', authenticate, sameProperty, can('approvals'), payments.pendingApprovals);
router.post('/payments/:id/approve',       authenticate, sameProperty, can('approvals'), assertOwnsResource('payment_ledger'), payments.approvePayment);

// ── Finance ───────────────────────────────────────────────
router.get   ('/expenses',           authenticate, sameProperty, can('expenses', 'reports_finance'), finance.listExpenses);
router.post  ('/expenses',           authenticate, sameProperty, can('expenses'), finance.addExpense);
router.patch ('/expenses/:id',       authenticate, sameProperty, can('expenses'), finance.updateExpense);
router.delete('/expenses/:id',       authenticate, sameProperty, can('expenses'), finance.deleteExpense);
router.get   ('/reports/summary',    authenticate, sameProperty, can('reports_finance'), finance.reportSummary);
router.get   ('/reports/registers',  authenticate, sameProperty, registers.listRegisters);
router.get   ('/reports/registers/:type', authenticate, sameProperty, registers.getRegister);
router.get   ('/reports/monthly',    authenticate, sameProperty, can('reports_finance'), summary.monthly);
router.get   ('/reports/export',     authenticate, sameProperty, can('reports_finance'), finance.reportExport);
router.get   ('/audit',              authenticate, sameProperty, can('audit'), finance.getAuditLog);

// ── My Account: how guests pay (UPI QR + bank) ───────────
router.get  ('/account/payment', authenticate, sameProperty, can('settings'), account.getPayment);
router.patch('/account/payment', authenticate, sameProperty, can('settings'), account.updatePayment);

// ── Property Settings ─────────────────────────────────────
router.get  ('/properties/profile',  authenticate, sameProperty, finance.getPropertyProfile);
router.get  ('/properties/settings', authenticate, sameProperty, can('settings'), finance.getPropertySettings);
router.patch('/properties/settings', authenticate, sameProperty, can('settings'), finance.updatePropertySettings);

// ── Staff ─────────────────────────────────────────────────
router.get   ('/staff',    authenticate, sameProperty, can('staff'), staff.listStaff);
router.post  ('/staff',    authenticate, sameProperty, can('staff'), aw(staff.inviteStaff));
router.post  ('/staff/:id/login-code', authenticate, sameProperty, can('staff'), aw(access.ownerLoginCode));
router.patch ('/staff/:id',authenticate, sameProperty, can('staff'), staff.updateStaff);
router.delete('/staff/:id',authenticate, sameProperty, can('staff'), staff.deactivateStaff);

// ── Bookings ──────────────────────────────────────────────
router.post('/bookings',                 authenticate, sameProperty, can('bookings'), bookings.createBooking);
router.get ('/bookings',                 authenticate, sameProperty, can('bookings', 'reports_daily'), bookings.listBookings);
router.post('/bookings/:id/confirm',     authenticate, sameProperty, can('bookings'), bookings.confirmBooking);
router.post('/bookings/:id/cancel',      authenticate, sameProperty, can('bookings'), bookings.cancelBooking);
router.post('/bookings/release-expired', authenticate, sameProperty, can('bookings'), bookings.releaseExpired);

// ── Cash Reconciliation ──────────────────────────────────
router.post  ('/reconciliation/cash',             authenticate, sameProperty, can('cash_close'), reconcile.closeCashDrawer);
router.get   ('/reconciliation/cash',             authenticate, sameProperty, can('cash_close', 'reports_daily'), reconcile.listReconciliations);
router.patch ('/reconciliation/cash/:id/explain', authenticate, sameProperty, can('approvals'), reconcile.explainDiscrepancy);

router.get   ('/reconciliation/cash/preview',     authenticate, sameProperty, can('cash_close'), reconcile.previewCashDrawer);

// ── Daily operations reports (money from the ledger) ─────
router.get ('/dashboard/today',         authenticate, sameProperty, daily.today);
router.get ('/reports/daily/snapshot',  authenticate, sameProperty, can('reports_daily'), daily.snapshot);
router.get ('/reports/daily/bed-map',   authenticate, sameProperty, can('reports_daily'), daily.bedMap);
router.get ('/reports/daily/movements', authenticate, sameProperty, can('reports_daily'), daily.movements);
router.get ('/reports/daily/cash-book', authenticate, sameProperty, can('cash_close', 'reports_daily'), daily.cashBook);
router.get ('/reports/daily/dues',      authenticate, sameProperty, can('reports_finance'), daily.dues);
router.get ('/residents/:id/bill',      authenticate, sameProperty, can('payments', 'reports_finance', 'checkout'), assertOwnsResource('residents'), summary.guestBill);
router.post('/residents/:id/bill-link', authenticate, sameProperty, can('payments', 'reports_finance', 'checkout'), assertOwnsResource('residents'), share.createBillLink);
router.get ('/residents/:id/statement', authenticate, sameProperty, can('payments', 'reports_finance'), assertOwnsResource('residents'), daily.residentStatement);
router.post('/residents/:id/discount',  authenticate, sameProperty, can('discounts'), assertOwnsResource('residents'), daily.addWaiver);
router.post('/ledger/entries/:id/reverse', authenticate, sameProperty, requireRole('owner'),  daily.reverseEntry);
router.get ('/ledger/integrity',        authenticate, sameProperty, requireRole('owner'),     daily.integrity);

// ── Add-on Catalog ────────────────────────────────────────
router.get   ('/addons/catalog',     authenticate, sameProperty, addons.getCatalog);
router.post  ('/addons/catalog',     authenticate, sameProperty, can('settings'), addons.createCatalogItem);
router.post  ('/addons/catalog/samples', authenticate, sameProperty, can('settings'), addons.addSampleItems);
router.patch ('/addons/catalog/:id', authenticate, sameProperty, can('settings'), addons.updateCatalogItem);

// ── Feedback ──────────────────────────────────────────────
router.post('/feedback/rate',         verifyWebhookSecret, feedback.rateFeedback);
router.get ('/feedback',              authenticate, sameProperty, can('reports_daily', 'approvals'), feedback.listFeedback);
router.patch('/feedback/:id/resolve', authenticate, sameProperty, can('approvals'), feedback.resolveFeedback);

// ── Receipts ──────────────────────────────────────────────
router.get ('/receipts/:receipt_number',         authenticate, sameProperty, receipts.getReceipt);
router.post('/receipts/:receipt_number/resend',  authenticate, sameProperty, can('payments'), receipts.resendReceipt);
router.get ('/receipts/:receipt_number/pdf',     authenticate, sameProperty, receipts.downloadReceiptPdf);

// ── Cron endpoints ────────────────────────────────────────
router.post('/cron/release-expired-bookings', verifyCronSecret, bookings.releaseExpired);

// ── Guards ────────────────────────────────────────────────
function verifyCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[SECURITY] CRON_SECRET not set — cron endpoint is disabled until configured');
    }
    return res.status(401).json({ error: 'Cron endpoint requires CRON_SECRET to be configured' });
  }
  if (!safeEqual(req.headers['x-cron-secret'], secret)) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }
  next();
}

function verifyWebhookSecret(req, res, next) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[SECURITY] WEBHOOK_SECRET not set — webhook endpoint is disabled until configured');
    }
    return res.status(401).json({ error: 'Webhook endpoint requires WEBHOOK_SECRET to be configured' });
  }
  if (!safeEqual(req.headers['x-webhook-secret'], secret)) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  next();
}

router.get('/health', (req, res) => res.json({ status: 'ok', version: '4.0.0', timestamp: new Date().toISOString() }));

module.exports = router;
