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
- `schema.sql` — database schema
- `public/` — the front end (`index.html`, `app.js`, `styles.css`)

## Guidelines
- **Match the surrounding style.** Vanilla JS, no framework, no transpiler.
- **Keep it dependency-light.** Open an issue before adding a new runtime dep.
- **Test your change in the browser** before opening a PR — add a yoyo, edit it,
  upload a photo, switch views, toggle dark mode.
- **Don't commit data.** `data/`, `uploads/`, and `.env` are git-ignored; keep it
  that way.
- One focused change per PR, with a short description of what and why.

## Reporting bugs / ideas
Open an issue with steps to reproduce (for bugs) or the problem you're trying to
solve (for features). Screenshots help a lot for UI issues.
