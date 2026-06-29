# 🪀 Yoyo Collection

A self-hosted web app to catalog and showcase your yoyo collection — specs,
purchase info, condition, and multiple photos per throw, with search, filtering,
sorting, stats, a public "For Sale" page, an arrivals calendar for on-order
yoyos, and shareable links for individual throws. No build step, no accounts,
runs from a single folder.

> Catalog your throws, track what's on the way, and show off the collection.

**Live demo:** [test.daveronica.com](https://test.daveronica.com) — log in with the
password `demo` to see the owner/editing view. It's read-only, so you can't break
anything.

<!-- Add screenshots here once you have them, e.g.:
![Collection grid](docs/screenshot-grid.png)
![Detail view](docs/screenshot-detail.png)
-->

## Features
- **Collection** — tile grid or spreadsheet-style table; per-yoyo detail view with
  photos; rich search, filtering, sorting, and selectable columns.
- **Full specs** — weight, diameter, width, gap, bearing, response, materials,
  composition, plus pricing (retail/paid, auto-computed % off) and condition.
- **Collector details** — finish, shape, edition/run, serial number, signature/collab,
  and an estimated current value, alongside acquisition info (purchase & sold dates,
  who you bought from / sold to). Private fields stay hidden from public viewers.
- **Photos** — multiple per yoyo, drag-to-reorder, auto-thumbnailed, with a
  click-to-zoom viewer.
- **For Sale page** — a public, shareable page for the throws you're selling or
  trading, with prices, status badges, and your own shipping/sale notes.
- **Sharing** — share any single yoyo as its own link (it shows the photo and key
  specs when pasted into a chat app), or download a clean card image to send.
- **Arrivals** — a calendar of on-order yoyos by ETA, with inline tracking/ETA
  editing and an optional carrier "Query ETA" button.
- **Insights** — collection totals, spend, standouts, and charts.
- **CSV import / export** and **full backup / restore** (database + photos as one zip).
- **Custom fields** — add your own beyond the built-ins.
- **Public showcase mode** — set a password so visitors see a read-only
  collection (with prices and other private fields hidden) while you log in to edit.
- **Dark mode**, responsive, and embeddable in an iframe.

## Stack
- **Backend:** Node.js + Express
- **Database:** SQLite via Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) — a single file, nothing to compile
- **Photos:** stored on disk under `uploads/`
- **Front end:** plain HTML/CSS/JS (no framework, no build step)
- **Requires:** Node 22+

## Quick start

### With Docker (easiest)
```bash
docker compose up -d
```
Open http://localhost:3000. Your data lives in the `yoyo-data` volume and
survives rebuilds.

### With Node
```bash
npm install
npm start          # or: npm run dev  (auto-restarts on changes)
```
Open http://localhost:3000.

## Configuration
All settings are environment variables and **all are optional** — with none set,
the app runs fully open on port 3000. Copy [`.env.example`](.env.example) to
`.env` and fill in what you want. Highlights:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `DB_PATH` / `UPLOAD_DIR` | Where the database and photos live |
| `ADMIN_PASSWORD` | Public read-only + owner login to edit |
| `READ_ONLY` | Make the whole app read-only |
| `AUTH_USER` / `AUTH_PASS` | HTTP Basic auth over the entire app (fully private) |
| `DEMO_MODE` | Public demo: login works but all writes are blocked, and pages are `noindex` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | Throttle requests per IP (off by default; recommended for public instances) |
| `FRAME_ANCESTORS` | Allow embedding the app in an `<iframe>` on your own site |
| `SESSION_SECRET` | Override the auto-derived owner-login signing key |
| `UPS_*` / `USPS_*` / `FEDEX_*` | Enable carrier ETA look-ups |

See [`.env.example`](.env.example) for the complete, commented list.

## Data & backups
Everything you enter lives in two places:
- the SQLite database (`data/yoyos.db` by default)
- the photo files (`uploads/` by default)

**Where to keep it:** on the machine running the app — local disk, a Docker
volume, or your host's persistent disk. In production, point `DB_PATH` /
`UPLOAD_DIR` at a persistent location; many hosts have ephemeral filesystems
that wipe on redeploy.

