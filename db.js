// The app's own database: opened from DB_PATH and migrated to the current
// schema on import. Everything that can be used without side effects lives in
// sqlite.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, migrate, nextRev as nextRevIn } from './sqlite.js';

export { openDatabase, backfillUuids, backfillPhotoUuids } from './sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'yoyos.db');

// Make sure the directory for the database file exists.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = openDatabase(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
migrate(db);

// Returns the next global revision. Call inside the surrounding write
// transaction so the bump commits or rolls back with the row it stamps.
export function nextRev(database = db) {
  return nextRevIn(database);
}

export default db;
