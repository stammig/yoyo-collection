// NMBTS was a long-standing misspelling of NMTBS, and MN/BI/TRI mean
// mono/bi/tri-material. Neither old form may survive any write path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { canonicalCondition, canonicalComposition } from '../vocab.js';
import { startServer, json, csvForm } from './helpers.js';

test('canonical spellings', () => {
  for (const v of ['NMBTS', 'nmbts', ' NMBTS ', 'NMTBS']) assert.equal(canonicalCondition(v), 'NMTBS');
  for (const v of ['MiB', 'Used', 'Used/Minor Damage', '']) assert.equal(canonicalCondition(v), v);
  assert.equal(canonicalComposition('Plastic'), 'MN');
  assert.equal(canonicalComposition('mono-material'), 'MN');
  assert.equal(canonicalComposition('Bi-metal'), 'BI');
  assert.equal(canonicalComposition('tri'), 'TRI');
  assert.equal(canonicalComposition('MN'), 'MN');
  assert.equal(canonicalComposition(''), '');
});

test('every write path stores NMTBS and MN', async () => {
  const s = await startServer();
  try {
    const a = await (await s.api('/api/yoyos', json({ brand: 'V', model: 'Api', condition: 'NMBTS', composition: 'Plastic' }))).json();
    assert.equal(a.condition, 'NMTBS'); assert.equal(a.composition, 'MN');
    await s.api('/api/import', csvForm('Brand,Model,Color,Condition,Composition\nV,Csv,,NMBTS,Plastic\n'));
    const c = (await (await s.api('/api/yoyos')).json()).find((y) => y.model === 'Csv');
    assert.equal(c.condition, 'NMTBS'); assert.equal(c.composition, 'MN');
  } finally { await s.stop(); }
});

test('existing rows are cleaned up when the server starts', async () => {
  const s1 = await startServer();
  await s1.api('/api/yoyos', json({ brand: 'V', model: 'Old', condition: 'MiB' }));
  await s1.stop();
  const db = new DatabaseSync(path.join(s1.dir, 'yoyos.db'));
  db.exec("UPDATE yoyos SET condition = 'NMBTS', composition = 'Plastic' WHERE model = 'Old'");
  const revBefore = db.prepare("SELECT rev FROM yoyos WHERE model = 'Old'").get().rev;
  db.close();
  const s2 = await startServer({ DB_PATH: path.join(s1.dir, 'yoyos.db'), UPLOAD_DIR: path.join(s1.dir, 'uploads') });
  try {
    const y = (await (await s2.api('/api/yoyos')).json()).find((r) => r.model === 'Old');
    assert.equal(y.condition, 'NMTBS'); assert.equal(y.composition, 'MN');
    assert.ok(y.rev > revBefore, 'rev bumped so sync clients re-pull');
  } finally { await s2.stop(); }
});
