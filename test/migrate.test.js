// Upgrades must never stop the server from starting. These boot real servers
// on databases shaped like older installs.
//
// Tests marked `todo` reproduce known bugs from the Phase 1 plan. They run and
// report, but don't fail the suite; the fix removes the `todo`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './helpers.js';
import { tempDir, makeDb, makePreSyncDb } from './fixtures.js';

const OLD_VOCAB = (db) => {
  db.prepare("INSERT INTO yoyos (brand, model, condition, composition) VALUES ('Oldco', 'Legacy', 'NMBTS', 'Plastic')").run();
  db.prepare("INSERT INTO yoyos (brand, model, condition, composition) VALUES ('Oldco', 'Second', 'Used', 'bi')").run();
};

async function bootAndList(dbFile) {
  const s = await startServer({ DB_PATH: dbFile });
  try {
    const list = await (await s.api('/api/yoyos')).json();
    return list;
  } finally {
    await s.stop();
  }
}

test('a current-schema database with no sync_rev boots and keeps its rows', async () => {
  const dir = tempDir();
  const file = makeDb(path.join(dir, 'yoyos.db'), (db) => {
    db.prepare("INSERT INTO yoyos (brand, model, condition) VALUES ('Newco', 'Clean', 'NMTBS')").run();
  });
  const list = await bootAndList(file);
  assert.equal(list.length, 1);
});

test('a pre-sync database with clean vocabulary boots', async () => {
  const dir = tempDir();
  const file = makePreSyncDb(path.join(dir, 'yoyos.db'), (db) => {
    db.prepare("INSERT INTO yoyos (brand, model, condition, composition) VALUES ('Oldco', 'Clean', 'NMTBS', 'MN')").run();
  });
  const list = await bootAndList(file);
  assert.equal(list.length, 1);
});

test('a pre-sync database with old vocabulary boots and is normalized',
  {},
  async () => {
    const dir = tempDir();
    const file = makePreSyncDb(path.join(dir, 'yoyos.db'), OLD_VOCAB);
    const list = await bootAndList(file);
    assert.equal(list.length, 2);
    assert.ok(list.every((y) => y.condition !== 'NMBTS'), 'NMBTS was rewritten');
    const db = new DatabaseSync(file, { readOnly: true });
    const revs = db.prepare('SELECT rev FROM yoyos').all().map((r) => r.rev);
    db.close();
    assert.ok(revs.every((r) => r > 0), 'every row has a sync rev');
  });

test('a current-schema database with old vocabulary but no sync_rev boots',
  {},
  async () => {
    const dir = tempDir();
    const file = makeDb(path.join(dir, 'yoyos.db'), OLD_VOCAB);
    const list = await bootAndList(file);
    assert.equal(list.length, 2);
  });
