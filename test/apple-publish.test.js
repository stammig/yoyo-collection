// "Publish to website" from the Yoyo Collection app for iPhone, iPad and Mac
// (WebPublisher.swift). The website is a mirror there: the device is the
// master copy and replaces the site's collection on every publish. These tests
// replay exactly what the app sends, so a server change that would break
// publishing fails here first. The Apple app will be updated too, but every
// server release must keep working with the version already installed.
//
// The app's steps, in order:
//   1. POST /api/login {password}                  → { token }   (Bearer from here on)
//   2. POST /api/restore  multipart "file"         a database-only zip (see makeAppleBackup)
//   3. HEAD /uploads/<PHOTO-UUID>.jpg, no auth     200 = already there, 404 = send it
//   4. POST /api/sync/photos/<YOYO-UUID>/<PHOTO-UUID>  multipart "photo", image/jpeg
// Errors are read from {"error": "..."}.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer, json } from './helpers.js';
import { tempDir, makeAppleBackup, applePhotoForm, zipForm } from './fixtures.js';

const PW = 'apple-pw';
const Y1 = 'A1B2C3D4-0000-4000-8000-000000000001';
const Y2 = 'A1B2C3D4-0000-4000-8000-000000000002';
const Y3 = 'A1B2C3D4-0000-4000-8000-000000000003';
const P1 = 'F0E1D2C3-0000-4000-8000-0000000000A1';
const P2 = 'F0E1D2C3-0000-4000-8000-0000000000A2';
const P3 = 'F0E1D2C3-0000-4000-8000-0000000000A3';

const LIBRARY = [
  { uuid: Y1, brand: 'Apple', model: 'Kept', photos: [P1, P2], custom: { 'serial-plate': 'SECRET-42' } },
  { uuid: Y2, brand: 'Apple', model: 'Sold one', sale_status: 'Sold', photos: [P3] },
  { uuid: Y3, brand: 'Apple', model: 'Deleted on phone', deleted_at: '2026-10-03 09:00:00' },
];

// Each mode the site might be in when the app publishes to it.
const MODES = [
  { name: 'password set', env: { ADMIN_PASSWORD: PW } },
  { name: 'password set, Settings read-only switch on (mirror)', env: { ADMIN_PASSWORD: PW }, readOnlySwitch: true },
  { name: 'READ_ONLY public showcase with a password', env: { ADMIN_PASSWORD: PW, READ_ONLY: '1' } },
];

for (const mode of MODES) {
  describe(`Apple app publish · ${mode.name}`, () => {
    let s, dir, bearer, jpeg;
    before(async () => {
      s = await startServer(mode.env);
      dir = tempDir();
      jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#36c' } }).jpeg().toBuffer();
      const res = await s.api('/api/login', json({ password: PW }));
      assert.equal(res.status, 200);
      const { token } = await res.json();
      assert.ok(token, 'login returns a token');
      bearer = { Authorization: 'Bearer ' + token };
      if (mode.readOnlySwitch) {
        const r = await s.api('/api/settings/read_only', { method: 'PUT', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: '1' }) });
        assert.ok(r.status < 300, 'read-only switch turns on');
      }
    });
    after(() => s.stop());

    const head = async (photoUuid) => (await s.api(`/uploads/${photoUuid}.jpg`, { method: 'HEAD' })).status;
    const sendPhoto = (yoyoUuid, photoUuid) =>
      s.api(`/api/sync/photos/${yoyoUuid}/${photoUuid}`, { method: 'POST', headers: bearer, body: applePhotoForm(jpeg, photoUuid) });
    const publishDb = async (library) =>
      s.api('/api/restore', { ...zipForm(await makeAppleBackup(dir, library)), headers: bearer });

    test('a first publish: database, then each missing photo', async () => {
      const r = await publishDb(LIBRARY);
      assert.equal(r.status, 200, await r.clone().text());
      for (const p of [P1, P2, P3]) assert.equal(await head(p), 404, `${p} is not there yet`);
      for (const [y, p] of [[Y1, P1], [Y1, P2], [Y2, P3]]) {
        const up = await sendPhoto(y, p);
        assert.equal(up.status, 200, await up.clone().text());
      }
      for (const p of [P1, P2, P3]) assert.equal(await head(p), 200, `${p} is there now`);
    });

    test('the owner sees the published collection, with photos in order and no duplicates', async () => {
      const list = await (await s.api('/api/yoyos', { headers: bearer })).json();
      const byUuid = Object.fromEntries(list.map((y) => [String(y.uuid).toUpperCase(), y]));
      assert.ok(byUuid[Y1] && byUuid[Y2], 'both live yoyos are listed');
      assert.ok(!byUuid[Y3], 'the tombstoned yoyo is not listed');
      assert.deepEqual(byUuid[Y1].photos.map((p) => p.url), [`/uploads/${P1}.jpg`, `/uploads/${P2}.jpg`]);
      for (const p of byUuid[Y1].photos) assert.equal((await s.api(p.url)).status, 200);
    });

    test('a repeat publish keeps photos already uploaded (HEAD still 200)', async () => {
      const r = await publishDb(LIBRARY);
      assert.equal(r.status, 200);
      for (const p of [P1, P2, P3]) assert.equal(await head(p), 200);
      const list = await (await s.api('/api/yoyos', { headers: bearer })).json();
      const y1 = list.find((y) => String(y.uuid).toUpperCase() === Y1);
      assert.equal(y1.photos.length, 2, 'no duplicate photo rows after re-publishing');
    });

    test('visitors see neither Sold items nor custom fields', async () => {
      const list = await (await s.api('/api/yoyos')).json();
      assert.ok(!list.some((y) => String(y.uuid || '').toUpperCase() === Y2 || y.sale_status === 'Sold'), 'no Sold rows for visitors');
      for (const y of list) assert.ok(!('custom' in y) || Object.keys(y.custom || {}).length === 0, 'no custom fields for visitors');
      assert.ok(!JSON.stringify(list).includes('SECRET-42'));
    });

    test('a visitor cannot publish', async () => {
      const r = await s.api('/api/restore', zipForm(await makeAppleBackup(dir, LIBRARY)));
      assert.ok(r.status === 401 || r.status === 403);
      const up = await s.api(`/api/sync/photos/${Y1}/${P1}`, { method: 'POST', body: applePhotoForm(jpeg, P1) });
      assert.ok(up.status === 401 || up.status === 403);
    });

    test('errors come back as {"error": "..."}', async () => {
      const r = await s.api('/api/login', json({ password: 'wrong' }));
      assert.equal(r.status, 401);
      assert.equal(typeof (await r.json()).error, 'string');
    });
  });
}
