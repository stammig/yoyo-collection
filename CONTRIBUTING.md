# Contributing

Thanks for your interest in improving Yoyo Collection! This is a small,
dependency-light project and contributions are very welcome.

## Getting set up
```bash
git clone <your-fork-url>
cd yoyo-collection
npm install
npm run dev   # auto-restarts on changes; open http://localhost:3000
```
No build step — the front end is plain HTML/CSS/JS in `public/`.

## Project layout
- `server.js` — Express app + REST API
- `db.js` — SQLite (Node's built-in `node:sqlite`) wrapper + schema bootstrap
- `carriers.js` — UPS / USPS / FedEx tracking lookups
- `dates.js` — calendar-day normalization (see "Dates" below)
- `unzip.js` — streaming zip reader used by Restore and the 360° spin `.zip` upload
- `schema.sql` — database schema
- `public/` — the front end (`index.html`, `app.js`, `styles.css`)

## Guidelines
- **Match the surrounding style.** Vanilla JS, no framework, no transpiler.
- **Keep it dependency-light.** Open an issue before adding a new runtime dep.
- **Run `npm test`** — it starts real servers on throwaway databases and
  covers public-field privacy, CSV import matching, dates and the zip reader.
  CI runs it on Node 22.13 and 24 for every PR. Add a test with your change.
- **Run `npm test`.** It starts real servers on throwaway databases and covers
  public-field privacy, CSV import matching, dates and the zip reader. CI runs
  it on Node 22.13 and 24 for every PR. Add a test with your change.
- **Test your change in the browser** before opening a PR — add a yoyo, edit it,
  upload a photo, switch views, toggle dark mode.
- **Don't commit data.** `data/`, `uploads/`, and `.env` are git-ignored; keep it
  that way.
- One focused change per PR, with a short description of what and why.
- **Update [CHANGELOG.md](CHANGELOG.md)** with a short entry for any
  behavior-changing commit (new feature, fix, migration) — newest entry on
  top, grouped by date.

## Dates
The app stores two kinds of time, and mixing them up causes off-by-one bugs:
- **Calendar days** (`purchase_date`, `sold_date`, `eta`) have no time zone.
  Store them as `YYYY-MM-DD` in the user's local calendar. In the browser use
  `localDay()` / `parseDay()` from `app.js`; never take a day from
  `new Date().toISOString()`, which is the UTC date and is tomorrow for
  anyone in the Americas after about 5pm. On the server, `dates.js`
  normalizes them on every write.
- **Instants** (`created_at`, `updated_at`, `deleted_at`, `sale_listed_at`) are
  UTC and keep their existing formats — sync compares them as strings.
- **Free-text dates** (`release_date`: "2025", "Spring 2024") stay as typed.

## Reporting bugs / ideas
Open an issue with steps to reproduce (for bugs) or the problem you're trying to
solve (for features). Screenshots help a lot for UI issues.
