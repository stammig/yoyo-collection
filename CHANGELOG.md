# Changelog

All notable changes to this project are documented here. Every commit that
changes app behavior gets an entry — newest first.

## 2026-10-09
- **The 360° spin `.zip` upload now unpacks through `unzip.js`**, the streaming
  reader restore moved to, instead of adm-zip (which main no longer ships).
  Only one frame is in flight at a time and the archive is never read into
  memory. The checks are unchanged: frame count, the declared per-frame and
  total sizes, magic-byte sniffing, and generated names. `extractEntry` gains
  an optional `maxBytes` that the spin path sets to each frame's declared size,
  so an entry whose header understates what it inflates to is stopped there
  rather than trusted. Restore doesn't pass it and behaves exactly as before.

## 2026-08-19 (2)
- **Review fixes to the media work below** (found by an adversarial review pass
  before merge; each was reproduced first, then fixed):
  - **Loose spin frames now enforce the 5 MB/frame cap.** Multer's `fileSize`
    limit is per file across all of an uploader's fields, so the shared spin
    uploader gave loose frames the *archive's* allowance — one request could
    write up to 180 oversized files where the zip path refused at 5 MB. Frames
    and archive are now separate endpoints (`/spin`, `/spin-archive`) with
    separate uploaders, which also makes the frames+archive-together request
    (whose loose files were silently orphaned) impossible by construction. The
    archive allowance drops 300 MB → 100 MB — real turntable exports are tens of
    MB.
  - **A video transported by sync now gets its poster.** The sync bytes endpoint
    accepts an optional `poster` part alongside video bytes (mirroring the web
    upload route), the manifest keeps requesting a video's uuid until both files
    exist, and until then list views serve a bundled placeholder still instead
    of the permanent 404 tile they used to show. The bytes-first fallback INSERT
    also stamps `kind` from the mimetype, so an .mp4 uploaded before its
    manifest no longer becomes a "photo" rendered as a broken `<img>`.
  - **`/api/sync/changes` now tells the truth about stills**: each photo entry
    carries `still_url` (the image to render — a video's poster, the file
    itself otherwise) and `thumb_url` only for files a thumbnail actually exists
    for. It used to advertise `thumb-<video>.jpg` and a thumbnail for every spin
    frame, none of which exist. An explicit manifest `kind` can now also correct
    an existing row, while manifests from older clients (no `kind`) can no
    longer flatten a video or spin back to a plain photo.
  - **Rejected multipart uploads no longer leave files behind** — the error
    handler removes whatever multer had already written when a later part
    tripped a limit or filter.

## 2026-08-19
- **Two fixes to the 360°/video media work below** —
  - `/api/sync/changes` was sending each photo without its `kind` or
    `group_uuid`, so a sync client would have rendered a 360 spin as N loose
    frames and pushed back a manifest that flattened it permanently. Both
    fields now ride along with every photo in the change feed.
  - Soft-deleting a yoyo freed its photo files and thumbnails but not a looping
    video's poster still (or that poster's thumbnail), leaving them orphaned in
    `uploads/`. Both tombstone paths — `DELETE /api/yoyos/:id` and a delete
    arriving via sync push — now go through `mediaFilesFor`, so every file a row
    owns is removed whatever its kind.

## 2026-08-21
- **`spin-frames.sh` + SPIN-FRAMES.md** — a companion script (runs on your own
  machine, not the server) that turns turntable videos into ready-to-upload
  360° spins: it auto-detects the in-point (when your hand leaves the shot,
  via ffmpeg signalstats) and the rotation period (SSIM against a reference
  frame, earliest peak = one full turn), then emits the frame sequence, a
  zip of it, and a muted H.264 loop. Takes single files or whole folders;
  `-p` skips detection when the turntable's period is known. Only needs
  ffmpeg/ffprobe/zip. Field-tested on GoPro footage of both fast (~31s) and
  slow (~62s) turntable modes, including the mirror-side half-rotation trap
  the doc explains.

