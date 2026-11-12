// One-time cleanup: rewrites existing purchase_date / sold_date values to
// "YYYY-MM-DD" using the same normalizeDay() every write path now applies
// (see dates.js). Rows stored before that — mostly CSV imports, which kept
// dates exactly as the spreadsheet had them ("6/15/2026") — get fixed here.
//
// Dry run by default; pass --apply to write. Idempotent: a second run finds
// nothing. Values it can't read ("Spring 2024", "13/13/2026") are left alone.
// Each rewritten row gets a new rev + updated_at so synced devices re-pull the
// clean value, which is why this is a script you run deliberately rather than
// something the server does on boot.
//
//   node normalize-dates.mjs                 # show what would change
//   node normalize-dates.mjs --apply         # change it
//   DB_PATH=/path/to/yoyos.db node normalize-dates.mjs --apply
//
// The app must have run once on this database first (it brings the schema up
// to date). --apply saves a snapshot beside the database before writing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openForScript, nextRev } from './sqlite.js';
import { DAY_FIELDS, normalizeDay } from './dates.js';

// Opened without running the app's migrations, so a dry run changes nothing.
// --apply snapshots the database first (the path is printed).
const DB_PATH = process.env.DB_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'yoyos.db');
const apply = process.argv.includes('--apply');
const { db, snapshot } = openForScript(DB_PATH, { apply, label: 'normalize-dates' });
if (snapshot) console.log(`Snapshot saved: ${snapshot}\n`);
const rows = db.prepare(
  `SELECT id, brand, model, ${DAY_FIELDS.join(', ')} FROM yoyos WHERE deleted_at IS NULL`
).all();

const changes = [];
const unreadable = [];
for (const row of rows) {
  const fixed = {};
  for (const f of DAY_FIELDS) {
    const v = row[f] == null ? '' : String(row[f]);
    if (!v.trim()) continue;
    const n = normalizeDay(v);
    if (n !== v) fixed[f] = n;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(n)) unreadable.push(`  #${row.id} ${row.brand} ${row.model} — ${f}: "${v}"`);
  }
  if (Object.keys(fixed).length) changes.push({ row, fixed });
}

console.log(`${DB_PATH}: ${rows.length} yoyos, ${changes.length} with dates to normalize.\n`);
for (const { row, fixed } of changes) {
  const parts = Object.entries(fixed).map(([f, n]) => `${f} "${row[f]}" -> "${n}"`);
  console.log(`  #${row.id} ${row.brand} ${row.model} — ${parts.join(', ')}`);
}
if (unreadable.length) {
  console.log(`\nLeft as typed (not a recognizable date):\n${unreadable.join('\n')}`);
}

if (!changes.length) {
  console.log('Nothing to do — already clean.');
} else if (!apply) {
  console.log('\nDry run. Re-run with --apply to write these changes.');
} else {
  db.transaction(() => {
    for (const { row, fixed } of changes) {
      const cols = Object.keys(fixed);
      db.prepare(
        `UPDATE yoyos SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now'), rev = @rev WHERE id = @id`
      ).run({ ...fixed, rev: nextRev(db), id: row.id });
    }
  })();
  console.log(`\nUpdated ${changes.length} yoyos.`);
}
db.close();
