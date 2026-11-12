// Who may back up, export, import and restore, in every way the server can be
// set up. privacy.test.js covers the password setup's field-hiding; this file
// covers the routes that move whole collections in and out.
//
// Tests marked `todo` reproduce known bugs from the Phase 1 plan. They run and
// report, but don't fail the suite; the fix removes the `todo`.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer, json, csvForm } from './helpers.js';
import { tempDir, makeBackup, zipForm } from './fixtures.js';

const PW = 'matrix-pw';
const CSV = 'Brand,Model,Color\nMatrixco,Imported,Green\n';
const allowed = (st) => st >= 200 && st < 300;
const denied = (st) => st === 401 || st === 403;

async function login(s) {
  const res = await s.api('/api/login', json({ password: PW }));
  assert.equal(res.status, 200, 'login works');
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const { token } = await res.json();
  return { token, cookie, bearer: { Authorization: 'Bearer ' + token } };
}

// Each mode: env for the server, and what an anonymous visitor may do.
const MODES = [
  { name: 'fully open (no password, not read-only)', env: {}, anon: { backup: true, export: true, import: true, restore: true } },
  { name: 'password set', env: { ADMIN_PASSWORD: PW }, anon: { backup: false, export: false, import: false, restore: false } },
  { name: 'READ_ONLY with no password (public showcase)', env: { READ_ONLY: '1' }, anon: { backup: false, export: false, import: false, restore: false } },
  { name: 'READ_ONLY with a password', env: { READ_ONLY: '1', ADMIN_PASSWORD: PW }, anon: { backup: false, export: false, import: false, restore: false } },
];

for (const mode of MODES) {
  describe(mode.name, () => {
    let s, dir;
    before(async () => { s = await startServer(mode.env); dir = tempDir(); });
    after(() => s.stop());

    const check = (action, run) => {
      const expectAllowed = mode.anon[action];
      test(`anonymous ${action} is ${expectAllowed ? 'allowed' : 'refused'}`, { todo: mode.todo?.[action] }, async () => {
        const st = await run();
        assert.ok(expectAllowed ? allowed(st) : denied(st), `got HTTP ${st}`);
      });
    };
    check('backup', async () => (await s.api('/api/backup.zip')).status);
    check('export', async () => (await s.api('/api/export.csv')).status);
    check('import', async () => (await s.api('/api/import', csvForm(CSV))).status);
    check('restore', async () => (await s.api('/api/restore', zipForm(await makeBackup(dir)))).status);

    if (mode.env.ADMIN_PASSWORD) {
      test('the logged-in owner may back up, export, import and restore', async () => {
        const { bearer } = await login(s);
        assert.equal((await s.api('/api/backup.zip', { headers: bearer })).status, 200);
        assert.equal((await s.api('/api/export.csv', { headers: bearer })).status, 200);
        assert.ok(allowed((await s.api('/api/import', { ...csvForm(CSV), headers: bearer })).status));
        assert.ok(allowed((await s.api('/api/restore', { ...zipForm(await makeBackup(dir)), headers: bearer })).status));
      });
    }
  });
}

describe('site read-only switch (Settings), with a password', () => {
  let s, dir, owner;
  before(async () => {
    s = await startServer({ ADMIN_PASSWORD: PW });
    dir = tempDir();
    owner = await login(s);
    const res = await s.api('/api/settings/read_only', {
      method: 'PUT', headers: { ...owner.bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: '1' }),
    });
    assert.ok(allowed(res.status), 'read-only switch turns on');
  });
  after(() => s.stop());

  test('the owner can still back up and export', async () => {
    assert.equal((await s.api('/api/backup.zip', { headers: owner.bearer })).status, 200);
    assert.equal((await s.api('/api/export.csv', { headers: owner.bearer })).status, 200);
  });
  test('the owner cannot import', async () => {
    assert.equal((await s.api('/api/import', { ...csvForm(CSV), headers: owner.bearer })).status, 403);
  });
  test('the owner can still publish a restore (the mirror use case)', async () => {
    assert.ok(allowed((await s.api('/api/restore', { ...zipForm(await makeBackup(dir)), headers: owner.bearer })).status));
  });
});

describe('cross-site requests carrying the owner cookie (CSRF)', () => {
  let s, owner;
  before(async () => { s = await startServer({ ADMIN_PASSWORD: PW }); owner = await login(s); });
  after(() => s.stop());

  test('a same-site cookie request can import', async () => {
    const res = await s.api('/api/import', { ...csvForm(CSV), headers: { Cookie: owner.cookie, 'Sec-Fetch-Site': 'same-origin' } });
    assert.ok(allowed(res.status), `got HTTP ${res.status}`);
  });
  test('a cross-site form post with the cookie is refused', async () => {
      const res = await s.api('/api/import', {
        ...csvForm(CSV),
        headers: { Cookie: owner.cookie, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      });
      assert.equal(res.status, 403);
    });
  test('a bearer-token client is unaffected by the origin check', async () => {
    const res = await s.api('/api/import', { ...csvForm(CSV), headers: { ...owner.bearer, Origin: 'https://evil.example' } });
    assert.ok(allowed(res.status), `got HTTP ${res.status}`);
  });
});

describe('backup round-trip', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());

  test('a downloaded backup restores the same collection, photos included', async () => {
    const ids = [];
    for (const model of ['Alpha', 'Beta']) {
      const res = await s.api('/api/yoyos', json({ brand: 'Roundtrip', model, color: 'Red' }));
      assert.equal(res.status, 201);
      ids.push((await res.json()).id);
    }
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } }).jpeg().toBuffer();
    const fdPhoto = new FormData();
    fdPhoto.append('photos', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');
    assert.ok(allowed((await s.api(`/api/yoyos/${ids[0]}/photos`, { method: 'POST', body: fdPhoto })).status), 'photo uploads');

    const zip = Buffer.from(await (await s.api('/api/backup.zip')).arrayBuffer());
    assert.ok(zip.length > 0 && zip.readUInt32LE(0) === 0x04034b50, 'backup is a zip');

    const extra = await s.api('/api/yoyos', json({ brand: 'Roundtrip', model: 'AddedAfter', color: 'Red' }));
    assert.equal(extra.status, 201);

    const fd = new FormData();
    fd.append('file', new Blob([zip], { type: 'application/zip' }), 'backup.zip');
    const res = await s.api('/api/restore', { method: 'POST', body: fd });
    assert.equal(res.status, 200);
    const list = await (await s.api('/api/yoyos')).json();
    assert.deepEqual(list.map((y) => y.model).sort(), ['Alpha', 'Beta']);
    const alpha = list.find((y) => y.model === 'Alpha');
    assert.equal(alpha.photos.length, 1, 'the photo row came back');
    assert.equal((await s.api(alpha.photos[0].url)).status, 200, 'the photo file came back');
  });
});