> ⚠️ **Don't put the live database in Dropbox / Google Drive / iCloud Drive.**
> File-sync services copy the `.db` file mid-write and don't understand SQLite's
> `-wal` / `-shm` sidecar files, which can **corrupt your collection**. Keep the
> live data on a normal local/host disk.

**Backups:** use **Settings ⚙ → Backup** in the app for a one-file (`.zip`)
snapshot of the database *and* photos, and **Restore** to bring it back. That
zip is safe to store anywhere — *this* is the file to drop in Dropbox/Drive or
keep off-machine. Both data paths are git-ignored so your collection is never
committed.

## Sample data
Want a populated collection to explore (or for screenshots / a public demo)?
```bash
node seed-demo.mjs        # writes data/demo.db with 10 example yoyos
DB_PATH=data/demo.db npm start
```
It refuses to overwrite a database that already has yoyos unless you pass
`FORCE=1`, so it can't clobber a real collection.

## Deploying
It's a standard Node web server, so it runs on most hosts (Docker, Render,
Railway, Fly.io, a VPS, shared cPanel/Passenger hosting, etc.):
1. Start command: `npm start` (or run the Docker image).
2. `PORT` is read from the environment (already handled).
3. Give `data/` and `uploads/` a **persistent volume**, or point `DB_PATH` and
   `UPLOAD_DIR` at one.

A detailed cPanel/Passenger walkthrough is in
[DEPLOY-NAMECHEAP.md](DEPLOY-NAMECHEAP.md), and general notes in
[DEPLOY.md](DEPLOY.md).

## Viewing your collection
The view toolbar (below the filters) controls how the collection is displayed,
and your choices are remembered in the browser.

- **Tiles ↔ Rows** — visual card grid or spreadsheet table. Click any tile/row
  for a detail view with all info and photos (click a photo to zoom); **✎ Edit**
  from there. From the detail view you can also **🔗 Copy link** to share that one
  yoyo as its own page, or **⤓ Share card** to download an image of it.
  Close any modal with its button, `Esc`, or by clicking outside.
- **Sort by column** (row view) — click a header to sort; click again to reverse.
- **Size** (tiles) — Small / Medium / Large.
- **Fields ▾** — choose which fields show (Brand and Model are always shown).
- **Per page** — 12 / 24 / 48 / 96 / All.

## CSV import / export
Use **⤓ Export CSV** / **⤴ Import CSV** in the toolbar. Columns:
```
Brand, Model, Body Material, Composition, In Hand, Color, Retail, Paid, Est. Value,
Purchase Date, Seller, Percent off, Condition, Weight, Diameter, Width, Gap Width,
Bearing Size, Reponse Type, Finish, Shape, Edition, Serial, Signature, Description,
Release Date, Tracking, ETA, Sold Date, Buyer
```
(export appends `Favorite`, `Photos`, and `id`). Import is lenient: column order
and case don't matter, `$85.00`→85 and `64.60 g`→64.6 are parsed, % off is
recomputed, brand+model-less rows are skipped, and rows with a matching `id` are
updated (so re-importing an export won't duplicate). Photos aren't imported.

## REST API
Handy if you want to script against it (subject to the access mode above):
- `GET/POST /api/yoyos`, `GET/PUT/DELETE /api/yoyos/:id`
- `POST /api/yoyos/:id/photos`, `DELETE /api/photos/:photoId`
- `POST /api/track` — carrier ETA look-up (needs carrier creds)
- `GET /api/stats`, `GET /api/config`
- `GET /api/backup.zip`, `POST /api/restore`
- `GET /y/:id` — public, shareable page for a single yoyo (with link-preview tags)

## Running it publicly
If you put an instance on the open internet, a sensible setup is:
- Set **`ADMIN_PASSWORD`** to a long, random value. This keeps the public view
  read-only (prices and other private fields are hidden from visitors) while you
  log in to edit. Avoid a short or guessable password.
- Set **`RATE_LIMIT_MAX`** (e.g. `120`) to throttle abusive traffic and slow down
  password-guessing.
- Serve it over **HTTPS** and force a redirect from HTTP (most hosts can do this).
- Keep the database and photos on a persistent disk (see **Data & backups**).

That's it — there are no accounts or third-party services involved.

## Contributing
Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License
[MIT](LICENSE) © David Barker
