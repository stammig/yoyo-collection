# Hosting a public demo

A demo lets people try both sides of the app:
- **Public view** — what visitors see by default: the collection, specs, and
  photos, with pricing/tracking hidden.
- **Private view** — log in with the demo password to reveal pricing, the
  Arrivals page, editing, and settings.

The trick for a public demo is to **publish the login password** and **reseed
the data regularly** so it stays clean after visitors poke at it.

## What makes it a demo
1. `ADMIN_PASSWORD` is set to something you publish (e.g. `demo`).
2. The sample data is (re)seeded on every start, so edits/vandalism reset:
   ```
   FORCE=1 node seed-demo.mjs && npm start
   ```
   `FORCE=1` lets the seed wipe and refill even a non-empty database.
3. Show the password on the page (e.g. in the GitHub README:
   *"Live demo — log in with password `demo` to see the owner view"*).

## Option A — Namecheap (unmetered bandwidth) ⭐ recommended
If you already host on Namecheap, run the demo there as a second app so a busy
(or bot-hammered) public demo never eats into a metered bandwidth quota.

1. **Subdomain:** cPanel → Domains → create e.g. `demo.yourdomain.com`.
2. **Upload** a copy of the app to a new folder, e.g. `~/yoyodemo`.
3. **Node app:** cPanel → Setup Node.js App → Create Application
   - Application root: `yoyodemo`
   - Application URL: the subdomain
   - Startup file: `app.cjs`
4. **Environment variables:**
   - `ADMIN_PASSWORD = demo`  (publish this so visitors can see the owner view)
   - `DEMO_MODE = 1`          (login works, but all edits/deletes/uploads/restores are blocked)
   - `DB_PATH = /home/USER/yoyodemo/data/demo.db`
   - `RATE_LIMIT_MAX = 120`   (per IP per minute — stops bots hammering it)
   - `NODE_ENV = production`
5. **Install + seed** (Terminal, using the app's Node binary):
   ```
   cd ~/yoyodemo
   ~/nodevenv/yoyodemo/22/bin/npm install
   FORCE=1 SEED_DB_PATH=data/demo.db ~/nodevenv/yoyodemo/22/bin/node seed-demo.mjs
   ```
6. **Restart** the app, then open the subdomain.
7. **Daily reseed** (undo visitor edits): cPanel → Cron Jobs → add, once a day:
   ```
   cd ~/yoyodemo && FORCE=1 SEED_DB_PATH=data/demo.db ~/nodevenv/yoyodemo/22/bin/node seed-demo.mjs && touch tmp/restart.txt
   ```

That's it — unmetered bandwidth, rate-limited against abuse, self-resetting daily.

## Option B — Render (free, gives you a public URL)
1. Push this repo to GitHub.
2. Render → **New + → Web Service** → connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `FORCE=1 node seed-demo.mjs && npm start`
   - **Plan:** Free is perfect here — no persistent disk means the data is
     fresh on every spin-up, which is exactly what you want for a demo.
   - **Environment:** add `ADMIN_PASSWORD = demo`
4. Deploy. Render gives you a `https://your-demo.onrender.com` URL.

On the free plan the service sleeps after inactivity and reseeds on the next
visit — a self-cleaning demo. (For an always-on demo, use a paid plan plus a
daily "reseed" cron job or scheduled restart.)

## Option C — Docker (any VPS / your own box)
```bash
docker build -t yoyo-demo .
docker run -d -p 3000:3000 \
  -e ADMIN_PASSWORD=demo \
  yoyo-demo sh -c "FORCE=1 node seed-demo.mjs && node server.js"
```
Put it behind a reverse proxy (Caddy/Nginx) for a public HTTPS URL, and add a
cron that restarts the container daily to reseed.

## Notes
- The demo deliberately uses **ephemeral data** — don't attach a persistent disk,
  or the reseed-on-start will be blocked by the safety guard (unless `FORCE=1`,
  which the start command already sets).
- To customize what visitors see, edit the `YOYOS` array in
  [`seed-demo.mjs`](seed-demo.mjs).
