'use strict';
// Change the bed layout after setup: add a bed, remove bed / bunker / floor — safely.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot } = require('./helpers');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();

test('add and remove beds, bunkers and floors', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-l-'));
  const s = await boot({ dbDir, port: 24000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  try {
    let r = await call('POST', '/auth/register', { business_name: 'A&P', owner_name: 'Amit', mobile: '9876500004',
      password: 'Passw0rd!23', pg_name: 'Dorm', city: 'Delhi' });
    s.setToken(r.body.token);
    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' });
    const ground = r.body.id;
    await call('POST', `/floors/${ground}/bunkers`, { bunkers: 3, beds_per_bunker: 2, daily_rate_paise: 30000 });
    r = await call('POST', '/floors', { floor_number: 1, label: 'First' });
    const first = r.body.id;
    await call('POST', `/floors/${first}/bunkers`, { bunkers: 1, beds_per_bunker: 2 });

    const layout = async () => (await call('GET', '/floors')).body;
    let fl = await layout();
    const [bA, bB, bC] = fl[0].rooms;          // 0A, 0B, 0C
    const bed = (label) => fl.flatMap((f) => f.rooms.flatMap((x) => x.beds)).find((b) => b.bed_label === label);

    // add one bed to bunker 0A → 0A3, same rate
    r = await call('POST', `/rooms/${bA.id}/beds`, {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.bed_label, '0A3'); assert.equal(r.body.daily_rate_paise, 30000);
    r = await call('POST', `/rooms/${bA.id}/beds`, { label: '0B1' });
    assert.equal(r.status, 409, 'name already used');
    r = await call('POST', `/rooms/${bA.id}/beds`, { label: 'Window-1' });
    assert.equal(r.status, 201);

    // guest in 0B1 → that bed, its bunker and the floor cannot be removed
    fl = await layout();
    r = await call('POST', '/residents', { full_name: 'Ravi', mobile: '9000000041', bed_id: bed('0B1').id, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 2), id_consent: true, id_type: 'passport', id_number: 'K1234567', rate_type: 'daily', rate_paise: 30000 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ravi = r.body.resident.id;
    r = await call('DELETE', `/beds/${bed('0B1').id}`);
    assert.equal(r.status, 409); assert.match(r.body.error, /has a guest/);
    r = await call('DELETE', `/rooms/${bB.id}`);
    assert.equal(r.status, 409);
    r = await call('DELETE', `/floors/${ground}`);
    assert.equal(r.status, 409);

    // free bed with no history → deleted
    r = await call('DELETE', `/beds/${bed('0A3').id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    fl = await layout();
    assert.equal(bed('0A3'), undefined);

    // bunker 0C (never used) removed completely
    r = await call('DELETE', `/rooms/${bC.id}`);
    assert.equal(r.status, 200);
    fl = await layout();
    assert.equal(fl[0].rooms.length, 2);

    // Ravi leaves → 0B1 has history: removing hides it; his bill still shows the bed
    r = await call('POST', `/residents/${ravi}/checkout`, { checkout_date: addDays(TODAY, 1) });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
    r = await call('DELETE', `/rooms/${bB.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    fl = await layout();
    assert.equal(fl[0].rooms.length, 1, 'bunker 0B gone from the layout');
    r = await call('GET', `/residents/${ravi}/bill`);
    assert.equal(r.body.guest.bed, '0B1', 'old bill still shows the bed');
    r = await call('GET', '/dashboard/today');
    assert.equal(r.body.beds.total, 3 + 2, 'counts only beds still in use (0A1, 0A2, Window-1 + first floor 2)');
    r = await call('GET', '/beds?status=available');
    assert.ok(!r.body.some((b) => b.bed_label === '0B1'), 'removed bed cannot be chosen at check-in');

    // bunker names can be reused after removal
    r = await call('POST', `/floors/${ground}/bunkers`, { bunkers: 1, beds_per_bunker: 2 });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.created[0].beds, ['0B1', '0B2']);

    // remove the whole first floor, then add it again with the same number
    r = await call('DELETE', `/floors/${first}`);
    assert.equal(r.status, 200);
    r = await call('POST', '/floors', { floor_number: 1, label: 'First again' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    fl = await layout();
    assert.deepEqual(fl.map((f) => f.label), ['Ground', 'First again']);

    // unknown ids
    assert.equal((await call('DELETE', '/beds/nope')).status, 404);
    assert.equal((await call('DELETE', '/rooms/nope')).status, 404);
    assert.equal((await call('DELETE', '/floors/nope')).status, 404);
  } finally {
    s.stop();
  }
});
