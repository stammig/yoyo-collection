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

![The collection: monthly feature, maker filters and the Shelf view](docs/screenshot-collection.jpg)

<p align="center">
  <img src="docs/screenshot-detail.jpg" alt="A yoyo's detail sheet with photos and specs" width="44%">
  &nbsp;
  <img src="docs/screenshot-for-sale.jpg" alt="The For Sale page" width="52%">
</p>

<sub>Screenshots from a real collection's public view — owner-only fields like price paid and seller aren't shown to visitors.</sub>

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
- **Linked videos** — attach YouTube or Instagram links (reviews, trick videos,
  unboxings) to a yoyo. They get their own section, and nothing loads from
  YouTube or Instagram until a visitor presses play. See
  [Linked videos](#linked-videos-youtube--instagram).
- **360° spins and video** — show a throw off in motion: upload a numbered frame
  sequence for a drag-to-rotate 360, or a short looping `.mp4`/`.webm`. Both sit
  in the gallery alongside photos and can be made the cover. List views keep
  showing a still, so the grid stays fast. No ffmpeg needed — see
  [360° spins and video](#360-spins-and-video).
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

### One-line install (easiest)
Requires [Docker](https://docs.docker.com/get-docker/). Copy-paste into a
terminal (macOS / Linux):
```bash
curl -fsSL https://raw.githubusercontent.com/stammig/yoyo-collection/main/install.sh | bash
```
It creates `~/yoyo-collection`, pulls the prebuilt image, optionally asks for an
owner password, and starts the app. Open **http://localhost:3000**. Re-run the
same command any time to update — your data is untouched.

<details>
<summary>Options (install to a different folder, port, or set a password up front)</summary>

```bash
# Install to /opt/yoyo, serve on port 8080, set the owner password without a prompt:
curl -fsSL https://raw.githubusercontent.com/stammig/yoyo-collection/main/install.sh \
  | YOYO_DIR=/opt/yoyo YOYO_PORT=8080 ADMIN_PASSWORD='super-secret' bash
```
`YOYO_DIR`, `YOYO_PORT`, `YOYO_IMAGE` (pin a version tag), and `ADMIN_PASSWORD`
are all honored.
</details>

### With Docker Compose (any OS, incl. Windows)
Grab the compose file and start the prebuilt image — no cloning, no building:
```bash
mkdir yoyo-collection && cd yoyo-collection
curl -fsSL https://raw.githubusercontent.com/stammig/yoyo-collection/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```
Open http://localhost:3000. Your data lives in the `yoyo-data` volume and
survives restarts and updates. Update with `docker compose pull && docker compose up -d`.

### With Node (from source)
```bash
npm install
npm start          # or: npm run dev  (auto-restarts on changes)
```
Open http://localhost:3000.

> **Build the Docker image from source** (instead of pulling it):
> `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`

## Configuration
All settings are environment variables and **all are optional** — with none set,
the app runs fully open on port 3000. Copy [`.env.example`](.env.example) to
`.env` and fill in what you want. Highlights:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `DB_PATH` / `UPLOAD_DIR` | Where the database and photos live |
| `RESTORE_TMP_DIR` | Where Restore puts its scratch folder (defaults to alongside `DB_PATH`) |
| `RESTORE_MAX_MB` | Largest backup Restore accepts (default 8192 MB) |
| `ADMIN_PASSWORD` | Public read-only + owner login to edit |
| `READ_ONLY` | Make the whole app read-only |
| `AUTH_USER` / `AUTH_PASS` | HTTP Basic auth over the entire app (fully private) |
| `DEMO_MODE` | Public demo: login works but all writes are blocked, and pages are `noindex` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | Throttle requests per IP (off by default; recommended for public instances) |
| `FRAME_ANCESTORS` | Allow embedding the app in an `<iframe>` on your own site |
| `SESSION_SECRET` | Override the auto-derived owner-login signing key |
| `TZ` | Your time zone (e.g. `America/New_York`). Only affects the dates in backup and CSV export filenames, which otherwise follow the server's clock (UTC in Docker) |
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

Restore handles multi-gigabyte backups. The browser uploads the file in small
chunks, which keeps it under the request-size limit most shared hosts and
reverse proxies enforce, and the server unpacks it one photo at a time rather
than loading it into memory. The server needs free disk for roughly twice the
backup's size while a restore runs.

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
1. Start command: `npm start` (or run the Docker image
   `ghcr.io/stammig/yoyo-collection:latest`, multi-arch amd64 + arm64).
2. `PORT` is read from the environment (already handled).
3. Give `data/` and `uploads/` a **persistent volume**, or point `DB_PATH` and
   `UPLOAD_DIR` at one.

### On a NAS or Linux server — [DEPLOY-NAS.md](DEPLOY-NAS.md)
The natural home for this app: a Docker container with one persistent local
disk. One guide, with per-platform sections for **OpenMediaVault, Unraid,
Synology, TrueNAS SCALE, QNAP**, and **generic Linux** (Proxmox, Raspberry Pi,
a VPS).

The rule that matters everywhere: **the database must live on a real local
filesystem** — never a union/FUSE layer (mergerfs, Unraid's `/mnt/user`) or a
network share (SMB/NFS). SQLite's locking assumes local disk, and the failure is
silent.

### On macOS or Windows — [DEPLOY-DESKTOP.md](DEPLOY-DESKTOP.md)
Good for a personal catalog on the machine you use; a desktop OS sleeps and
reboots, so it's a weaker fit as the household's always-on collection.

That guide recommends running **natively rather than in Docker** — the reverse
of the NAS advice. Docker Desktop reaches host files through a translation layer
(VirtioFS on macOS, 9p/WSL2 on Windows), the same hazard as a union or network
filesystem. Native puts the database directly on APFS or NTFS. If you do use
Docker there, use a **named volume**, not a bind mount.

### Reaching it from outside your network
[REMOTE-ACCESS.md](REMOTE-ACCESS.md) covers getting to your collection from
anywhere. Short version: a mesh VPN like Tailscale needs no app changes and
exposes nothing to the internet, while genuinely publishing the app means
setting `ADMIN_PASSWORD` and `RATE_LIMIT_MAX` first. Don't forward a router port.

### Elsewhere
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

## Linked videos (YouTube / Instagram)
Links to **other people's videos** about a throw — a review, a trick video, an
unboxing. Paste one into the **Videos** section of the add/edit form, with an
optional label.

They're deliberately kept out of the photo gallery: there are usually several,
and none of them should end up as the cover image for your yoyo.

Accepted link formats:
```
https://www.youtube.com/watch?v=ID          https://youtu.be/ID
https://m.youtube.com/watch?v=ID            https://youtu.be/ID?t=90
https://www.youtube.com/shorts/ID           https://www.youtube.com/live/ID
https://www.instagram.com/p/SHORTCODE/      https://www.instagram.com/reel/SHORTCODE/
```
Mobile (`m.youtube.com`) links, `music.youtube.com`, and links pasted without
`https://` all work, as do the tracking parameters that get appended when you
share from an app. A `t=` / `?t=90` timestamp is preserved, so you can link
straight to the part of a review that discusses the throw. The same video pasted
in two different formats is recognised as a duplicate. Shorts and Reels get a
portrait frame.

**Nothing is requested from YouTube or Instagram until someone presses play.** The
card you see first is local markup; the player `<iframe>` is only created on
click, and YouTube is embedded via `youtube-nocookie.com`. On a public showcase
page that means visitors aren't handed third-party cookies for videos they never
watched — and a yoyo with several videos still opens instantly.

Instagram embeds only work for **public** posts and reels. Private or age-gated
ones will show an empty frame, so every card also carries an "Open on Instagram"
link as a fallback.

## 360° spins and video
Two ways to show a throw in motion, both added from the **Photos** section of
the add/edit form. They sit in the gallery next to your photos — drag either one
to the front to make it the cover.

The server never decodes video, so there's **no ffmpeg to install** and nothing
extra to run on a NAS or SBC.

### 360° spin (drag to rotate)
Shoot a full rotation on a turntable and export it as a **numbered image
sequence**, then use **Add 360° spin** — either pick all the frames at once, or
hand it a single **`.zip`** of them and the server unpacks it for you (frames in
a subfolder are fine, so zipping the export folder just works). Frames are
ordered numerically either way, so `spin_2.jpg` correctly lands before
`spin_10.jpg`.

- 24-72 frames is the usual range (36 is a good default — 10° per frame).
- Export around 800-1200px; every frame is downloaded to rotate the spin.
- Lock the camera and use a plain backdrop — rotate only the yoyo.
- Drop the duplicate final frame; a full turn ends where it started, and keeping
  both makes the loop stutter.

If you have a video instead of frames, ffmpeg on your own machine will do it:
```bash
ffmpeg -i spin.mov -vf "fps=12,scale=1000:-2" -q:v 3 frames/spin_%03d.jpg
```
Rotate it by dragging, or with the ← / → keys when it has focus.

### Looping video
**Add video** takes a short `.mp4` or `.webm` (up to 50 MB). It autoplays,
loops, and is muted — audio is never played. Your browser grabs the poster frame
as it uploads, so list views draw a still rather than pulling the video.

**H.264 in an .mp4** is the safe choice — it plays everywhere. A 5-second
1080×1080 spin lands around 400-800 KB:
```bash
ffmpeg -i spin.mov -an -c:v libx264 -preset veryslow -crf 24 \
  -pix_fmt yuv420p -vf "fps=30,scale=1080:-2" -movflags +faststart spin.mp4
```
`-an` drops the audio track, `-pix_fmt yuv420p` keeps Safari happy, and
`+faststart` lets playback begin before the file finishes downloading.

### Where motion plays
Only the **detail view** and the **zoom lightbox** animate. Tiles, rows, For
Sale, Arrivals and Insights all keep showing a still, so a big collection loads
at exactly the speed it did before.

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
Purchase and sold dates are stored as `YYYY-MM-DD`: `6/15/2026` is read as
month/day, and `15/6/2026` (first number over 12) as day/month. Anything that
isn't a recognizable date, like `Spring 2024`, is kept exactly as typed.

## REST API
Handy if you want to script against it (subject to the access mode above):
- `GET/POST /api/yoyos`, `GET/PUT/DELETE /api/yoyos/:id`
- `POST /api/yoyos/:id/photos`, `DELETE /api/photos/:photoId`
  (deleting a spin removes the whole frame sequence)
- `POST /api/yoyos/:id/spin` — multipart `frames` (2-180 images) **or**
  `archive` (one `.zip` of them), producing one 360° spin
- `POST /api/yoyos/:id/video` — multipart `video` + `poster` (both required)
- `POST /api/yoyos/:id/videos` — JSON `{ url, title? }`, attach a YouTube /
  Instagram link; `DELETE /api/videos/:videoId`
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
Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). See
[CHANGELOG.md](CHANGELOG.md) for a history of what's changed and why.

## License
[MIT](LICENSE) © David Barker
