'use strict';
// Dormitory setup, ID documents, dashboard tasks, report registers, ledger upgrade.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { boot } = require('./helpers');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();
// 1x1 JPEG
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

test('dormitory setup, ID proof, dashboard and reports', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-f-'));
  const s = await boot({ dbDir, port: 20000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  try {
    let r = await call('POST', '/auth/register', { business_name: 'Sunrise Hostels', owner_name: 'Amit', mobile: '9876500001',
      password: 'Passw0rd!23', pg_name: 'Sunrise Dorm', city: 'Pune' });
    s.setToken(r.body.token);
    r = await call('PATCH', '/properties/settings', { address: '12 MG Road', state: 'Maharashtra', pincode: '411001',
      contact_phone: '9876500001', gstin: '27abcde1234f1z5' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // Ground floor: 6 bunkers x 2 beds -> 0A1, 0A2, 0B1 ... 0F2
    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' });
    const g = r.body.id;
    r = await call('POST', `/floors/${g}/bunkers`, { bunkers: 6, beds_per_bunker: 2, daily_rate_paise: 40000 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.total_beds, 12);
    assert.deepEqual(r.body.created.map((c) => c.bunker), ['0A', '0B', '0C', '0D', '0E', '0F']);
    assert.deepEqual(r.body.created[0].beds, ['0A1', '0A2']);
    r = await call('POST', `/floors/${g}/bunkers`, { bunkers: 1, beds_per_bunker: 2 });
    assert.deepEqual(r.body.created[0].beds, ['0G1', '0G2'], 'adding more continues the letters');
    r = await call('POST', `/floors/${g}/bunkers`, { bunkers: 0 });
    assert.equal(r.status, 400);
    r = await call('POST', '/floors', { floor_number: 1, label: 'First' });
    r = await call('POST', `/floors/${r.body.id}/bunkers`, { bunkers: 2, beds_per_bunker: 3 });
    assert.deepEqual(r.body.created.map((c) => c.beds), [['1A1', '1A2', '1A3'], ['1B1', '1B2', '1B3']]);
    r = await call('GET', '/beds?status=available');
    assert.equal(r.body.length, 20);
    const bed = r.body.find((b) => b.bed_label === '0A1');

    // ID proof: Aadhaar not compulsory, format checked per type
    const base = { full_name: 'Neha', mobile: '9000000011', bed_id: bed.id, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 5), id_consent: true, rate_type: 'daily', rate_paise: 40000 };
    r = await call('POST', '/residents', { ...base });
    assert.equal(r.status, 400, 'ID type required');
    r = await call('POST', '/residents', { ...base, id_type: 'pan', id_number: '12345' });
    assert.equal(r.status, 400); assert.match(r.body.error, /PAN/);
    r = await call('POST', '/residents', { ...base, id_type: 'pan', id_number: 'abcde1234f', id_consent: false });
    assert.equal(r.status, 400, 'consent required');
    r = await call('POST', '/residents', { ...base, id_type: 'pan', id_number: 'abcde1234f' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const neha = r.body.resident.id;
    assert.equal(r.body.resident.id_display, 'PAN Card ••••234F');
    assert.equal(r.body.resident.id_number_encrypted, undefined);

    // Upload ID photo: stored encrypted, readable only with permission
    r = await call('POST', `/residents/${neha}/documents`, { doc_type: 'id_front', data_url: JPEG });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const docId = r.body.id;
    r = await call('POST', `/residents/${neha}/documents`, { doc_type: 'id_front', data_url: 'data:image/png;base64,AAAA' });
    assert.equal(r.status, 400, 'content must match type');
    const stored = fs.readdirSync(path.join(dbDir, 'uploads'), { recursive: true }).find((f) => String(f).endsWith('.enc'));
    const raw = fs.readFileSync(path.join(dbDir, 'uploads', stored));
    assert.notEqual(raw.subarray(0, 2).toString('hex'), 'ffd8', 'file on disk is encrypted');
    const res = await fetch(`http://127.0.0.1:${s.port}/api/v1/residents/${neha}/documents/${docId}`, { headers: { authorization: `Bearer ${s.token()}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString('hex'), 'ffd8');
    r = await call('GET', `/residents/${neha}`);
    assert.equal(r.body.documents.length, 1);

    // Dashboard tasks + every report register renders with the letterhead
    r = await call('GET', '/dashboard/today');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.beds.total, 20);
    assert.equal(r.body.tasks.collect_dues.count, 1);
    r = await call('GET', '/reports/registers');
    const ids = r.body.map((x) => x.id);
    assert.deepEqual(ids.sort(), ['cash', 'collections', 'deposits', 'dues', 'expenses', 'guests', 'occupancy', 'pnl']);
    for (const id of ids) {
      r = await call('GET', `/reports/registers/${id}?from=${addDays(TODAY, -7)}&to=${TODAY}`);
      assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.company.business_name, 'Sunrise Hostels');
      assert.equal(r.body.company.address, '12 MG Road, Pune, Maharashtra, 411001');
      assert.equal(r.body.company.gstin, '27ABCDE1234F1Z5');
      assert.ok(Array.isArray(r.body.columns) && r.body.columns.length >= 2);
    }
    r = await call('GET', `/reports/registers/guests?from=${TODAY}&to=${TODAY}`);
    assert.equal(r.body.rows[0].id_proof, 'PAN Card ••••234F');
    r = await call('GET', `/reports/registers/occupancy?from=${TODAY}&to=${TODAY}`);
    assert.equal(r.body.rows[0].occupied, 1);
    r = await call('GET', '/reports/registers/pnl?from=2026-02-30&to=2026-03-01');
    assert.equal(r.status, 400);
    assert.ok(!/\[ERROR\]|UNCAUGHT/.test(s.logs.join('')), s.logs.join(''));
  } finally {
    s.stop();
  }
});

test('an existing v1 ledger is upgraded in place without losing rows', () => {
  const { setDb } = require('../src/db/connection');
  const L = require('../src/services/ledger');
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  setDb(db);
  // v1 table: same columns, CHECK without CREDIT_REFUND
  const v2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ledger.js'), 'utf8');
  const v1Schema = v2.slice(v2.indexOf('const SCHEMA = `') + 16, v2.indexOf('`;', v2.indexOf('const SCHEMA = `')))
    .replace(",'CREDIT_REFUND'", '').replace(",'CREDIT_REFUND'", '');
  db.exec(v1Schema);
  db.exec(`INSERT INTO ledger_entries (id, property_id, biz_date, ref_date, created_at, kind, category, mode, amount_paise)
           VALUES ('e1','p1','2026-09-01','2026-09-01','x','EXPENSE','food','cash',100)`);
  assert.ok(!db.prepare("SELECT sql FROM sqlite_master WHERE name='ledger_entries'").get().sql.includes('CREDIT_REFUND'));
  L.setupLedger(db);
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name='ledger_entries'").get().sql.includes('CREDIT_REFUND'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n, 1);
  assert.throws(() => db.prepare('DELETE FROM ledger_entries').run(), /LEDGER_IMMUTABLE/, 'protection triggers recreated');
  L.setupLedger(db); // second run is a no-op
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n, 1);
});
