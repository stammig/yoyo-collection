-- Yoyo collection schema (mirrors the user's spreadsheet columns).
-- Applied on every boot via db.js (CREATE TABLE IF NOT EXISTS — safe to re-run).
-- Columns added after the initial release are migrated in with ALTER TABLE in
-- db.js instead of edited in here, so this file always matches a fresh install
-- while db.js documents the upgrade path for existing databases.

CREATE TABLE IF NOT EXISTS yoyos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid            TEXT,                       -- stable cross-device id for sync (unique index created in db.js)

  -- Identity
  brand           TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '',
  body_material   TEXT NOT NULL DEFAULT '',   -- e.g. "6061 AL, SS"
  composition     TEXT NOT NULL DEFAULT '',   -- BI / MN / TRI

  -- Status
  in_hand         INTEGER NOT NULL DEFAULT 0, -- 1 = in hand, 0 = on order / wishlist
  condition       TEXT NOT NULL DEFAULT '',   -- MiB / NMBTS / Used / Beat

  -- Pricing  (percent_off is computed from these, not stored)
  retail          REAL,
  paid            REAL,
  market_value    REAL,                       -- estimated current value (owner-only)
  purchase_date   TEXT NOT NULL DEFAULT '',   -- when you bought it (ISO date, owner-only)
  seller          TEXT NOT NULL DEFAULT '',   -- who you bought it from (owner-only)

  -- For sale / trade (shown on the public For Sale page)
  sale_status     TEXT NOT NULL DEFAULT '',   -- '' | For Sale | For Trade | For Sale or Trade | Sold
  sale_price      REAL,                       -- asking price
  sold_date       TEXT NOT NULL DEFAULT '',   -- when it sold (ISO date, owner-only)
  buyer           TEXT NOT NULL DEFAULT '',   -- who you sold it to (owner-only)

  -- Specs
  weight_g        REAL,
  diameter_mm     REAL,
  width_mm        REAL,
  gap_mm          REAL,
  bearing_size    TEXT NOT NULL DEFAULT '',   -- Size C / Size D
  response_type   TEXT NOT NULL DEFAULT '',

  -- Edition & appearance (collector details)
  finish          TEXT NOT NULL DEFAULT '',   -- e.g. Blasted, Polished, Pyramatte, Raw
  shape           TEXT NOT NULL DEFAULT '',   -- e.g. Organic, H-Shape, V-Shape, W-Shape
  edition         TEXT NOT NULL DEFAULT '',   -- limited run, e.g. "1 of 50"
  serial_number   TEXT NOT NULL DEFAULT '',   -- engraved serial, if any
  signature       TEXT NOT NULL DEFAULT '',   -- signature player or maker/shop collab

  -- Details / acquisition
  description     TEXT NOT NULL DEFAULT '',
  release_date    TEXT NOT NULL DEFAULT '',   -- free text: "2025", "6/15/2026", etc.
  tracking        TEXT NOT NULL DEFAULT '',
  eta             TEXT NOT NULL DEFAULT '',

  -- User-defined custom fields, stored as a JSON object { fieldKey: value }
  custom          TEXT NOT NULL DEFAULT '{}',

  -- Bookkeeping
  favorite        INTEGER NOT NULL DEFAULT 0,
  retired         INTEGER NOT NULL DEFAULT 0, -- discontinued / limited run (paid may exceed retail)
  deleted_at      TEXT,                       -- soft-delete tombstone; NULL = live. Deletes are kept as
                                              -- tombstones so a future sync could propagate them instead
                                              -- of a stale copy resurrecting the row.
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Definitions for user-added custom fields (columns).
CREATE TABLE IF NOT EXISTS field_defs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,        -- stable slug used in yoyos.custom
  label       TEXT NOT NULL,               -- human label shown in the UI
  type        TEXT NOT NULL DEFAULT 'text',-- text | number | select | boolean
  options     TEXT NOT NULL DEFAULT '[]',  -- JSON array of choices (select only)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  yoyo_id     INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (yoyo_id) REFERENCES yoyos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_photos_yoyo ON photos(yoyo_id);

-- Site-wide key/value settings (e.g. the For Sale shipping notes).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
