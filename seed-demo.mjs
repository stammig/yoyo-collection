// Seed a DEMO collection of 10 real yoyos (specs from YoYoExpert / makers).
// Use this to populate a public demo instance or to take screenshots.
//
//   node seed-demo.mjs                 -> writes data/demo.db (safe default)
//   SEED_DB_PATH=/var/data/yoyos.db node seed-demo.mjs   -> a deploy's DB
//
// Safety: it refuses to overwrite a database that already has yoyos unless you
// pass FORCE=1, so it can never clobber a real collection by accident.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.SEED_DB_PATH || process.env.DB_PATH || 'data/demo.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// A mix on purpose: mono + bi-metal, budget + premium, several conditions, a few
// favorites, some with a discount (to show % off), and two on-order (to populate
// the Arrivals page and show what the public view hides).
const YOYOS = [
  { brand: 'CLYW', model: 'Peak 2', color: 'Bloodcell', composition: 'MN', body_material: '6061 AL',
    bearing_size: 'Size C', response_type: 'CLYW Snow Tire', weight_g: 63.9, diameter_mm: 54.55, width_mm: 42.5, gap_mm: 4.6,
    condition: 'NMBTS', retail: 99.99, paid: 99.99, release_date: '2017', favorite: 1, in_hand: 1,
    description: 'The return of a legend — a modern take on the original Peak.' },

  { brand: 'CLYW', model: 'Akita 2025', color: 'Liquid Gold', composition: 'MN', body_material: '6061 AL',
    bearing_size: 'Size C', response_type: 'CLYW Snow Tire', weight_g: 66.2, diameter_mm: 55.35, width_mm: 48.1, gap_mm: 4.5,
    condition: 'MiB', retail: 110, paid: 110, release_date: '2025', favorite: 1, in_hand: 1 },

  { brand: 'Atmos', model: 'Ekta', color: 'Galaxy', composition: 'BI', body_material: '7068 AL, SS',
    bearing_size: 'Size C', response_type: '19mm Pads', weight_g: 67.3, diameter_mm: 58, width_mm: 48, gap_mm: 4.5,
    condition: 'MiB', retail: 199, paid: 185, release_date: '2023', in_hand: 1,
    description: 'Bi-metal designed by Evgeniy Kochergin — fast and stable.',
    sale_status: 'For Sale or Trade', sale_price: 180 },

  { brand: 'Good Life', model: 'Zen', color: 'Seafoam', composition: 'MN', body_material: '6061 AL',
    bearing_size: 'Size C', response_type: '19mm Slim Pad', weight_g: 66.24, diameter_mm: 53.7, width_mm: 47.7, gap_mm: 4.3,
    condition: 'Used', retail: 54.99, paid: 49.99, release_date: '2023', in_hand: 1 },

  { brand: 'Edition', model: 'Forma', color: 'Silver', composition: 'MN', body_material: '6061 AL',
    bearing_size: 'Size C', response_type: '19mm Slim Pad', weight_g: 65.9, diameter_mm: 56, width_mm: 46,
    condition: 'NMBTS', retail: 60, paid: 60, release_date: '2024', in_hand: 1 },

  { brand: 'G2', model: 'Council', color: 'Stone', composition: 'BI', body_material: '6061 AL, SS',
    bearing_size: 'Size C', response_type: '19mm Pads', weight_g: 65.3, diameter_mm: 56.65, width_mm: 48.5,
    condition: 'MiB', retail: 119, paid: 119, release_date: '2024', favorite: 1, in_hand: 1 },

  { brand: 'G2', model: 'Herdsman - AL7', color: 'Fire Blast', composition: 'BI', body_material: '7068 AL, SS',
    bearing_size: 'Size C', response_type: '19mm Pads', weight_g: 63.85, diameter_mm: 55.65, width_mm: 46.75,
    condition: 'Used', retail: 145, paid: 130, release_date: '2024', in_hand: 1,
    sale_status: 'For Trade' },

  { brand: 'YoYoFactory', model: 'Shutter', color: 'Black / Gold', composition: 'MN', body_material: '6061 AL',
    bearing_size: 'Size C', response_type: 'CBC Slim Pad', weight_g: 65.5, diameter_mm: 56, width_mm: 44.4, gap_mm: 4.7,
    condition: 'Beat', retail: 44.99, paid: 39.99, release_date: '2014', in_hand: 1,
    description: 'The classic competition workhorse — Gentry Steins signature throw.',
    sale_status: 'For Sale', sale_price: 30 },

  // ---- on order (shows on Arrivals; pricing + tracking hidden in public view) ----
  { brand: 'One Drop', model: 'Kuntosh', color: 'Acid Wash', composition: 'MN', body_material: '7075 AL',
    bearing_size: 'Size C', response_type: 'One Drop Flow Groove', weight_g: 66.3, diameter_mm: 55.9, width_mm: 45.6, gap_mm: 4.32,
    condition: 'NMBTS', retail: 95, paid: 95, release_date: '2020', in_hand: 0,
    tracking: '1Z999AA10123456784', eta: '2026-07-08' },

  { brand: 'CLYW', model: 'Kodiak', color: 'Northern Lights', composition: 'MN', body_material: '6061 AL',
    bearing_size: 'Size C', response_type: 'CLYW Snow Tire', weight_g: 65.83, diameter_mm: 56.31,
    retail: 89.99, release_date: '2022', in_hand: 0,
    tracking: '9400111899223818971234', eta: '2026-07-15' },
];

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')); // ensure tables exist
// CREATE TABLE IF NOT EXISTS won't add columns to a pre-existing table, so apply
// the same column migrations db.js does (lets reseed work on an older demo DB).
const cols = db.prepare('PRAGMA table_info(yoyos)').all().map((c) => c.name);
if (!cols.includes('sale_status')) db.exec("ALTER TABLE yoyos ADD COLUMN sale_status TEXT NOT NULL DEFAULT ''");
if (!cols.includes('sale_price')) db.exec('ALTER TABLE yoyos ADD COLUMN sale_price REAL');

