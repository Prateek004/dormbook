'use strict';
// Bed names, items on the bill (tea/coffee), price list, business settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot } = require('./helpers');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();

test('bed names, items on bill, price list and settings', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-i-'));
  const s = await boot({ dbDir, port: 22000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  try {
    let r = await call('POST', '/auth/register', { business_name: 'Old Name', owner_name: 'Amit', mobile: '9876500002',
      password: 'Passw0rd!23', pg_name: 'Sunrise Dorm', city: 'Pune' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken(r.body.token);

    // ── Business settings ──
    r = await call('PATCH', '/properties/settings', { business_name: 'A&P Infotech Solutions Pvt Ltd', address: '12 MG Road', pincode: '411001' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.business_name, 'A&P Infotech Solutions Pvt Ltd');
    r = await call('GET', '/reports/registers/collections');
    assert.equal(r.body.company.business_name, 'A&P Infotech Solutions Pvt Ltd', 'company name shows on reports');
    r = await call('PATCH', '/properties/settings', { address: '' });
    assert.equal(r.body.address, null, 'address can be cleared');
    for (const bad of [{ pincode: '12' }, { business_name: '  ' }, { cleaning_timeout_minutes: -1 }, { booking_lock_hours: 'x' },
      { gstin: 'short' }, { contact_email: 'nope' }]) {
      r = await call('PATCH', '/properties/settings', { ...bad, name: 'Should Not Save' });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    r = await call('GET', '/properties/settings');
    assert.equal(r.body.name, 'Sunrise Dorm', 'nothing saved when a value is wrong');

    // ── Beds: create, then rename to own convention ──
    r = await call('POST', '/floors', { floor_number: 1, label: 'First' });
    const floorId = r.body.id;
    r = await call('POST', `/floors/${floorId}/bunkers`, { bunkers: 2, beds_per_bunker: 2, daily_rate_paise: 40000 });
    assert.equal(r.status, 201);
    r = await call('GET', '/floors');
    const rooms = r.body[0].rooms;
    const beds = rooms.flatMap((rm) => rm.beds);
    assert.deepEqual(beds.map((b) => b.bed_label).sort(), ['1A1', '1A2', '1B1', '1B2']);

    // duplicate name is refused and nothing changes
    r = await call('PATCH', '/beds/names', { beds: [{ id: beds[0].id, label: '101-A' }, { id: beds[1].id, label: '101-a' }] });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    r = await call('PATCH', '/beds/names', { beds: [{ id: beds[0].id, label: '1A2' }] });
    assert.equal(r.status, 409, 'clash with an existing bed name');
    r = await call('PATCH', '/beds/names', { beds: [{ id: beds[0].id, label: '<b>' }] });
    assert.equal(r.status, 400, 'bad characters refused');
    r = await call('PATCH', '/beds/names', { beds: [{ id: 'nope', label: 'X1' }] });
    assert.equal(r.status, 400);

    // swap-style rename in one go works (all checked together)
    r = await call('PATCH', '/beds/names', {
      floors: [{ id: floorId, label: '1st Floor' }],
      rooms: [{ id: rooms[0].id, name: '101' }, { id: rooms[1].id, name: '102' }],
      beds: [{ id: beds[0].id, label: '101-A' }, { id: beds[1].id, label: '101-B' }, { id: beds[2].id, label: '102-A' }, { id: beds[3].id, label: '102-B' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, 7);
    r = await call('GET', '/floors');
    assert.equal(r.body[0].label, '1st Floor');
    assert.deepEqual(r.body[0].rooms.flatMap((rm) => rm.beds.map((b) => b.bed_label)).sort(), ['101-A', '101-B', '102-A', '102-B']);

    // adding more bunkers still works and never clashes with renamed beds
    await call('PATCH', '/beds/names', { beds: [{ id: beds[3].id, label: '1A1' }] });
    r = await call('POST', `/floors/${floorId}/bunkers`, { bunkers: 1, beds_per_bunker: 2 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.notDeepEqual(r.body.created[0].beds, ['1A1', '1A2'], 'skips a bunker whose bed names are taken');
    await call('PATCH', '/beds/names', { beds: [{ id: beds[3].id, label: '102-B' }] });

    // ── Price list ──
    r = await call('POST', '/addons/catalog/samples', {});
    assert.equal(r.status, 201); assert.ok(r.body.added >= 5);
    r = await call('POST', '/addons/catalog/samples', {});
    assert.equal(r.body.added, 0, 'samples are not added twice');
    r = await call('POST', '/addons/catalog', { name: 'tea', category: 'Food & drinks', default_price_paise: 1500 });
    assert.equal(r.status, 409, 'same item twice refused');
    r = await call('POST', '/addons/catalog', { name: 'Juice', default_price_paise: -5 });
    assert.equal(r.status, 400);
    r = await call('GET', '/addons/catalog');
    const tea = r.body.find((c) => c.name === 'Tea');
    const coffee = r.body.find((c) => c.name === 'Coffee');
    r = await call('PATCH', `/addons/catalog/${tea.id}`, { default_price_paise: 1200 });
    assert.equal(r.body.default_price_paise, 1200);

    // ── Items on a guest's bill ──
    r = await call('POST', '/residents', { full_name: 'Ravi', mobile: '9000000021', bed_id: beds[0].id, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 3), id_consent: true, id_type: 'passport', id_number: 'K1234567', rate_type: 'daily', rate_paise: 40000 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ravi = r.body.resident.id;
    r = await call('GET', `/residents/${ravi}`);
    const duesBefore = r.body.balance.dues_paise;

    const key = 'items-' + Date.now();
    const body = { items: [{ catalog_item_id: tea.id, quantity: 2 }, { catalog_item_id: coffee.id, quantity: 1 }, { name: 'Extra blanket', unit_price_paise: 5000, quantity: 1 }],
      billing_mode: 'monthly_bill' };
    r = await call('POST', `/residents/${ravi}/addons`, body, { 'Idempotency-Key': key });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.total_paise, 2 * 1200 + coffee.default_price_paise + 5000);
    assert.ok(r.body.charges.some((c) => c.name === 'Tea × 2' && c.amount_paise === 2400));
    r = await call('POST', `/residents/${ravi}/addons`, body, { 'Idempotency-Key': key });
    assert.equal(r.status, 200); assert.equal(r.body.duplicate, true, 'retry is not charged twice');
    r = await call('GET', `/residents/${ravi}`);
    assert.equal(r.body.balance.dues_paise - duesBefore, 2400 + coffee.default_price_paise + 5000, 'items are in dues');

    // paid now → no change in dues
    r = await call('POST', `/residents/${ravi}/addons`, { items: [{ catalog_item_id: tea.id, quantity: 1 }], billing_mode: 'immediate', payment_mode: 'upi' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const r2 = await call('GET', `/residents/${ravi}`);
    assert.equal(r2.body.balance.dues_paise - duesBefore, 2400 + coffee.default_price_paise + 5000, 'paid-now item leaves dues unchanged');

    // bad input: nothing saved
    for (const bad of [{ items: [] }, { items: [{ catalog_item_id: tea.id, quantity: 0 }] }, { items: [{ catalog_item_id: tea.id, quantity: 1 }, { name: 'X', unit_price_paise: 0 }] },
      { items: [{ catalog_item_id: tea.id, quantity: 1.5 }] }]) {
      r = await call('POST', `/residents/${ravi}/addons`, { ...bad, billing_mode: 'monthly_bill' });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    r = await call('GET', `/residents/${ravi}`);
    assert.equal(r.body.balance.dues_paise - duesBefore, 2400 + coffee.default_price_paise + 5000, 'failed requests saved nothing');

    // checkout preview includes the items
    r = await call('GET', `/residents/${ravi}/checkout-preview?checkout_date=${TODAY}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // removed item can't be billed
    await call('PATCH', `/addons/catalog/${coffee.id}`, { is_active: false });
    r = await call('POST', `/residents/${ravi}/addons`, { items: [{ catalog_item_id: coffee.id, quantity: 1 }], billing_mode: 'monthly_bill' });
    assert.equal(r.status, 404);
  } finally {
    s.stop();
  }
});
