import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
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

export default db;
