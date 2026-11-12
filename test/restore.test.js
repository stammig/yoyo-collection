// Restore takes a whole collection from a zip someone else may have made, so it
// must treat everything inside as untrusted: file types, file names, video
// links and sizes. It must also bring back everything a backup holds.
//
// Tests marked `todo` reproduce known bugs from the Phase 1 plan. They run and
// report, but don't fail the suite; the fix removes the `todo`.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.js';
import { tempDir, makeBackup, makeZip, zipForm, lieAboutSizes, corruptCrcs } from './fixtures.js';
import { listEntries, extractEntry } from '../unzip.js';

// The smallest valid JPEG header is enough for static serving and for tests
// that only check names and headers.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const SAFE_URL = /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const photo = (filename) => (db) =>
  db.prepare("INSERT INTO photos (yoyo_id, uuid, filename) VALUES (1, '22222222-2222-4222-8222-222222222222', ?)").run(filename);

describe('restore', () => {
  let s, dir;
  beforeEach(async () => { s = await startServer(); dir = tempDir(); });
  afterEach(() => s.stop());

  const restore = async (opts) => {
    const res = await s.api('/api/restore', zipForm(await makeBackup(dir, opts)));
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  test('a normal backup with a photo restores and serves the photo', async () => {
    const r = await restore({ setup: photo('1700000000000-abc123.jpg'), files: { 'uploads/1700000000000-abc123.jpg': JPEG } });
    assert.equal(r.status, 200);
    const [y] = await (await s.api('/api/yoyos')).json();
    assert.equal(y.photos.length, 1);
    const img = await s.api(y.photos[0].url);
    assert.equal(img.status, 200);
  });

  for (const [name, body] of [
    ['x.html', '<!doctype html><script>alert(document.domain)</script>'],
    ['x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ]) {
    test(`a ${path.extname(name)} file in uploads/ is never served as a live page`,
      { todo: 'Phase 1 · 1B.1 — restore extracts any file type; /uploads has no nosniff/CSP (server.js:1838, 370)' },
      async () => {
        assert.equal((await restore({ files: { [`uploads/${name}`]: body } })).status, 200);
        const res = await s.api('/uploads/' + name);
        if (res.status === 404) return; // not extracted at all: the preferred fix
        const type = res.headers.get('content-type') || '';
        assert.ok(!/text\/html|image\/svg/.test(type) || /default-src 'none'/.test(res.headers.get('content-security-policy') || ''),
          `served as ${type} with no sandboxing CSP`);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      });
  }

  test('a photo filename that climbs out of uploads/ cannot delete the database',
    { todo: 'Phase 1 · 1B.2 — restored photo filenames are trusted; delete calls fs.rm on them (server.js:1876, 861)' },
    async () => {
      const liveDb = path.join(s.dir, 'yoyos.db');
      assert.ok(fs.existsSync(liveDb));
      await restore({ setup: photo('../yoyos.db') });
      const [y] = await (await s.api('/api/yoyos')).json();
      await s.api('/api/yoyos/' + y.id, { method: 'DELETE' });
      await new Promise((r) => setTimeout(r, 200)); // fs.rm runs after the response
      assert.ok(fs.existsSync(liveDb), 'the live database file was deleted');
    });

  test('a photo filename with quotes or markup is refused or renamed',
    { todo: "Phase 1 · 1B.2 / 1E.2 — a ' in a filename escapes the inline onerror handler (app.js:764)" },
    async () => {
      await restore({ setup: photo("x'+alert(document.domain)+'.jpg"), files: { "uploads/x'+alert(document.domain)+'.jpg": JPEG } });
      const [y] = await (await s.api('/api/yoyos')).json();
      for (const p of y.photos) assert.match(p.url, SAFE_URL);
    });

  test('a javascript: video link is dropped on restore',
    { todo: 'Phase 1 · 1B.2 — restored video rows skip parseVideoUrl (server.js:1877)' },
    async () => {
      await restore({
        setup: (db) => db.prepare("INSERT INTO videos (yoyo_id, uuid, provider, embed_ref, url) VALUES (1, '33333333-3333-4333-8333-333333333333', 'youtube', 'dQw4w9WgXcQ', 'javascript:alert(1)')").run(),
      });
      const [y] = await (await s.api('/api/yoyos')).json();
      for (const v of y.videos || []) assert.ok(!/^\s*javascript:/i.test(v.url), `video url ${v.url}`);
    });

  test('custom field definitions come back with the backup',
    { todo: 'Phase 1 · 1B.3 — restore never reads field_defs or settings (server.js:1815-1820)' },
    async () => {
      await restore({
        setup: (db) => {
          db.prepare("INSERT INTO field_defs (key, label, type) VALUES ('string_type', 'String type', 'text')").run();
          db.prepare(`UPDATE yoyos SET custom = '{"string_type":"Kitty Hybrid"}'`).run();
          db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sale_notes', 'Shipping is $5 in the US')").run();
        },
      });
      const fields = await (await s.api('/api/fields')).json();
      assert.ok(fields.some((f) => f.key === 'string_type'), 'field definition restored');
      const settings = await (await s.api('/api/settings')).json();
      assert.equal(settings.sale_notes, 'Shipping is $5 in the US');
    });
});

describe('unzip.js integrity checks', () => {
  const zero = Buffer.alloc(4 * 1024 * 1024); // 4 MB of zeros deflates to a few KB

  test('a deflated entry extracts to its real contents', async () => {
    const dir = tempDir();
    const zip = await makeZip(path.join(dir, 'ok.zip'), { 'uploads/big.bin': zero }, { store: false });
    const [e] = listEntries(zip);
    const out = path.join(dir, 'out.bin');
    await extractEntry(zip, e, out);
    assert.equal(fs.statSync(out).size, zero.length);
  });

  test('an entry that inflates past its declared size is refused (zip bomb)',
    { todo: 'Phase 1 · 1B.7 — unzip.js never checks the extracted size (unzip.js:110)' },
    async () => {
      const dir = tempDir();
      const zip = await makeZip(path.join(dir, 'bomb.zip'), { 'uploads/big.bin': zero }, { store: false });
      lieAboutSizes(zip, 1024);
      const [e] = listEntries(zip);
      await assert.rejects(extractEntry(zip, e, path.join(dir, 'out.bin')));
    });

  test('an entry whose CRC-32 does not match is refused',
    { todo: 'Phase 1 · 1B.7 — unzip.js never verifies CRC-32 (unzip.js:110)' },
    async () => {
      const dir = tempDir();
      const zip = await makeZip(path.join(dir, 'crc.zip'), { 'uploads/a.jpg': JPEG }, { store: true });
      corruptCrcs(zip);
      const [e] = listEntries(zip);
      await assert.rejects(extractEntry(zip, e, path.join(dir, 'out.jpg')));
    });
});
