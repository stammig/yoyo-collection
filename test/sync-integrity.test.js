// Data and sync integrity (1D.2, 1D.3, 1D.4, 1D.6, 1D.7). The Android app
// pushes full records with a full photo list and lower-case uuids
// (SyncDto.kt); the Apple apps use upper-case uuids. Neither may lose data.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer, json } from './helpers.js';

// A signed-in client, like the apps: every request carries the bearer token.
async function signedIn(env = {}) {
  const s = await startServer({ ADMIN_PASSWORD: 'sync-pw', ...env });
  const { token } = await (await s.api('/api/login', json({ password: 'sync-pw' }))).json();
  const raw = s.api;
  s.api = (p, opts = {}) => raw(p, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  return s;
}
const put = (s, id, body) => s.api(`/api/yoyos/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const push = (s, yoyos) => s.api('/api/sync/push', json({ yoyos }));
let tick = 0; // each push in a test is one second newer than the last
const ts = (offsetS = 0) => new Date(Date.now() - 60_000 + offsetS * 1000).toISOString().slice(0, 19).replace('T', ' ');
const androidRecord = (uuid, extra = {}) => ({
  uuid, created_at: ts(), updated_at: ts(), deleted_at: null,
  brand: 'Droid', model: 'Sync', color: 'Green', body_material: '', composition: 'BI', condition: 'MiB',
  bearing_size: '', response_type: '', description: '', release_date: '', tracking: '', eta: '',
  sale_status: '', purchase_date: '', sold_date: '', seller: '', buyer: '', finish: '', shape: '',
  edition: '', serial_number: '', signature: '', retail: 100, paid: 70, weight_g: null, diameter_mm: null,
  width_mm: null, gap_mm: null, sale_price: null, trade_value: null, market_value: null,
  in_hand: true, favorite: false, retired: false, custom: {}, photos: [], ...extra,
});

describe('partial updates (1D.2)', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());
  test('a PUT changes only the fields it sends', async () => {
    const y = await (await s.api('/api/yoyos', json({ brand: 'Part', model: 'Ial', color: 'Red', paid: 50, seller: 'Shop' }))).json();
    const r = await put(s, y.id, { color: 'Blue' });
    assert.equal(r.status, 200);
    const after = await r.json();
    assert.equal(after.color, 'Blue');
    assert.equal(after.paid, 50);
    assert.equal(after.seller, 'Shop');
    assert.equal(after.brand, 'Part');
  });
  test('custom fields merge; a key sent empty is cleared', async () => {
    await s.api('/api/fields', json({ label: 'String', type: 'text' }));
    await s.api('/api/fields', json({ label: 'Box', type: 'text' }));
    const fields = await (await s.api('/api/fields')).json();
    const [kS, kB] = ['String', 'Box'].map((l) => fields.find((f) => f.label === l).key);
    const y = await (await s.api('/api/yoyos', json({ brand: 'Cust', model: 'Om', color: 'Red', custom: { [kS]: 'Kitty', [kB]: 'Yes' } }))).json();
    let after = await (await put(s, y.id, { custom: { [kS]: 'Toxic' } })).json();
    assert.deepEqual(after.custom, { [kS]: 'Toxic', [kB]: 'Yes' });
    after = await (await put(s, y.id, { custom: { [kB]: '' } })).json();
    assert.deepEqual(after.custom, { [kS]: 'Toxic' });
  });
  test('listing for sale stamps sale_listed_at in the SQL format the apps read', async () => {
    const y = await (await s.api('/api/yoyos', json({ brand: 'Sale', model: 'Stamp', color: 'Red' }))).json();
    const after = await (await put(s, y.id, { sale_status: 'For Sale', sale_price: 40 })).json();
    assert.match(after.sale_listed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('sync push photo lists (1D.3, 1D.6)', () => {
  let s, jpeg;
  const U = 'c0ffee00-0000-4000-8000-000000000001';
  const P1 = 'c0ffee00-0000-4000-8000-0000000000a1';
  const P2 = 'c0ffee00-0000-4000-8000-0000000000a2';
  before(async () => {
    s = await signedIn();
    jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a0' } }).jpeg().toBuffer();
  });
  after(() => s.stop());
  const photosOf = async () => {
    const feed = await (await s.api('/api/sync/changes?since=0')).json();
    const rows = feed.changes || feed.yoyos || [];
    return rows.find((r) => r.uuid.toLowerCase() === U)?.photos.map((p) => p.uuid.toLowerCase()) || [];
  };
  const upload = (p) => {
    const fd = new FormData();
    fd.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), `${p}.jpg`);
    return s.api(`/api/sync/photos/${U}/${p}`, { method: 'POST', body: fd });
  };

  test('an Android push with two photos', async () => {
    const r = await (await push(s, [androidRecord(U, { photos: [{ uuid: P1, sort_order: 0, ext: 'jpg' }, { uuid: P2, sort_order: 1, ext: 'jpg' }] })])).json();
    assert.equal(r.results[0].applied, true);
    assert.deepEqual(r.results[0].missingPhotos.sort(), [P1, P2]);
    for (const p of [P1, P2]) assert.equal((await upload(p)).status, 200);
    assert.deepEqual(await photosOf(), [P1, P2]);
  });
  for (const [label, photos] of [['missing', undefined], ['null', null], ['an object', { uuid: P1 }], ['a list with a bad uuid', [{ uuid: P1 }, { uuid: 'nope' }]]]) {
    test(`a photo list that is ${label} leaves the photos alone`, async () => {
      const rec = androidRecord(U, { updated_at: ts(++tick), color: 'Teal' });
      if (photos === undefined) delete rec.photos; else rec.photos = photos;
      const r = await (await push(s, [rec])).json();
      assert.equal(r.results[0].applied, true, 'the record itself still applies');
      assert.deepEqual(await photosOf(), [P1, P2]);
    });
  }
  test('upper-case photo uuids match the existing photos (no duplicates, no deletes)', async () => {
    const r = await (await push(s, [androidRecord(U, { updated_at: ts(++tick), photos: [{ uuid: P1.toUpperCase(), sort_order: 0, ext: 'jpg' }, { uuid: P2.toUpperCase(), sort_order: 1, ext: 'jpg' }] })])).json();
    assert.deepEqual(r.results[0].missingPhotos, []);
    assert.deepEqual(await photosOf(), [P1, P2]);
  });
  test('a malformed deleted_at is refused, not saved as a live record', async () => {
    const uuid = 'c0ffee00-0000-4000-8000-000000000099';
    const r = await (await push(s, [androidRecord(uuid, { deleted_at: 'yesterday' })])).json();
    assert.equal(r.results[0].applied, false);
    assert.equal(r.results[0].reason, 'bad-timestamp');
  });
});

describe('custom field delete and savings (1D.4, 1D.7)', () => {
  let s;
  before(async () => { s = await signedIn(); });
  after(() => s.stop());
  test('deleting a custom field gives each changed yoyo a new rev', async () => {
    const def = await (await s.api('/api/fields', json({ label: 'Temp', type: 'text' }))).json();
    const key = (Array.isArray(def) ? def : [def]).find((f) => f.label === 'Temp').key;
    const y = await (await s.api('/api/yoyos', json({ brand: 'Field', model: 'Del', color: 'Red', custom: { [key]: 'x' } }))).json();
    const before = (await (await s.api('/api/sync/changes?since=0')).json()).latestRev;
    const id = (await (await s.api('/api/fields')).json()).find((f) => f.key === key).id;
    assert.equal((await s.api(`/api/fields/${id}`, { method: 'DELETE' })).status, 200);
    const feed = await (await s.api(`/api/sync/changes?since=${before}`)).json();
    const rows = feed.changes || feed.yoyos || [];
    const row = rows.find((r) => r.uuid === y.uuid);
    assert.ok(row, 'the yoyo is in the change feed again');
    assert.deepEqual(row.custom, {});
  });
  test('"saved vs retail" counts only yoyos with both prices', async () => {
    await s.api('/api/yoyos', json({ brand: 'Save', model: 'Both', color: 'R', retail: 100, paid: 60 }));
    await s.api('/api/yoyos', json({ brand: 'Save', model: 'RetailOnly', color: 'R', retail: 200 }));
    await s.api('/api/yoyos', json({ brand: 'Save', model: 'PaidOnly', color: 'R', paid: 30 }));
    const st = await (await s.api('/api/stats')).json();
    assert.equal(st.total_saved, 40);
  });
});
