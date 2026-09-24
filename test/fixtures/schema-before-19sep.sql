-- ============================================================
-- DormBook — SQLite Schema v4.0 (SaaS)
-- All monetary values in PAISE (integer). UTC timestamps.
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Accounts (one per PG business, SaaS tenant) ───────────
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  business_name   TEXT NOT NULL,
  owner_name      TEXT NOT NULL,
  owner_mobile    TEXT NOT NULL UNIQUE,
  owner_email     TEXT UNIQUE,
  plan            TEXT NOT NULL DEFAULT 'trial'
                    CHECK (plan IN ('trial','active','suspended')),
  trial_ends_at   TEXT NOT NULL,
  suspended_at    TEXT,
  suspend_reason  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Properties ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id                               TEXT PRIMARY KEY,
  account_id                       TEXT NOT NULL,
  name                             TEXT NOT NULL,
  address                          TEXT NOT NULL DEFAULT '',
  city                             TEXT NOT NULL DEFAULT '',
  state                            TEXT NOT NULL DEFAULT '',
  pincode                          TEXT,
  owner_id                         TEXT NOT NULL,
  whatsapp_number                  TEXT,
  cleaning_timeout_minutes         INTEGER NOT NULL DEFAULT 120,
  refund_approval_threshold_paise  INTEGER NOT NULL DEFAULT 0,
  daily_summary_time               TEXT    NOT NULL DEFAULT '22:00',
  eod_report_time                  TEXT    NOT NULL DEFAULT '22:00',
  timezone                         TEXT    NOT NULL DEFAULT 'Asia/Kolkata',
  cash_reconciliation_tolerance_paise INTEGER NOT NULL DEFAULT 0,
  booking_lock_hours               INTEGER NOT NULL DEFAULT 24,
  property_code                    TEXT    NOT NULL DEFAULT 'PROP',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- ── Users ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  account_id    TEXT,
  property_id   TEXT,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  mobile        TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'reception'
                  CHECK (role IN ('superadmin', 'owner', 'manager', 'reception')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id)  REFERENCES accounts(id),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- ── OTP Store (password reset via WhatsApp) ───────────────
