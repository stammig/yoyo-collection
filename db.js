// SQLite access layer: a thin better-sqlite3-compatible wrapper around Node's
// built-in `node:sqlite`, plus schema bootstrap and column migrations that run
// once at startup. Every migration below is an idempotent `ALTER TABLE ...
// IF NOT EXISTS`-style check, so this file is safe to run against a database
// from any earlier version of the app — new columns just get added in place.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'yoyos.db');

// Make sure the directory for the database file exists.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// We use Node's built-in SQLite (`node:sqlite`) rather than the native
// `better-sqlite3` add-on: some shared hosts (e.g. LiteSpeed/cPanel on older
// glibc) can neither load its prebuilt binary nor compile it. `node:sqlite`
// ships inside the Node runtime, so there's nothing to build.
//
// The wrapper below exposes the small slice of the better-sqlite3 API this app
// relies on (prepare / exec / pragma / transaction), so the rest of the code is
// unchanged. `openDatabase` is also reused by the restore endpoint.
export function openDatabase(file, opts = {}) {
  const raw = new DatabaseSync(file, opts);

  const prepare = (sql) => {
    const stmt = raw.prepare(sql);
    // Match better-sqlite3's object binding: keys like { id } bind to @id / :id,
    // and extra keys that don't map to a placeholder are ignored.
    stmt.setAllowBareNamedParameters?.(true);
    stmt.setAllowUnknownNamedParameters?.(true);
    return stmt;
  };

  return {
    raw,
    prepare,
    exec: (sql) => raw.exec(sql),
    pragma: (stmt) => raw.exec(`PRAGMA ${stmt}`),
    // better-sqlite3-style transaction: returns a function that runs `fn` inside
    // BEGIN/COMMIT, rolling back on error.
    transaction(fn) {
      return (...args) => {
        raw.exec('BEGIN');
        try {
          const result = fn(...args);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        }
      };
    },
    close: () => raw.close(),
  };
}

const db = openDatabase(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply the schema on startup (all statements are idempotent).
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migrate existing databases that predate the custom-fields feature.
const yoyoCols = db.prepare('PRAGMA table_info(yoyos)').all().map((c) => c.name);
if (!yoyoCols.includes('custom')) {
  db.exec("ALTER TABLE yoyos ADD COLUMN custom TEXT NOT NULL DEFAULT '{}'");
}
if (!yoyoCols.includes('retired')) {
  db.exec('ALTER TABLE yoyos ADD COLUMN retired INTEGER NOT NULL DEFAULT 0');
}
if (!yoyoCols.includes('sale_status')) {
  db.exec("ALTER TABLE yoyos ADD COLUMN sale_status TEXT NOT NULL DEFAULT ''");
}
if (!yoyoCols.includes('sale_price')) {
  db.exec('ALTER TABLE yoyos ADD COLUMN sale_price REAL');
}
if (!yoyoCols.includes('trade_value')) {
  db.exec('ALTER TABLE yoyos ADD COLUMN trade_value REAL');
}
if (!yoyoCols.includes('purchase_date')) {
  db.exec("ALTER TABLE yoyos ADD COLUMN purchase_date TEXT NOT NULL DEFAULT ''");
}
if (!yoyoCols.includes('sold_date')) {
  db.exec("ALTER TABLE yoyos ADD COLUMN sold_date TEXT NOT NULL DEFAULT ''");
}
if (!yoyoCols.includes('seller')) {
  db.exec("ALTER TABLE yoyos ADD COLUMN seller TEXT NOT NULL DEFAULT ''");
}
if (!yoyoCols.includes('buyer')) {
  db.exec("ALTER TABLE yoyos ADD COLUMN buyer TEXT NOT NULL DEFAULT ''");
}
if (!yoyoCols.includes('market_value')) {
  db.exec('ALTER TABLE yoyos ADD COLUMN market_value REAL');
}
for (const col of ['finish', 'shape', 'edition', 'serial_number', 'signature']) {
  if (!yoyoCols.includes(col)) {
    db.exec(`ALTER TABLE yoyos ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
}

// Soft-delete tombstone: DELETE /api/yoyos/:id sets this instead of removing
// the row (see server.js), so a future sync can propagate the deletion to
// other devices instead of a stale copy resurrecting it. Every read filters
// `WHERE deleted_at IS NULL`.
if (!yoyoCols.includes('deleted_at')) {
  db.exec('ALTER TABLE yoyos ADD COLUMN deleted_at TEXT');
}

// Stable, client-independent id for every yoyo — the anchor a future sync
// protocol would key off of, since auto-increment `id` values collide across
// devices that create rows offline. Backfill any rows without one
// (pre-existing rows, or rows restored from a backup made before this column
// existed), then enforce uniqueness.
if (!yoyoCols.includes('uuid')) {
  db.exec('ALTER TABLE yoyos ADD COLUMN uuid TEXT');
}
backfillUuids(db);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_yoyos_uuid ON yoyos(uuid)');

// Assign a UUID to every yoyo that lacks one. Exported so the restore endpoint
// can re-run it after importing rows from an older backup.
export function backfillUuids(database) {
  const rows = database.prepare("SELECT id FROM yoyos WHERE uuid IS NULL OR uuid = ''").all();
  if (!rows.length) return 0;
  const setUuid = database.prepare('UPDATE yoyos SET uuid = ? WHERE id = ?');
  database.transaction((rs) => { for (const r of rs) setUuid.run(crypto.randomUUID(), r.id); })(rows);
  return rows.length;
}

export default db;
