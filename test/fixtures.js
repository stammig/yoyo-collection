// Builds test databases and backup zips in code, so no binary fixtures live
// in the repo. A "backup" here has the same layout as /api/backup.zip:
// yoyos.db at the root plus uploads/<file> entries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');

export function tempDir(prefix = 'yoyo-fixture-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A database created straight from schema.sql, without booting the server, so
// none of db.js's migrations or settings rows have run. `setup` gets the open
// handle to add rows or reshape the schema.
export function makeDb(file, setup = () => {}) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  setup(db);
  db.close();
  return file;
}

// A database shaped like an install from before sync support: no `rev` column
// and no `sync_rev` setting.
export function makePreSyncDb(file, setup = () => {}) {
  return makeDb(file, (db) => {
    db.exec('DROP INDEX IF EXISTS idx_yoyos_rev');
    db.exec('ALTER TABLE yoyos DROP COLUMN rev');
    db.exec("DELETE FROM settings WHERE key = 'sync_rev'");
    setup(db);
  });
}

// Zips { 'yoyos.db': <path>, 'uploads/a.jpg': <Buffer|string>, ... }.
// Entries whose value is a string path to an existing file are added from disk;
// everything else is added as content. `store: false` deflates entries.
export function makeZip(file, entries, { store = true } = {}) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const zip = new ZipArchive({ store, zlib: { level: 9 } });
    out.on('close', () => resolve(file));
    zip.on('error', reject);
    zip.pipe(out);
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value === 'string' && fs.existsSync(value)) zip.file(value, { name });
      else zip.append(value, { name });
    }
    zip.finalize();
  });
}

// A complete, valid backup with one yoyo. `setup` can add or alter rows.
export async function makeBackup(dir, { setup = () => {}, files = {}, store = true } = {}) {
  const stem = `backup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbFile = makeDb(path.join(dir, `${stem}.db`), (db) => {
    db.prepare("INSERT INTO yoyos (uuid, brand, model, color) VALUES ('11111111-1111-4111-8111-111111111111', 'Fixture', 'Backup', 'Blue')").run();
    setup(db);
  });
  return makeZip(path.join(dir, `${stem}.zip`), { 'yoyos.db': dbFile, ...files }, { store });
}

export function zipForm(file, field = 'file') {
  const fd = new FormData();
  fd.append(field, new Blob([fs.readFileSync(file)], { type: 'application/zip' }), 'backup.zip');
  return { method: 'POST', body: fd };
}

// Rewrites the uncompressed-size field of every entry (local header and
// central directory) so an archive can claim less than it really inflates to.
export function lieAboutSizes(file, claimedSize) {
  const buf = fs.readFileSync(file);
  for (let i = 0; i < buf.length - 4; i++) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x04034b50) buf.writeUInt32LE(claimedSize, i + 22);      // local file header
    else if (sig === 0x02014b50) buf.writeUInt32LE(claimedSize, i + 24); // central directory header
  }
  fs.writeFileSync(file, buf);
}

// Flips the stored CRC-32 of every entry so the data no longer matches it.
export function corruptCrcs(file) {
  const buf = fs.readFileSync(file);
  for (let i = 0; i < buf.length - 4; i++) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x04034b50) buf.writeUInt32LE(buf.readUInt32LE(i + 14) ^ 0xffffffff, i + 14);
    else if (sig === 0x02014b50) buf.writeUInt32LE(buf.readUInt32LE(i + 16) ^ 0xffffffff, i + 16);
  }
  fs.writeFileSync(file, buf);
}