## 2026-08-18
- **360° spins and looping video** — a yoyo's gallery can now hold more than
  stills. **Add 360° spin** takes a numbered frame sequence and renders a
  drag-to-rotate viewer (pointer, touch, and ← / → keys); **Add video** takes a
  short `.mp4`/`.webm` that autoplays muted on loop. Either can be dragged to
  the front to become the cover.
  - A spin can be handed over as loose frames **or as a single `.zip`**, which
    the server unpacks (frames nested in a folder are fine). Archive members are
    identified by magic bytes and re-named on the way in, and their paths are
    ignored entirely, so a crafted entry name can't write outside `uploads/`.
  - No new dependencies, and **no ffmpeg** — spins arrive as already-extracted
    frames, and the browser reads a video's poster frame out via canvas before
    upload, so the server never decodes anything.
  - `photos` gains `kind` (`photo`/`video`/`spin`) and `group_uuid`; a spin is
    one row per frame sharing a group, which the API collapses back into a
    single gallery entry. Existing rows migrate to `kind = 'photo'` with no data
    pass, and one-row-per-file means backup/restore and the sync photo manifest
    needed no special cases.
  - Every gallery entry's `url`/`thumbUrl` still points at a still image
    whatever its kind, so tiles, rows, For Sale, Arrivals and Insights render
    unchanged and a big collection loads no slower. Only the detail view and the
    lightbox animate.
  - Deleting a spin removes its whole frame sequence, and reordering keeps a
    spin's frames contiguous and in sequence.

## 2026-10-05
- **Condition is spelled NMTBS everywhere** ("Near Mint To Be Safe"). The old
  misspelling NMBTS kept coming back from CSVs, backups and synced devices. Every
  write path (form, CSV import, restore, sync push) now converts NMBTS to NMTBS.
  Existing rows are fixed once at startup, and their rev is bumped so synced
  devices pull the corrected value.
- **Composition labels are Mono-material / Bi-material / Tri-material.** The
  stored codes stay MN / BI / TRI. Free-text values such as "Plastic",
  "Bi-metal" or "mono-material" are mapped to the matching code.
