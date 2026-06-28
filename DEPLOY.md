# Adding the Yoyo Collection to your WordPress site

## The big picture (read this first)

This app is a **Node.js server** with its own database and photo storage.
WordPress runs on **PHP**, so the app can't run *inside* WordPress, and it can't
go on typical shared WordPress hosting.

The clean, reliable way to put it on your site:

1. **Host the app** as its own small service somewhere that runs Node and gives
   you HTTPS (e.g. Render, Railway, Fly.io, or your own server).
2. **Embed it** in a WordPress page with an `<iframe>` so it appears as part of
   your site (e.g. at `yoursite.com/yoyos`).

Your WordPress site stays exactly as it is; the app just lives at its own URL and
shows through a window in one of your pages.

---

## Step 0 — Decide how people should use it

| Mode | Who can view | Who can edit | How to set |
|------|--------------|--------------|------------|
| **Public + you can edit live** (recommended) | Everyone | You, after logging in | `ADMIN_PASSWORD` |
| **Public showcase, no editing** | Everyone | No one via the web | `READ_ONLY=true` |
| **Private** | Only you (password) | Only you | `AUTH_USER` + `AUTH_PASS` |
| **Open** (not recommended online) | Everyone | Everyone | (no env vars) |

Pick one. You can change it later by editing an environment variable.

**Recommended: `ADMIN_PASSWORD`.** Visitors see a normal, read-only collection
(no Add/Edit/Delete buttons). You click **Log in** (top-right), enter the
password, and the editing controls appear — no env-flipping. Log in on the app's
**own URL** (e.g. `https://your-app.onrender.com`), not through the WordPress
iframe, because browsers often block logins inside third-party iframes. Once
logged in there, your changes show up everywhere, including the embed.

> ⚠️ Don't deploy in "Open" mode on the public internet — anyone who finds the
> URL could edit or delete your collection.

---

## Step 1 — Put the code on GitHub

The easy hosts deploy straight from a GitHub repo.

```bash
cd yoyo-collection
git init
git add .
git commit -m "Yoyo collection app"
```

Then create an empty repo on GitHub and push (GitHub shows you the exact two
commands after you create it):

```bash
git remote add origin https://github.com/YOURNAME/yoyo-collection.git
git branch -M main
git push -u origin main
```

`node_modules/`, `data/`, and `uploads/` are already git-ignored, so your local
database and photos won't be uploaded — you'll load your data into the hosted
copy in Step 3.

---

## Step 2 — Deploy the app (Render example)

Render is a good default: simple, free to try, HTTPS included.

1. Go to <https://render.com> and sign up (free).
2. Click **New +** → **Blueprint**, and connect your GitHub repo.
   Render reads the included **`render.yaml`** and sets everything up.
