// The maintenance scripts (1D.4, 1D.5): a dry run must not touch the
// database, --apply must snapshot it first and stamp every change so synced
// devices pull it, and an un-migrated database is refused rather than changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase, migrate } from '../sqlite.js';
import { tempDir, makePreSyncDb } from './fixtures.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const run = (script, dbFile, ...args) => execFileSync(process.execPath, [script, ...args], {
  cwd: root, env: { ...process.env, DB_PATH: dbFile }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

function migratedDb(setup) {
  const file = path.join(tempDir(), 'yoyos.db');
  const db = openDatabase(file);
  migrate(db);
  setup(db);
  db.close();
  return file;
}
const revOf = (file, id) => {
  const db = openDatabase(file, { readOnly: true });
  try { return db.prepare('SELECT rev, body_material, purchase_date FROM yoyos WHERE id = ?').get(id); } finally { db.close(); }
};

test('normalize-fields: dry run changes nothing, --apply snapshots and bumps rev', () => {
  const file = migratedDb((db) => db.prepare("INSERT INTO yoyos (uuid, brand, model, body_material) VALUES ('a0000000-0000-4000-8000-000000000001', 'S', 'M', '6061AL')").run());
  const before = hash(file);
  const out = run('normalize-fields.mjs', file);
  assert.match(out, /Dry run/);
  assert.equal(hash(file), before, 'dry run left the file untouched');
  const rev0 = revOf(file, 1).rev;
  const applied = run('normalize-fields.mjs', file, '--apply');
  const snap = applied.match(/Snapshot saved: (.+)/)[1].trim();
  assert.ok(fs.existsSync(snap), 'snapshot written');
  const after = revOf(file, 1);
  assert.equal(after.body_material, '6061 AL');
  assert.ok(after.rev > rev0, 'rev bumped so devices pull the change');
});

test('normalize-dates: dry run changes nothing, --apply writes', () => {
  const file = migratedDb((db) => db.prepare("INSERT INTO yoyos (uuid, brand, model, purchase_date) VALUES ('a0000000-0000-4000-8000-000000000002', 'S', 'M', '6/15/2026')").run());
  const before = hash(file);
  run('normalize-dates.mjs', file);
  assert.equal(hash(file), before);
  run('normalize-dates.mjs', file, '--apply');
  assert.equal(revOf(file, 1).purchase_date, '2026-06-15');
});

test('a database the app has not updated yet is refused, not migrated', () => {
  const file = makePreSyncDb(path.join(tempDir(), 'old.db'));
  const before = hash(file);
  assert.throws(() => run('normalize-dates.mjs', file, '--apply'), /Start the app once/);
  assert.equal(hash(file), before);
});

test('seed-demo never touches DB_PATH and needs FORCE=1 exactly', () => {
  const dir = tempDir();
  const live = migratedDb((db) => db.prepare("INSERT INTO yoyos (uuid, brand, model) VALUES ('a0000000-0000-4000-8000-000000000003', 'Real', 'Collection')").run());
  const liveHash = hash(live);
  const demo = path.join(dir, 'demo.db');
  const seed = (env) => execFileSync(process.execPath, ['seed-demo.mjs'], {
    cwd: root, env: { ...process.env, DB_PATH: live, SEED_DB_PATH: demo, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  seed({ FORCE: '' });
  assert.equal(hash(live), liveHash, 'DB_PATH (the real collection) is untouched');
  assert.throws(() => seed({ FORCE: '0' }), /Refusing to overwrite/, 'FORCE=0 is not yes');
  seed({ FORCE: '1' });
  assert.equal(hash(live), liveHash);
});
