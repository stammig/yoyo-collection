// Merges duplicate free-text values (different spellings of the same thing)
// so the autocomplete dropdowns for Body Material, Bearing Size, and Response
// Type stop showing near-identical entries side by side (e.g. "6061 AL" vs
// "6061AL" vs "6061 Aluminum"). Applies to the local DB and writes an
// equivalent guarded SQL script (normalize-fields.sql) for the live DB.
// Safe to re-run: each entry is an exact-match UPDATE, a no-op once applied.
// Extend MERGES below whenever a new duplicate shows up in the field lists.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

// [field, duplicate value as currently stored, canonical value to use instead]
const MERGES = [
  // Body material — collapse spelling/spacing variants onto "<grade> AL[, alloy]".
  ['body_material', '6061 Aluminum', '6061 AL'],
  ['body_material', '6061AL', '6061 AL'],
  ['body_material', '6061 AL, Stainless Steel', '6061 AL, SS'],
  ['body_material', 'Al, Delrin', 'AL, Delrin'],

  // Bearing size — collapse onto the "Size C" / "Size D" convention.
  ['bearing_size', 'Konkave', 'Size C'],

  // Response type — collapse spelling/pluralization variants.
  ['response_type', '19mm Slim Pads', '19mm Slim Pad'],
  ['response_type', '19mm pads', '19mm Pads'],
  ['response_type', 'CLYW Snow Tires', 'CLYW Snow Tire'],
  ['response_type', 'D-Size Pad', 'Size D Pad'],
];

const sqlEsc = (v) => `'${String(v).replace(/'/g, "''")}'`;

// Honors DB_PATH so the same file works on the live server (where the DB may
// live outside the app dir). Falls back to the local default.
const DB_PATH = process.env.DB_PATH || 'data/yoyos.db';
const db = new DatabaseSync(DB_PATH);
let changed = 0;
const sqlLines = [];
const report = [];

for (const [field, from, to] of MERGES) {
  sqlLines.push(`UPDATE yoyos SET ${field} = ${sqlEsc(to)} WHERE ${field} = ${sqlEsc(from)};`);
  const res = db.prepare(`UPDATE yoyos SET ${field} = ? WHERE ${field} = ?`).run(to, from);
  if (res.changes > 0) {
    changed += res.changes;
    report.push(`${field}: "${from}" -> "${to}" (${res.changes} row${res.changes > 1 ? 's' : ''})`);
  }
}

fs.writeFileSync('normalize-fields.sql',
  '-- Merges duplicate free-text field values. Safe to run once on the live DB:\n' +
  '-- each statement is an exact-match UPDATE, a no-op if already applied.\n' +
  'BEGIN;\n' + sqlLines.join('\n') + '\nCOMMIT;\n');

console.log('Local rows updated:', changed, '\n');
console.log(report.length ? report.join('\n') : '(nothing to merge — already clean)');
console.log('\nLive SQL written to normalize-fields.sql');
db.close();
