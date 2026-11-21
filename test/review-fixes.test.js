// Fixes from the Phase 1 review: each test reproduces one finding.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { startServer, json } from './helpers.js';
import { tempDir, makeBackup, zipForm } from './fixtures.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PW = 'review-pw';

describe('formula escaping', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());
  test('a cell that starts like a number but is a formula is escaped', async () => {
    await s.api('/api/yoyos', json({ brand: 'Dde', model: 'Payload', color: '-2+3+cmd|\' /C calc\'!A0', edition: '-5', description: '+1.5' }));
    const rows = parse(await (await s.api('/api/export.csv')).text(), { columns: true, bom: true });
    const row = rows.find((r) => r.Model === 'Payload');
    assert.equal(row.Color, `'-2+3+cmd|' /C calc'!A0`);
    assert.equal(row.Edition, '-5', 'a plain number is left alone');
  });
});

describe('photos saved by older versions', () => {
  let s, dir;
  before(async () => { s = await startServer(); dir = tempDir(); });
  after(() => s.stop());
  test('a .jfif photo stays visible, served and backed up', async () => {
    const r = await s.api('/api/restore', zipForm(await makeBackup(dir, {
      setup: (db) => db.prepare("INSERT INTO photos (yoyo_id, uuid, filename) VALUES (1, '44444444-4444-4444-8444-444444444444', '1690000000000-ab12cd.jfif')").run(),
      files: { 'uploads/1690000000000-ab12cd.jfif': JPEG },
    })));
    assert.equal(r.status, 200);
    const [y] = await (await s.api('/api/yoyos')).json();
    assert.equal(y.photos.length, 1);
    assert.equal((await s.api(y.photos[0].url)).status, 200);
    const zip = Buffer.from(await (await s.api('/api/backup.zip')).arrayBuffer());
    assert.ok(zip.includes(Buffer.from('uploads/1690000000000-ab12cd.jfif')), 'the photo is in the backup');
  });
});

describe('site-wide wrong-password ceiling', () => {
  let s;
  before(async () => { s = await startServer({ ADMIN_PASSWORD: PW, TRUST_PROXY: '1', LOGIN_FAIL_GLOBAL_MAX: '3' }); });
  after(() => s.stop());
  const login = (ip, password) => s.api('/api/login', { ...json({ password }), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip } });
  test('guesses spread over many addresses do not lock out the owner', async () => {
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) assert.equal((await login(ip, 'nope')).status, 401);
    assert.equal((await login('198.51.100.1', 'nope')).status, 429, 'an address that guessed wrong is paused');
    assert.equal((await login('203.0.113.50', PW)).status, 200, 'the owner, who never guessed wrong, signs in');
  });
});

describe('cross-site check behind a proxy that rewrites Host', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());
  test('Sec-Fetch-Site: same-origin wins over a mismatched Origin', async () => {
    const r = await s.api('/api/yoyos', json({ brand: 'Proxy', model: 'Ok', color: 'Red' }, { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://yoyo.example.com' }));
    assert.equal(r.status, 201);
  });
  test('an old browser with no Sec-Fetch-Site still gets the Origin check', async () => {
    const r = await s.api('/api/yoyos', json({ brand: 'Proxy', model: 'Bad', color: 'Red' }, { Origin: 'https://evil.example' }));
    assert.equal(r.status, 403);
  });
});

describe('a PUT that changes nothing', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());
  test('leaves updated_at alone', async () => {
    const y = await (await s.api('/api/yoyos', json({ brand: 'Same', model: 'Same', color: 'Red', paid: 40, custom: {} }))).json();
    const put = (body) => s.api(`/api/yoyos/${y.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const a = await (await put({ color: 'Red', paid: 40 })).json();
    assert.equal(a.updated_at, y.updated_at);
    assert.equal(a.rev, y.rev);
    const b = await (await put({})).json();
    assert.equal(b.rev, y.rev);
    const c = await (await put({ color: 'Blue' })).json();
    assert.ok(c.rev > y.rev, 'a real change still bumps');
  });
});