const existing = db.prepare('SELECT COUNT(*) AS c FROM yoyos').get().c;
if (existing > 0 && !process.env.FORCE) {
  console.error(`Refusing to overwrite ${DB_PATH} — it already has ${existing} yoyos.\n` +
    `If you really mean to wipe and reseed it, re-run with FORCE=1.`);
  process.exit(1);
}

const COLS = ['brand','model','color','body_material','composition','in_hand','condition','retail','paid',
  'weight_g','diameter_mm','width_mm','gap_mm','bearing_size','response_type','description','release_date',
  'tracking','eta','favorite','retired','sale_status','sale_price'];
const insert = db.prepare(
  `INSERT INTO yoyos (${COLS.join(', ')}) VALUES (${COLS.map((c) => '@' + c).join(', ')})`
);

db.exec('BEGIN');
db.exec('DELETE FROM photos; DELETE FROM yoyos;');
db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('yoyos','photos')`);
for (const y of YOYOS) {
  const row = {};
  for (const c of COLS) row[c] = y[c] ?? (['in_hand','favorite','retired'].includes(c) ? 0 : (['retail','paid','weight_g','diameter_mm','width_mm','gap_mm','sale_price'].includes(c) ? null : ''));
  insert.run(row);
}
// Example shipping/sale note for the For Sale page.
db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  .run('sale_notes', 'Ships from the US · buyer pays shipping · PayPal G&S · DM to arrange a sale or trade.');
db.exec('COMMIT');

console.log(`Seeded ${YOYOS.length} demo yoyos into ${DB_PATH}`);
console.log(`  in hand: ${YOYOS.filter((y) => y.in_hand).length}, on order: ${YOYOS.filter((y) => !y.in_hand).length}, favorites: ${YOYOS.filter((y) => y.favorite).length}`);
db.close();
