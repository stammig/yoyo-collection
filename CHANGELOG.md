# Changelog

All notable changes to this project are documented here. Every commit that
changes app behavior gets an entry — newest first.

## 2026-07-04 (2)
- **Exempt `/uploads` photo GETs from the rate limiter** — the limiter
  exists to protect the API from abuse, but it was also counting static
  photo file requests. The native app's "Import from server" fetches
  hundreds of photos in a burst and got rate-limited into corrupt
  imports (the app stored the 429 error body as image data — fixed
  app-side too). Photo files are immutable and long-cached; they now
  pass through uncounted.

## 2026-07-04
- **Sold yoyos move to history with real profit/loss tracking** — marking a
  yoyo Sold now actually removes it from the active Collection (grid, list,
  search, and the header stats all start from "owned = everything not Sold"),
  so the collection count and value reflect only what you still own; the
  record itself is untouched and lives on the Sold page. That page gained a
  proper ledger in logical order — **# sold → total proceeds → total cost →
  net profit/loss** — where the net is computed only over sales whose
  original cost (`paid`) is known and the label says so when that's a subset
  ("Net (2 with cost)"). Each sold card now shows its own sale economics:
  `$paid → $proceeds` with the net gain/loss colored green/red by sign, or
  "cost unknown" when `paid` was never recorded. Insights was split the same
  way: owned metrics (count, in hand/on order, Collection value, Saved, Avg
  discount/paid, standouts, brand/composition charts) exclude sold yoyos,
  while **Total paid stays lifetime spend** and is joined by Sold count,
  Recovered, Net spent (`total paid − recovered`), and a signed "Sale net"
  card. New `isSold()`/`ownedYoyos()`/`saleNet()` helpers are the single
  source of truth for all of it.

## 2026-07-03 (4)
- **Add sold-yoyo tracking: new Sold tab, trade valuation, net-spend stats** —
  a new owner-only "Sold" tab lists every yoyo marked Sold (most recent first,
  with a running "N sold · $recovered" total) — no manual bookkeeping, it's
  just a live filter over `sale_status`. Added a `trade_value` column
  (owner-only, like `paid`/`retail`) to record what a *trade* brought in,
  distinct from `sale_price` (the cash amount / public asking price): editing
  a yoyo's Sale Status to "Sold" reveals a Cash sale/Trade toggle inline in
  the form, and picking Trade reveals the Trade Value field. Insights gained
  two new metrics, "Recovered" and "Net spent" (`total paid − recovered`),
  shown once at least one yoyo is sold. The detail view's scattered sale
  fields (`sale_status`/`sale_price`/`sold_date`/`buyer`) are now one
  coherent "Sale" section instead of `sold_date`/`buyer` living oddly under
  "Acquisition". `trade_value` is intentionally left out of the CSV export —
  `sale_status`/`sale_price` were never in it either (a pre-existing gap from
  before the For Sale feature), so this doesn't introduce a new inconsistency.

## 2026-07-03 (3)
- **Expand the dropdown-value audit against the real collection** — the
  earlier pass only saw a stale local dev copy (140 rows); re-ran it against
  a live CSV export (218 rows) and found much more: `6061 Aluminum`/
  `6061 Aluminium`/`6061AL` → `6061 AL`, `7068/7075 Aluminum` → `7068/7075 AL`,
  `POM` → `Delrin` (same material, genericized name), `PC` → `Polycarbonate`,
  a `Size C` bearing entry that just spelled out its own spec, eight more
  `19mm Slim Pad` phrasings, two more `One Drop Flow Groove` phrasings, and
  `Monometal` → `MN` (composition is a fixed BI/MN/TRI picker in the UI, so a
  spelled-out value could only get in via CSV import). Left several
  judgment-call entries un-merged rather than guess: ambiguous/ungraded
  values (`Aluminum` alone, `SS, AL`), values with a real distinguishing
  detail a merge would erase (`Used/Minor Damage`, `Size C Center Trac`,
  `Slim Pad Size D`), and a few verbose one-off construction descriptions
  that may describe different specific yoyos.

## 2026-07-03 (2)
- **Fix Add-form field carryover + mobile layout overflow, dedupe dropdown
  values** — three bugs reported after real-world use:
  - "Save & add another" carried over more than intended: brand carryover was
    a deliberate feature but proved more annoying than useful in practice, so
    it's removed — every new Add form is now fully blank. Composition and
    Condition (the tile-picker fields) were leaking across *any* fresh Add
    form, not just "add another" — root cause was that `form.reset()` can't
    blank a hidden `<input>`, because for that input type the `value` IDL
    property *is* the default value (unlike text/number inputs, which track
    a separate "current" vs. "default" value). The tile click handler's
    `input.value = ...` was permanently overwriting the default. Fixed by
    explicitly clearing each `.tile-group`'s linked input in `openAdd()`.
  - Mobile layout: modal footers (detail view, add/edit form) held 4-5
    buttons in a single non-wrapping flex row, so on an iPhone-width screen
    the primary action (Edit / Save) was pushed off-screen with no way to
    reach it. The Filters and Fields toolbar popovers were anchored `left: 0`
    under buttons that sit right-of-center in the toolbar, so they overflowed
    off the right edge of the screen, hiding several options. Fixed by
    letting `.modal-foot` wrap (forcing the destructive Delete button onto
    its own row via a full-width spacer break) and anchoring both popovers
    `right: 0` — the same pattern the toolbar's "⋯ Data tools" menu already
    used correctly. Also fixed the Status section's In hand/Favorite/Retired
    toggle row clipping "Retired" off-screen on narrow widths.
  - Dropdown/autocomplete fields (Body Material, Bearing Size, Response Type)
    had accumulated near-duplicate free-text entries from being typed
    slightly differently over time (e.g. "6061 AL, Stainless Steel" vs
    "6061 AL, SS", "CLYW Snow Tires" vs "CLYW Snow Tire"). Added
    `normalize-fields.mjs` — a small, re-runnable, exact-match merge script
    (mirrors `fill-specs.mjs`'s pattern) that also writes an equivalent guarded
    SQL script for the live DB. Extend its `MERGES` list whenever a new
    duplicate turns up.

## 2026-07-03
- **Add CHANGELOG.md and document the codebase** (`f508aa1`) — added this file
  and a note in CONTRIBUTING.md to keep it updated going forward. Added a file
  header and doc comments throughout `server.js`, `db.js`, `schema.sql`, and
  ~55 previously-uncommented functions in `public/app.js`, so someone unfamiliar
  with the code can read a function and understand what it does and why.
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
