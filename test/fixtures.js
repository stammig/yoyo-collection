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

// The database the iPhone/iPad/Mac app's "Publish to website" uploads, built
// with the same CREATE TABLE statements as BackupExporter.swift (Yoyo
// Collection for Apple platforms). Keep this in step with that file: it is the
// contract the Apple apps rely on. Notable differences from a web backup:
//   · no rev, sale_listed_at, field_defs, videos or settings
//   · uuids are UPPERCASE (Swift's UUID().uuidString)
//   · photo filenames are "<photo uuid>.jpg", and the zip has no uploads/ —
//     photo bytes follow one at a time through /api/sync/photos
//   · tombstoned rows (deleted_at set) are included
export const APPLE_SCHEMA = `
CREATE TABLE yoyos (
  id INTEGER PRIMARY KEY, uuid TEXT,
  brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '', body_material TEXT NOT NULL DEFAULT '',
  composition TEXT NOT NULL DEFAULT '', in_hand INTEGER NOT NULL DEFAULT 0,
  condition TEXT NOT NULL DEFAULT '', retail REAL, paid REAL, market_value REAL,
  purchase_date TEXT NOT NULL DEFAULT '', seller TEXT NOT NULL DEFAULT '',
  sale_status TEXT NOT NULL DEFAULT '', sale_price REAL, trade_value REAL,
  sold_date TEXT NOT NULL DEFAULT '', buyer TEXT NOT NULL DEFAULT '',
  weight_g REAL, diameter_mm REAL, width_mm REAL, gap_mm REAL,
  bearing_size TEXT NOT NULL DEFAULT '', response_type TEXT NOT NULL DEFAULT '',
  finish TEXT NOT NULL DEFAULT '', shape TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '', serial_number TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  release_date TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '',
  eta TEXT NOT NULL DEFAULT '', custom TEXT NOT NULL DEFAULT '{}',
  favorite INTEGER NOT NULL DEFAULT 0, retired INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE photos (
  id INTEGER PRIMARY KEY, yoyo_id INTEGER NOT NULL, uuid TEXT,
  filename TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
);`;

// yoyos: [{ uuid, brand, model, sale_status?, custom?, deleted_at?, photos: [photoUuid] }]
export async function makeAppleBackup(dir, yoyos) {
  const stem = `apple-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const file = path.join(dir, `${stem}.db`);
  const db = new DatabaseSync(file);
  db.exec(APPLE_SCHEMA);
  const insY = db.prepare(`INSERT INTO yoyos (id, uuid, brand, model, color, condition, composition, paid, sale_status, sale_price, sold_date, buyer, custom, deleted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Blue', 'MiB', 'BI', 80, ?, ?, ?, ?, ?, ?, '2026-10-01 12:00:00', '2026-10-02 12:00:00')`);
  const insP = db.prepare('INSERT INTO photos (id, yoyo_id, uuid, filename, sort_order) VALUES (?, ?, ?, ?, ?)');
  let photoId = 1;
  yoyos.forEach((y, i) => {
    const sold = y.sale_status === 'Sold';
    insY.run(i + 1, y.uuid, y.brand, y.model, y.sale_status || '', sold ? 120 : null, sold ? '2026-10-05' : '', sold ? 'A buyer' : '',
      JSON.stringify(y.custom || {}), y.deleted_at || null);
    (y.photos || []).forEach((p, order) => insP.run(photoId++, i + 1, p, `${p}.jpg`, order));
  });
  db.close();
  return makeZip(path.join(dir, `${stem}.zip`), { 'yoyos.db': file });
}

// The multipart body WebPublisher.uploadPhoto sends: one part named "photo".
export function applePhotoForm(jpeg, photoUuid) {
  const fd = new FormData();
  fd.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), `${photoUuid}.jpg`);
  return fd;
}
