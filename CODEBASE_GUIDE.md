# Sthappit / DormBook — Complete Codebase Guide
**For Software Engineers: Every file, every fix, every decision explained.**

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [File-by-File Reference](#3-file-by-file-reference)
4. [Database Schema & Indexes](#4-database-schema--indexes)
5. [API Route Map](#5-api-route-map)
6. [Role & Permission System](#6-role--permission-system)
7. [Security Model](#7-security-model)
8. [All Issues Found & Fixed](#8-all-issues-found--fixed)
9. [Environment Variables](#9-environment-variables)
10. [Local Setup & Deployment](#10-local-setup--deployment)
11. [Known Limitations & Roadmap](#11-known-limitations--roadmap)

---

## 1. Project Overview

**Sthappit** is a Node.js + Express REST API with a vanilla-JS SPA frontend for managing PG (Paying Guest) accommodations — hostels, dormitories, shared housing.

**Tech Stack**

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 18 |
| Framework | Express 4 |
| Database | SQLite via `better-sqlite3` (synchronous, embedded) |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` |
| Frontend | Plain HTML / CSS / JS — no build step |
| Deployment | Vercel Serverless (primary) + VPS/PM2 (supported) |
| Notifications | Twilio WhatsApp (optional — degrades to console logging) |

**What it manages**
- Property → Floor → Room → Bed hierarchy
- Resident check-in / check-out lifecycle
- Payment ledger (rent, deposit, advance, refunds, extras)
- Expense tracking by category
- Staff accounts with role-based access (owner / manager / reception)
- Finance P&L reports + CSV/Excel export
- Tamper-evident audit trail for every write operation
- Async WhatsApp notification queue with Vercel Cron support

---

## 2. Architecture

### Directory Layout

```
sthappit/
├── api/
│   └── index.js              ← Vercel serverless entry point (sets DB_PATH, exports app)
├── public/
│   ├── index.html            ← SPA shell (single HTML file, no framework)
│   ├── css/app.css           ← All styles
│   └── js/app.js             ← All frontend logic (fetch + DOM, no build step)
├── src/
│   ├── server.js             ← Express app config + middleware stack
│   ├── routes/
│   │   └── index.js          ← Every route definition (method + path → controller)
│   ├── controllers/
│   │   ├── authController.js     ← Login, me, change-password
│   │   ├── bedsController.js     ← Bed map, available beds, add bed, update status
│   │   ├── checkinController.js  ← Check-in, check-out, list/get residents, extend stay
│   │   ├── financeController.js  ← Dashboard, P&L report, export, expenses, audit log
│   │   ├── paymentsController.js ← Create payment, ledger, pending dues, refund approval
│   │   └── staffController.js    ← List/add/update/deactivate staff
│   ├── middleware/
│   │   ├── auth.js           ← authenticate, requireRole, assertOwnsResource (IDOR guard), sameProperty
│   │   └── auditLog.js       ← writeAudit() direct call + auditMiddleware() factory
│   ├── db/
│   │   ├── connection.js     ← Singleton DB getter with WAL + FK pragmas
│   │   ├── init.js           ← Creates data/ dir + runs schema.sql
│   │   ├── schema.sql        ← All 11 table definitions + indexes
│   │   └── seed.js           ← Demo data seeder (dev only)
│   └── services/
│       ├── scheduler.js          ← setInterval cron (VPS) + /api/cron trigger (Vercel)
│       └── whatsappService.js    ← Queue writer + Twilio sender
├── .env.example              ← All 13 env vars documented
├── .gitignore
├── package.json
├── vercel.json               ← Builds, routes, Vercel Cron config
└── bundle_project.py         ← Zips project for GitHub push
```

### Request Flow

```
Browser Request
    │
    ▼
Express (server.js)
    ├── helmet()              Security headers (CSP, HSTS, X-Frame-Options…)
    ├── cors()                Origin whitelist from CORS_ORIGIN env var
    ├── loginLimiter          10 req/15min per IP — /api/auth/login only
    ├── rateLimit()           200 req/15min per IP — all /api/* routes
    ├── express.json()        Body parser, 2 MB limit
    ├── morgan()              HTTP logger (combined in prod, dev locally)
    ├── express.static()      Serves public/ (HTML, CSS, JS)
    │
    └── /api/* → routes/index.js
            │
            ├── authenticate()           Verify JWT, re-fetch user from DB
            ├── sameProperty()           Attach req.property_id = req.user.property_id
            ├── requireRole(minRole)     Check role weight (owner>manager>reception)
            ├── assertOwnsResource()     IDOR guard: verify UUID belongs to this property
            ├── auditMiddleware()        Intercepts res.json to log successful writes
            │
            └── controller(req, res, next)
                    │
                    ├── Input validation (format, range, required fields)
                    ├── better-sqlite3 (synchronous queries — no callback/promise)
                    ├── DB transaction (for multi-table writes like check-in)
                    ├── scheduleWhatsApp() (non-blocking queue insert)
                    └── res.json(result)
```

---

## 3. File-by-File Reference

---

### `api/index.js` — Vercel Serverless Entry Point

**What it does:**
Sets `process.env.DB_PATH = '/tmp/sthappit.db'` *before* any other module loads, then imports and re-exports the Express app. Vercel invokes this file for every request.

**Why `/tmp`:** Vercel's filesystem is read-only except for `/tmp`. The DB is rebuilt from scratch on every cold start — see [Known Limitations](#11-known-limitations--roadmap).

**Critical:** This file does NOT call `app.listen()`. The listen guard in `server.js` (`require.main === module`) is `false` when imported here, so no port is opened.

---

### `src/server.js` — Express Application Setup

**What it does:** Configures the full middleware stack, mounts routes, and exports the app. If run directly (`node src/server.js`), also starts the HTTP server and background scheduler.

**Middleware order (matters):**
1. `app.set('trust proxy', 1)` — Without this, `req.ip` returns the load-balancer IP on Vercel, making rate limiting ineffective
2. `helmet({ contentSecurityPolicy: {...} })` — Security headers; `unsafe-inline` is needed for the inline `onclick=` handlers in the SPA frontend
3. `cors()` — Reads `CORS_ORIGIN` env var; defaults to `*` in dev
4. `loginLimiter` — Strict 10-req/15min per IP on `/api/auth/login` only
5. `rateLimit()` — 200-req/15min per IP on all `/api/*` routes
6. `express.json({ limit: '2mb' })` + `express.urlencoded()`
7. `morgan()` — `combined` format in production (includes IP, user-agent for logs)
8. `express.static('public')` — Serves the SPA
9. `/api` router — Main API
10. `*` catch-all — Returns `index.html` for any non-API path (SPA client routing)
11. Global error handler — Returns `500 { error: 'Internal server error' }` in prod (hides stack traces)

**Production guard:** On startup, checks `JWT_SECRET` length. Calls `process.exit(1)` if it's missing or under 32 characters in `NODE_ENV=production`.

**Graceful shutdown:** `SIGTERM` and `SIGINT` handlers stop the scheduler, close the DB connection, then exit cleanly. Required for PM2 / Docker deployments.

---

### `src/routes/index.js` — Route Registry

**What it does:** Every HTTP route is defined here. No business logic — purely maps `[METHOD, path, ...middleware, controller]`.

**Middleware applied per route:**

| Middleware | Applied to |
|-----------|-----------|
| `authenticate` | All protected routes |
| `sameProperty` | All protected routes — attaches `req.property_id` |
| `requireRole('manager')` | Finance, expenses, approvals, extend stay |
| `requireRole('owner')` | Add/update/deactivate staff |
| `assertOwnsResource(table, param)` | All routes with `:id`, `:residentId`, `:paymentId`, `:bedId`, `:userId` |
| `auditMiddleware(action, entity)` | All write operations (POST/PUT/DELETE) |

**New route added: `GET /api/cron`**
Secured with `x-cron-secret` header. Called by Vercel Cron Jobs every 5 minutes to flush the WhatsApp send queue. Without this, WhatsApp notifications never send on Vercel (serverless has no `setInterval`).

---

### `src/middleware/auth.js` — Authentication & Authorization

**Exports:**

**`authenticate(req, res, next)`**
Reads `Authorization: Bearer <token>`, verifies JWT signature, then re-fetches the user from DB on every request. This catches deactivated accounts mid-session — if a manager deactivates a staff member, their next request fails even if their token hasn't expired. Attaches `req.user = { id, property_id, name, role }`.

**`requireRole(minRole)`**
Returns middleware. Role weights: `owner=3`, `manager=2`, `reception=1`. Passing `'manager'` allows both manager and owner. Passing `'owner'` allows only owner.

**`sameProperty(req, res, next)`**
Attaches `req.property_id = req.user.property_id`. Also blocks if `property_id` is explicitly passed in the URL/body and doesn't match the logged-in user's property. Note: most routes don't include `property_id` in the URL, so this primarily serves as the `req.property_id` setter.

**`assertOwnsResource(table, paramName = 'id')` ← NEW**
IDOR (Insecure Direct Object Reference) guard. Looks up `SELECT property_id FROM <table> WHERE id = ?` using the URL param, then compares against `req.user.property_id`. Returns 404 if not found, 403 if different property. This prevents a logged-in user at Property A from accessing resident/payment/bed data at Property B by guessing or brute-forcing UUIDs. Applied to all 8 routes that take a resource ID in the URL.

**`stripFinancialFields(user, data)`**
Removes monetary fields from response objects for `reception`-role users.

**`maskAadhaar()`**
Always returns `'XXXX XXXX XXXX'`. Called before any resident data leaves a controller.

---

### `src/middleware/auditLog.js` — Audit Trail

**Two usage patterns:**

**1. Direct call inside controller** (for precise control):
```js
writeAudit({ propertyId, userId, userRole, action, entityType, entityId, before, after, ip })
```
Used in: `checkIn`, `checkOut`, `updateBedStatus`, `approveRefund`

**2. Route middleware factory** (automatic):
```js
auditMiddleware('PAYMENT_CREATED', 'payment')
```
Wraps `res.json()` to intercept the successful response, extracts the entity ID from the response body, writes the log. Applied in routes where the ID comes from the response.

**Actions logged:** `CHECKIN`, `CHECKOUT`, `STAY_EXTENDED`, `BED_STATUS_CHANGED`, `PAYMENT_CREATED`, `REFUND_DECISION`, `EXPENSE_CREATED`, `STAFF_ADDED`, `STAFF_UPDATED`, `STAFF_DEACTIVATED`

---

### `src/controllers/authController.js` — Authentication

**`login`**
- Normalises email to lowercase
- Looks up user by email — always runs `bcrypt.compareSync` even if user not found (timing-safe, prevents email enumeration)
- Issues JWT signed with `JWT_SECRET`, expiry from `JWT_EXPIRES_IN` (default `8h`)
- Returns token + sanitised user object (no `password_hash`)

**`changePassword`**
- Requires `current_password` (verifies against stored hash)
- Enforces 8-character minimum on `new_password`
- bcrypt-hashes new password with `BCRYPT_ROUNDS` (default `12`)

**`me`**
Returns own user record — no `password_hash` field.

---

### `src/controllers/bedsController.js` — Bed Management

**`getBedMap`**
Returns full `floor → room → bed` hierarchy with occupancy counts per room. Auto-reverts `cleaning` beds to `available` if elapsed time exceeds `CLEANING_AUTO_REVERT_MINUTES` (default `120`). This runs on every `GET /api/beds` call — no separate cron needed.

**`getAvailableBeds`**
Returns only `available` beds with human-readable display labels like `"Floor 1 – Room 101 – Bed A"`. Used by the check-in form dropdown.

**`addBed`**
Creates the room if it doesn't exist yet (upsert-style). Validates the floor belongs to the same property. Prevents duplicate bed labels within a room.

**`updateBedStatus`**
Allows: `available`, `reserved`, `cleaning`. Blocks: setting to `occupied` directly (must go through check-in), and changing an already-`occupied` bed (must go through check-out).

---

### `src/controllers/checkinController.js` — Resident Lifecycle

**`checkIn`** — Most complex function. Validates:
- Required fields present
- Mobile: 10–12 digits after stripping non-numeric characters
- `rent_amount` is a non-negative number
- `check_in_date` and `expected_checkout` are `YYYY-MM-DD`
- `expected_checkout > check_in_date` (logical ordering)
- `id_consent_given === true` (PDPA/consent gate)
- Bed is `available` and belongs to this property

Then runs a single **SQLite transaction**:
1. `INSERT INTO residents`
2. If `deposit_amount > 0` → `INSERT INTO payments` (type=deposit)
3. If `amount_paid > 0` → `INSERT INTO payments` (type=rent)
4. `UPDATE beds SET status='occupied'`
5. Write audit log
6. Queue WhatsApp confirmation (non-blocking, outside transaction)

**`checkOut`** — Validates:
- `checkout_date` is `YYYY-MM-DD`
- Resident is currently `active`

Runs transaction:
1. `UPDATE residents SET status='checked_out'`
2. If `extra_charges > 0` → `INSERT INTO payments` (type=extra_charge)
3. If `deposit_refund_amount > 0` → `INSERT INTO payments` (type=refund, `approval_status='pending'`)
4. `UPDATE beds SET status='cleaning'`
5. Write audit log
6. Queue WhatsApp checkout message

**`listResidents`**
Filterable by `status` (active/checked_out/all) and `search` (name or mobile). Search string trimmed and capped at 100 chars. Returns payment badge (`paid`/`partial`/`pending`) computed from current month payments vs rent amount. All Aadhaar fields always masked.

**`extendStay`**
Updates `expected_checkout` and optionally `rent_amount`. Writes to `stay_extensions` table for history.

---

### `src/controllers/paymentsController.js` — Payment Ledger

**`createPayment`**
- Validates `billing_month` is `YYYY-MM` format
- Validates `payment_type` is one of: `rent`, `deposit`, `advance`, `extra_charge`
- Validates `amount > 0`
- Inserts payment, queues WhatsApp receipt

**`getResidentLedger`**
Returns all payments for a resident plus computed totals: total credited, total debited, net paid, outstanding dues.

**`getPendingDues`**
Lists all active residents with payment status `pending` or `partial` for the current month. Returns per-resident breakdown and total outstanding amount.

**`getPendingApprovals`**
Lists all payments with `payment_type='refund'` and `approval_status='pending'`. These require manager sign-off before money is disbursed.

**`approveRefund`**
Sets `approval_status` to `approved` or `rejected`. Only works on refund-type payments that are still pending. Logs the decision to audit trail.

---

### `src/controllers/financeController.js` — Finance & Reports

**`getDashboard`**
Single round-trip: bed occupancy stats, today's activity (check-ins, check-outs, collections), current month P&L, pending dues count, pending refund approvals count.

**`getReport`**
Supports `period`: `daily`, `weekly`, `monthly`, `yearly`, `custom`. For `custom`, validates `start_date` and `end_date` as `YYYY-MM-DD`. Returns income breakdown by payment type, refunds, expenses by category, net profit, and a daily timeseries array for charting.

**`createExpense`**
Validates `expense_date` is `YYYY-MM-DD`, `amount` is a positive non-NaN number.

**`exportReport`** ← CSV injection fixed
Async function, fully wrapped in `try/catch → next(err)`. All string values run through `sanitizeCsv()` which prefixes cells starting with `=`, `+`, `-`, `@` with a tab — preventing formula execution when opened in Excel. Supports `format=csv` and `format=excel` (ExcelJS, two worksheets).

**`getAuditLog`**
Paginated. Integers validated and clamped: `limit` 1–500 (default 100), `offset` ≥0 (default 0). Joins with `users` to show `user_name`.

---

### `src/controllers/staffController.js` — Staff Management

**`listStaff`** — Returns all users for the property (no `password_hash`).

**`addStaff`**
- Role must be `manager` or `reception` — creating `owner` via API is explicitly blocked
- Password minimum 8 characters
- Email format validated if provided
- Bcrypt-hashes password before storing

**`updateStaff`**
- Cannot change your own role (prevents self-lock-out)
- Cannot modify another `owner`'s account

**`deactivateStaff`**
- Cannot deactivate yourself
- Sets `is_active=0` (soft delete — all records preserved for audit)

---

### `src/db/connection.js` — Database Singleton

**What it does:** Returns the same `better-sqlite3` Database instance every time (singleton pattern). Sets pragmas on first open:

| Pragma | Value | Why |
|--------|-------|-----|
| `foreign_keys` | `ON` | Enforce referential integrity |
| `journal_mode` | `WAL` | Write-Ahead Log — allows concurrent reads during writes |
| `synchronous` | `NORMAL` | Safe with WAL, ~30% faster than `FULL` |
| `cache_size` | `-16000` | 16 MB page cache (negative = kilobytes) |
| `wal_autocheckpoint` | `1000` | Checkpoint WAL every 1000 pages (prevents WAL bloat) |

**Why synchronous:** `better-sqlite3` calls are synchronous — no `await`, no callbacks. This is intentional and correct for SQLite. Node.js's event loop is not blocked in practice because SQLite queries complete in microseconds.

---

### `src/db/init.js` — Schema Runner

Creates the `data/` directory if it doesn't exist, opens the DB at `DB_PATH`, executes `schema.sql`. Can be run standalone: `node src/db/init.js`.

**`DB_PATH` resolution:** `process.env.DB_PATH` → `./data/sthappit.db`

---

### `src/db/schema.sql` — Table Definitions

**11 tables:** `properties`, `users`, `floors`, `rooms`, `beds`, `residents`, `payments`, `expenses`, `stay_extensions`, `audit_logs`, `notification_log`

All primary keys are UUIDs (`TEXT`). No auto-increment integers — UUIDs prevent ID guessing.

**Indexes created:**
- `beds(property_id)`, `beds(status)`
- `residents(property_id)`, `residents(status)`, `residents(bed_id, status)` ← new
- `payments(resident_id)`, `payments(property_id, paid_at)`, `payments(approval_status, payment_type)` ← new
- `audit_logs(property_id, created_at)`
- `expenses(property_id, expense_date)`
- `notification_log(status, scheduled_at)` ← new (needed by sendPending query)

---

### `src/db/seed.js` — Demo Data Seeder

Populates a fresh DB with one demo property, 3 users, 3 floors, 9 rooms, 18 beds, 8 residents (mix of active and checked-out), and sample payments/expenses. Skips if data already exists. **Dev only.**

**⚠️ Warning printed on run:** `[SEED] DEMO credentials — CHANGE ALL PASSWORDS before going live!`

---

### `src/services/whatsappService.js` — Notification Queue

**Two modes:**
- **With Twilio creds** (`TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` set): sends real WhatsApp messages
- **Without creds**: logs message body to `console.log` and marks as `delivered` — dev/test friendly

**`scheduleWhatsApp(opts)`** — Synchronous. Inserts one row into `notification_log` with `status='pending'`. Never throws (errors logged). Called from controllers; completes in ~1ms.

**`sendPending()`** — Async. Reads up to 50 `pending` rows ordered by `scheduled_at`, sends each via Twilio, updates `status` to `delivered` or `failed`. Called by scheduler every 5 minutes.

**`sendDailySummary(propertyId)`** — Builds P&L summary from DB, queues to all `owner`-role users.

**`sendOverdueReminders(propertyId)`** — Finds active residents where current month rent is unpaid, queues reminder messages.

---

### `src/services/scheduler.js` — Background Cron

**On VPS/PM2:** `startScheduler()` runs `setInterval` loops — flush queue every 5 min, check for 21:00 IST daily tasks every 5 min.

**On Vercel:** Serverless functions have no persistent `setInterval`. Instead, `vercel.json` defines a Vercel Cron Job that hits `GET /api/cron` every 5 minutes, which calls `runNow()`.

`stopScheduler()` is called on `SIGTERM`/`SIGINT` for clean shutdown.

---

### `public/index.html` — SPA Shell

Single HTML file. Login form is shown first; all other views are hidden `<div>`s shown/hidden by JS. Demo credential hint removed for production.

### `public/css/app.css` — Styles

All styles in one file. No external CSS dependencies.

### `public/js/app.js` — Frontend Application

Complete SPA logic in a single IIFE (`const App = (() => { ... })()`). Handles all views, makes `fetch()` calls to `/api/*`, stores JWT in `sessionStorage` (cleared when tab closes — safer than `localStorage`). API base is `const API = '/api'` — relative, works on any deployment URL.

---

### `vercel.json` — Vercel Config

```json
{
  "version": 2,
  "builds": [{ "src": "api/index.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "/api/index.js" }],
  "env": { "NODE_ENV": "production" },
  "functions": { "api/index.js": { "maxDuration": 30, "memory": 512 } },
  "crons": [{ "path": "/api/cron", "schedule": "*/5 * * * *" }]
}
```

All traffic (including static assets) goes through Express, which serves `public/` via `express.static`. The `crons` section fires `GET /api/cron` every 5 minutes to flush WhatsApp notifications.

### `package.json` — Scripts & Dependencies

**Scripts:**

| Script | Command | Use |
|--------|---------|-----|
| `start` | `node src/server.js` | Production (VPS) |
| `dev` | `nodemon src/server.js` | Local development |
| `db:init` | `node src/db/init.js` | Create DB + run schema |
| `db:seed` | `node src/db/seed.js` | Load demo data |
| `vercel-build` | `npm install && echo ...` | Regenerates lock file on Vercel |

**Dependencies (12):** `bcryptjs`, `better-sqlite3`, `cors`, `dotenv`, `exceljs`, `express`, `express-rate-limit`, `helmet`, `jsonwebtoken`, `morgan`, `twilio`, `uuid`

**DevDependencies (1):** `nodemon`

---

## 4. Database Schema & Indexes

### Entity Relationships

```
properties ──< floors ──< rooms ──< beds
properties ──< users           (staff)
properties ──< residents       (guests)
properties ──< payments
properties ──< expenses
properties ──< audit_logs
properties ──< notification_log
residents  ──< payments
residents  ──< stay_extensions
beds       ──< residents       (one bed, many residents over time)
```

### Payment Flow

```
CHECK-IN
  deposit_amount > 0 → payments(type=deposit,    direction=credit, approval=not_required)
  amount_paid    > 0 → payments(type=rent,        direction=credit, approval=not_required)
  beds.status        → occupied

MONTHLY RENT
  POST /api/payments → payments(type=rent, direction=credit, approval=not_required)

CHECK-OUT
  extra_charges > 0          → payments(type=extra_charge, direction=credit)
  deposit_refund_amount > 0  → payments(type=refund,       direction=debit, approval=PENDING)
  beds.status                → cleaning → (auto-reverts to available after N minutes)

REFUND APPROVAL
  POST /payments/:id/approve → payments(approval_status = approved | rejected)
```

### Key Constraints

| Table | Column | CHECK |
|-------|--------|-------|
| beds | status | `available \| occupied \| reserved \| cleaning` |
| residents | status | `active \| checked_out \| reserved` |
| payments | direction | `credit \| debit` |
| payments | payment_mode | `cash \| upi \| card \| bank_transfer` |
| payments | approval_status | `not_required \| pending \| approved \| rejected` |
| users | role | `owner \| manager \| reception` |
| rooms | room_type | `shared \| private \| dormitory` |

---

## 5. API Route Map

Base URL: `https://your-domain.vercel.app/api`
All protected routes require: `Authorization: Bearer <jwt>`

### Auth
```
POST  /auth/login            { email, password }           → { token, user }
GET   /auth/me               (auth)                        → user object
POST  /auth/change-password  (auth) { current_password, new_password }
```

### Dashboard
```
GET   /dashboard             (auth)                        → summary stats
```

### Beds
```
GET   /beds                  (auth)                        → floor/room/bed hierarchy
GET   /beds/available        (auth)                        → [ available beds for dropdown ]
POST  /beds                  (manager) { floor_id, room_number, bed_label, room_type? }
PUT   /beds/:bedId/status    (reception) { status }
```

### Residents
```
GET   /residents             (auth) ?status=active|checked_out|all&search=
GET   /residents/:id         (auth)                        → resident + payment history
POST  /checkin               (auth) { full_name, mobile, bed_id, check_in_date,
                                      expected_checkout, rent_amount, deposit_amount,
                                      amount_paid, payment_mode, id_consent_given }
POST  /checkout/:residentId  (auth) { checkout_date, extra_charges?, deposit_refund_amount?,
                                      payment_mode?, notes? }
POST  /residents/:id/extend  (manager) { new_expected_checkout, new_rent_amount? }
```

### Payments
```
POST  /payments                       (auth)    { resident_id, amount, payment_type,
                                                  payment_mode, billing_month:YYYY-MM }
GET   /payments/resident/:residentId  (auth)    → ledger + totals
GET   /payments/pending               (manager) → residents with unpaid dues
GET   /payments/pending-approvals     (manager) → refunds awaiting approval
POST  /payments/:paymentId/approve    (manager) { decision: approved|rejected, notes? }
```

### Finance
```
GET   /finance/report         (manager) ?period=monthly&start_date=&end_date=
GET   /finance/export         (manager) ?format=csv|excel&period=...
GET   /finance/audit          (manager) ?limit=100&offset=0
POST  /expenses               (manager) { category, amount, expense_date, description?, payment_mode? }
GET   /expenses               (manager) ?start_date=&end_date=
```

### Staff
```
GET    /staff             (manager) → [ staff list ]
POST   /staff             (owner)   { name, mobile, password, role: manager|reception, email? }
PUT    /staff/:userId     (owner)   { name?, mobile?, role?, is_active? }
DELETE /staff/:userId     (owner)   → deactivates account
```

### System
```
GET   /health             (public) → { status: 'ok' }
GET   /cron               (secret header: x-cron-secret) → runs WhatsApp queue flush
```

---

## 6. Role & Permission System

| Feature | reception | manager | owner |
|---------|-----------|---------|-------|
| Login / change own password | ✅ | ✅ | ✅ |
| View dashboard | ✅ | ✅ | ✅ |
| View / update beds | ✅ | ✅ | ✅ |
| Add new bed | ❌ | ✅ | ✅ |
| List / view residents | ✅ | ✅ | ✅ |
| Check-in / check-out | ✅ | ✅ | ✅ |
| Extend stay / change rent | ❌ | ✅ | ✅ |
| Record payment | ✅ | ✅ | ✅ |
| View payment ledger | ✅ | ✅ | ✅ |
| View pending dues | ❌ | ✅ | ✅ |
| Approve / reject refund | ❌ | ✅ | ✅ |
| Finance reports + export | ❌ | ✅ | ✅ |
| Audit log | ❌ | ✅ | ✅ |
| Expenses | ❌ | ✅ | ✅ |
| List staff | ❌ | ✅ | ✅ |
| Add / update / deactivate staff | ❌ | ❌ | ✅ |

**Financial data restriction:** `reception` users get `[restricted]` instead of monetary values where `stripFinancialFields()` is applied.

---

## 7. Security Model

### Authentication
- JWT, HS256, signed with `JWT_SECRET` (must be ≥32 chars in production)
- Token expiry: `JWT_EXPIRES_IN` (default `8h`)
- User re-fetched from DB on every request — deactivated accounts rejected immediately
- Login is timing-safe: runs `bcrypt.compare` even for unknown emails (prevents email enumeration)

### Authorisation Layers (defence in depth)
1. **`authenticate`** — Valid JWT required
2. **`requireRole`** — Minimum role level
3. **`sameProperty`** — Attaches property scope
4. **`assertOwnsResource`** — UUID lookup validates resource belongs to user's property (IDOR guard)
5. **Controller-level** — All SQL queries include `WHERE property_id = req.user.property_id`

### Rate Limiting
- All `/api/*`: 200 requests / 15 min / IP
- `/api/auth/login`: 10 requests / 15 min / IP (strict brute-force protection)

### Input Validation (added)
- Mobile: 10–12 digits
- Dates: `YYYY-MM-DD` regex + logical ordering checks
- Billing month: `YYYY-MM`
- Amounts: `> 0`, non-NaN
- Search: trimmed, max 100 chars
- Pagination: integers validated, limit clamped to 500
- Email: RFC-style regex
- Roles: whitelist enforced (no `owner` creatable via API)

### Data Privacy
- Aadhaar numbers never stored — always saved as `[Aadhaar Redacted]`
- `id_consent_given` gate required before check-in
- `password_hash` never returned in any API response

### Export Security
- CSV injection prevention: `sanitizeCsv()` prefixes formula-starting characters with tab
- Excel export uses ExcelJS (proper XLSX format, not CSV renamed)

### Other
- Helmet sets CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- `unsafe-inline` in CSP is a known tradeoff — required by the SPA's `onclick=` attributes
- CORS locked to `CORS_ORIGIN` env var in production
- `/api/cron` protected by `CRON_SECRET` header

---

## 8. All Issues Found & Fixed

### Round 1 (Initial Audit)

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | 🔴 Critical | `twilio` not in `package.json` — `npm ci` fails | Added `"twilio": "^5.3.3"` |
| 2 | 🔴 Critical | `package-lock.json` out of sync with new twilio dep | `vercel-build` runs `npm install` to regenerate |
| 3 | 🔴 Critical | `JWT_SECRET` silent fallback in production | Now throws `Error` + `process.exit(1)` at startup |
| 4 | 🟠 Medium | `trust proxy` not set — rate limiting broken on Vercel | Added `app.set('trust proxy', 1)` |
| 5 | 🟠 Medium | Demo credentials visible in `public/index.html` | Removed — comment only |
| 6 | 🟠 Medium | `seed.js` logs credentials with no dev-only warning | Added `console.warn('[SEED] DEMO credentials...')` |
| 7 | 🟠 Medium | `exportReport` async errors uncaught | Wrapped in `try/catch → next(err)` |
| 8 | 🟠 Medium | `sql.js` + `@databases/sqlite` never used (dead deps) | Removed from `package.json` |
| 9 | 🟡 Low | `CLEANING_AUTO_REVERT_MINUTES` undocumented | Added to `.env.example` |
| 10 | 🟡 Low | `JWT_EXPIRES_IN`, `BCRYPT_ROUNDS` undocumented | Added to `.env.example` |
| 11 | 🟡 Low | Pagination integers not validated in `getAuditLog` | Validated, clamped 1–500 |
| 12 | 🟡 Low | Search string uncapped in `listResidents` | Trimmed, capped at 100 chars |
| 13 | 🟡 Low | No mobile validation on check-in | 10–12 digit validation added |
| 14 | 🟡 Low | No date format/ordering validation on check-in | `YYYY-MM-DD` + `checkout > checkin` check |
| 15 | 🟡 Low | No date validation on checkout, expenses, report params | `YYYY-MM-DD` validation added per endpoint |
| 16 | 🟡 Low | No `billing_month` format validation | `YYYY-MM` validation added |
| 17 | 🟡 Low | No email validation in `addStaff` | RFC-style regex added |
| 18 | 🟡 Low | `!data/.gitkeep` missing from `.gitignore` | Added negation exception |
| 19 | 🟡 Low | `README.md` referenced demo passwords | Removed, updated install note |

### Round 2 (Deep Audit)

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| A | 🔴 Critical | Login timing attack — email enumeration via response time | Dummy hash always compared; `if (!user \|\| !valid)` combined |
| B | 🟠 Medium | CSV injection — formula cells execute in Excel | `sanitizeCsv()` prefixes `= + - @` cells with tab |
| C | 🟠 Medium | `json2csv` + `multer` in `package.json` but never used | Removed (saves ~2.5 MB install) |
| D | 🟠 Medium | No `/api/cron` route — WhatsApp never fires on Vercel | Added `GET /api/cron` with secret header auth |
| E | 🟠 Medium | `vercel.json` missing `crons` section | Added `"*/5 * * * *"` schedule |
| F | 🟡 Low | `CRON_SECRET` undocumented | Added to `.env.example` |
| G | 🟠 Medium | No IDOR protection on resource ID routes | `assertOwnsResource()` middleware added |
| H | 🟠 Medium | `assertOwnsResource` not wired to any route | Applied to all 8 routes with `:id` params |
| I | 🟠 Medium | Login only rate-limited by global 200/15min limiter | Dedicated `loginLimiter` (10/15min) added |
| J | 🟡 Low | No password length check in `addStaff` | 8-character minimum enforced |
| K | 🟡 Low | `role` not explicitly whitelisted in `addStaff` | `ALLOWED_ROLES = ['manager','reception']` check |
| L | 🟡 Low | SQLite missing performance pragmas | `synchronous=NORMAL`, `cache_size=-16000`, `wal_autocheckpoint=1000` |
| M | 🟡 Low | Missing indexes on `notification_log`, `residents(bed_id)`, `payments(approval_status)` | 3 indexes added to `schema.sql` |
| N | 🟡 Low | No graceful shutdown on SIGTERM/SIGINT | Handlers close DB + stop scheduler before exit |
| O | 🟡 Low | `stopScheduler` not imported in `server.js` | Import added |
| P | 🟡 Low | `nodemon` used in `npm run dev` but not in `devDependencies` | Added `"nodemon": "^3.1.0"` |

---

## 9. Environment Variables

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `NODE_ENV` | Yes | `development` | Set `production` on Vercel |
| `PORT` | No | `3000` | Local only — Vercel assigns port automatically |
| `DB_PATH` | No | `./data/sthappit.db` | Auto-overridden to `/tmp/sthappit.db` on Vercel |
| `JWT_SECRET` | **YES (prod)** | *(throws if missing)* | ≥32 chars. Generate: `openssl rand -base64 48` |
| `JWT_EXPIRES_IN` | No | `8h` | Token lifetime |
| `BCRYPT_ROUNDS` | No | `12` | Hash rounds. 10–14 is practical range |
| `CORS_ORIGIN` | No | `*` | Your Vercel deployment URL |
| `RATE_LIMIT_WINDOW_MS` | No | `900000` | 15 minutes in ms |
| `RATE_LIMIT_MAX_REQUESTS` | No | `200` | Requests per window per IP |
| `CLEANING_AUTO_REVERT_MINUTES` | No | `120` | Auto-revert cleaning→available. `0` = disabled |
| `CRON_SECRET` | Recommended | *(no auth if unset)* | Header value for `/api/cron`. `openssl rand -base64 32` |
| `TWILIO_ACCOUNT_SID` | No | *(console-only mode)* | `ACxxxxxxxx...` from Twilio console |
| `TWILIO_AUTH_TOKEN` | No | *(console-only mode)* | Twilio auth token |
| `TWILIO_WHATSAPP_FROM` | No | `whatsapp:+14155238886` | Twilio sandbox or approved number |

---

## 10. Local Setup & Deployment

### Local Development

```bash
# 1. Clone
git clone https://github.com/your-org/sthappit.git && cd sthappit

# 2. Install deps (also regenerates package-lock.json with twilio)
npm install

# 3. Configure
cp .env.example .env
# Edit .env — generate JWT_SECRET:
#   openssl rand -base64 48

# 4. Initialise DB
npm run db:init

# 5. Load demo data (optional)
npm run db:seed

# 6. Start
npm run dev      # nodemon with auto-reload
# or
npm start        # plain node
```

### Vercel Deployment

```bash
# Deploy
npm i -g vercel
vercel

# Set env vars in Vercel Dashboard → Project → Settings → Environment Variables
# Required: JWT_SECRET
# Recommended: CORS_ORIGIN, CRON_SECRET, TWILIO_*

# Redeploy
vercel --prod
```

**Vercel notes:**
- The Cron Job (`*/5 * * * *` → `/api/cron`) requires a **paid Vercel plan** (Pro or above) for custom schedules. On the free plan, remove the `crons` block and WhatsApp notifications won't send automatically.
- SQLite at `/tmp` is ephemeral. For persistent data, migrate to [Turso](https://turso.tech) (libSQL, drop-in compatible with `better-sqlite3` API via `@libsql/client`).

### VPS / PM2 Deployment

```bash
# pm2 ecosystem file (ecosystem.config.js):
module.exports = {
  apps: [{
    name: 'sthappit',
    script: 'src/server.js',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
      DB_PATH: '/var/data/sthappit.db',
      JWT_SECRET: 'your-strong-secret-here'
    }
  }]
};

pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

The scheduler runs natively on VPS — no cron config needed.

---

## 11. Known Limitations & Roadmap

| Limitation | Impact | Recommended Solution |
|------------|--------|---------------------|
| SQLite on Vercel is ephemeral | Data lost on cold start | Migrate to [Turso](https://turso.tech) (libSQL) — API-compatible |
| No Vercel Cron on free plan | WhatsApp queue never flushes | Upgrade to Vercel Pro, or use external cron (cron-job.org) hitting `/api/cron` |
| Single property per deployment | Can't serve multiple owners | Add property selection screen; data isolation already built in via `property_id` |
| No file uploads implemented | `photo_path`, `aadhaar_photo_path` are stored as strings only | Add Multer + Cloudflare R2 or AWS S3 |
| Aadhaar stored as placeholder | Full KYC compliance not met | Encrypt with AES-256-GCM, store cipher, decrypt only for authorised roles |
| No email notifications | WhatsApp only | Add Resend or Nodemailer for email fallback |
| No JWT refresh tokens | Users re-login every 8h | Implement `refresh_tokens` table |
| `unsafe-inline` in CSP | XSS protections weakened | Refactor SPA to use `addEventListener` instead of `onclick=`; enables nonce-based CSP |
| No test suite | Regressions possible | Add Jest + Supertest; DB can be in-memory (`':memory:'`) for tests |
| Frontend is vanilla JS | Harder to scale UI | Consider React/Vue when feature count grows |
| CSV comma-escaping edge cases | Fields with commas may wrap oddly | Use `json2csv` (already removed — re-add) or always quote all fields |
