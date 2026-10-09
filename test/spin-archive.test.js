// The 360° spin .zip upload: an untrusted archive unpacked through unzip.js.
// What matters is that a real export becomes one ordered spin, and that a
// crafted one is refused without leaving files behind in uploads/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import sharp from 'sharp';
import { startServer, json } from './helpers.js';

let s, auth, id;

before(async () => {
  s = await startServer({ ADMIN_PASSWORD: 'test-pw' });
  const token = (await (await s.api('/api/login', json({ password: 'test-pw' }))).json()).token;
  auth = { Authorization: 'Bearer ' + token };
  id = (await (await s.api('/api/yoyos', json({ brand: 'Testco', model: 'Spinner' }, auth))).json()).id;
});
after(() => s.stop());

const frame = (shade) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: shade, g: 0, b: 0 } } }).png().toBuffer();

function zipOf(members) {
  return new Promise((resolve, reject) => {
    const a = archiver('zip');
    const chunks = [];
    a.on('data', (c) => chunks.push(c));
    a.on('end', () => resolve(Buffer.concat(chunks)));
    a.on('error', reject);
    for (const [name, data] of members) a.append(data, { name });
    a.finalize();
  });
}

// Rewrites every central-directory entry's uncompressed size, so the archive
// claims its members are smaller than they inflate to.
function understateSizes(zip, size) {
  const out = Buffer.from(zip);
  for (let i = 0; i + 4 <= out.length; i++) {
    if (out.readUInt32LE(i) === 0x02014b50) out.writeUInt32LE(size, i + 24);
  }
  return out;
}

const upload = (zip) => {
  const fd = new FormData();
  fd.append('archive', new Blob([zip], { type: 'application/zip' }), 'spin.zip');
  return s.api(`/api/yoyos/${id}/spin-archive`, { method: 'POST', headers: auth, body: fd });
};

const uploadsNow = () => fs.readdirSync(path.join(s.dir, 'uploads')).sort();

test('a zipped frame sequence becomes one spin, in numeric order', async () => {
  const [f1, f2, f10] = await Promise.all([frame(10), frame(20), frame(100)]);
  const zip = await zipOf([
    ['export/spin_10.png', f10],
    ['export/spin_2.png', f2],
    ['export/spin_1.png', f1],
    ['__MACOSX/export/._spin_1.png', Buffer.from('resource fork')],
    ['export/README.txt', Buffer.from('not an image')],
  ]);
  const res = await upload(zip);
  assert.equal(res.status, 201, await res.clone().text());
  const spins = (await res.json()).photos.filter((p) => p.kind === 'spin');
  assert.equal(spins.length, 1);
  assert.equal(spins[0].frames.length, 3, 'the readme and macOS metadata are skipped');
  const bytes = await Promise.all(spins[0].frames.map(async (u) => Buffer.from(await (await s.api(u)).arrayBuffer())));
  assert.deepEqual(bytes, [f1, f2, f10], 'spin_2 sorts before spin_10');
  assert.ok(!uploadsNow().some((f) => f.endsWith('.zip') || f.endsWith('.part')), 'no archive or partial file is left behind');
});

test('an archive that understates its sizes is refused and leaves nothing behind', async () => {
  const before = uploadsNow();
  // Real PNG headers, so the members pass the magic-byte sniff and only the
  // size cap stands between them and uploads/.
  const big = async (shade) => Buffer.concat([await frame(shade), Buffer.alloc(200_000)]);
  const zip = understateSizes(await zipOf([['a.png', await big(1)], ['b.png', await big(2)]]), 10);
  const res = await upload(zip);
  assert.equal(res.status, 400);
  assert.deepEqual(uploadsNow(), before);
});

test('a file that is not a zip is refused', async () => {
  const before = uploadsNow();
  const res = await upload(Buffer.from('definitely not a zip'));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a readable \.zip/);
  assert.deepEqual(uploadsNow(), before);
});