3. Important — **persistent storage**: `render.yaml` defines a 1 GB disk so your
   database and photos survive restarts/redeploys. This requires a **paid
   instance** (Render's *Starter*, ~$7/month). On the free plan there is **no
   persistent disk**, so your data would be wiped on every redeploy. For a real
   collection, use Starter.
4. (Optional) In the service's **Environment** tab, add the variable for your
   chosen mode from Step 0:
   - Public showcase: `READ_ONLY` = `true`
   - Private: `AUTH_USER` = your username, `AUTH_PASS` = a strong password
5. Click **Deploy**. After a minute or two you'll get a URL like
   `https://yoyo-collection-xxxx.onrender.com`. Open it to confirm it loads.

**Other hosts** work the same way (point them at `npm start`, set `PORT` from the
environment — already handled — and give `data/` + `uploads/` a persistent
volume):
- **Railway** (<https://railway.app>) — add a Volume, mount it, set `DB_PATH` and
  `UPLOAD_DIR` to point inside it.
- **Fly.io** (<https://fly.io>) — `fly launch`, then `fly volumes create`.
- **Your own VPS** — `npm install && npm start` behind nginx/Caddy (see
  "Self-hosting next to WordPress" below).

---

## Step 3 — Load your collection into the hosted copy

The hosted app starts empty. Get your data in — **including photos** — with
Backup/Restore:

1. In your **local** app (`npm start` → <http://localhost:3000>), click
   **⤓ Backup**. This downloads one `.zip` containing your database *and* all
   photos.
2. Open the **hosted** app's URL, log in if you set `ADMIN_PASSWORD`, and click
   **⤴ Restore**, choose that zip. It replaces the hosted collection with your
   backup. Done — yoyos and photos all moved.

(CSV Import/Export still exists for spreadsheet-style edits, but it does **not**
carry photos — Backup/Restore does. Backup is also how you make periodic safety
copies of everything.)

---

## Step 4 — Embed it in WordPress

1. In WordPress admin, create or edit the page where you want the collection
   (e.g. a page called **My Yoyos**).
2. Add a **Custom HTML** block (in the block editor: **+** → search "Custom
   HTML").
3. Paste this, replacing the URL with your hosted URL:

   ```html
   <iframe
     src="https://yoyo-collection-xxxx.onrender.com"
     title="Yoyo Collection"
     style="width:100%; height:1200px; border:0; border-radius:12px;"
     loading="lazy">
   </iframe>
   ```

4. **Publish**. Visit the page — your collection appears inside your site.

Notes:
- **HTTPS is required.** Your WordPress site is almost certainly `https://`, and
  browsers block `http://` iframes on an `https://` page ("mixed content"). The
  hosts above all give you HTTPS automatically, so you're fine.
- **If the iframe doesn't show**, a security plugin (e.g. Wordfence) or your
  theme may be stripping iframes. Use the **Custom HTML** block (not a paragraph),
  or install a small plugin like **"iframe"** which adds an `[iframe]` shortcode:
  `[iframe src="https://...onrender.com" width="100%" height="1200"]`.
- **Auto-resize height (optional):** the iframe above is a fixed `1200px`. The app
  also broadcasts its real height to the parent page, so you can make the iframe
  grow/shrink automatically. Use this Custom HTML block instead of the plain one:

  ```html
  <iframe id="yoyoFrame"
    src="https://yoyo-collection-xxxx.onrender.com"
    title="Yoyo Collection"
    style="width:100%; height:1200px; border:0; border-radius:12px;"
    loading="lazy"></iframe>
  <script>
    window.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'yoyo-collection-height') {
        document.getElementById('yoyoFrame').style.height = e.data.height + 'px';
      }
    });
  </script>
  ```

---

## Step 5 — Lock it down (recommended for a public page)

Set these as environment variables on your host (Render: **Environment** tab):

- `READ_ONLY=true` — visitors can browse, sort, filter, and view photos, but the
  Add / Edit / Delete / Import buttons disappear and the server refuses any
  change. Best for a public showcase.
- `FRAME_ANCESTORS=https://yoursite.com` — only *your* site is allowed to embed
  the app, so others can't iframe it elsewhere. Use your real domain, including
  `https://`.

After changing env vars, the host redeploys automatically (~1 minute).

---

## Editing your collection after it's live

Because there's a single hosted copy, how you edit depends on your mode:

- **Login mode (`ADMIN_PASSWORD`) — recommended**: open the app's own URL, click
  **Log in**, enter your password. The Add/Edit/Delete/Backup/Restore controls
  appear and your changes go live immediately for everyone. Click **Log out**
  when done. (Log in on the direct URL, not the WordPress iframe.)
- **Private mode (`AUTH_USER`/`AUTH_PASS`)**: open the app's URL, enter your
  password when the browser asks, and edit normally. (Viewers also need the
  password — suits a personal/family page.)
- **Public read-only mode (`READ_ONLY=true`)**: to make changes, set `READ_ONLY`
  to `false` in your host's Environment tab, edit, then set it back.

### Backups
Click **⤓ Backup** any time to download a full `.zip` (database + photos). Keep a
copy somewhere safe. To roll back or move hosts, use **⤴ Restore** with that zip.

---

## Optional — a tidy subdomain

Instead of `…onrender.com`, you can serve it at `collection.yoursite.com`:

1. In your host (Render: **Settings → Custom Domains**), add
   `collection.yoursite.com`.
2. In your domain's DNS, add the CNAME record the host gives you.
3. Use `https://collection.yoursite.com` as the iframe `src`.

---

## Optional — self-hosting next to WordPress (VPS only)

If your WordPress runs on a server you control (a VPS, not shared hosting):

1. Install Node 18+ and copy the project to the server.
2. `npm install`, then run it under a process manager: `pm2 start server.js
   --name yoyo` (so it restarts on reboot).
3. Reverse-proxy a path or subdomain to it. Example nginx:

   ```nginx
   location /yoyos/ {
     proxy_pass http://127.0.0.1:3000/;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

4. Embed `https://yoursite.com/yoyos/` in your WordPress page as in Step 4.

---

## Troubleshooting

- **"Port 3000 in use"** locally → the app is already running; open
  <http://localhost:3000>, or `lsof -ti:3000 | xargs kill`.
- **Iframe is blank** → check the hosted URL works on its own; check it's
  `https://`; check a security plugin isn't blocking iframes (Step 4 notes).
- **Data disappeared after a redeploy** → you're on a host/plan without a
  persistent disk. Attach a volume and point `DB_PATH` + `UPLOAD_DIR` at it.
- **Can't edit on the live site** → see "Editing your collection after it's
  live" above.