CREATE TABLE IF NOT EXISTS otp_store (
  id          TEXT PRIMARY KEY,
  mobile      TEXT NOT NULL,
  otp_hash    TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Property hierarchy ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS floors (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL,
  floor_number INTEGER NOT NULL,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  floor_id    TEXT NOT NULL,
  property_id TEXT NOT NULL,
  room_number TEXT NOT NULL,
  room_type   TEXT NOT NULL DEFAULT 'shared'
                CHECK (room_type IN ('shared', 'private', 'dormitory')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (floor_id)    REFERENCES floors(id),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

CREATE TABLE IF NOT EXISTS beds (
  id                  TEXT PRIMARY KEY,
  room_id             TEXT NOT NULL,
  property_id         TEXT NOT NULL,
  bed_label           TEXT NOT NULL,
  base_rate_paise     INTEGER NOT NULL DEFAULT 0,
  daily_rate_paise    INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','occupied','reserved','cleaning','pending')),
  cleaning_started_at TEXT,
  booking_request_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (room_id)     REFERENCES rooms(id),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- ── Residents ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS residents (
  id                       TEXT PRIMARY KEY,
  property_id              TEXT NOT NULL,
  bed_id                   TEXT,
  full_name                TEXT NOT NULL,
  mobile                   TEXT NOT NULL,
  aadhaar_number_encrypted TEXT,
  aadhaar_last4            TEXT,
  aadhaar_mobile           TEXT,
  aadhaar_photo_path       TEXT,
  aadhaar_consent          INTEGER NOT NULL DEFAULT 0,
  aadhaar_consent_at       TEXT,
  coming_from              TEXT,
  permanent_address        TEXT,
  purpose_of_visit         TEXT,
  emergency_contact_name   TEXT,
  emergency_contact_mobile TEXT,
  photo_path               TEXT,
  check_in_date            TEXT,
  expected_checkout        TEXT,
  actual_checkout          TEXT,
  rent_due_day             INTEGER NOT NULL DEFAULT 1,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','checked_out')),
  monthly_rent_paise       INTEGER NOT NULL DEFAULT 0,
  rate_type                TEXT    NOT NULL DEFAULT 'monthly'
                             CHECK (rate_type IN ('daily','weekly','monthly')),
  rate_paise               INTEGER NOT NULL DEFAULT 0,
  deposit_paise            INTEGER NOT NULL DEFAULT 0,
  notes                    TEXT,
  checkin_by               TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (bed_id)      REFERENCES beds(id),
  FOREIGN KEY (checkin_by)  REFERENCES users(id)
);

-- ── Payment Ledger ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_ledger (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL,
  resident_id     TEXT NOT NULL,
  billing_month   TEXT,
  amount_paise    INTEGER NOT NULL,
  direction       TEXT NOT NULL DEFAULT 'credit'
                    CHECK (direction IN ('credit','debit')),
  type            TEXT NOT NULL
                    CHECK (type IN ('rent','deposit','deposit_refund','extra_charge','advance')),
  payment_mode    TEXT NOT NULL DEFAULT 'cash'
                    CHECK (payment_mode IN ('cash','upi','card','bank_transfer')),
  gateway_txn_id  TEXT,
  gateway_status  TEXT CHECK (gateway_status IN ('success','pending','failed',NULL)),
  due_date        TEXT,
  paid_at         TEXT NOT NULL DEFAULT (datetime('now')),
  requires_approval  INTEGER NOT NULL DEFAULT 0,
  approved_by        TEXT,
  approved_at        TEXT,
  approval_status    TEXT NOT NULL DEFAULT 'not_required'
                       CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  sync_status     TEXT NOT NULL DEFAULT 'synced'
                    CHECK (sync_status IN ('synced','pending')),
  notes           TEXT,
  recorded_by     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (resident_id) REFERENCES residents(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id)
);

-- ── Expenses ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL,
  category     TEXT NOT NULL,
  description  TEXT,
  amount_paise INTEGER NOT NULL,
  expense_date TEXT NOT NULL,
  payment_mode TEXT NOT NULL DEFAULT 'cash'
                 CHECK (payment_mode IN ('cash','upi','card','bank_transfer')),
  receipt_path TEXT,
  recorded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id)
);

-- ── Stay Extensions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stay_extensions (
  id              TEXT PRIMARY KEY,
  resident_id     TEXT NOT NULL,
  property_id     TEXT NOT NULL,
  old_checkout    TEXT NOT NULL,
  new_checkout    TEXT NOT NULL,
  old_rent_paise  INTEGER,
  new_rent_paise  INTEGER,
  notes           TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (resident_id) REFERENCES residents(id),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (created_by)  REFERENCES users(id)
);

-- ── Audit Log (insert-only) ────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  amount_paise INTEGER,
  snapshot    TEXT,
  ip_address  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (actor_id)    REFERENCES users(id)
);

-- ── Document Access Log (DPDP compliance) ─────────────────
CREATE TABLE IF NOT EXISTS document_access_log (
  id            TEXT PRIMARY KEY,
  resident_id   TEXT NOT NULL,
  accessed_by   TEXT NOT NULL,
  document_type TEXT NOT NULL
                  CHECK (document_type IN ('aadhaar_number','aadhaar_photo')),
  ip_address    TEXT,
  accessed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (resident_id) REFERENCES residents(id),
  FOREIGN KEY (accessed_by) REFERENCES users(id)
);

-- ── Booking Requests ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_requests (
  id                      TEXT PRIMARY KEY,
  property_id             TEXT NOT NULL,
  bed_id                  TEXT NOT NULL,
  prospect_name           TEXT NOT NULL,
  prospect_phone          TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','confirmed','expired','cancelled')),
  advance_deposit_paise   INTEGER NOT NULL DEFAULT 0,
  lock_expires_at         TEXT NOT NULL,
  converted_to_resident_id TEXT,
  created_by              TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (bed_id)      REFERENCES beds(id),
  FOREIGN KEY (created_by)  REFERENCES users(id)
);

-- ── Refund Deductions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS refund_deductions (
  id          TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  logged_by   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (resident_id) REFERENCES residents(id),
  FOREIGN KEY (logged_by)   REFERENCES users(id)
);

-- ── Cash Reconciliations ──────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_reconciliations (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL,
  date                TEXT NOT NULL,
  drawer_amount_paise INTEGER NOT NULL,
  system_amount_paise INTEGER NOT NULL,
  delta_paise         INTEGER NOT NULL,
  is_discrepancy      INTEGER NOT NULL DEFAULT 0,
  owner_note          TEXT,
  submitted_by        TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (submitted_by) REFERENCES users(id)
);

-- ── Add-on Catalog ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS addon_catalog (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL,
  default_price_paise INTEGER NOT NULL DEFAULT 0,
  is_assignable       INTEGER NOT NULL DEFAULT 0,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- ── Add-on Charges ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS addon_charges (
  id                    TEXT PRIMARY KEY,
  resident_id           TEXT NOT NULL,
  property_id           TEXT NOT NULL,
  catalog_item_id       TEXT,
  name                  TEXT NOT NULL,
  amount_paise          INTEGER NOT NULL,
  billing_mode          TEXT NOT NULL DEFAULT 'immediate'
                          CHECK (billing_mode IN ('immediate','monthly_bill')),
  is_custom_entry       INTEGER NOT NULL DEFAULT 0,
  custom_reason         TEXT,
  assigned_item_returned INTEGER,
  billing_month         TEXT,
  recorded_by           TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (resident_id)    REFERENCES residents(id),
  FOREIGN KEY (property_id)    REFERENCES properties(id),
  FOREIGN KEY (catalog_item_id) REFERENCES addon_catalog(id),
  FOREIGN KEY (recorded_by)    REFERENCES users(id)
);

-- ── Receipts ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipts (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL,
  resident_id       TEXT NOT NULL,
  payment_ledger_id TEXT NOT NULL,
  receipt_number    TEXT NOT NULL UNIQUE,
  amount_paise      INTEGER NOT NULL,
  line_items        TEXT NOT NULL DEFAULT '[]',
  wa_delivered      INTEGER NOT NULL DEFAULT 0,
  wa_delivered_at   TEXT,
  pdf_path          TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id)       REFERENCES properties(id),
  FOREIGN KEY (resident_id)       REFERENCES residents(id),
  FOREIGN KEY (payment_ledger_id) REFERENCES payment_ledger(id)
);

-- ── Tenant Feedback ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_feedback (
  id             TEXT PRIMARY KEY,
  resident_id    TEXT NOT NULL,
  property_id    TEXT NOT NULL,
  invoice_id     TEXT NOT NULL,
  rating         TEXT NOT NULL CHECK (rating IN ('good','average','needs_help')),
  is_flagged     INTEGER NOT NULL DEFAULT 0,
  followup_notes TEXT,
  resolved_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (resident_id) REFERENCES residents(id),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  UNIQUE (invoice_id)
);

-- ── WhatsApp Notification Log ─────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL,
  resident_id     TEXT,
  recipient_mobile TEXT NOT NULL,
  recipient_type  TEXT NOT NULL DEFAULT 'tenant',
  event_type      TEXT NOT NULL,
  message_body    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','delivered','failed')),
  provider_msg_id TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- ── Indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_accounts_mobile       ON accounts(owner_mobile);
CREATE INDEX IF NOT EXISTS idx_accounts_plan         ON accounts(plan);
CREATE INDEX IF NOT EXISTS idx_beds_property         ON beds(property_id);
CREATE INDEX IF NOT EXISTS idx_beds_status           ON beds(status);
CREATE INDEX IF NOT EXISTS idx_residents_property    ON residents(property_id);
CREATE INDEX IF NOT EXISTS idx_residents_status      ON residents(status);
CREATE INDEX IF NOT EXISTS idx_residents_bed         ON residents(bed_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_resident       ON payment_ledger(resident_id);
CREATE INDEX IF NOT EXISTS idx_ledger_property_date  ON payment_ledger(property_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_ledger_approval       ON payment_ledger(approval_status, type);
CREATE INDEX IF NOT EXISTS idx_audit_property_date   ON audit_log(property_id, created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_property     ON expenses(property_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_notification_status   ON notification_log(status, created_at);
CREATE INDEX IF NOT EXISTS idx_booking_status        ON booking_requests(status, lock_expires_at);
CREATE INDEX IF NOT EXISTS idx_feedback_property     ON tenant_feedback(property_id, created_at);
CREATE INDEX IF NOT EXISTS idx_receipts_number       ON receipts(receipt_number);
CREATE INDEX IF NOT EXISTS idx_doc_access_resident   ON document_access_log(resident_id);
CREATE INDEX IF NOT EXISTS idx_otp_mobile            ON otp_store(mobile, expires_at);
