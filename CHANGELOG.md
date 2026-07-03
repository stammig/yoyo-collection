# Changelog

All notable changes to this project are documented here. Every commit that
changes app behavior gets an entry — newest first.

## 2026-07-03
- **Shared data layer foundation** (`2c6cba2`) — every yoyo now has a stable
  `uuid` (backfilled on existing rows, generated on create/import/restore,
  preserved on update, exposed in the API). Deletes are now **soft-deletes**:
  a `deleted_at` timestamp is set and photos are purged from disk, but the row
  stays so a future sync can propagate the deletion instead of resurrecting
  it. All reads filter out tombstoned rows. This is groundwork for a future
  sync protocol (see `docs`/roadmap notes) — no API contract changes for
  existing clients.
- **Security hardening and code-review cleanup** (`89a9df4`) — photo uploads
  now derive their file extension from the validated MIME type instead of the
  client-supplied filename, closing a filename-injection hole. Fixed two
  async races: a stale in-flight save could overwrite a newer edit, and
  out-of-order list refreshes could show stale data. Added `aria-labelledby`
  to all modals and an `aria-label` on search. Minor dark-mode shadow fix and
  a couple of dead-code/rename cleanups.

## 2026-06-28
- **Add collector & acquisition fields** (`f87b019`) — added `finish`,
  `shape`, `edition`, `serial_number`, `signature` (public, own "Edition &
  Finish" section) and `purchase_date`, `sold_date`, `seller`, `buyer`,
  `market_value` (owner-only). All auto-migrate on boot and round-trip
  through CSV import/export.
- **Update README** (`19a2a07`) — documented the removed AI auto-fill
  feature, the new For Sale page, sharing, the public demo link, and
  self-hosting notes.
- **Add shareable per-yoyo links and a downloadable share card** (`2f1ec23`)
  — `GET /y/:id` renders a focused, read-only single-yoyo page with Open
  Graph/Twitter meta tags so pasted links unfurl in chat apps. The client
  renders a matching read-only view. Added a client-side `<canvas>`-rendered
  "share card" PNG that respects the collection's visible-field selection and
  the same public-field filtering as the rest of the UI.

## 2026-06-27
- **Drop unused sparkle icon** (`5d6748c`) and **remove dead CSS from the
  logo + auto-fill features** (`302820f`) — cleanup after removing the AI
  auto-fill feature (kept the app dependency-light; no Anthropic SDK
  dependency).
- **Initial public release** (`53442c5`) — first public commit. Self-hosted
  yoyo collection manager: Node/Express + SQLite (`node:sqlite`), plain
  HTML/CSS/JS front end, collection grid/list views with search/filter/sort,
  detail view with photo gallery, arrivals calendar with carrier tracking,
  insights/charts, CSV import/export, full backup/restore, custom fields, and
  configurable access modes (public read-only, demo mode, basic auth).
