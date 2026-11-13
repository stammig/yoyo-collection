// Merges duplicate free-text values (different spellings of the same thing)
// so the autocomplete dropdowns for Body Material, Bearing Size, and Response
// Type stop showing near-identical entries side by side (e.g. "6061 AL" vs
// "6061AL" vs "6061 Aluminum"). Run it on the server with DB_PATH pointing at
// the live database. Safe to re-run: once applied, nothing matches.
// Extend MERGES below whenever a new duplicate shows up in the field lists.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openForScript, nextRev } from './sqlite.js';

// [field, duplicate value as currently stored, canonical value to use instead]
const MERGES = [
  // Body material — collapse spelling/spacing variants onto "<grade> AL[, alloy]".
  ['body_material', '6061 Aluminum', '6061 AL'],
  ['body_material', '6061 Aluminium', '6061 AL'],       // British spelling
  ['body_material', '6061AL', '6061 AL'],
  ['body_material', '7068 Aluminum', '7068 AL'],
  ['body_material', '7075 Aluminum', '7075 AL'],
  ['body_material', '6061 AL, Stainless Steel', '6061 AL, SS'],
  ['body_material', 'Al, Delrin', 'AL, Delrin'],          // casing
  ['body_material', 'POM', 'Delrin'],                     // POM is Delrin's genericized name
  ['body_material', 'PC', 'Polycarbonate'],               // abbreviation, standalone entries only

  // Bearing size — collapse onto the "Size C" / "Size D" convention.
  ['bearing_size', 'Konkave', 'Size C'],
  ['bearing_size', 'Size C (.250 x .500 x .187)', 'Size C'], // that's just Size C's own spec

  // Response type — collapse spelling/pluralization/phrasing variants.
  ['response_type', '19mm pads', '19mm Pads'],
  ['response_type', '19mm Standard', '19mm Pads'],
  ['response_type', '19mm Slim Pads', '19mm Slim Pad'],
  ['response_type', '19mm slim pad', '19mm Slim Pad'],
  ['response_type', '19mm slim pads', '19mm Slim Pad'],
  ['response_type', 'Slim 19mm', '19mm Slim Pad'],
  ['response_type', 'Slim Pad 19mm OD', '19mm Slim Pad'],
  ['response_type', 'Slim Pad Size 19mm OD', '19mm Slim Pad'],
  ['response_type', 'CLYW Snow Tires', 'CLYW Snow Tire'],
  ['response_type', 'D-Size Pad', 'Size D Pad'],
  ['response_type', 'One Drop Standard Flow Groove Pad', 'One Drop Flow Groove'],
  ['response_type', 'Original Flow Groove', 'One Drop Flow Groove'],
  ['response_type', 'Stratos pads', 'Stratos Pads'],

  // Composition — the tile picker only offers BI/MN/TRI; collapse the spelled-out form.
  ['composition', 'Monometal', 'MN'],
];

// Honors DB_PATH so the same file works on the live server (where the DB may
// live outside the app dir). Dry run by default; --apply snapshots the database
// beside it, then writes. Each changed yoyo gets a new rev and updated_at so
// synced devices pull the merged value.
//
//   node normalize-fields.mjs                          # show what would change
//   DB_PATH=/path/to/yoyos.db node normalize-fields.mjs --apply
const DB_PATH = process.env.DB_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'yoyos.db');
const apply = process.argv.includes('--apply');
const { db, snapshot } = openForScript(DB_PATH, { apply, label: 'normalize-fields' });
if (snapshot) console.log(`Snapshot saved: ${snapshot}\n`);

const report = [];
const plan = []; // [id, field, to]
for (const [field, from, to] of MERGES) {
  const ids = db.prepare(`SELECT id FROM yoyos WHERE ${field} = ?`).all(from).map((r) => r.id);
  if (ids.length) {
    report.push(`${field}: "${from}" -> "${to}" (${ids.length} row${ids.length > 1 ? 's' : ''})`);
    for (const id of ids) plan.push([id, field, to]);
  }
}

console.log(report.length ? report.join('\n') : '(nothing to merge — already clean)');
if (plan.length && !apply) {
  console.log('\nDry run. Re-run with --apply to write these changes.');
} else if (plan.length) {
  db.transaction(() => {
    for (const [id, field, to] of plan) {
      db.prepare(`UPDATE yoyos SET ${field} = ?, updated_at = datetime('now'), rev = ? WHERE id = ?`).run(to, nextRev(db), id);
    }
  })();
  console.log(`\nUpdated ${plan.length} value${plan.length > 1 ? 's' : ''}.`);
}
db.close();
