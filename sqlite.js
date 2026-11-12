// SQLite access with no side effects: opening a database, the schema
// migrations, and the sync helpers. db.js opens the app's own database and
// migrates it on import; the maintenance scripts import this file instead, so
// a dry run never changes anything (see normalize-dates.mjs).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalCondition, canonicalComposition } from './vocab.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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


// Brings a database from any earlier version of the app up to date. Every step
// checks before it changes anything, so running it again is a no-op. Steps run
// in order; the vocabulary cleanup comes after the sync columns because it
// stamps fixed rows with nextRev().
export function migrate(database) {
  // Apply the schema on startup (all statements are idempotent).
  database.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  // Migrate existing databases that predate the custom-fields feature.
  const yoyoCols = database.prepare('PRAGMA table_info(yoyos)').all().map((c) => c.name);
  if (!yoyoCols.includes('custom')) {
    database.exec("ALTER TABLE yoyos ADD COLUMN custom TEXT NOT NULL DEFAULT '{}'");
  }
  if (!yoyoCols.includes('retired')) {
    database.exec('ALTER TABLE yoyos ADD COLUMN retired INTEGER NOT NULL DEFAULT 0');
  }
  if (!yoyoCols.includes('sale_status')) {
    database.exec("ALTER TABLE yoyos ADD COLUMN sale_status TEXT NOT NULL DEFAULT ''");
  }
  if (!yoyoCols.includes('sale_price')) {
    database.exec('ALTER TABLE yoyos ADD COLUMN sale_price REAL');
  }
  if (!yoyoCols.includes('trade_value')) {
    database.exec('ALTER TABLE yoyos ADD COLUMN trade_value REAL');
  }
  if (!yoyoCols.includes('purchase_date')) {
    database.exec("ALTER TABLE yoyos ADD COLUMN purchase_date TEXT NOT NULL DEFAULT ''");
  }
  if (!yoyoCols.includes('sold_date')) {
    database.exec("ALTER TABLE yoyos ADD COLUMN sold_date TEXT NOT NULL DEFAULT ''");
  }
  if (!yoyoCols.includes('seller')) {
    database.exec("ALTER TABLE yoyos ADD COLUMN seller TEXT NOT NULL DEFAULT ''");
  }
  if (!yoyoCols.includes('buyer')) {
    database.exec("ALTER TABLE yoyos ADD COLUMN buyer TEXT NOT NULL DEFAULT ''");
  }
  if (!yoyoCols.includes('market_value')) {
    database.exec('ALTER TABLE yoyos ADD COLUMN market_value REAL');
  }
  if (!yoyoCols.includes('sale_listed_at')) {
    database.exec('ALTER TABLE yoyos ADD COLUMN sale_listed_at TEXT');
  }
  // Backfill for listings that predate sale_listed_at: without this the
  // "Days listed" column is a wall of "—" that reads as broken. Stamping "now"
  // means they show 0d today but age accurately from here on. Idempotent —
  // only ever fills NULL/empty on rows that are currently listed. (The native
  // app does the same one-time stamp on its side; values converge via sync.)
  database.exec(`UPDATE yoyos SET sale_listed_at = datetime('now')
    WHERE sale_status IN ('For Sale', 'For Trade', 'For Sale or Trade')
      AND (sale_listed_at IS NULL OR sale_listed_at = '')`);
  for (const col of ['finish', 'shape', 'edition', 'serial_number', 'signature']) {
    if (!yoyoCols.includes(col)) {
      database.exec(`ALTER TABLE yoyos ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  }

  // Soft-delete tombstone: DELETE /api/yoyos/:id sets this instead of removing
  // the row (see server.js), so a future sync can propagate the deletion to
  // other devices instead of a stale copy resurrecting it. Every read filters
  // `WHERE deleted_at IS NULL`.
  if (!yoyoCols.includes('deleted_at')) {
    database.exec('ALTER TABLE yoyos ADD COLUMN deleted_at TEXT');
  }

  // Stable, client-independent id for every yoyo — the anchor a future sync
  // protocol would key off of, since auto-increment `id` values collide across
  // devices that create rows offline. Backfill any rows without one
  // (pre-existing rows, or rows restored from a backup made before this column
  // existed), then enforce uniqueness.
  if (!yoyoCols.includes('uuid')) {
    database.exec('ALTER TABLE yoyos ADD COLUMN uuid TEXT');
  }
  backfillUuids(database);
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_yoyos_uuid ON yoyos(uuid)');


  // ---- Sync support: photo uuids + revision cursor ----

  // Photos get the same stable cross-device identity yoyos have — sync manifests
  // key photos by uuid. Existing filenames are untouched so /uploads URLs stay
  // valid; only photos pushed from a device are named <uuid>.<ext>.
  const photoCols = database.prepare('PRAGMA table_info(photos)').all().map((c) => c.name);
  if (!photoCols.includes('uuid')) {
    database.exec('ALTER TABLE photos ADD COLUMN uuid TEXT');
  }
  backfillPhotoUuids(database);

  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_uuid ON photos(uuid)');


  // Monotonic revision cursor for sync: every server write stamps its row with
  // the next value of a global counter (settings.sync_rev), and clients pull
  // `WHERE rev > since`. Revs order the change feed; updated_at timestamps only
  // resolve conflicts. On the first boot with sync, existing rows get distinct
  // revs in edit order so a fresh client can page through history.
  if (!yoyoCols.includes('rev')) {
    database.exec('ALTER TABLE yoyos ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_yoyos_rev ON yoyos(rev)');
  if (!database.prepare("SELECT value FROM settings WHERE key = 'sync_rev'").get()) {
    const rows = database.prepare('SELECT id FROM yoyos ORDER BY updated_at, id').all();
    const setRev = database.prepare('UPDATE yoyos SET rev = ? WHERE id = ?');
    database.transaction(() => {
      rows.forEach((r, i) => setRev.run(i + 1, r.id));
      database.prepare("INSERT INTO settings (key, value) VALUES ('sync_rev', ?)").run(String(rows.length));
    })();
  }

  // Rewrite retired vocabulary in place. This must run after the rev column and
  // the sync_rev counter exist (just above), because it stamps each fixed row
  // with nextRev(); run any earlier and an older install crashes on startup.
  // (NMBTS -> NMTBS, "Plastic" -> MN; see
  // vocab.js). Idempotent: once clean, the WHERE matches nothing. Each changed
  // row gets a new rev so sync clients pull the corrected value.
  {
    const stale = database.prepare(
      `SELECT id, condition, composition FROM yoyos
       WHERE upper(trim(condition)) = 'NMBTS' OR lower(trim(composition)) IN ('plastic','mono-material','bi-material','tri-material','mono-metal','bi-metal','tri-metal','mn','bi','tri') AND composition NOT IN ('MN','BI','TRI')`
    ).all();
    if (stale.length) {
      const fix = database.prepare('UPDATE yoyos SET condition = ?, composition = ?, rev = ? WHERE id = ?');
      database.transaction(() => {
        for (const r of stale) fix.run(canonicalCondition(r.condition), canonicalComposition(r.composition), nextRev(database), r.id);
      })();
      console.log(`vocab: normalized ${stale.length} yoyo(s) (NMBTS -> NMTBS / composition codes)`);
    }
  }

  // One timestamp format everywhere: sale_listed_at was once written as an ISO
  // string ("2026-10-01T12:00:00.000Z"), which the Android app can't read.
  database.exec(`UPDATE yoyos SET sale_listed_at = substr(replace(sale_listed_at, 'T', ' '), 1, 19)
    WHERE sale_listed_at LIKE '____-__-__T%'`);

  database.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION));
}

// Bump when migrate() gains a step.
export const SCHEMA_VERSION = 2;

// True when a database has every column and setting the app and its scripts
// rely on, without changing it to find out.
export function isMigrated(database) {
  const row = database.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
  return !!row && Number(row.value) >= SCHEMA_VERSION;
}

// Assign a UUID to every yoyo that lacks one. Exported so the restore endpoint
// can re-run it after importing rows from an older backup.
export function backfillUuids(database) {
  const rows = database.prepare("SELECT id FROM yoyos WHERE uuid IS NULL OR uuid = ''").all();
  if (!rows.length) return 0;
  const setUuid = database.prepare('UPDATE yoyos SET uuid = ? WHERE id = ?');
  database.transaction((rs) => { for (const r of rs) setUuid.run(crypto.randomUUID(), r.id); })(rows);
  return rows.length;
}

// Assign a UUID to every photo that lacks one. Exported so the restore endpoint
// can re-run it after importing rows from a pre-sync backup.
export function backfillPhotoUuids(database) {
  const rows = database.prepare("SELECT id FROM photos WHERE uuid IS NULL OR uuid = ''").all();
  if (!rows.length) return 0;
  const setUuid = database.prepare('UPDATE photos SET uuid = ? WHERE id = ?');
  database.transaction((rs) => { for (const r of rs) setUuid.run(crypto.randomUUID(), r.id); })(rows);
  return rows.length;
}

// Returns the next global revision. Call inside the surrounding write
// transaction so the bump commits or rolls back with the row it stamps.
export function nextRev(database) {
  database.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'sync_rev'").run();
  return Number(database.prepare("SELECT value FROM settings WHERE key = 'sync_rev'").get().value);
}

// For the maintenance scripts. A dry run opens the database read-only. With
// `apply`, it first checks the app has already brought the database up to
// date (the scripts never migrate it themselves), then writes a snapshot next
// to it with VACUUM INTO, so a bad run can be undone by restoring that file.
export function openForScript(file, { apply = false, label = 'script' } = {}) {
  if (!fs.existsSync(file)) throw new Error(`No database at ${file}. Set DB_PATH to your yoyos.db.`);
  if (!apply) return { db: openDatabase(file, { readOnly: true }), snapshot: null };
  const database = openDatabase(file);
  let ok = false;
  try { ok = isMigrated(database); } catch { ok = false; }
  if (!ok) {
    database.close();
    throw new Error('This database is from an older version of the app. Start the app once so it can update the database, then run this again.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapshot = `${file}.before-${label}-${stamp}`;
  database.prepare('VACUUM INTO ?').run(snapshot);
  return { db: database, snapshot };
}
