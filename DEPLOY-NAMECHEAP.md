# Hosting the Yoyo Collection on Namecheap (cPanel + Node.js)

Namecheap shared hosting can run this Node/Express/SQLite app via cPanel's
**Setup Node.js App** (Passenger). Benefits over Render: **unmetered bandwidth**
and a **persistent disk** (your DB + photos won't be wiped, and you won't get
suspended for egress).

Target **Node 22.x** (matches the app's engines pin). Your cPanel username
appears in paths as `USER` below — substitute your own.

---

## 1. Put the code on the server
Easiest = upload a zip:
1. Download the repo as a zip (GitHub → Code → Download ZIP), or export your
   local `yoyo-collection` folder **without** `node_modules`.
2. cPanel → **File Manager** → create a folder `yoyocollection` in your home dir.
3. Upload the zip there and **Extract** so `server.js`, `package.json`, `public/`
   etc. sit directly in `~/yoyocollection`.

(Alternatively cPanel → **Git Version Control** → clone the repo. The repo is
private, so you'd need a GitHub access token in the clone URL.)

## 2. Create a place for data (survives redeploys)
cPanel → File Manager → create `~/yoyo-data` and inside it `uploads`.
Keeping data outside the code folder means re-uploading code never risks it.

## 3. Create the Node app
cPanel → **Setup Node.js App** → **Create Application**:
- **Node.js version:** `22.22.3`
- **Application mode:** Production
- **Application root:** `yoyocollection`
- **Application URL:** a subdomain, e.g. `yoyos.example.com`
  (create the subdomain first under **Domains** if it isn't offered here)
- **Application startup file:** `app.cjs`
  (a CommonJS shim that loads the ESM `server.js` — required because
  LiteSpeed/Passenger `require()` the startup file, which can't load an ESM
  module that has top-level await)
- Save.

## 4. Environment variables
In the Node app panel, add (use your real values / `USER`):
- `ADMIN_PASSWORD` = your owner password
- `DB_PATH` = `/home/USER/yoyo-data/yoyos.db`
- `UPLOAD_DIR` = `/home/USER/yoyo-data/uploads`

Optional — **carrier tracking** (the "Query ETA" button on Arrivals). Add only
the carriers you want; each needs a production OAuth client (not sandbox). The
button appears once at least one pair is set, and the app restarted.
- `UPS_CLIENT_ID` / `UPS_CLIENT_SECRET` — from [developer.ups.com](https://developer.ups.com) → your app → OAuth credentials
- `USPS_CLIENT_ID` / `USPS_CLIENT_SECRET` — from [developer.usps.com](https://developer.usps.com) (the new APIs portal)
- `FEDEX_API_KEY` / `FEDEX_SECRET_KEY` — from [developer.fedex.com](https://developer.fedex.com) → project with the Track API enabled

Carrier lookups are handled by `carriers.js`; the number's carrier is auto-detected
(with a fallback to trying each configured carrier). After adding/changing any of
these, **Restart** the app for them to take effect.

Do **not** set `PORT` — Passenger assigns it.

## 5. Install dependencies
In the Node app panel click **Run NPM Install** (or, in Terminal, `source` the
virtualenv command shown at the top of the panel, then `npm install`).
The database uses Node's **built-in** `node:sqlite` (nothing to compile), so the
only native dependency left is `sharp`:
- If it fails on **sharp**, the app still runs fine — thumbnails just turn off.
  (This host can't build native add-ons, so `sharp` will likely stay off; that's
  OK on unmetered hosting.)
- Everything else is pure JS and installs cleanly.

## 6. Start + open
Click **Restart**, then visit `https://yoyos.example.com`. Log in with
`ADMIN_PASSWORD`.

## 7. Move your data over
Your live data is on the (suspended) Render instance.
- If you can **resume Render** briefly: open the Render app → **Settings →
  Download backup** (a `.zip` of DB + photos), then on the Namecheap app →
  **Settings → Restore** and upload that zip.
- If Render can't be resumed yet: we can seed from a CSV export or your local
  backup (older). Tell me what you have.

## 8. Optimize photos
On the Namecheap app: **Settings ⚙ → Photos & bandwidth → Optimize photos**
(generates thumbnails; speeds up loads even on unmetered hosting).

---

## Notes / gotchas
- The app is **ESM** (`"type": "module"`). LiteSpeed/Passenger `require()` the
  startup file and can't load an ESM module with top-level await, so the startup
  file is the CommonJS shim **`app.cjs`** (it `import()`s `server.js`). If you
  ever point the startup file back at `server.js` you'll get a 503 with
  `ERR_REQUIRE_ASYNC_MODULE` in stderr.
- No need for the WordPress iframe anymore — use `yoyos.example.com` directly.
  (You can still embed it with `?embed=1` if you want.)
- Cron/keepalive isn't needed; Passenger starts the app on first request.