- **Tests** — `npm test` (Node's built-in runner, no new dependencies), run in
  CI on Node 22.13 and 24 for every push and PR. Covers owner-only fields never
  reaching logged-out visitors, CSV import matching and round trips, date
  normalization, and `unzip.js`.
- **Fix: a CSV listing two identical yoyos collapsed them into one.** Both rows
  matched the same yoyo by brand + model + color, so the second overwrote the
  first; and one row with two identical candidates created a third copy. Each
  yoyo can now be matched by only one row per import (oldest first), and a row
  with no unclaimed match is added as new. Found by the new tests.
- **Fix: linked videos were wiped by every "Publish to website"** from the
  native apps. Publishing restores from the app's database, which has no
  videos table (videos are web-only), and restore replaced everything. Now,
  when a backup has no videos table at all, the site's existing videos are
  kept for every yoyo the backup still contains (matched by uuid). A web
  backup — which has the table — still restores videos exactly. The restore
  response reports `videosKept`.
- **Self-hosting guides** (#5, thanks @bmurphy-dev): `DEPLOY-NAS.md`,
  `DEPLOY-DESKTOP.md` and `REMOTE-ACCESS.md`. Their restore notes are updated
  for the streaming, chunked restore (memory no longer scales with backup size).
- **Fix: restoring a backup from a newer version could be refused** on Node
  builds without `setAllowUnknownNamedParameters` — an extra column in the
  backup became an unmatched SQL parameter. Restore now passes only the columns
  this schema has. Reported in #7 by @bmurphy-dev.
- **Security updates** — clears all open Dependabot alerts (`npm audit`: 0).
  multer 2.2.0 → 2.4.0 (5 advisories; 2.3.0 was still affected), sharp 0.35.2 →
  0.35.5, brace-expansion 2.1.4 → 2.1.7 (via archiver), and csv-parse 5.6 → 7.0.3
  (major bump; the sync `parse()` options used by CSV import are unchanged —
  verified with BOM, quoted fields, embedded commas/newlines and a full
  export → re-import round trip). Existing installs need `npm install`.

## 2026-10-04
- **Fix: restoring a large backup failed with "Request failed (413)".** A full
  backup with photos is easily over a gigabyte, and shared hosts reject a
  request body that size in the proxy in front of Node, before the app sees
  it. (The app also capped a restore at 200MB.) Restore now works at any size:
  - **The browser uploads in chunks** (new `/api/restore/uploads` routes),
    with a progress readout. It starts at 8MB and halves on a 413 until chunks
    fit the host's limit. Each chunk is retried on its own after a dropped
    connection or a rate-limit 429, so a hiccup costs seconds, not the upload.
  - **The server unpacks the zip by streaming** (new `unzip.js`, Zip64-aware)
    instead of adm-zip, which read the whole archive into memory. Restoring a
    1.24GB backup now peaks under 100MB. The `adm-zip` dependency is gone.
  - **Photos are written before the collection is replaced**, so a restore
    that fails part-way (disk full, corrupt file) leaves the collection as it
    was.
  - New optional `RESTORE_MAX_MB` (default 8192). The one-shot `POST
    /api/restore` used by the native apps' "Publish to website" is unchanged.
- **Fix: "Publish to website" reported dozens of failed photos with the rate
  limiter on.** The apps send a HEAD for every photo to skip ones already
  uploaded, and only photo GETs were exempt from the limiter, so a large
  publish exhausted `RATE_LIMIT_MAX` on checks alone and the uploads after it
  got 429s. Photo HEADs are now exempt too.

## 2026-10-03
- **Dates: one convention, and five bugs it fixes** (issue #14). Calendar days
  (`purchase_date`, `sold_date`, `eta`) are local `YYYY-MM-DD`; instants stay
  UTC. Written down in `CONTRIBUTING.md` and `dates.js`.
  - **Bulk "Mark sold" records your date, not UTC's.** It sliced the date off
    `toISOString()`, so anyone in the Americas marking a sale in the evening
    got tomorrow's date. It now uses the browser's local calendar.
  - **Date columns sort chronologically** on Collection, For Sale, Arrivals and
    Sold, with blanks last in both directions. They were compared as text, so
    `6/15/2026` sorted after `2026-09-01`.
  - **Purchase and sold dates are normalized on every write** — save, CSV
    import, and sync push — to `YYYY-MM-DD`. `a/b/yyyy` reads as month/day
    unless the first number is over 12; anything unrecognizable (`Spring 2024`)
    is kept as typed. `normalize-dates.mjs` fixes rows stored before this (dry
    run by default, `--apply` to write; bumps `rev` so synced devices re-pull).
  - **The edit form no longer rewrites a day/month date into the wrong year.**
    `15/6/2026` was read as month 15 and rolled over to 2027-03-06, which Save
    then wrote back. Impossible dates now read as no date at all, and free text
    without a day in it (`Spring 2024`, `March 2024`) is no longer turned into
    the 1st of the month.
  - **Saving the edit form no longer erases a date it can't display.** A stored
    value the date picker couldn't show (`Spring 2024`, `TBD`) was saved back
    as blank; it's now kept unless you change that field.
  - **Backup and CSV filenames use local time**, so a `TZ` setting is respected
    (new optional `TZ` in `.env.example` / `docker-compose.yml`).

## 2026-09-05 — Release v1.2.0
- **Read-only mode: the way back, and the owner's whole view** — three fixes
  to the follow-through of the read-only switch:
  - The **Settings gear no longer disappears** in read-only mode, so the switch
    is actually reachable while it's on (before, the same CSS rule that hides
    the Add button hid the gear too — the one way to turn it back off). The
    gear is now owner-only chrome instead of read-only chrome.
  - **Arrivals and Sold open again for the owner in read-only mode.** The view
    router still bounced to Collection on the old edit-permission flag while
    the sidebar showed the items; both now hang off ownership. Public viewers
    see exactly what they saw before.
  - **Owner-only data displays follow ownership, not edit permission:** stats,
    ledger band, paid/retail/value rows, sensitive table columns and filters,
    financial sort options, "on order" badges, and the sale-view stats all
    show for a read-only owner again (the owner's view stays whole — the
    intent the switch shipped with). Editing controls stay gated on edit
    permission and are untouched.
- **Carrier ETA query works in read-only mode** — POST /api/track was caught by
  the method-based write gate, so a read-only owner lost the Arrivals "Query
  ETA" button. It changes nothing in the collection and stays owner-only; it
  is now exempt from the read-only gate, like the toggle and publishing.
- Version bump to 1.2.0 (Settings → Version & updates reads it from here).

## 2026-08-25
- **Fix: desktop scroll showed page content in a gap above the pinned Collection
  header.** The header pinned at `top: 55px` — an offset sized for the old sticky
  toolbar, which the top-bar redesign made static — so the grid scrolled visibly
  through the 55px strip where the toolbar used to sit. The whole header stack is
  now sticky on desktop: the top bar (brand + nav), the view title beneath it,
  and the Collection header beneath both, each pinned flush under the layer
  above. Those heights aren't constants (the top bar wraps at narrower windows),
  so a ResizeObserver measures them into `--topbar-h` / `--toolbar-h` instead of
  hardcoding new offsets. Phones and embeds are untouched — nothing up there is
  sticky for them, same as before.
- **Fix: a phantom click target in the edit form flipped the Retired toggle.**
  The form body is a CSS multicol, and the toggles' hidden checkboxes were
  `position: absolute` with no positioned ancestor — in multicol their static
  position resolves against the un-fragmented flow, so all three escaped their
  labels and stacked into an invisible clickable area over the opposite column
  (near Photos). Clicking it toggled whichever input was last in the DOM:
  Retired. The switch label is now `position: relative` and the input ignores
  pointer events; the label keeps forwarding clicks and keyboard focus, so
  nothing else changes.

## 2026-08-19 (6)

- **Read-only mode, as a switch in Settings** — for the mirror setup where
  another device holds the master copy: editing here only creates work that
  the next publish quietly destroys. The switch is stored server-side (the
  settings key/value table), so it holds for every visitor and survives a
  restart. Editing and ownership are now two separate questions — isOwner
  (see owner-only data) vs canEdit (change the collection) — so turning
  editing off removes every edit control while leaving the owner's own view
  whole. The switch itself and publishing (/api/restore, /api/sync/*) stay
  available; neither survives demo mode. The env READ_ONLY is untouched.

- **Don't send the original's uuid when duplicating** — bulkDuplicate stripped
  every field "except identity" but not identity itself: a duplicate travelled
  carrying the original's uuid. The server always overwrote it on POST, so
  nothing was ever wrong on the wire — but two records sharing a uuid is the
  one payload that breaks the unique index and every client keyed on that id,
  so it should not be in flight at all.




- **Linked videos (YouTube / Instagram)** — a yoyo can now carry links to other
  people's videos: reviews, trick videos, unboxings. Paste a link (with an
  optional label) in the new **Videos** section of the add/edit form; they show
  in their own section of the detail view.
  - Kept **out** of the photo gallery on purpose. There are usually several per
    yoyo and none of them should become its cover image, so they live in a new
    `videos` table — a row has no file, and none of the list views need to know
    they exist.
  - **Nothing is requested from YouTube or Instagram until a visitor presses
    play.** The card is local markup and the `<iframe>` is created on click, so a
    public showcase page hands out no third-party cookies for videos nobody
    watched, and a yoyo with several videos still opens instantly. YouTube is
    embedded through `youtube-nocookie.com`.
  - Accepts every common link shape: `watch?v=`, `youtu.be/`, **`m.youtube.com`**,
    `music.youtube.com`, `/shorts/`, `/live/`, `/embed/`, Instagram `/p/`,
    `/reel/` and `/tv/` (including the `/<user>/reel/<code>` form), links pasted
    without a scheme, and app-share tracking parameters. A `t=`/`t=1m30s`
    timestamp is preserved. Shorts and Reels get a portrait frame.
  - Only whitelisted hosts are accepted and ids are pattern-matched, so the embed
    URL is rebuilt from a fixed template rather than from pasted text — a
    lookalike host like `youtube.com.evil.tld`, or a `javascript:`/`data:` URL,
    is rejected. Because links normalise to a provider + id pair, the same video
    pasted in two formats is detected as a duplicate.
  - Backup/restore carries videos, and restoring a backup made *before* this
    release still works (a missing `videos` table is an empty list, not an
    error). Deleting a yoyo clears its video rows, including via sync push.


- **Review fixes to the linked-videos work below** (found by an adversarial
  review pass before merge; each was reproduced first, then fixed):
  - The video-link box is a plain text input now. It was `type="url"` inside the
    yoyo form, so a schemeless link left in it — `youtube.com/…`, a form the
    feature explicitly supports — failed native validation and **blocked saving
    the entire yoyo** with a browser bubble. Validation belongs to the server's
    parser, which already handles schemeless links.
  - A link left in the box when you hit **Save** is now folded into the save
    instead of silently vanishing with the modal; if it's a bad link, the save
    stops with everything intact and a clear message.
  - Stored links are the **normalized absolute URL**, not the raw paste — a
    schemeless paste used to render "Open on YouTube" as a relative link into
    this app (a 404 on your own host).
  - Instagram path parsing uses `Object.hasOwn` instead of `in`, which also
    matched inherited `Object.prototype` keys — `instagram.com/constructor/…`
    stored the stringified `Object` constructor as an embed path.

- **Untitled videos now caption themselves with the real video title**, fetched
  once server-side from YouTube's keyless oEmbed endpoint when a video is added
  without a title (a typed title always wins). Existing blank-title rows are
  filled in quietly at boot. Instagram's oEmbed requires an API token, so IG
  cards keep the generic label.

- **Cards now show the real video thumbnail** (feedback from device testing —
  the placeholder-only cards read as broken). The server fetches YouTube's
  thumbnail once per video and serves it from `uploads/` like any other image,
  so viewers' browsers still make zero third-party requests before pressing
  play. Fetched at add time, self-healing in the background for videos that
  predate the cache, refcounted on delete (two yoyos sharing a video share one
  cached file). Instagram publishes no tokenless thumbnail endpoint, so IG
  cards keep the local placeholder.

## 2026-08-15
- **Restore no longer buffers the whole backup in memory** — `POST /api/restore`
  used `multer.memoryStorage()`, holding the entire upload (up to 200MB) as a
  Buffer for the whole request: across what can be a multi-minute upload on a
  home connection, retained even when the file turned out not to be a valid zip,
  and multiplied by any concurrent request. Uploads now stream to a scratch
  directory, and the handler deletes the file on every exit path — the body moved
  into `restoreFromZip()` so a single `try/finally` covers the early validation
  returns too. Measured on a 121MB backup: peak RSS over baseline dropped from
  **274MB to ~190–210MB**. The remainder is `adm-zip`, which reads the whole
  archive into a Buffer even when handed a path (`adm-zip.js` → `readFileSync`),
  so eliminating the rest of the spike would need a streaming unzip library.
  Backup was already stream-based and is unchanged.

  The scratch directory is `restore-tmp` **next to the database**, deliberately
  not `os.tmpdir()`: `/tmp` is tmpfs — RAM — on Armbian, Fedora, recent Ubuntu,
  and most SBC images tuned to spare an SD card, so temp-filing a 200MB upload
  there would have put it straight back into memory. It's swept clean at startup
  so a crash mid-restore can't leave anything behind, and it sits outside what
  backups archive (`DB_PATH` and `UPLOAD_DIR` only).

  A new **`RESTORE_TMP_DIR`** relocates it, for when the database sits on a disk
  too small to absorb a transient copy of the backup — `render.yaml` provisions
  1GB, and now points this at `/tmp` so the upload uses ephemeral instance
  storage instead. It names the *parent*: a `restore-tmp` subdirectory is always
  created inside it and the startup sweep only touches that subdirectory, so
  setting it to `/tmp` can't mean "empty /tmp on boot".
- **Fix: restore left `-wal`/`-shm` files behind on every run** — the extracted
  backup database is opened read-only, but backups are taken from a WAL database
  so the copy carries WAL mode in its header and SQLite creates both sidecars
  alongside it. Cleanup removed only the `.db`, so two small files leaked per
  restore into `os.tmpdir()` — where, on a tmpfs `/tmp`, they were leaking RAM.
- **`.env` now works when running with `node server.js`** — README and
  `.env.example` both say to copy `.env.example` to `.env`, but there's no dotenv
  dependency, so a plain `npm start` ignored the file entirely and silently ran
  with defaults. A new `load-env.js` calls `process.loadEnvFile()` if the file
  exists. It's imported first in `server.js` because `db.js` resolves `DB_PATH`
  (and creates that directory) at import time, and ESM evaluates imports before
  any module body — so anything later would be too late. No new dependency, and
  no output when there's no `.env`, which is the normal case in Docker.
- **Fix `engines` floor: `22.x` → `>=22.13 <23 || >=23.4`** — `node:sqlite`
  landed in Node 22.5 behind `--experimental-sqlite` and was only unflagged in
  **22.13.0** on the 22.x line and **23.4.0** on the 23.x line (a plain
  `>=22.13` would wave through Node 23.0–23.3, where startup still dies with
  `ERR_UNKNOWN_BUILTIN_MODULE`), so the
  old range advertised support for 22.5–22.12, where the app can't start at all
  (`ERR_UNKNOWN_BUILTIN_MODULE`). The Docker image was never affected; this bit
  native installs, which the deployment guides now describe.
- **Self-hosting deployment guides** — three new docs covering where to actually
  run this, since "give `data/` and `uploads/` a persistent volume" was the only
  guidance outside the cPanel walkthrough. [`DEPLOY-NAS.md`](DEPLOY-NAS.md) covers
  NAS appliances and Linux servers (OpenMediaVault, Unraid, Synology, TrueNAS
  SCALE, QNAP, plus generic Linux/Proxmox/Raspberry Pi/VPS);
  [`DEPLOY-DESKTOP.md`](DEPLOY-DESKTOP.md) covers macOS and Windows;
  [`REMOTE-ACCESS.md`](REMOTE-ACCESS.md) covers reaching an instance from outside
  the LAN. Each is structured as shared setup first, then per-platform notes, so
  the common material lives in one place.

  The through-line is a storage rule the app depends on but never stated: **the
  database must sit on a real local filesystem.** SQLite's locking assumes one,
  so a union/FUSE layer (mergerfs, Unraid's `/mnt/user` shfs), a network share
  (NFS/SMB), or a Docker Desktop bind mount on macOS/Windows can all break it —
  and the failure is silent, because `journal_mode = WAL` is quietly ignored and
  the `wal_checkpoint(TRUNCATE)` that makes `GET /api/backup.zip` trustworthy
  becomes a no-op. On single-board computers the same reasoning rules out putting
  the database on the microSD boot card. Docs only; no code changes.

## 2026-08-02 (3)
- **Dependency security updates (Dependabot)** — patched six advisories by
  bumping: **multer** → 2.2.0 (DoS via deeply nested field names; incomplete
  cleanup of aborted uploads), **adm-zip** → 0.6.0 (crafted-ZIP 4 GB allocation),
  **brace-expansion** → 2.1.4 (two DoS) and **body-parser** → 1.20.6 (size-limit
  bypass), both transitive. adm-zip 0.6 is a 0.x bump but its API is unchanged
  for our use; verified with a full backup → restore roundtrip and a photo
  upload. `npm audit` is clean (0 vulnerabilities).

## 2026-08-02 (2)
- **Security hardening (from CodeQL code scanning)** —
  - Session-token signing key is now derived from `ADMIN_PASSWORD` with **scrypt**
    (a slow KDF) instead of SHA-256, so a captured token can't be used for a cheap
    offline dictionary attack on the password. Deterministic across restarts;
    `SESSION_SECRET` still overrides. (Existing sessions re-authenticate once.)
  - `slugify()` no longer uses a backtracking-prone trim regex on owner-supplied
    field labels and bounds input length — removes a potential ReDoS.
  - Sync photo cleanup path now goes through `path.basename` (defense-in-depth
    alongside the existing uuid validation).
  - Gallery size is coerced to the known `sm/md/lg` set before it reaches markup;
    the sale dialog's accessible name is taken from rendered text rather than a
    regex tag-strip.

## 2026-08-02
- **Settings → Version & updates** — the app now shows the version it's running
  and a **Check for updates** button that compares it against the latest GitHub
  release (`GET /api/check-update`, owner-only, cached 5 min, soft-fails when
  offline). When a newer release exists it shows the new version, a release-notes
  link, and the exact copy-paste update command for how this instance is running
  — `docker compose pull && docker compose up -d` inside a container, otherwise
  `git pull && npm install && npm start` (both overridable via `UPDATE_HINT`;
  `UPDATE_REPO` lets forks point at their own repo). The app never updates
  itself — a containerized process can't safely restart into a new image — so
  this is advisory. `GET /api/config` now also returns `version`.

## 2026-08-01
- **One-line install + prebuilt Docker image** — a new `install.sh` lets anyone
  set the app up with a single command
  (`curl -fsSL .../install.sh | bash`): it checks for Docker, creates an install
  folder, optionally prompts for an owner password (stored in `.env`, passed to
  the container verbatim via `env_file`), pulls the image, and starts on
  :3000 — and re-running it updates in place. A GitHub Actions workflow
  (`.github/workflows/docker-publish.yml`) publishes a multi-arch (amd64 +
  arm64) image to `ghcr.io/stammig/yoyo-collection` on every push to `main` and
  version tag. `docker-compose.yml` now pulls that prebuilt image (no build
  step); `docker-compose.build.yml` is the override for building from source.
- **Fix: Ledger "Listed" status filter ignored by the filter controls** —
  selecting **Listed** filtered the collection but left the "Clear all" button
  hidden, the filter badge at 0, and no removable chip, and "Clear all filters"
  never reset it (the collection stayed silently filtered to for-sale items).
  `filters.listed` is now wired into `filtersActive`, `activeFilterCount`,
  `renderActiveFilters`, and `clearAllFilters`.

## 2026-07-27 (2)
- **New Gallery view — a wall of your yoyo photos** — a dedicated sidebar
  section (`data-view="gallery"`) that lays every photographed yoyo out as a
  dense grid of square lead images (`renderGallery`). Captions (brand/model)
  are hidden by default, fade in on hover, and can be pinned on for every tile
  with the toolbar's **Info** toggle; a Small/Medium/Large control resizes the
  wall. Favourites show a gold star and For Sale/Sold tiles a corner badge.
  Photo-less yoyos are omitted (the toolbar notes how many: "N photos · M
  without"). Clicking a tile opens the detail modal, stepping through the
  gallery's own order.
- **Insights: "Yoyo of the day"** — a featured banner at the top of Insights
  picks one yoyo deterministically from the calendar day (stable all day,
  rotates daily; prefers photographed yoyos), showing its photo, name, a couple
  of chips, and key specs. Click to open its detail.
- **Insights: average specs** — a new "Average specs" card showing the mean
  weight / diameter / width / gap across the owned collection, as metric tiles
  (only specs that have data appear).

## 2026-07-27
- **Fix modals rendering unusable — footer floated over the content** — every
  modal (detail, add/edit, settings, login) sized its card to full natural
  height and let the whole `.modal` overlay scroll, while `.modal-foot` was
  `position: sticky; bottom: 0`. On any card taller than the viewport the
  footer pinned to the *viewport* bottom mid-card, overlapping the fields with
  the rest of the form clipped off-screen below it. The card is now a flex
  column capped to the viewport (`max-height: 100%`, which resolves against the
  fixed `.modal`'s height and respects its 44px padding); the head and foot are
  `flex: 0 0 auto`; and the middle region scrolls internally — `.detail-body`
  for the detail modal, `.modal-card > .form` for add/edit/login/settings
  (`flex: 1 1 auto; min-height: 0; overflow-y: auto`). The sticky footer now
  pins to that contained scroll area. Bottom padding is zeroed on footer-bearing
  forms (`#modal`/`#loginModal` via `:has(> .modal-foot)`) so the footer seats
  flush instead of leaking a strip of content below it. Verified on desktop,
  mobile (375px footer-wrap), light/dark, and on the live site in a short
  viewport (card caps, footer flush, no overlap).

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
