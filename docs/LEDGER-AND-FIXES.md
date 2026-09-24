# Money ledger, daily reports and production fixes (Sep 2026)

## Before you deploy (Railway), in this order

1. **Attach a volume at `/data`** (Service → Settings → Volumes). Without one, every deploy or restart deletes the database.
2. **Point the service at this repo.** Today it deploys from `Prateek004/try`, not `dorm1`.
3. **Set these variables:**
   - `JWT_SECRET`: a long random string
   - `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD`
   - `APP_TZ=Asia/Kolkata` (optional, this is the default)
4. **Change the superadmin password.** The old seed script printed it in the logs.
5. Deploy, then open **Daily Reports** and call `GET /api/v1/ledger/integrity` as the owner. It should return `{ "ok": true }`.

On first boot the app copies existing payments, deposits, refunds, expenses and add-ons into the ledger. It also bills rent from each resident's check-in date. This runs **once**; it is recorded in `ledger_meta` and safe on every later boot.

## What changed

### Crashes fixed
- **7 missing tables restored** in `schema.sql`, along with the indexes: bookings, cash close, add-ons, receipts, refund deductions and feedback. On a fresh database these all returned a 500 error.
- **Signup works on older databases.** The old schema had extra `NOT NULL` columns, handled in `util/dbcompat.js`. Admin suspend works on older databases too (`suspension_reason` column added).
- **Timestamp comparisons fixed.** Comparing ISO and SQLite timestamp formats as text gave wrong answers:
  - OTPs stayed valid all day instead of 10 minutes.
  - Beds left "cleaning" after about 30 minutes instead of 2 hours.
  - Booking holds expired up to a day late.
  - All of these now compare with `julianday()`.
- **SQLite driver upgraded** to better-sqlite3 12, which ships a prebuilt binary for Node 22. The `nixpacks.toml` rebuild step, which could silently delete the working binary, is removed.

### Money is now correct
- **`ledger_entries` is the one money record.** Every payment, deposit, refund, charge, discount and expense is written there in the same transaction as `payment_ledger` or `expenses`.
- **Rows can't be changed.** Database triggers block edits and deletes; mistakes are fixed with a reversal.
- **Rent is actually billed** for each rent cycle: daily, weekly, or monthly on the resident's rent-due day, with part-periods charged pro-rata.
  - A daily job at 00:05 IST bills new cycles; it also runs at boot and at check-in.
  - Checkout bills rent up to the checkout date and no further.
  - Previously, dues were guessed as "monthly rent × every calendar month".
- **Deposits are not revenue.** The dashboard, reports and PDF export now exclude them.
- **Checkout extra charges are recovered from the deposit.** They no longer count as cash received.
- **Cash close counts cash expenses.** Pending and rejected refunds are ignored.
- **Cash close locks the day.** Anything recorded after a close goes to the next open day. Closing a day also covers any earlier days that were never closed.
- **Approving a refund from the Payments page now completes the checkout.** Before, the resident stayed active and the bed stayed occupied.
- **A refund can't exceed the deposit held.**
- **A resident who has left can still pay their dues.**
- **Add-ons billed to the next bill now show up in dues.** Before, they were recorded nowhere.
- **Duplicate payments are blocked:** a retried request, a repeated gateway transaction ID, or the same payment within 60 seconds (staff can confirm a genuine repeat).
- **Amounts like `"12abc"` are rejected** instead of being read as 12.
- **All "today" and "this month" figures use India time.** A 2 AM payment no longer lands on yesterday.
- **Scheduled jobs run on India time.** The end-of-day report now goes out at 22:00 IST, not 03:30.

### Security
- **The seed script no longer prints the password.**
- **User-entered text is escaped** in the web app. A resident named `<img onerror=…>` used to run as code in the owner's browser.
- **Offline writes are no longer silently queued.** The queue lived in service-worker memory and could lose, or double-post, payments. Staff now see a clear "not saved — you're offline" message.

### New
- **Daily Reports page:** Today, Dues (with ageing buckets), Cash Book, Bed Map, and Check-ins/outs.
- **Resident statement** with a running balance, plus a **Give Discount** button (a reason is required).
- **Cash close** shows opening, cash in, cash out and expected cash before counting.
- **Endpoints:**
  - `/reports/daily/*`
  - `/residents/:id/statement`
  - `/residents/:id/discount`
  - `/ledger/entries/:id/reverse`
  - `/ledger/integrity`
  - `/reconciliation/cash/preview`

## Rules to keep when changing code
- **Never write money anywhere without also posting it through `src/services/ledger.js`,** in the same `db.transaction`.
- **Never `UPDATE` or `DELETE` a `ledger_entries` row.** Use `ledger.reverse` or `ledger.reverseSource`.
- **Use `util/time.js` (`istDate`, `istMonth`, `sqlIstDate`) for dates,** never `toISOString().substring(0,10)`.
- **Run `npm test` before every deploy.** The suite boots the real server on a fresh database and on an old-schema database.

## Known limits
- **A booking's advance deposit isn't in the ledger yet** (there is no resident at that point). Keep booking advances out of the cash drawer, or record them as a deposit at check-in.
- **Changing a resident's rate applies from their next unbilled cycle.** To fix a cycle that's already been billed, reverse that rent charge; it is re-billed at the new rate.
- **The PDF export's default font can't draw ₹.**
