// Yoyo Collection — Express app + REST API.
//
// Single-file server: auth/access control, the yoyo/photo/field-def CRUD API,
// CSV import/export, and full zip backup/restore. Talks to SQLite through
// db.js and to carrier tracking APIs through carriers.js. No build step — this
// runs directly with `node server.js` (see app.cjs for the CommonJS startup
// shim some hosts require).
import './load-env.js'; // must stay first — see the note in that file
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';
import archiver from 'archiver';
import { track as trackPackage, configuredCarriers } from './carriers.js';
import { DAY_FIELDS, normalizeDay, localDayStamp } from './dates.js';
import { canonicalCondition, canonicalComposition } from './vocab.js';
import { listEntries, extractEntry } from './unzip.js';
import db, { DB_PATH, openDatabase, backfillUuids, backfillPhotoUuids, nextRev } from './db.js';

// sharp (image thumbnails) is native; on some shared hosts it may not install.
// Load it optionally so the app still boots and just serves full images.
let sharp = null;
try { ({ default: sharp } = await import('sharp')); }
catch (e) { console.warn('sharp unavailable — thumbnails disabled, serving full images:', e.message); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// App version (from package.json) + how this instance is running — surfaced in
// Settings → Version & updates so the owner can see they're current and get the
// right update command for their setup.
let APP_VERSION = '0.0.0';
try { APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || APP_VERSION; }
catch { /* keep default */ }
// Inside a container the app can't restart itself; we just show the command.
const IN_DOCKER = fs.existsSync('/.dockerenv');
// Which GitHub repo to check for releases (overridable so forks work).
const UPDATE_REPO = process.env.UPDATE_REPO || 'stammig/yoyo-collection';
// The copy-paste command shown when an update is available. Overridable for
// non-standard setups; otherwise inferred from whether we're in Docker.
function updateCommand() {
  if (process.env.UPDATE_HINT) return process.env.UPDATE_HINT;
  if (IN_DOCKER) return 'docker compose pull && docker compose up -d';
  return 'git pull && npm install && npm start';
}
// Compare dotted versions (ignoring any leading "v"): -1 / 0 / 1.
function cmpVersion(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1; }
  return 0;
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Scratch space for restore: the uploaded zip, and the database extracted from
// it. Deliberately NOT os.tmpdir() — /tmp is tmpfs (i.e. RAM) on Armbian,
// Fedora, recent Ubuntu, and most SBC images tuned to spare an SD card, so
// writing a 200MB upload there would put it straight back into memory and undo
// the point of streaming it to disk at all. The database's own directory is
// real disk by definition and already holds the collection, so it has room.
// Not included in backups: those archive DB_PATH and UPLOAD_DIR only.
//
// RESTORE_TMP_DIR overrides where that scratch folder is placed, for the case
// where the database lives on a disk too small to absorb a transient copy of
// the backup — Render's blueprint provisions 1GB, for instance, and there the
// upload is better off on ephemeral container storage. It names the PARENT: a
// `restore-tmp` subdirectory is always created inside it, and the sweep below
// only ever touches that subdirectory. Pointing this straight at /tmp must not
// mean "delete everything in /tmp" on boot.
const SCRATCH_DIR = path.join(process.env.RESTORE_TMP_DIR || path.dirname(DB_PATH), 'restore-tmp');
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
// Clear anything left behind by a previous run that died mid-restore.
for (const stale of fs.readdirSync(SCRATCH_DIR)) {
  fs.rmSync(path.join(SCRATCH_DIR, stale), { force: true, recursive: true });
}

const app = express();

// Optional in-memory rate limiter (per client IP). Off unless RATE_LIMIT_MAX is
// set — handy for a public demo so a bot can't hammer it. Behind a proxy
// (cPanel/Passenger, Cloudflare) the real client IP is the first
// X-Forwarded-For entry; we read it directly so we don't have to trust-proxy
// globally.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 0;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
if (RATE_LIMIT_MAX > 0) {
  const hits = new Map(); // ip -> { count, resetAt }
  setInterval(() => { // drop expired buckets so the map can't grow unbounded
    const now = Date.now();
    for (const [ip, b] of hits) if (b.resetAt <= now) hits.delete(ip);
  }, RATE_LIMIT_WINDOW_MS).unref();

  app.use((req, res, next) => {
    // Static photos are cheap, immutable, long-cached files — and a native-app
    // import legitimately fetches hundreds in a burst. The limiter exists to
    // protect the API, so photo GETs pass through uncounted — and so do HEADs,
    // which the native apps' "Publish to website" sends for every photo to ask
    // "is this one already there?" (a 700-photo publish otherwise trips the limit
    // and the real uploads that follow fail with 429).
    if ((req.method === 'GET' || req.method === 'HEAD') && req.path.startsWith('/uploads/')) return next();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let b = hits.get(ip);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }; hits.set(ip, b); }
    b.count++;
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - b.count));
    if (b.count > RATE_LIMIT_MAX) {
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests — slow down a moment.' });
    }
    next();
  });
}

app.use(express.json({ limit: '2mb' }));

// Serve SSL/ACME domain-validation files. When the app runs the whole domain
// (e.g. Passenger), requests to /.well-known reach the app, and the main static
// handler ignores dot-folders — so this serves them explicitly. Public, before
// any auth gate, so cert validation/renewal always works.
app.use('/.well-known', express.static(path.join(__dirname, 'public', '.well-known'), { dotfiles: 'allow' }));

// ---- Access control (all opt-in via env vars; default = wide open, as before) ----
const AUTH_USER = process.env.AUTH_USER;            // set both AUTH_USER + AUTH_PASS to
const AUTH_PASS = process.env.AUTH_PASS || '';      //   password-protect the WHOLE app
const READ_ONLY = ['1', 'true', 'yes'].includes(String(process.env.READ_ONLY || '').toLowerCase());
// Public demo: login still works (so visitors can see the owner view) but every
// data-changing request is refused — no edits, deletes, uploads, or restores.
const DEMO_MODE = ['1', 'true', 'yes'].includes(String(process.env.DEMO_MODE || '').toLowerCase());
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS; // e.g. "https://yoursite.com" to allow embedding

// Owner login: set ADMIN_PASSWORD to let the public view read-only while you
// log in (on the app's own URL) to edit. No env-flipping needed.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const LOGIN_ENABLED = !!ADMIN_PASSWORD;

// Derive the token-signing key from the admin password with scrypt (a slow KDF)
// rather than a fast hash: it's computed once at startup, but it means a captured
// session token can't be used for a cheap offline dictionary attack on the
// password. Deterministic (fixed salt) so tokens survive restarts. Set
// SESSION_SECRET explicitly to bypass this entirely.
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.scryptSync(ADMIN_PASSWORD, 'yoyo-session', 32).toString('hex');
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Signed, stateless session token: base64url(JSON payload) + "." + HMAC signature.
// No server-side session store needed — validity is just "signature checks out
// and exp hasn't passed".
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
// Verifies a token from makeToken(): signature must match (constant-time
// compare, to avoid a timing side-channel) and it must not be expired.
function validToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); }
  catch { return false; }
}
// Minimal cookie parser — avoids pulling in a whole cookie-parsing dependency
// for the one cookie this app sets.
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function bearerToken(req) {
  const a = req.headers.authorization || '';
  return a.startsWith('Bearer ') ? a.slice(7) : '';
}
// Is this request from a logged-in owner? Checks both the session cookie and
// a bearer token (see comment above on why both exist).
function isLoggedIn(req) {
  if (!LOGIN_ENABLED) return false;
  // Cookie (works on the direct URL) OR bearer token (works inside an iframe,
  // including mobile Safari which blocks third-party cookies).
  const cookie = parseCookies(req).yoyo_session;
  if (cookie && validToken(cookie)) return true;
  const bt = bearerToken(req);
  return bt ? validToken(bt) : false;
}
// Can the requester change data? Logged-in owner, or fully-open mode.
// Two different questions, kept apart because conflating them costs the owner
// things they should keep:
//
//   isOwner  — may this requester SEE owner-only data (what you paid, Arrivals,
//              Sold history, CSV export)?
//   canEdit  — may this requester CHANGE the collection?
//
// They diverge when read-only mode is on. That is a switch in Settings, not an
// env var, so it can be flipped from the site itself: it turns off editing for
// EVERYONE, the signed-in owner included, while leaving the owner's own view
// completely intact. The point is the deployment where another device holds the
// master copy and this site mirrors it — there, editing here only creates work
// that the next publish quietly destroys.
//
// The env READ_ONLY keeps its original meaning (a permanently public,
// non-editable instance) and still feeds isOwner exactly as before.
function siteReadOnly() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'read_only'").get();
  return !!row && ['1', 'true', 'yes'].includes(String(row.value).toLowerCase());
}
function isOwner(req) {
  return isLoggedIn(req) || (!READ_ONLY && !LOGIN_ENABLED);
}
function canEdit(req) {
  return isOwner(req) && !siteReadOnly();
}
// Two writes survive read-only mode, and both have to.
//   · the switch itself, or it could never be turned back off
//   · publishing, since receiving the collection is what a mirror is FOR
// Neither survives demo mode.
function isReadOnlyToggle(req) {
  return req.method === 'PUT' && req.path === '/api/settings/read_only';
}
function isPublish(req) {
  return req.path === '/api/restore' || req.path.startsWith('/api/sync/');
}
function allowedDespiteReadOnly(req) {
  if (DEMO_MODE || !siteReadOnly()) return false;
  if (isReadOnlyToggle(req)) return isOwner(req);
  // A carrier ETA query changes nothing in the collection, but it arrives as a
  // POST so the method-based write gate catches it. Arrivals is owner-only, so
  // the only read-only requester who needs it is the owner.
  if (req.path === '/api/track') return isOwner(req);
  return isPublish(req) && isLoggedIn(req);
}

// ---- Login / logout (registered BEFORE the write gate so they aren't blocked) ----
app.post('/api/login', (req, res) => {
  if (!LOGIN_ENABLED) return res.status(400).json({ error: 'Login is not enabled on this server.' });
  if ((req.body?.password || '') !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = ['Path=/', 'HttpOnly', `Max-Age=${SESSION_MAX_AGE}`];
  // SameSite=None;Secure lets login work inside an HTTPS iframe; Lax for local http.
  attrs.push(secure ? 'SameSite=None' : 'SameSite=Lax');
  if (secure) attrs.push('Secure');
  const token = makeToken();
  res.setHeader('Set-Cookie', `yoyo_session=${token}; ${attrs.join('; ')}`);
  res.json({ ok: true, token });
});
app.post('/api/logout', (req, res) => {
  // Must mirror the login cookie's attributes (incl. SameSite=None; Secure on
  // HTTPS) or the browser won't clear it inside a cross-site iframe.
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = ['yoyo_session=', 'Path=/', 'HttpOnly', 'Max-Age=0'];
  attrs.push(secure ? 'SameSite=None' : 'SameSite=Lax');
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  res.json({ ok: true });
});

app.use((req, res, next) => {
  // Allow (only) your site to embed this app in an <iframe>.
  if (FRAME_ANCESTORS) {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  }

  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  // Public demo: keep it out of search, and refuse every write even from a
  // logged-in visitor (login/logout are registered before this gate, so they
  // still work — visitors can sign in to see the owner view, just not change it).
  if (DEMO_MODE) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (isWrite) {
      return res.status(403).json({ error: 'This is a read-only demo — sign in to explore the owner view, but changes are disabled.' });
    }
  }

  // Block data-changing requests unless the requester is allowed to edit.
  if (isWrite && !canEdit(req) && !allowedDespiteReadOnly(req)) {
    // Sync clients distinguish "token expired — re-login silently" (401) from
    // "writes are off here" (403, e.g. demo mode above). Only sync routes get
    // the 401; the web client's own error handling expects 403 elsewhere.
    if (req.path.startsWith('/api/sync/')) {
      return res.status(401).json({ error: 'Please sign in to sync.' });
    }
    // Say which of the three reasons it is. "Please log in" to someone who is
    // already logged in reads as a bug and sends them looking in the wrong place.
    return res.status(403).json({
      error: siteReadOnly()
        ? 'This site is in read-only mode. Turn it off in Settings to make changes.'
        : (LOGIN_ENABLED ? 'Please log in to make changes.' : 'This collection is read-only.'),
    });
  }

  // Optional HTTP Basic Auth over the entire app (fully-private instance).
  if (AUTH_USER) {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    let ok = false;
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      ok = u === AUTH_USER && p === AUTH_PASS;
    }
    if (!ok) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Yoyo Collection"');
      return res.status(401).send('Authentication required.');
    }
  }

  next();
});

// ---- File uploads (photos) ----
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// Looped videos are stored and served verbatim — the server never decodes them,
// so no ffmpeg. The browser supplies the poster frame (see POST .../video).
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
// A full turntable rotation is typically 24-72 frames; the cap is generous
// enough for a 1-degree-per-frame sequence without letting one upload fill a disk.
const MAX_SPIN_FRAMES = 180;
const MAX_SPIN_FRAME_BYTES = 5 * 1024 * 1024;
// Ceiling on the archive itself and on what it may expand to (checked against
// the zip's declared sizes before anything is written). Frames are already-
// compressed images, so compressed ~ expanded; adm-zip buffers the whole file
// in RAM, which is the other reason to keep this far below "generous".
const MAX_SPIN_ARCHIVE_BYTES = 100 * 1024 * 1024;
// Browsers disagree on the mimetype for .zip (Windows reports x-zip-compressed,
// and some report nothing useful at all), so accept the spellings and let the
// zip parser be the real arbiter of whether it's an archive.
const ALLOWED_ARCHIVE_TYPES = new Set([
  'application/zip', 'application/x-zip-compressed', 'application/x-zip', 'multipart/x-zip',
  'application/octet-stream',
]);
// Stored filenames get their extension from this fixed table, keyed by the
// already-validated mimetype — NOT from the client-supplied original filename.
// The original filename is attacker-controlled and can contain arbitrary
// characters (quotes, angle brackets, etc.); deriving the extension from it
// would let a crafted upload name inject those characters into a filename
// that later gets embedded in HTML (photo URLs are rendered client-side).
const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm',
};

// Every stored upload gets a generated name; nothing client-supplied reaches
// the filesystem. Shared with the spin-archive path so extracted frames are
// named exactly like directly-uploaded ones.
function tempName(ext) {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, tempName(EXT_BY_MIME[file.mimetype] || '.jpg')),
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 12 }, // 10MB each, up to 12 at once
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed (jpg, png, webp, gif).'));
  },
});

// A 360 spin arrives as an already-extracted frame sequence, so the server
// never has to decode anything. Loose frames and a zipped sequence are separate
// endpoints with separate uploaders because multer's fileSize limit is per file
// across ALL of an instance's fields: one shared uploader sized for the archive
// silently gave loose frames the archive's allowance — 180 x 100MB instead of
// 5MB each — and a request carrying both fields orphaned whichever set lost.
const uploadSpinFrames = multer({
  storage,
  limits: { fileSize: MAX_SPIN_FRAME_BYTES, files: MAX_SPIN_FRAMES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('Spin frames must be images (jpg, png, webp, gif).'));
  },
});
const uploadSpinArchive = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, tempName('.zip')),
  }),
  limits: { fileSize: MAX_SPIN_ARCHIVE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_ARCHIVE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('A spin archive must be one .zip of image frames.'));
  },
});

// A looped video plus the poster frame the browser extracted from it. The
// poster is what every existing <img> surface (grid, table, For Sale) renders,
// so a video is never fetched just to draw a thumbnail.
const uploadVideo = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const ok = file.fieldname === 'poster'
      ? ALLOWED_IMAGE_TYPES.has(file.mimetype)
      : ALLOWED_VIDEO_TYPES.has(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Video must be .mp4 or .webm, and the poster an image.'));
  },
});

// CSV imports are parsed in memory rather than written to disk.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Backup zips can be large (they include photos), so the upload streams to a
// temp file instead of being accumulated in memory. memoryStorage() held the
// whole thing as a Buffer for the entire request — a sustained 200MB
// allocation across what can be a multi-minute upload on a home connection,
// held even when the file turned out not to be a valid zip, and multiplied by
// any concurrent request. That's a lot to ask of a 2–4GB NAS or SBC.
// (multer removes its temp file itself if the upload errors or exceeds the
// limit; the handler below deletes it on every other path.)
const uploadZip = multer({
  dest: SCRATCH_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ---- Static files ----
// Uploads use unique filenames, so cache hard (cuts repeat egress dramatically).
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Shareable per-yoyo page (/y/:id) ----
// Serves the SPA but with per-yoyo Open Graph / Twitter tags injected into the
// <head>, so a pasted link unfurls (photo + name + a few non-sensitive specs) in
// chat apps and link previews. The client then opens that yoyo's read-only detail
// view with its zoomable photo gallery (see the /y/ routing in public/app.js).
const escHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

app.get('/y/:id', (req, res) => {
  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.type('html');
  const row = db.prepare('SELECT * FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.send(indexHtml); // unknown/deleted id — just load the app

  const y = decorate(row);
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const base = `${proto}://${req.get('host')}`;
  const name = `${y.brand || ''} ${y.model || ''}`.trim() || 'Yoyo';

  // Description: a few NON-sensitive specs (never paid/retail), plus sale info.
  const bits = [];
  if (y.weight_g) bits.push(`${y.weight_g} g`);
  if (y.diameter_mm) bits.push(`${y.diameter_mm} mm`);
  if (y.body_material) bits.push(y.body_material);
  if (y.sale_status) bits.push(y.sale_price != null ? `${y.sale_status} · $${y.sale_price}` : y.sale_status);
  const desc = bits.join(' · ') || (y.description || '').slice(0, 160) || 'From my yoyo collection';

  const image = y.photos[0] ? base + y.photos[0].url : '';
  const url = `${base}/y/${y.id}`;
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Yoyo Collection" />`,
    `<meta property="og:title" content="${escHtml(name)}" />`,
    `<meta property="og:description" content="${escHtml(desc)}" />`,
    `<meta property="og:url" content="${escHtml(url)}" />`,
    image ? `<meta property="og:image" content="${escHtml(image)}" />` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${escHtml(name)}" />`,
    `<meta name="twitter:description" content="${escHtml(desc)}" />`,
    image ? `<meta name="twitter:image" content="${escHtml(image)}" />` : '',
  ].filter(Boolean).join('\n  ');

  res.send(indexHtml.replace('</head>', `  ${tags}\n</head>`));
});

// ---- Helpers ----

// Columns the client is allowed to write, with how to coerce each value.
const TEXT_FIELDS = [
  'brand', 'model', 'color', 'body_material', 'composition', 'condition',
  'bearing_size', 'response_type', 'description', 'release_date', 'tracking', 'eta',
  'sale_status', 'purchase_date', 'sold_date', 'seller', 'buyer',
  'finish', 'shape', 'edition', 'serial_number', 'signature',
];
const NUMBER_FIELDS = [
  'retail', 'paid', 'weight_g', 'diameter_mm', 'width_mm', 'gap_mm', 'sale_price', 'trade_value', 'market_value',
];
const BOOL_FIELDS = ['in_hand', 'favorite', 'retired'];
const WRITE_COLS = [...TEXT_FIELDS, ...NUMBER_FIELDS, ...BOOL_FIELDS];

// Pull a number out of strings like "$85.00", "64.60 g", "56.55 mm".
function toNumber(v) {
  if (v === '' || v == null) return null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  return cleaned === '' || isNaN(Number(cleaned)) ? null : Number(cleaned);
}

// Coerces a raw request body into a { column: value } map matching WRITE_COLS,
// so the caller can hand it straight to a parameterized INSERT/UPDATE.
// Every write path (POST/PUT, CSV import, sync push) comes through here, so
// this is where day fields get normalized.
function sanitizeYoyo(body) {
  const out = {};
  for (const f of TEXT_FIELDS) out[f] = body[f] == null ? '' : String(body[f]).trim();
  for (const f of DAY_FIELDS) out[f] = normalizeDay(out[f]);
  out.condition = canonicalCondition(out.condition);
  out.composition = canonicalComposition(out.composition);
  for (const f of NUMBER_FIELDS) out[f] = toNumber(body[f]);
  for (const f of BOOL_FIELDS) out[f] = body[f] ? 1 : 0;
  return out;
}

// Statuses that count as "actively listed" — used to auto-stamp sale_listed_at
// (see POST/PUT below) so the seller tools can sort/flag by days-listed
// without the client ever having to manage that timestamp itself.
const FOR_SALE_STATUSES = new Set(['For Sale', 'For Trade', 'For Sale or Trade']);

// Discount inferred from retail vs. paid (e.g. 29.41), or null if not computable.
function percentOff(y) {
  if (y.retail && y.retail > 0 && y.paid != null) {
    return Math.round(((y.retail - y.paid) / y.retail) * 10000) / 100;
  }
  return null;
}

// ---- Thumbnails (cut bandwidth: grid/list show small thumbs, full image only on zoom) ----
const THUMB_MAX = 480;
function thumbName(filename) {
  return 'thumb-' + filename.replace(/\.[^.]+$/, '') + '.jpg';
}
// The still the browser extracted from a video, stored alongside it. Deriving
// the name means a video row needs no second database row for its poster.
function posterName(filename) {
  return 'poster-' + filename.replace(/\.[^.]+$/, '') + '.jpg';
}
async function makeThumb(filename) {
  if (!sharp) return; // image processing unavailable — frontend falls back to full image
  const src = path.join(UPLOAD_DIR, filename);
  const out = path.join(UPLOAD_DIR, thumbName(filename));
  await sharp(src)
    .rotate() // respect EXIF orientation from phone cameras
    .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toFile(out);
}

// ---- External video embeds (YouTube / Instagram) ----

// Hosts we'll accept a link from. Anything else is rejected outright rather than
// guessed at, so a pasted tracking-redirect URL doesn't become an iframe.
const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
  'youtu.be', 'www.youtu.be',
]);
const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']);

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const IG_CODE_RE = /^[A-Za-z0-9_-]{5,32}$/;
// Instagram serves the same shortcode under a few path prefixes; keep whichever
// one was pasted, because that's the path its /embed endpoint expects.
const IG_TYPES = { p: 'p', reel: 'reel', reels: 'reel', tv: 'tv' };

// "90", "1m30s", "2h3m4s" -> seconds. YouTube accepts all of these in `t`.
function parseStartSeconds(raw) {
  if (!raw) return 0;
  const v = String(raw).trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), 86400);
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || !m.slice(1).some(Boolean)) return 0;
  const secs = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return Math.min(secs, 86400);
}

// Turns a pasted link into the pieces needed to embed it, or null if it isn't a
// supported video URL. Returns { provider, embed_ref, vertical, start_s, url } —
// `url` is the NORMALIZED absolute form (scheme guaranteed), which is what gets
// stored: the raw pasted text may be schemeless ("youtube.com/…"), and storing
// that verbatim rendered "Open on YouTube" as a relative link into this app.
function parseVideoUrl(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 2048) return null;
  let u;
  // Tolerate a link copied without its scheme ("youtube.com/watch?v=...").
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  if (YT_HOSTS.has(host)) {
    const start = parseStartSeconds(u.searchParams.get('t') || u.searchParams.get('start'));
    // youtu.be/<id> puts the id in the path; every youtube.com form either uses
    // ?v= or a known path prefix.
    let id = null, vertical = false;
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = segs[0] || null;
    } else if (segs[0] === 'watch') {
      id = u.searchParams.get('v');
    } else if (['shorts', 'embed', 'live', 'v'].includes(segs[0])) {
      id = segs[1] || null;
      vertical = segs[0] === 'shorts';
    }
    if (!id || !YT_ID_RE.test(id)) return null;
    return { provider: 'youtube', embed_ref: id, vertical, start_s: start, url: u.href };
  }

  if (IG_HOSTS.has(host)) {
    // Reels are also linked as /<username>/reel/<code>, so find the type
    // anywhere in the path rather than assuming it's first.
    // Object.hasOwn, not `in`: `in` also matches inherited Object.prototype
    // keys, so instagram.com/constructor/<code> stored the stringified Object
    // constructor as the embed path.
    const at = segs.findIndex((sg) => Object.hasOwn(IG_TYPES, sg.toLowerCase()));
    if (at === -1) return null;
    const type = IG_TYPES[segs[at].toLowerCase()];
    const code = segs[at + 1];
    if (!code || !IG_CODE_RE.test(code)) return null;
    return { provider: 'instagram', embed_ref: `${type}/${code}`, vertical: type !== 'p', start_s: 0, url: u.href };
  }

  return null;
}

// Rebuilds the embed URL from the stored (already-validated) pair. The player is
// only ever created after the viewer clicks, so nothing here is requested on load.
function buildEmbedUrl(v) {
  if (v.provider === 'youtube') {
    // youtube-nocookie keeps Google from setting tracking cookies for viewers
    // who do press play.
    const qs = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1' });
    if (v.start_s > 0) qs.set('start', String(v.start_s));
    return `https://www.youtube-nocookie.com/embed/${v.embed_ref}?${qs}`;
  }
  if (v.provider === 'instagram') return `https://www.instagram.com/${v.embed_ref}/embed`;
  return null;
}

const PROVIDER_LABELS = { youtube: 'YouTube', instagram: 'Instagram' };

// ---- Cached video posters ----
// The placeholder cards deliberately make no third-party requests, which left
// them as blank boxes. Instead of loading YouTube's thumbnail in the viewer's
// browser (which would leak every visit to Google before any consent), the
// SERVER fetches it once per video and serves it from uploads/ like any other
// image — viewers still touch YouTube only when they press play. The filename
// is derived from the video identity, so rows never need a poster column and
// backup/restore carries the file with no special case. Instagram publishes no
// tokenless thumbnail endpoint, so IG cards keep the placeholder.
function vidThumbName(provider, embedRef) {
  const key = crypto.createHash('sha256').update(`${provider}:${embedRef}`).digest('hex').slice(0, 24);
  return `vidthumb-${key}.jpg`;
}

function vidThumbSource(provider, embedRef) {
  // hqdefault exists for every YouTube video (maxresdefault does not).
  if (provider === 'youtube') return `https://i.ytimg.com/vi/${embedRef}/hqdefault.jpg`;
  return null;
}

// Failures are remembered for the life of the process so a dead network isn't
// re-probed on every render (a restart naturally retries). Successes are NOT —
// the file on disk is the record, so a poster that goes missing is re-fetched.
const vidThumbFailed = new Set();
async function fetchVidThumb(provider, embedRef) {
  const src = vidThumbSource(provider, embedRef);
  if (!src) return false;
  const name = vidThumbName(provider, embedRef);
  const dest = path.join(UPLOAD_DIR, name);
  if (fs.existsSync(dest)) return true;
  if (vidThumbFailed.has(name)) return false;
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    if (!res.ok || !String(res.headers.get('content-type') || '').startsWith('image/')) { vidThumbFailed.add(name); return false; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 2 * 1024 * 1024) { vidThumbFailed.add(name); return false; }
    fs.writeFileSync(dest, buf);
    return true;
  } catch (e) {
    vidThumbFailed.add(name);
    console.warn(`video poster fetch failed (${provider} ${embedRef}):`, e.message);
    return false;
  }
}

// The video's real title, for cards where the owner didn't type one. Same
// server-side single-fetch pattern as the posters: YouTube's oEmbed endpoint
// needs no API key, and Instagram's requires an access token, so IG cards
// keep their generic label.
async function fetchVideoTitle(provider, embedRef) {
  if (provider !== 'youtube') return '';
  try {
    const watch = encodeURIComponent(`https://www.youtube.com/watch?v=${embedRef}`);
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${watch}`,
      { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return '';
    const meta = await res.json();
    return String(meta?.title || '').trim().slice(0, 200);
  } catch {
    return '';
  }
}

// Fills in titles for videos saved without one (rows that predate this
// feature, or oEmbed being unreachable at add time). The parent gets a
// rev-only bump — same as the sync photo-bytes path — so other devices
// re-pull the row without this looking like a user edit.
async function backfillVideoTitles() {
  const rows = db.prepare(
    "SELECT id, yoyo_id, provider, embed_ref FROM videos WHERE provider = 'youtube' AND (title IS NULL OR title = '')"
  ).all();
  let filled = 0;
  for (const r of rows) {
    const title = await fetchVideoTitle(r.provider, r.embed_ref);
    if (!title) continue;
    db.transaction(() => {
      db.prepare('UPDATE videos SET title = ? WHERE id = ?').run(title, r.id);
      db.prepare('UPDATE yoyos SET rev = ? WHERE id = ?').run(nextRev(), r.yoyo_id);
    })();
    filled++;
  }
  if (filled) console.log(`video titles: filled ${filled} from oEmbed`);
}

// Self-heal: videos that predate the cache (or arrived while offline) get
// their poster fetched in the background the first time something renders
// them; the page that triggered it just shows the placeholder once.
function queueVidThumb(provider, embedRef) {
  fetchVidThumb(provider, embedRef).catch(() => {});
}

// Removes a deleted video's cached poster — unless another row (any yoyo)
// still shows the same video.
function cleanupVidThumbs(rows) {
  for (const v of rows) {
    const left = db.prepare('SELECT COUNT(*) AS c FROM videos WHERE provider = ? AND embed_ref = ?')
      .get(v.provider, v.embed_ref).c;
    if (left === 0) fs.rm(path.join(UPLOAD_DIR, vidThumbName(v.provider, v.embed_ref)), { force: true }, () => {});
  }
}

function videosFor(yoyoId) {
  return db
    .prepare('SELECT * FROM videos WHERE yoyo_id = ? ORDER BY sort_order, id')
    .all(yoyoId)
    .map((v) => ({
      id: v.id,
      uuid: v.uuid,
      provider: v.provider,
      providerLabel: PROVIDER_LABELS[v.provider] || v.provider,
      title: v.title,
      url: v.url,
      embedUrl: buildEmbedUrl(v),
      posterUrl: (() => {
        const name = vidThumbName(v.provider, v.embed_ref);
        if (fs.existsSync(path.join(UPLOAD_DIR, name))) return `/uploads/${name}`;
        queueVidThumb(v.provider, v.embed_ref);
        return null;
      })(),
      vertical: !!v.vertical,
      start_s: v.start_s,
    }))
    .filter((v) => v.embedUrl); // a row whose provider we no longer build for
}

// Folds the one-row-per-file photo table into one entry per gallery item: a
// spin's N frame rows become a single entry carrying a `frames` array.
//
// Every entry's `url` and `thumbUrl` point at a STILL image regardless of kind
// (a video's poster, a spin's first frame). That invariant is what lets the
// grid, table, For Sale, Arrivals and Insights views keep rendering plain
// <img> tags with no idea that video or spins exist — only the detail hero and
// lightbox read `kind` and reach for `videoUrl` / `frames`.
function collapseMedia(rows) {
  const out = [];
  const spinIndex = new Map(); // group_uuid -> position in `out`
  for (const p of rows) {
    const full = `/uploads/${p.filename}`;
    if (p.kind === 'spin' && p.group_uuid) {
      const at = spinIndex.get(p.group_uuid);
      if (at != null) { out[at].frames.push(full); continue; }
      spinIndex.set(p.group_uuid, out.length);
      out.push({
        id: p.id, uuid: p.uuid, kind: 'spin', group: p.group_uuid,
        url: full, thumbUrl: `/uploads/${thumbName(p.filename)}`, frames: [full],
      });
      continue;
    }
    if (p.kind === 'video') {
      // A locally-uploaded video always has its poster (the browser extracted
      // it before upload); one that arrived via sync may not have received the
      // poster bytes yet. Serve a bundled placeholder still until it exists —
      // a missing file here used to mean a permanent 404 tile.
      const poster = posterName(p.filename);
      const hasPoster = fs.existsSync(path.join(UPLOAD_DIR, poster));
      out.push({
        id: p.id, uuid: p.uuid, kind: 'video',
        url: hasPoster ? `/uploads/${poster}` : VIDEO_PENDING_STILL,
        thumbUrl: hasPoster ? `/uploads/${thumbName(poster)}` : VIDEO_PENDING_STILL,
        videoUrl: full,
      });
      continue;
    }
    out.push({ id: p.id, uuid: p.uuid, kind: 'photo', url: full, thumbUrl: `/uploads/${thumbName(p.filename)}` });
  }
  return out;
}

// Expands a raw `yoyos` row into the shape the API/client expects: attaches
// its photos (in sort order, as URLs), parses the `custom` JSON blob back into
// an object, and adds the computed `percent_off`.
function decorate(yoyo) {
  const photos = collapseMedia(
    db.prepare('SELECT id, uuid, filename, kind, group_uuid FROM photos WHERE yoyo_id = ? ORDER BY sort_order, id')
      .all(yoyo.id)
  );
  let custom = {};
  try { custom = JSON.parse(yoyo.custom || '{}'); } catch { /* ignore bad JSON */ }
  return { ...yoyo, custom, percent_off: percentOff(yoyo), photos, videos: videosFor(yoyo.id) };
}

// ---- Custom fields ----
const FIELD_TYPES = ['text', 'number', 'select', 'boolean'];
const RESERVED_KEYS = new Set([...TEXT_FIELDS, ...NUMBER_FIELDS, ...BOOL_FIELDS,
  'id', 'uuid', 'custom', 'created_at', 'updated_at', 'deleted_at', 'rev', 'percent_off', 'photos']);

// All custom field definitions, in display order, with `options` parsed from
// its stored JSON string into a real array.
function loadFieldDefs() {
  return db.prepare('SELECT * FROM field_defs ORDER BY sort_order, id').all()
    .map((d) => ({ ...d, options: JSON.parse(d.options || '[]') }));
}

// Turns a user-typed label ("Wax Finish?") into a safe column-ish key
// ("wax_finish") for storing inside the `custom` JSON blob.
function slugify(label) {
  // Bound the input first so a pathologically long label can't cause a
  // super-linear regex, then collapse non-alphanumerics and trim underscores
  // with a plain loop (no backtracking-prone anchored regex).
  const s = String(label).slice(0, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  let a = 0, b = s.length;
  while (a < b && s[a] === '_') a++;
  while (b > a && s[b - 1] === '_') b--;
  return s.slice(a, b).slice(0, 40) || 'field';
}

// Disambiguates a slugified key against both the built-in columns and any
// existing custom-field keys, appending _2, _3, ... until it's free.
function uniqueKey(base) {
  const taken = new Set(db.prepare('SELECT key FROM field_defs').all().map((r) => r.key));
  let key = base, n = 2;
  while (RESERVED_KEYS.has(key) || taken.has(key)) key = `${base}_${n++}`;
  return key;
}

// Sanitize a { key: value } object against the current field definitions.
function sanitizeCustom(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const out = {};
  for (const d of loadFieldDefs()) {
    const v = src[d.key];
    if (v === undefined || v === null || v === '') continue;
    if (d.type === 'number') { const n = toNumber(v); if (n != null) out[d.key] = n; }
    else if (d.type === 'boolean') { if (v === true || v === 1 || /^(1|true|yes|x)$/i.test(String(v))) out[d.key] = true; }
    else if (d.type === 'select') { const s = String(v).trim(); if (s) out[d.key] = s; } // new values allowed (see growSelectOptions)
    else out[d.key] = String(v).trim();
  }
  return out;
}

// When a yoyo is saved with a new choice value, remember it as a dropdown option.
function growSelectOptions(customObj) {
  for (const d of loadFieldDefs()) {
    if (d.type !== 'select') continue;
    const v = customObj[d.key];
    if (v && !d.options.includes(v)) {
      db.prepare('UPDATE field_defs SET options = ? WHERE id = ?')
        .run(JSON.stringify([...d.options, v]), d.id);
    }
  }
}

// Fields hidden from anyone who can't edit (public/read-only view).
const SENSITIVE_KEYS = ['retail', 'paid', 'percent_off', 'tracking', 'eta', 'in_hand', 'purchase_date', 'sold_date', 'seller', 'buyer', 'market_value', 'trade_value', 'sale_listed_at'];
function publicSafe(y, editable) {
  if (editable) return y;
  const out = { ...y };
  for (const k of SENSITIVE_KEYS) delete out[k];
  return out;
}

// ---- API: yoyos ----

app.get('/api/yoyos', (req, res) => {
  const editable = isOwner(req);
  const rows = db.prepare('SELECT * FROM yoyos WHERE deleted_at IS NULL ORDER BY brand, model, color').all();
  res.json(rows.map((r) => publicSafe(decorate(r), editable)));
});

app.get('/api/yoyos/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(publicSafe(decorate(row), isOwner(req)));
});

const WRITE_COLS_C = [...WRITE_COLS, 'custom'];
// Columns written when creating a row. `uuid` is server-generated here (not part
// of the client-writable set) so every yoyo gets a stable cross-device id.
// `rev` marks the row's position in the sync change feed (see db.js nextRev).
// `sale_listed_at` is likewise server-managed (see below) rather than client-writable.
const INSERT_COLS = [...WRITE_COLS_C, 'uuid', 'rev', 'sale_listed_at'];
const INSERT_SQL = `INSERT INTO yoyos (${INSERT_COLS.join(', ')}) VALUES (${INSERT_COLS.map((c) => `@${c}`).join(', ')})`;

app.post('/api/yoyos', (req, res) => {
  const y = sanitizeYoyo(req.body);
  const customObj = sanitizeCustom(req.body.custom);
  growSelectOptions(customObj);
  y.custom = JSON.stringify(customObj);
  y.uuid = crypto.randomUUID();
  y.sale_listed_at = FOR_SALE_STATUSES.has(y.sale_status) ? new Date().toISOString() : null;
  let info;
  db.transaction(() => {
    y.rev = nextRev();
    info = db.prepare(INSERT_SQL).run(y);
  })();
  const row = db.prepare('SELECT * FROM yoyos WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(decorate(row));
});

app.put('/api/yoyos/:id', (req, res) => {
  const existing = db.prepare('SELECT sale_status, sale_listed_at FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const y = sanitizeYoyo(req.body);
  const customObj = sanitizeCustom(req.body.custom);
  growSelectOptions(customObj);
  y.custom = JSON.stringify(customObj);
  // Stamp sale_listed_at the moment a yoyo first goes live (wasn't for-sale,
  // now is); clear it on unlisting; otherwise leave it alone — this is what
  // lets the seller tools sort/flag by "days listed" without the client
  // needing to know or send this timestamp at all.
  const wasListed = FOR_SALE_STATUSES.has(existing.sale_status);
  const nowListed = FOR_SALE_STATUSES.has(y.sale_status);
  y.sale_listed_at = nowListed
    ? (wasListed ? existing.sale_listed_at : new Date().toISOString())
    : (y.sale_status === '' ? null : existing.sale_listed_at);
  const assignments = WRITE_COLS_C.map((c) => `${c} = @${c}`).join(', ');
  db.transaction(() => {
    db.prepare(
      `UPDATE yoyos SET ${assignments}, sale_listed_at = @sale_listed_at, updated_at = datetime('now'), rev = @rev WHERE id = @id`
    ).run({ ...y, rev: nextRev(), id: Number(req.params.id) });
  })();
  const row = db.prepare('SELECT * FROM yoyos WHERE id = ?').get(req.params.id);
  res.json(decorate(row));
});

app.delete('/api/yoyos/:id', (req, res) => {
  // Only a live yoyo can be deleted; a soft-deleted one is already gone.
  const existing = db.prepare('SELECT id FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Free the disk now (a tombstone doesn't need its media) — every file each row
  // owns, which for a video means its poster still and that poster's thumbnail
  // as well, then drop the photo rows.
  const photos = db.prepare('SELECT filename, kind FROM photos WHERE yoyo_id = ?').all(req.params.id);
  for (const p of photos) {
    for (const name of mediaFilesFor(p)) fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
  }
  // Keep the yoyo row as a tombstone (deleted_at set) so the deletion propagates
  // to other devices on sync, rather than re-appearing from a device that still has it.
  db.transaction(() => {
    db.prepare('DELETE FROM photos WHERE yoyo_id = ?').run(req.params.id);
    db.prepare('DELETE FROM videos WHERE yoyo_id = ?').run(req.params.id);
    db.prepare("UPDATE yoyos SET deleted_at = datetime('now'), updated_at = datetime('now'), rev = ? WHERE id = ?")
      .run(nextRev(), req.params.id);
  })();
  res.json({ ok: true });
});

// ---- API: photos ----

// Photo changes ride the parent yoyo through sync (its photo manifest), so
// every photo mutation must look like an edit to the parent: bump updated_at
// and give the row a fresh change-feed position.
function touchYoyo(id) {
  db.prepare("UPDATE yoyos SET updated_at = datetime('now'), rev = ? WHERE id = ?").run(nextRev(), id);
}

app.post('/api/yoyos/:id/photos', upload.array('photos', 12), async (req, res) => {
  const yoyo = db.prepare('SELECT id FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!yoyo) return res.status(404).json({ error: 'Not found' });

  const maxRow = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM photos WHERE yoyo_id = ?')
    .get(req.params.id);
  let order = maxRow.m + 1;

  const insert = db.prepare(
    'INSERT INTO photos (yoyo_id, uuid, filename, sort_order) VALUES (?, ?, ?, ?)'
  );
  const files = req.files || [];
  const tx = db.transaction((fs2) => {
    for (const file of fs2) insert.run(req.params.id, crypto.randomUUID(), file.filename, order++);
    touchYoyo(req.params.id);
  });
  tx(files);

  // Build a small thumbnail for each upload so the grid never serves the full image.
  await Promise.all(files.map((f) => makeThumb(f.filename).catch((e) => console.error('thumb error:', e.message))));

  res.status(201).json(decorate(db.prepare('SELECT * FROM yoyos WHERE id = ?').get(req.params.id)));
});

// Identifies an image by its magic bytes rather than its name. Inside a zip the
// entry name is attacker-controlled, so an extension there proves nothing about
// the contents — this is what decides whether a member is stored at all, and
// what extension it gets.
function sniffImageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  const gif = buf.subarray(0, 6).toString('latin1');
  if (gif === 'GIF87a' || gif === 'GIF89a') return '.gif';
  return null;
}

// Unpacks a zip of spin frames into UPLOAD_DIR and returns them in frame order,
// shaped like multer's file objects so the caller can't tell the two paths apart.
//
// Nothing from inside the archive reaches the filesystem: names are generated,
// entry paths are ignored entirely (so a `../../etc/passwd` member is just
// another image), and members are identified by magic bytes.
function extractSpinArchive(zipPath) {
  let entries;
  try { entries = new AdmZip(zipPath).getEntries(); }
  catch { throw new Error('That file is not a readable .zip.'); }

  const members = entries
    .filter((e) => !e.isDirectory)
    // Skip the metadata folders macOS adds when you right-click → Compress, and
    // any dotfile — otherwise ._spin_01.jpg doubles every frame.
    .filter((e) => !e.entryName.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('.')))
    .sort((a, b) => path.basename(a.entryName).localeCompare(path.basename(b.entryName), undefined, { numeric: true, sensitivity: 'base' }));

  if (members.length > MAX_SPIN_FRAMES) {
    throw new Error(`That archive holds ${members.length} files — the limit is ${MAX_SPIN_FRAMES} frames.`);
  }
  // Check the declared sizes before writing anything, so a zip bomb is refused
  // rather than half-extracted.
  let declared = 0;
  for (const e of members) {
    if (e.header.size > MAX_SPIN_FRAME_BYTES) throw new Error('A frame in that archive is larger than 5 MB.');
    declared += e.header.size;
  }
  if (declared > MAX_SPIN_ARCHIVE_BYTES) {
    throw new Error(`That archive expands to more than ${Math.round(MAX_SPIN_ARCHIVE_BYTES / 1048576)} MB.`);
  }

  const written = [];
  try {
    for (const e of members) {
      const data = e.getData();
      const ext = sniffImageExt(data);
      if (!ext) continue; // not an image — a stray readme, say
      const filename = tempName(ext);
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), data);
      written.push({ filename, originalname: path.basename(e.entryName) });
    }
  } catch (err) {
    // Don't leave a partial sequence behind if one member fails to inflate.
    for (const f of written) fs.rmSync(path.join(UPLOAD_DIR, f.filename), { force: true });
    throw err;
  }
  return written;
}

// Shared tail of both spin endpoints: sort the frames, insert them as one
// group, thumbnail the lead frame. The client sorts frames by filename before
// sending, but sort again here so a client that doesn't (or a browser that
// reorders multipart parts) still gets a spin that rotates smoothly rather
// than shuffling.
async function saveSpinFrames(req, res, files) {
  files.sort((a, b) => a.originalname.localeCompare(b.originalname, undefined, { numeric: true, sensitivity: 'base' }));

  const group = crypto.randomUUID();
  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM photos WHERE yoyo_id = ?').get(req.params.id);
  let order = maxRow.m + 1;
  const insert = db.prepare(
    'INSERT INTO photos (yoyo_id, uuid, filename, kind, group_uuid, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  );
  db.transaction((frames) => {
    for (const f of frames) insert.run(req.params.id, crypto.randomUUID(), f.filename, 'spin', group, order++);
    touchYoyo(req.params.id);
  })(files);

  // Only the first frame needs a thumbnail — it's the still every list view
  // draws. Thumbnailing the rest would write dozens of images nothing requests.
  await makeThumb(files[0].filename).catch((e) => console.error('thumb error:', e.message));

  res.status(201).json(decorate(db.prepare('SELECT * FROM yoyos WHERE id = ?').get(req.params.id)));
}

// Uploads a 360 spin as loose, already-extracted frames.
app.post('/api/yoyos/:id/spin', uploadSpinFrames.array('frames', MAX_SPIN_FRAMES), async (req, res) => {
  const files = req.files || [];
  const discard = () => files.forEach((f) => fs.rm(path.join(UPLOAD_DIR, f.filename), { force: true }, () => {}));

  const yoyo = db.prepare('SELECT id FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!yoyo) { discard(); return res.status(404).json({ error: 'Not found' }); }
  if (files.length < 2) { discard(); return res.status(400).json({ error: 'A 360 spin needs at least 2 frames.' }); }

  await saveSpinFrames(req, res, files);
});

// Uploads a 360 spin as one .zip of the frame sequence — the same spin as the
// route above, just delivered in a single file and unpacked here.
app.post('/api/yoyos/:id/spin-archive', uploadSpinArchive.single('archive'), async (req, res) => {
  const archive = req.file;
  const dropArchive = () => { if (archive) fs.rm(path.join(UPLOAD_DIR, archive.filename), { force: true }, () => {}); };

  const yoyo = db.prepare('SELECT id FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!yoyo) { dropArchive(); return res.status(404).json({ error: 'Not found' }); }
  if (!archive) return res.status(400).json({ error: 'No archive uploaded.' });

  let files;
  try {
    files = extractSpinArchive(path.join(UPLOAD_DIR, archive.filename));
  } catch (err) {
    dropArchive();
    return res.status(400).json({ error: err.message });
  } finally {
    fs.rm(path.join(UPLOAD_DIR, archive.filename), { force: true }, () => {});
  }

  if (files.length < 2) {
    files.forEach((f) => fs.rm(path.join(UPLOAD_DIR, f.filename), { force: true }, () => {}));
    return res.status(400).json({ error: 'That archive held fewer than 2 images — a 360 spin needs a frame sequence.' });
  }

  await saveSpinFrames(req, res, files);
});

// Uploads a looped video plus the poster frame the browser extracted from it.
// The poster is mandatory: without it every list view would have to load the
// video itself just to draw a tile.
app.post('/api/yoyos/:id/video',
  uploadVideo.fields([{ name: 'video', maxCount: 1 }, { name: 'poster', maxCount: 1 }]),
  async (req, res) => {
    const video = req.files?.video?.[0];
    const poster = req.files?.poster?.[0];
    const discard = () => [video, poster].forEach((f) => {
      if (f) fs.rm(path.join(UPLOAD_DIR, f.filename), { force: true }, () => {});
    });

    const yoyo = db.prepare('SELECT id FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!yoyo) { discard(); return res.status(404).json({ error: 'Not found' }); }
    if (!video) { discard(); return res.status(400).json({ error: 'No video uploaded.' }); }
    if (!poster) { discard(); return res.status(400).json({ error: 'Could not read a poster frame from that video.' }); }

    // Park the poster at the name derived from the video, so the pairing
    // survives in the filesystem alone (backup/restore copies files by basename).
    const posterFile = posterName(video.filename);
    fs.renameSync(path.join(UPLOAD_DIR, poster.filename), path.join(UPLOAD_DIR, posterFile));

    const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM photos WHERE yoyo_id = ?').get(req.params.id);
    db.transaction(() => {
      db.prepare('INSERT INTO photos (yoyo_id, uuid, filename, kind, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(req.params.id, crypto.randomUUID(), video.filename, 'video', maxRow.m + 1);
      touchYoyo(req.params.id);
    })();

    await makeThumb(posterFile).catch((e) => console.error('thumb error:', e.message));

    res.status(201).json(decorate(db.prepare('SELECT * FROM yoyos WHERE id = ?').get(req.params.id)));
  });

// The still image that stands in for a media row in list views: the file
// itself for a photo or spin frame, the extracted poster for a video. Every
// surface that needs "the still for this row" goes through here so they can't
// diverge (collapseMedia, /api/photos/optimize, and the sync change feed each
// used to derive it independently — the feed's copy was wrong for videos).
// Served for a synced video whose poster bytes haven't arrived yet (see
// collapseMedia). A static asset, so it caches like any other file.
const VIDEO_PENDING_STILL = '/video-pending.svg';

function stillNameFor(row) {
  return row.kind === 'video' ? posterName(row.filename) : row.filename;
}

// Every file a photo row owns: the media itself, its thumbnail, and (for
// video) the poster still and the poster's thumbnail.
function mediaFilesFor(row) {
  const names = [row.filename, thumbName(row.filename)];
  if (row.kind === 'video') {
    const poster = posterName(row.filename);
    names.push(poster, thumbName(poster));
  }
  return names;
}

app.delete('/api/photos/:photoId', (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  // A spin is one gallery item, so deleting it deletes the whole sequence —
  // removing a single frame would leave a rotation that jumps.
  const rows = photo.kind === 'spin' && photo.group_uuid
    ? db.prepare('SELECT * FROM photos WHERE group_uuid = ? AND yoyo_id = ?').all(photo.group_uuid, photo.yoyo_id)
    : [photo];
  const del = db.prepare('DELETE FROM photos WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) del.run(r.id);
    touchYoyo(photo.yoyo_id);
  })();
  for (const r of rows) {
    for (const name of mediaFilesFor(r)) {
      fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
    }
  }
  res.json({ ok: true });
});

// One-time backfill: generate thumbnails for existing photos (idempotent).
app.post('/api/photos/optimize', async (req, res) => {
  if (!sharp) return res.status(503).json({ error: 'Image processing (sharp) is not installed on this server.' });
  const rows = db.prepare('SELECT filename, kind, group_uuid FROM photos ORDER BY sort_order, id').all();
  let processed = 0, skipped = 0, failed = 0;
  const seenSpin = new Set();
  for (const r of rows) {
    // Only a spin's lead frame is ever drawn as a still; thumbnailing the rest
    // would write dozens of images nothing requests.
    if (r.kind === 'spin' && r.group_uuid) {
      if (seenSpin.has(r.group_uuid)) { skipped++; continue; }
      seenSpin.add(r.group_uuid);
    }
    // sharp can't decode video, so a video row's still is its poster frame.
    const src = stillNameFor(r);
    if (!fs.existsSync(path.join(UPLOAD_DIR, src))) { skipped++; continue; }
    if (fs.existsSync(path.join(UPLOAD_DIR, thumbName(src)))) { skipped++; continue; }
    try { await makeThumb(src); processed++; } catch (e) { console.error('optimize:', e.message); failed++; }
  }
  res.json({ total: rows.length, processed, skipped, failed });
});

// Reorder a yoyo's photos (first = cover). Body: { ids: [photoId, ...] }.
app.put('/api/yoyos/:id/photos/order', (req, res) => {
  const yoyo = db.prepare('SELECT id FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!yoyo) return res.status(404).json({ error: 'Not found' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
  const upd = db.prepare('UPDATE photos SET sort_order = ? WHERE id = ? AND yoyo_id = ?');
  // The client reorders gallery items, but sort_order lives on files. Each id
  // is a spin's first frame or a standalone photo/video, so expand it back into
  // its rows and hand out a contiguous block — that keeps a spin's frames
  // adjacent and in sequence no matter where the spin lands in the gallery.
  const rowsFor = (pid) => {
    const row = db.prepare('SELECT id, kind, group_uuid FROM photos WHERE id = ? AND yoyo_id = ?').get(pid, req.params.id);
    if (!row) return [];
    if (row.kind !== 'spin' || !row.group_uuid) return [row.id];
    return db.prepare('SELECT id FROM photos WHERE group_uuid = ? AND yoyo_id = ? ORDER BY sort_order, id')
      .all(row.group_uuid, req.params.id).map((r) => r.id);
  };
  db.transaction(() => {
    let order = 0;
    for (const pid of ids) {
      for (const rowId of rowsFor(pid)) upd.run(order++, rowId, req.params.id);
    }
    touchYoyo(req.params.id);
  })();
  res.json(decorate(db.prepare('SELECT * FROM yoyos WHERE id = ?').get(req.params.id)));
});

// ---- API: external video embeds ----

app.post('/api/yoyos/:id/videos', async (req, res) => {
  const yoyo = db.prepare('SELECT id FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!yoyo) return res.status(404).json({ error: 'Not found' });

  const parsed = parseVideoUrl(req.body?.url);
  if (!parsed) {
    return res.status(400).json({
      error: 'Paste a YouTube or Instagram link (youtube.com, m.youtube.com, youtu.be, or instagram.com).',
    });
  }
  let title = String(req.body?.title || '').trim().slice(0, 200);
  if (!title) title = await fetchVideoTitle(parsed.provider, parsed.embed_ref);

  const dupe = db.prepare('SELECT id FROM videos WHERE yoyo_id = ? AND provider = ? AND embed_ref = ?')
    .get(req.params.id, parsed.provider, parsed.embed_ref);
  if (dupe) return res.status(409).json({ error: 'That video is already on this yoyo.' });

  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM videos WHERE yoyo_id = ?').get(req.params.id);
  db.transaction(() => {
    db.prepare(`INSERT INTO videos (yoyo_id, uuid, provider, embed_ref, url, title, vertical, start_s, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, crypto.randomUUID(), parsed.provider, parsed.embed_ref,
        parsed.url.slice(0, 2048), title, parsed.vertical ? 1 : 0, parsed.start_s, maxRow.m + 1);
    touchYoyo(req.params.id);
  })();

  // Cache the poster before responding so the card renders with it
  // immediately; a failed fetch just means the placeholder until self-heal.
  await fetchVidThumb(parsed.provider, parsed.embed_ref);

  res.status(201).json(decorate(db.prepare('SELECT * FROM yoyos WHERE id = ?').get(req.params.id)));
});

app.delete('/api/videos/:videoId', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
  if (!video) return res.status(404).json({ error: 'Not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.videoId);
    touchYoyo(video.yoyo_id);
  })();
  cleanupVidThumbs([video]);
  res.json({ ok: true });
});

// ---- API: sync (native apps) ----
// Hub-and-spoke sync: apps pull rows changed since a rev cursor (tombstones
// included), push batched uuid-keyed upserts resolved by last-writer-wins on
// updated_at, and transfer photo files incrementally. See yoyo-ios-plan.md.

const SQL_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MANIFEST_EXTS = new Set(['jpg', 'png', 'webp', 'gif', 'mp4', 'webm']);

// Same shape as SQLite's datetime('now') so string comparisons stay valid.
function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function currentRev() {
  return Number(db.prepare("SELECT value FROM settings WHERE key = 'sync_rev'").get().value);
}

// Accepts only well-formed "YYYY-MM-DD HH:MM:SS"; clamps timestamps more than
// 5 minutes in the future (a skewed device clock must not win conflicts forever).
function acceptTimestamp(ts, now) {
  if (!SQL_TS_RE.test(String(ts || ''))) return null;
  const max = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  if (ts > max) { console.warn(`sync: clamped future timestamp ${ts}`); return now; }
  return ts;
}

// Sync stores custom keys as-is (the app is a first-class writer and may carry
// keys the web has no field_defs for) — shape-check only, unlike sanitizeCustom.
function sanitizeSyncCustom(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== 'string' || !k || k.length > 60) continue;
    if (!['string', 'number', 'boolean'].includes(typeof v)) continue;
    out[k] = v;
    if (Object.keys(out).length >= 50) break;
  }
  return out;
}

app.get('/api/sync/changes', (req, res) => {
  // GETs bypass the write gate, and this payload includes owner-only fields.
  if (!isLoggedIn(req)) return res.status(401).json({ error: 'Please sign in to sync.' });
  const since = Math.max(0, Number(req.query.since) || 0);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));

  const rows = db.prepare('SELECT * FROM yoyos WHERE rev > ? ORDER BY rev LIMIT ?').all(since, limit);
  const photosFor = db.prepare('SELECT uuid, filename, kind, group_uuid, sort_order FROM photos WHERE yoyo_id = ? ORDER BY sort_order, id');
  const yoyos = rows.map((r) => {
    let custom = {};
    try { custom = JSON.parse(r.custom || '{}'); } catch { /* ignore bad JSON */ }
    // kind/group_uuid ride along so a client can reassemble a spin's frames into
    // one gallery item instead of showing them as N loose photos — and so the
    // manifest it pushes back doesn't flatten the spin.
    //
    // still_url is the image to RENDER for the row (a video's poster, the file
    // itself otherwise); thumb_url is only sent for files a thumbnail is
    // actually generated for — the lead frame of a spin, the poster of a video,
    // every plain photo. It used to name thumb-<video>.jpg and a thumb for all
    // 36 frames of a spin, none of which exist on disk.
    const seenGroups = new Set();
    const photos = r.deleted_at ? [] : photosFor.all(r.id).map((p) => {
      const still = stillNameFor(p);
      let hasThumb = true;
      if (p.kind === 'spin' && p.group_uuid) {
        hasThumb = !seenGroups.has(p.group_uuid); // only the lead frame is thumbnailed
        seenGroups.add(p.group_uuid);
      }
      return {
        uuid: p.uuid,
        sort_order: p.sort_order,
        kind: p.kind,
        group_uuid: p.group_uuid,
        url: `/uploads/${p.filename}`,
        still_url: `/uploads/${still}`,
        thumb_url: hasThumb ? `/uploads/${thumbName(still)}` : null,
      };
    });
    return { ...r, custom, photos, videos: r.deleted_at ? [] : videosFor(r.id) };
  });

  res.json({
    serverTime: nowSql(),
    latestRev: currentRev(),
    hasMore: rows.length === limit,
    yoyos,
  });
});

const SYNC_UPSERT_COLS = [...WRITE_COLS_C, 'uuid', 'created_at', 'updated_at', 'deleted_at', 'rev'];
const SYNC_INSERT_SQL = `INSERT INTO yoyos (${SYNC_UPSERT_COLS.join(', ')}) VALUES (${SYNC_UPSERT_COLS.map((c) => `@${c}`).join(', ')})`;
const SYNC_UPDATE_SQL = `UPDATE yoyos SET ${[...WRITE_COLS_C, 'updated_at', 'deleted_at'].map((c) => `${c} = @${c}`).join(', ')}, rev = @rev WHERE id = @id`;

// Reconciles a live yoyo's photo rows against a pushed manifest
// [{uuid, sort_order, ext}]. Returns the uuids whose files the client must
// upload (rows exist so other devices see the manifest; bytes follow).
function applyPhotoManifest(yoyoId, manifest) {
  const missing = [];
  const entries = [];
  for (const m of Array.isArray(manifest) ? manifest : []) {
    if (!UUID_RE.test(String(m?.uuid || ''))) continue;
    const ext = MANIFEST_EXTS.has(String(m?.ext || '').toLowerCase()) ? String(m.ext).toLowerCase() : 'jpg';
    // A client that predates spin/video omits kind entirely; treat its rows as
    // plain photos on insert, but remember whether kind was explicit — an
    // explicit kind may correct an existing row (e.g. one created bytes-first),
    // while an absent one must never flatten a video or spin back to 'photo'.
    const kindProvided = ['photo', 'video', 'spin'].includes(m?.kind);
    const kind = kindProvided ? m.kind : 'photo';
    const groupUuid = kind === 'spin' && UUID_RE.test(String(m?.group_uuid || '')) ? m.group_uuid : null;
    entries.push({ uuid: m.uuid, sort_order: Number(m.sort_order) || 0, ext, kind, kindProvided, group_uuid: groupUuid });
  }
  const keep = new Set(entries.map((e) => e.uuid));
  for (const p of db.prepare('SELECT * FROM photos WHERE yoyo_id = ?').all(yoyoId)) {
    if (keep.has(p.uuid)) continue;
    db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    for (const name of mediaFilesFor(p)) fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
  }
  for (const e of entries) {
    const row = db.prepare('SELECT * FROM photos WHERE uuid = ?').get(e.uuid);
    if (row) {
      if (row.yoyo_id !== yoyoId) continue; // uuid belongs to another yoyo — ignore
      if (e.kindProvided) {
        db.prepare('UPDATE photos SET sort_order = ?, kind = ?, group_uuid = ? WHERE id = ?')
          .run(e.sort_order, e.kind, e.group_uuid, row.id);
      } else {
        db.prepare('UPDATE photos SET sort_order = ? WHERE id = ?').run(e.sort_order, row.id);
      }
      // A video needs both its bytes and its poster still; ask again until the
      // client has delivered the pair (see /api/sync/photos).
      const kindNow = e.kindProvided ? e.kind : row.kind;
      const wantPoster = kindNow === 'video' && !fs.existsSync(path.join(UPLOAD_DIR, posterName(row.filename)));
      if (!fs.existsSync(path.join(UPLOAD_DIR, row.filename)) || wantPoster) missing.push(e.uuid);
    } else {
      db.prepare('INSERT INTO photos (yoyo_id, uuid, filename, kind, group_uuid, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
        .run(yoyoId, e.uuid, `${e.uuid}.${e.ext}`, e.kind, e.group_uuid, e.sort_order);
      missing.push(e.uuid);
    }
  }
  return missing;
}

// Reconciles a live yoyo's video rows against a pushed list, mirroring
// applyPhotoManifest. Videos carry no files, so there's nothing to report back.
function applyVideoList(yoyoId, list) {
  const entries = [];
  for (const v of Array.isArray(list) ? list : []) {
    if (!UUID_RE.test(String(v?.uuid || ''))) continue;
    const parsed = parseVideoUrl(v?.url);
    if (!parsed) continue; // unsupported or malformed link — don't store it
    entries.push({
      uuid: v.uuid,
      sort_order: Number(v.sort_order) || 0,
      title: String(v?.title || '').trim().slice(0, 200),
      ...parsed,
      url: parsed.url.slice(0, 2048), // normalized absolute form, never the raw paste
    });
  }
  const keep = new Set(entries.map((e) => e.uuid));
  const removed = [];
  for (const row of db.prepare('SELECT id, uuid, provider, embed_ref FROM videos WHERE yoyo_id = ?').all(yoyoId)) {
    if (!keep.has(row.uuid)) { removed.push(row); db.prepare('DELETE FROM videos WHERE id = ?').run(row.id); }
  }
  for (const e of entries) {
    const row = db.prepare('SELECT * FROM videos WHERE uuid = ?').get(e.uuid);
    if (row) {
      if (row.yoyo_id !== yoyoId) continue; // uuid belongs to another yoyo — ignore
      db.prepare(`UPDATE videos SET provider = ?, embed_ref = ?, url = ?, title = ?,
        vertical = ?, start_s = ?, sort_order = ? WHERE id = ?`)
        .run(e.provider, e.embed_ref, e.url, e.title, e.vertical ? 1 : 0, e.start_s, e.sort_order, row.id);
    } else {
      db.prepare(`INSERT INTO videos (yoyo_id, uuid, provider, embed_ref, url, title, vertical, start_s, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(yoyoId, e.uuid, e.provider, e.embed_ref, e.url, e.title, e.vertical ? 1 : 0, e.start_s, e.sort_order);
    }
  }
  // Outside-the-transaction work: posters are a cache, so fetch/cleanup can
  // safely run after commit — queueVidThumb never throws and cleanup re-checks
  // the table before removing a file.
  setImmediate(async () => {
    for (const e of entries) queueVidThumb(e.provider, e.embed_ref);
    cleanupVidThumbs(removed);
    if (entries.some((e) => !e.title)) await backfillVideoTitles().catch(() => {});
  });
}

app.post('/api/sync/push', (req, res) => {
  const incoming = Array.isArray(req.body?.yoyos) ? req.body.yoyos : null;
  if (!incoming) return res.status(400).json({ error: 'Body must be { yoyos: [...] }.' });
  if (incoming.length > 50) return res.status(400).json({ error: 'Batch too large (max 50 records).' });

  const now = nowSql();
  const results = [];

  db.transaction(() => {
    for (const rec of incoming) {
      const uuid = String(rec?.uuid || '');
      if (!UUID_RE.test(uuid)) { results.push({ uuid, applied: false, reason: 'bad-uuid' }); continue; }
      const updatedAt = acceptTimestamp(rec.updated_at, now);
      if (!updatedAt) { results.push({ uuid, applied: false, reason: 'bad-timestamp' }); continue; }
      const deletedAt = rec.deleted_at == null ? null : acceptTimestamp(rec.deleted_at, now);
      const createdAt = acceptTimestamp(rec.created_at, now) || now;

      const y = sanitizeYoyo(rec);
      const customObj = sanitizeSyncCustom(rec.custom);
      growSelectOptions(customObj);
      y.custom = JSON.stringify(customObj);

      const existing = db.prepare('SELECT * FROM yoyos WHERE uuid = ?').get(uuid);
      if (existing) {
        // Last-writer-wins: strictly newer applies; ties go to the server (the
        // loser's device marks itself clean and re-pulls the winning copy).
        if (updatedAt <= existing.updated_at) {
          results.push({ uuid, applied: false, reason: 'server-newer' });
          continue;
        }
        // A pushed delete mirrors DELETE /api/yoyos/:id — media files go now.
        if (deletedAt && !existing.deleted_at) {
          for (const p of db.prepare('SELECT filename, kind FROM photos WHERE yoyo_id = ?').all(existing.id)) {
            for (const name of mediaFilesFor(p)) fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
          }
          db.prepare('DELETE FROM photos WHERE yoyo_id = ?').run(existing.id);
          db.prepare('DELETE FROM videos WHERE yoyo_id = ?').run(existing.id);
        }
        const rev = nextRev();
        db.prepare(SYNC_UPDATE_SQL).run({ ...y, updated_at: updatedAt, deleted_at: deletedAt, rev, id: existing.id });
        const missingPhotos = (!deletedAt && rec.photos !== undefined)
          ? applyPhotoManifest(existing.id, rec.photos) : [];
        if (!deletedAt && rec.videos !== undefined) applyVideoList(existing.id, rec.videos);
        results.push({ uuid, applied: true, rev, missingPhotos });
      } else {
        // New to the server. Tombstones insert too: a device that still holds
        // the record must learn about the delete on its next pull.
        const rev = nextRev();
        const info = db.prepare(SYNC_INSERT_SQL).run({
          ...y, uuid, created_at: createdAt, updated_at: updatedAt, deleted_at: deletedAt, rev,
        });
        const missingPhotos = (!deletedAt && rec.photos !== undefined)
          ? applyPhotoManifest(info.lastInsertRowid, rec.photos) : [];
        if (!deletedAt && rec.videos !== undefined) applyVideoList(info.lastInsertRowid, rec.videos);
        results.push({ uuid, applied: true, rev, missingPhotos });
      }
    }
  })();

  res.json({ serverTime: nowSql(), latestRev: currentRev(), results });
});

// Receives the bytes for one photo the client was told is missing. The row
// (created by push) maps uuid -> filename; the parent gets a rev-only bump so
// other devices re-pull and fetch the now-present file — no updated_at bump,
// because the manifest edit already synced and this must not look like a new
// conflicting edit.
const uploadSyncPhoto = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    // The poster part is written to a temp name and renamed once the video's
    // final name is known — deriving it from the uuid directly would let a
    // poster-only request (no video part) plant a file at the video's name.
    filename: (req, file, cb) => cb(null, file.fieldname === 'poster'
      ? tempName('.jpg')
      : `${req.params.photoUuid}${EXT_BY_MIME[file.mimetype] || '.jpg'}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const ok = file.fieldname === 'poster'
      ? ALLOWED_IMAGE_TYPES.has(file.mimetype)
      : ALLOWED_IMAGE_TYPES.has(file.mimetype) || ALLOWED_VIDEO_TYPES.has(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Only image or video files are allowed.'));
  },
});

app.post('/api/sync/photos/:yoyoUuid/:photoUuid', (req, res, next) => {
  // Validate BEFORE multer touches the filesystem — the uuid becomes a filename.
  if (!UUID_RE.test(req.params.yoyoUuid) || !UUID_RE.test(req.params.photoUuid)) {
    return res.status(400).json({ error: 'Bad identifier.' });
  }
  next();
}, uploadSyncPhoto.fields([{ name: 'photo', maxCount: 1 }, { name: 'poster', maxCount: 1 }]), async (req, res) => {
  const file = req.files?.photo?.[0];
  const posterPart = req.files?.poster?.[0];
  const dropPoster = () => {
    if (posterPart) fs.rmSync(path.join(UPLOAD_DIR, path.basename(posterPart.filename)), { force: true });
  };
  if (!file) { dropPoster(); return res.status(400).json({ error: 'No photo uploaded.' }); }
  const yoyo = db.prepare('SELECT id FROM yoyos WHERE uuid = ? AND deleted_at IS NULL').get(req.params.yoyoUuid);
  if (!yoyo) {
    // basename() keeps this strictly inside UPLOAD_DIR even though the filename
    // is already a validated uuid (see the UUID_RE guard above).
    fs.rmSync(path.join(UPLOAD_DIR, path.basename(file.filename)), { force: true });
    dropPoster();
    return res.status(404).json({ error: 'Yoyo not found.' });
  }

  const isVideo = ALLOWED_VIDEO_TYPES.has(file.mimetype);
  let rev;
  db.transaction(() => {
    const row = db.prepare('SELECT * FROM photos WHERE uuid = ?').get(req.params.photoUuid);
    if (row && row.yoyo_id === yoyo.id) {
      db.prepare('UPDATE photos SET filename = ? WHERE id = ?').run(file.filename, row.id);
    } else if (!row) {
      const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM photos WHERE yoyo_id = ?').get(yoyo.id);
      // Bytes can arrive before the manifest (upload-first client, retries), so
      // this row must carry the right kind from the start — .mp4 bytes filed as
      // kind='photo' render as a broken <img src=".mp4"> in every view, and the
      // manifest's existing-row branch only corrects kind when one is provided.
      db.prepare('INSERT INTO photos (yoyo_id, uuid, filename, kind, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(yoyo.id, req.params.photoUuid, file.filename, isVideo ? 'video' : 'photo', maxRow.m + 1);
    }
    rev = nextRev();
    db.prepare('UPDATE yoyos SET rev = ? WHERE id = ?').run(rev, yoyo.id);
  })();

  if (isVideo) {
    // The server can't decode video (no ffmpeg), so the still comes from the
    // client, exactly like the web app's own /api/yoyos/:id/video route: an
    // optional `poster` part stored alongside the video under a derived name.
    // Until it arrives, collapseMedia serves a placeholder and the manifest
    // keeps listing this uuid as missing so the client re-sends the pair.
    if (posterPart) {
      const posterFile = posterName(file.filename);
      fs.renameSync(path.join(UPLOAD_DIR, posterPart.filename), path.join(UPLOAD_DIR, posterFile));
      await makeThumb(posterFile).catch((e) => console.error('thumb error:', e.message));
    }
  } else {
    dropPoster(); // a poster only pairs with video bytes
    await makeThumb(file.filename).catch((e) => console.error('thumb error:', e.message));
  }
  res.json({ ok: true, url: `/uploads/${file.filename}`, rev });
});

// ---- API: config ----
app.get('/api/config', (req, res) => res.json({
  canEdit: canEdit(req),
  isOwner: isOwner(req),
  readOnly: siteReadOnly(),
  loginEnabled: LOGIN_ENABLED,
  loggedIn: isLoggedIn(req),
  trackingEnabled: Object.values(configuredCarriers(process.env)).some(Boolean),
  demoMode: DEMO_MODE,
  version: APP_VERSION,
}));

// ---- API: update check ----
// Compares this instance's version against the latest GitHub release and, when
// behind, returns the copy-paste command to update. Owner-only (it makes an
// outbound call) and cached briefly so repeated clicks don't hammer GitHub's
// unauthenticated rate limit. The app never updates itself — a containerized
// process can't safely restart into a new image — so this is advisory only.
let updateCache = { at: 0, data: null };
app.get('/api/check-update', async (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ error: 'Log in to check for updates.' });
  const base = { current: APP_VERSION, runtime: IN_DOCKER ? 'docker' : 'node', updateCommand: updateCommand(), repo: UPDATE_REPO };

  const now = Date.now();
  if (updateCache.data && now - updateCache.at < 5 * 60 * 1000) {
    return res.json({ ...updateCache.data, cached: true });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let r;
    try {
      r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `yoyo-collection/${APP_VERSION}` },
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    const data = {
      ...base,
      latest,
      updateAvailable: latest ? cmpVersion(APP_VERSION, latest) < 0 : false,
      releaseUrl: j.html_url || `https://github.com/${UPDATE_REPO}/releases`,
      releaseName: j.name || null,
      publishedAt: j.published_at || null,
    };
    updateCache = { at: now, data };
    res.json(data);
  } catch (err) {
    // Soft failure (offline, rate-limited, timeout): still a 200 so the client
    // can show a friendly "couldn't check" without treating it as a hard error.
    res.json({ ...base, error: err.name === 'AbortError' ? 'The update check timed out.' : (err.message || 'Update check failed.') });
  }
});

// ---- API: site settings (key/value; e.g. For Sale shipping notes) ----
// Only these keys are readable/writable through the API.
const PUBLIC_SETTINGS = ['sale_notes', 'read_only'];
app.get('/api/settings', (_req, res) => {
  const out = {};
  for (const k of PUBLIC_SETTINGS) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    out[k] = row ? row.value : '';
  }
  res.json(out);
});
// Owner-only (the write gate above blocks this unless logged in, and in demo mode).
app.put('/api/settings/:key', (req, res) => {
  if (!PUBLIC_SETTINGS.includes(req.params.key)) return res.status(400).json({ error: 'Unknown setting.' });
  const value = String(req.body?.value ?? '').slice(0, 5000);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(req.params.key, value);
  res.json({ ok: true });
});

// ---- API: carrier tracking lookup (UPS / USPS / FedEx) ----
// Resolves a tracking number to an estimated delivery date. Carrier credentials
// are read from the environment; see carriers.js. Owner-only (write gate above).
app.post('/api/track', async (req, res) => {
  const tracking = String(req.body?.tracking || '').trim();
  const carrier = req.body?.carrier ? String(req.body.carrier).toLowerCase() : '';
  if (!tracking) return res.status(400).json({ error: 'Tracking number required.' });
  try {
    res.json(await trackPackage(tracking, carrier, process.env));
  } catch (err) {
    console.error('track error:', err.message);
    res.status(502).json({ error: err.message || 'Tracking lookup failed.' });
  }
});

// ---- API: custom field definitions ----
app.get('/api/fields', (_req, res) => res.json(loadFieldDefs()));

app.post('/api/fields', (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'A field name is required.' });
  const type = FIELD_TYPES.includes(req.body?.type) ? req.body.type : 'text';
  let options = Array.isArray(req.body?.options)
    ? [...new Set(req.body.options.map((o) => String(o).trim()).filter(Boolean))] : [];
  if (type !== 'select') options = [];
  if (type === 'select' && !options.length) return res.status(400).json({ error: 'A choice field needs at least one option.' });

  const key = uniqueKey(slugify(label));
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM field_defs').get().m;
  db.prepare('INSERT INTO field_defs (key, label, type, options, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(key, label, type, JSON.stringify(options), maxSort + 1);
  res.status(201).json(loadFieldDefs());
});

// Reorder must be matched before the ":id" route below.
app.put('/api/fields/reorder', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const upd = db.prepare('UPDATE field_defs SET sort_order = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, Number(id))))();
  res.json(loadFieldDefs());
});

// Rename a field and/or edit its choices (type is fixed once created).
app.put('/api/fields/:id', (req, res) => {
  const def = db.prepare('SELECT * FROM field_defs WHERE id = ?').get(req.params.id);
  if (!def) return res.status(404).json({ error: 'Not found' });
  const label = req.body?.label != null ? String(req.body.label).trim() : def.label;
  if (!label) return res.status(400).json({ error: 'A field name is required.' });
  let options = JSON.parse(def.options || '[]');
  if (def.type === 'select' && Array.isArray(req.body?.options)) {
    options = [...new Set(req.body.options.map((o) => String(o).trim()).filter(Boolean))];
    if (!options.length) return res.status(400).json({ error: 'A choice field needs at least one option.' });
  }
  db.prepare('UPDATE field_defs SET label = ?, options = ? WHERE id = ?')
    .run(label, JSON.stringify(options), def.id);
  res.json(loadFieldDefs());
});

app.delete('/api/fields/:id', (req, res) => {
  const def = db.prepare('SELECT * FROM field_defs WHERE id = ?').get(req.params.id);
  if (!def) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM field_defs WHERE id = ?').run(def.id);
  // Strip this field's values out of every yoyo's custom JSON.
  const rows = db.prepare('SELECT id, custom FROM yoyos').all();
  const upd = db.prepare('UPDATE yoyos SET custom = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      try {
        const o = JSON.parse(r.custom || '{}');
        if (def.key in o) { delete o[def.key]; upd.run(JSON.stringify(o), r.id); }
      } catch { /* ignore */ }
    }
  })();
  res.json(loadFieldDefs());
});

// ---- API: stats ----

app.get('/api/stats', (req, res) => {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(in_hand), 0)            AS in_hand,
              COALESCE(SUM(CASE WHEN in_hand = 0 THEN 1 ELSE 0 END), 0) AS on_order,
              COALESCE(SUM(paid), 0)               AS total_paid,
              COALESCE(SUM(retail), 0)             AS total_retail,
              COALESCE(SUM(COALESCE(retail, 0) - COALESCE(paid, 0)), 0) AS total_saved
       FROM yoyos WHERE deleted_at IS NULL`
    )
    .get();
  const byBrand = db
    .prepare(
      `SELECT CASE WHEN brand = '' THEN 'Unknown' ELSE brand END AS brand,
              COUNT(*) AS count
       FROM yoyos WHERE deleted_at IS NULL GROUP BY brand ORDER BY count DESC, brand`
    )
    .all();
  // Public viewers don't get financial / ownership totals.
  if (!isOwner(req)) return res.json({ count: totals.count, byBrand });
  res.json({ ...totals, byBrand });
});

// ---- API: CSV import / export ----
//
// The CSV uses the exact column headers from the user's spreadsheet so their
// existing sheet imports cleanly and exports stay drop-in compatible. "Photos"
// and "id" are appended at the end as extras (id enables update-on-reimport).

// [ Spreadsheet header, db field ] in the spreadsheet's original order.
// `null` field = computed/derived (written on export, ignored on import).
const CSV_MAP = [
  ['Brand', 'brand'],
  ['Model', 'model'],
  ['Body Material', 'body_material'],
  ['Composition', 'composition'],
  ['In Hand', 'in_hand'],
  ['Color', 'color'],
  ['Retail', 'retail'],
  ['Paid', 'paid'],
  ['Est. Value', 'market_value'],
  ['Purchase Date', 'purchase_date'],
  ['Seller', 'seller'],
  ['Percent off', null],
  ['Condition', 'condition'],
  ['Weight', 'weight_g'],
  ['Diameter', 'diameter_mm'],
  ['Width', 'width_mm'],
  ['Gap Width', 'gap_mm'],
  ['Bearing Size', 'bearing_size'],
  ['Reponse Type', 'response_type'], // keeps the spreadsheet's original spelling
  ['Finish', 'finish'],
  ['Shape', 'shape'],
  ['Edition', 'edition'],
  ['Serial', 'serial_number'],
  ['Signature', 'signature'],
  ['Description', 'description'],
  ['Release Date', 'release_date'],
  ['Tracking', 'tracking'],
  ['ETA', 'eta'],
  ['Sold Date', 'sold_date'],
  ['Buyer', 'buyer'],
  ['Favorite', 'favorite'],
  ['Photos', null],
  ['id', 'id'],
];
const CSV_HEADERS = CSV_MAP.map(([h]) => h);

const money = (v) => (v == null ? '' : `$${Number(v).toFixed(2)}`);
const grams = (v) => (v == null ? '' : `${Number(v).toFixed(2)} g`);
const mm = (v) => (v == null ? '' : `${Number(v).toFixed(2)} mm`);

// Formats one built-in column for a CSV export row, matching the spreadsheet's
// original conventions (e.g. "$85.00", "64.60 g") so re-importing round-trips cleanly.
function exportValue(header, y, base) {
  switch (header) {
    case 'In Hand': return y.in_hand ? 'x' : '';
    case 'Favorite': return y.favorite ? 'Yes' : '';
    case 'Retail': return money(y.retail);
    case 'Paid': return money(y.paid);
    case 'Percent off': {
      const p = percentOff(y);
      return p == null ? '' : `${p.toFixed(2)}%`;
    }
    case 'Weight': return grams(y.weight_g);
    case 'Diameter': return mm(y.diameter_mm);
    case 'Width': return mm(y.width_mm);
    case 'Gap Width': return mm(y.gap_mm);
    case 'Photos': return (y._photoUrls || []).map((u) => base + u).join(' | ');
    default: {
      const field = CSV_MAP.find(([h]) => h === header)[1];
      return y[field] ?? '';
    }
  }
}

app.get('/api/export.csv', (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ error: 'Log in to export.' });
  const rows = db.prepare('SELECT * FROM yoyos WHERE deleted_at IS NULL ORDER BY brand, model, color').all();
  const base = `${req.protocol}://${req.get('host')}`;

  // Headers = built-in columns, then custom-field labels, then Photos + id.
  const defs = loadFieldDefs();
  const defByLabel = new Map(defs.map((d) => [d.label, d]));
  const headers = [
    ...CSV_MAP.filter(([h]) => h !== 'Photos' && h !== 'id').map(([h]) => h),
    ...defs.map((d) => d.label),
    'Photos', 'id',
  ];

  const records = rows.map((y) => {
    y._photoUrls = db
      .prepare('SELECT filename FROM photos WHERE yoyo_id = ? ORDER BY sort_order, id')
      .all(y.id)
      .map((p) => `/uploads/${p.filename}`);
    let custom = {};
    try { custom = JSON.parse(y.custom || '{}'); } catch { /* ignore */ }
    const rec = {};
    for (const h of headers) {
      if (defByLabel.has(h)) {
        const d = defByLabel.get(h);
        const v = custom[d.key];
        rec[h] = d.type === 'boolean' ? (v ? 'Yes' : '') : (v == null ? '' : String(v));
      } else {
        rec[h] = exportValue(h, y, base);
      }
    }
    return rec;
  });

  const csv = stringify(records, { header: true, columns: headers });
  const date = localDayStamp();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="yoyo-collection-${date}.csv"`);
  res.send(csv);
});

app.post('/api/import', uploadCsv.single('file'), (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No CSV content provided.' });

  let records;
  try {
    records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err.message}` });
  }

  // Map incoming header names (case/space-insensitive) to db fields.
  const headerToField = {};
  for (const [header, field] of CSV_MAP) {
    if (field) headerToField[header.toLowerCase().trim()] = field;
  }
  // Accept the corrected spelling too.
  headerToField['response type'] = 'response_type';
  // Custom-field columns are matched by their label.
  const customByHeader = new Map(loadFieldDefs().map((d) => [d.label.toLowerCase().trim(), d]));

  const insertSql = db.prepare(INSERT_SQL);
  const findSql = db.prepare('SELECT id FROM yoyos WHERE id = ? AND deleted_at IS NULL');
  const getCustomSql = db.prepare('SELECT custom FROM yoyos WHERE id = ?');
  const matchByIdentity = db.prepare(
    `SELECT id FROM yoyos
     WHERE lower(brand) = lower(@brand) AND lower(model) = lower(@model) AND lower(color) = lower(@color)
       AND deleted_at IS NULL ORDER BY id`
  );

  // Which columns does this CSV actually provide? Updates only touch those, so a
  // partial CSV (e.g. just a couple of columns) never blanks out the rest.
  const headerKeys = records.length ? Object.keys(records[0]) : [];
  const presentCols = [];
  let hasInHand = false, hasFavorite = false;
  const presentCustomKeys = [];
  for (const h of headerKeys) {
    const norm = String(h).toLowerCase().trim();
    const f = headerToField[norm];
    if (f === 'id') continue;
    else if (f === 'in_hand') hasInHand = true;
    else if (f === 'favorite') hasFavorite = true;
    else if (f) presentCols.push(f);
    else if (customByHeader.has(norm)) presentCustomKeys.push(customByHeader.get(norm).key);
  }
  const updateCols = [...presentCols];
  if (hasInHand) updateCols.push('in_hand');
  if (hasFavorite) updateCols.push('favorite');
  const hasCustomCols = presentCustomKeys.length > 0;
  const updateAssign = [...updateCols.map((c) => `${c} = @${c}`), ...(hasCustomCols ? ['custom = @custom'] : [])];
  const updateSql = updateAssign.length
    ? db.prepare(`UPDATE yoyos SET ${updateAssign.join(', ')}, updated_at = datetime('now'), rev = @rev WHERE id = @id`)
    : null;

  const truthy = (v) => /^(x|1|true|yes|y|★|favou?rite)$/i.test(String(v ?? '').trim());

  let created = 0, updated = 0, skipped = 0;

  // Each yoyo can be matched by only one row per import. Without this, a sheet
  // listing two identical yoyos (same brand/model/color) wrote both rows onto
  // the first one, and a single row with two identical candidates created a
  // third. Rows claim the oldest unclaimed match; a row with none left is new.
  const claimed = new Set();
  const run = db.transaction((recs) => {
    for (const rec of recs) {
      // Translate the row's headers into our internal field names first.
      const mapped = {};
      const customIn = {};
      let rawId = '';
      for (const [key, value] of Object.entries(rec)) {
        const norm = String(key).toLowerCase().trim();
        const field = headerToField[norm];
        if (field === 'id') rawId = value;
        else if (field) mapped[field] = value;
        else if (customByHeader.has(norm)) customIn[customByHeader.get(norm).key] = value;
      }

      const sc = sanitizeCustom(customIn);
      growSelectOptions(sc);
      const y = sanitizeYoyo(mapped);
      y.in_hand = truthy(mapped.in_hand) ? 1 : 0;
      y.favorite = truthy(mapped.favorite) ? 1 : 0;
      y.custom = JSON.stringify(sc);

      // Skip rows that aren't real yoyos (blank rows, and the spreadsheet's
      // totals / summary / title footer rows, which have no brand or model).
      if (!y.brand && !y.model) { skipped++; continue; }

      let id = /^\d+$/.test(String(rawId ?? '').trim()) ? Number(rawId) : null;
      // No id (e.g. importing a fresh spreadsheet): match an existing yoyo by
      // brand + model + color so re-imports update instead of duplicating.
      if (!id) {
        const open = matchByIdentity.all({ brand: y.brand, model: y.model, color: y.color })
          .filter((m) => !claimed.has(m.id));
        if (open.length) id = open[0].id;
      }

      if (id && findSql.get(id)) {
        if (updateSql) {
          const params = { id, rev: nextRev() };
          for (const c of updateCols) params[c] = y[c];
          if (hasCustomCols) {
            let existing = {};
            try { existing = JSON.parse(getCustomSql.get(id).custom || '{}'); } catch { /* ignore */ }
            params.custom = JSON.stringify({ ...existing, ...sc }); // merge, don't replace
          }
          updateSql.run(params);
        }
        claimed.add(id);
        updated++;
      } else {
        y.uuid = crypto.randomUUID();
        y.rev = nextRev();
        claimed.add(Number(insertSql.run(y).lastInsertRowid));
        created++;
      }
    }
  });
  run(records);

  res.json({ created, updated, skipped, total: records.length });
});

// ---- API: full backup / restore (database + photos as one .zip) ----

app.get('/api/backup.zip', (req, res) => {
  if (LOGIN_ENABLED && !isLoggedIn(req)) {
    return res.status(401).json({ error: 'Log in to download a backup.' });
  }
  // Flush the write-ahead log so the copied DB file is complete and current.
  db.pragma('wal_checkpoint(TRUNCATE)');

  const date = localDayStamp();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="yoyo-backup-${date}.zip"`);

  // Stream the archive straight to the response. Building it in memory (the old
  // AdmZip.toBuffer approach) OOM-crashes the process once the photo collection
  // grows past available RAM; archiver pipes file-by-file with bounded memory.
  // `store: true` (no compression) is deliberate: the bulk is already-compressed
  // JPEGs, so deflating them wastes CPU/time for ~no size gain — and that slow
  // compression burst is what makes shared hosts (LiteSpeed/CloudLinux) kill the
  // request with a 503. Storing makes bytes flow almost immediately.
  const archive = archiver('zip', { store: true });
  archive.on('error', (err) => {
    console.error('backup archive error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Backup failed.' });
    res.destroy(err);
  });
  archive.pipe(res);
  archive.file(DB_PATH, { name: 'yoyos.db' });
  if (fs.existsSync(UPLOAD_DIR) && fs.readdirSync(UPLOAD_DIR).length) {
    archive.directory(UPLOAD_DIR, 'uploads');
  }
  archive.finalize();
});

// Restore REPLACES the entire collection with the contents of a backup zip.
// One-shot upload: fine for small backups and for API clients (the native
// apps' "Publish to website" posts a database-only zip here). The web UI uses
// the chunked endpoints below instead, since a full backup can be bigger than
// the request size a reverse proxy will accept.
app.post('/api/restore', uploadZip.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No backup file uploaded.' });
  // Every path out of here has to drop the uploaded temp file, including the
  // early validation returns below.
  try {
    await restoreFromZip(req.file.path, res);
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
});

// ---- Chunked restore upload ----
// A backup with photos is easily over a gigabyte, and shared hosts put a cap
// on request bodies in the proxy in front of Node (Namecheap's answers 413
// long before multer's own limit). So the browser sends the file in pieces:
// start → PUT each chunk at its byte offset → finish, which restores from the
// assembled file. A PUT is idempotent (a retried chunk overwrites itself), so
// a dropped connection or a 429 costs one chunk, not the whole upload.
const RESTORE_CHUNK_MAX = 16 * 1024 * 1024;
const RESTORE_TOTAL_MAX = Number(process.env.RESTORE_MAX_MB || 8192) * 1024 * 1024;
const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/;
const chunkPath = (id) => path.join(SCRATCH_DIR, `chunked-${id}.zip`);

app.post('/api/restore/uploads', (req, res) => {
  const size = Number(req.body?.size);
  if (!Number.isSafeInteger(size) || size <= 0) return res.status(400).json({ error: 'Missing file size.' });
  if (size > RESTORE_TOTAL_MAX) {
    return res.status(400).json({ error: `Backup is larger than this server allows (${Math.round(RESTORE_TOTAL_MAX / 1048576)}MB; see RESTORE_MAX_MB).` });
  }
  // An upload abandoned mid-way (tab closed) would otherwise sit in scratch
  // until the next restart; clear any older than a day.
  for (const f of fs.readdirSync(SCRATCH_DIR)) {
    const fp = path.join(SCRATCH_DIR, f);
    if (f.startsWith('chunked-') && Date.now() - fs.statSync(fp).mtimeMs > 86_400_000) fs.rmSync(fp, { force: true });
  }
  const id = crypto.randomUUID();
  fs.writeFileSync(chunkPath(id), '');
  res.status(201).json({ id, chunkSize: RESTORE_CHUNK_MAX });
});

app.put('/api/restore/uploads/:id', async (req, res) => {
  const { id } = req.params;
  const offset = Number(req.query.offset);
  const file = chunkPath(id);
  if (!UPLOAD_ID_RE.test(id) || !fs.existsSync(file)) return res.status(404).json({ error: 'Upload not found — start the restore again.' });
  const have = fs.statSync(file).size;
  // Chunks arrive in order; a retry may resend the last one, so accept any
  // offset up to what's already on disk and drop whatever followed it.
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > have) {
    return res.status(409).json({ error: 'Chunk out of order.', received: have });
  }
  if (offset < have) fs.truncateSync(file, offset);
  let written = 0;
  const out = fs.createWriteStream(file, { flags: 'r+', start: offset });
  try {
    await pipeline(req, async function* (source) {
      for await (const buf of source) {
        written += buf.length;
        if (written > RESTORE_CHUNK_MAX || offset + written > RESTORE_TOTAL_MAX) throw Object.assign(new Error('Chunk too large.'), { status: 413 });
        yield buf;
      }
    }, out);
  } catch (err) {
    fs.truncateSync(file, offset);
    return res.status(err.status || 400).json({ error: err.message });
  }
  res.json({ received: offset + written });
});

app.post('/api/restore/uploads/:id/finish', async (req, res) => {
  const { id } = req.params;
  const file = chunkPath(id);
  if (!UPLOAD_ID_RE.test(id) || !fs.existsSync(file)) return res.status(404).json({ error: 'Upload not found — start the restore again.' });
  try {
    const have = fs.statSync(file).size;
    if (have !== Number(req.body?.size)) {
      return res.status(400).json({ error: `Upload incomplete (${have} of ${req.body?.size} bytes) — try the restore again.` });
    }
    await restoreFromZip(file, res);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

app.delete('/api/restore/uploads/:id', (req, res) => {
  if (UPLOAD_ID_RE.test(req.params.id)) fs.rmSync(chunkPath(req.params.id), { force: true });
  res.status(204).end();
});

async function restoreFromZip(zipPath, res) {
  let entries;
  try { entries = listEntries(zipPath); }
  catch { return res.status(400).json({ error: 'That file is not a valid .zip backup.' }); }

  const dbEntry = entries.find((e) => !e.isDirectory && path.basename(e.name) === 'yoyos.db');
  if (!dbEntry) return res.status(400).json({ error: 'Backup is missing yoyos.db — is this a yoyo backup?' });

  // Open the backup DB from a temp file (read-only) and copy its rows in.
  const tmp = path.join(SCRATCH_DIR, `yoyo-restore-${Date.now()}.db`);
  let yoyoRows, photoRows, videoRows, backupHasVideos = true;
  try {
    await extractEntry(zipPath, dbEntry, tmp);
    const src = openDatabase(tmp, { readOnly: true });
    yoyoRows = src.prepare('SELECT * FROM yoyos').all();
    photoRows = src.prepare('SELECT * FROM photos').all();
    // A backup taken before video embeds existed has no such table; that's an
    // empty list, not a broken backup.
    try { videoRows = src.prepare('SELECT * FROM videos').all(); }
    catch { videoRows = []; backupHasVideos = false; }
    src.close();
  } catch (err) {
    return res.status(400).json({ error: `Could not read backup database: ${err.message}` });
  } finally {
    // Backups are taken from a WAL database, so the copy carries WAL mode in its
    // header and even a read-only open spawns -wal/-shm alongside it. Removing
    // just the .db left those two behind on every restore.
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmp + suffix, { force: true });
  }

  // Photo files go first (basename only — never trust paths inside the zip):
  // they're additive, so if extraction fails part-way (disk full, corrupt
  // entry) the collection itself hasn't been touched yet.
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  let photoFiles = 0;
  try {
    for (const e of entries) {
      if (e.isDirectory || e.name.split('/')[0] !== 'uploads') continue;
      const name = path.basename(e.name);
      if (!name || name.startsWith('.')) continue;
      await extractEntry(zipPath, e, path.join(UPLOAD_DIR, name));
      photoFiles++;
    }
  } catch (err) {
    return res.status(500).json({ error: `Could not restore photos (your collection was not changed): ${err.message}` });
  }

  const yoyoCols = new Set(db.prepare('PRAGMA table_info(yoyos)').all().map((c) => c.name));
  const photoCols = new Set(db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name));
  const videoCols = new Set(db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name));
  // Only columns this schema has are inserted, and only those are passed as
  // parameters: a backup from a newer build can carry extra columns, and on
  // Node builds without setAllowUnknownNamedParameters an unmatched named
  // parameter is an error that would refuse the whole restore.
  const insertFrom = (table, cols, row) => {
    const keys = Object.keys(row).filter((k) => cols.has(k));
    const params = Object.fromEntries(keys.map((k) => [k, row[k]]));
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
      .run(params);
  };

  // The native apps' "Publish to website" restores from a database that has no
  // videos table at all — linked videos exist only on the web. Wiping them on
  // every publish would make them impossible to keep, so when the backup has
  // no videos table, the site's current videos are carried over to whichever
  // yoyos (matched by uuid) the backup still contains. A backup that does have
  // the table — any web backup — replaces videos exactly, as before.
  const keptVideos = backupHasVideos ? [] : db.prepare(
    `SELECT v.*, y.uuid AS yoyo_uuid FROM videos v JOIN yoyos y ON y.id = v.yoyo_id WHERE y.deleted_at IS NULL`
  ).all();
  let videosKept = 0;

  db.transaction(() => {
    db.prepare('DELETE FROM yoyos').run(); // cascades to photos and videos
    for (const r of yoyoRows) insertFrom('yoyos', yoyoCols, r);
    for (const p of photoRows) insertFrom('photos', photoCols, p);
    for (const v of videoRows) insertFrom('videos', videoCols, v);
    const idByUuid = db.prepare('SELECT id FROM yoyos WHERE uuid = ? AND deleted_at IS NULL');
    for (const { yoyo_uuid, id, ...v } of keptVideos) {
      const target = yoyo_uuid && idByUuid.get(yoyo_uuid);
      if (!target) continue;
      insertFrom('videos', videoCols, { ...v, yoyo_id: target.id });
      videosKept++;
    }
    // Restored rows carry stale or absent revs; re-stamp every row with a fresh
    // change-feed position so sync clients re-pull the whole (replaced)
    // collection. Photo files still match by uuid, so blobs aren't re-fetched.
    for (const row of db.prepare('SELECT id FROM yoyos ORDER BY updated_at, id').all()) {
      db.prepare('UPDATE yoyos SET rev = ? WHERE id = ?').run(nextRev(), row.id);
    }
  })();
  // A backup made before the uuid column existed restores rows without one —
  // give those a stable id so the unique index holds and they can sync later.
  backfillUuids(db);
  backfillPhotoUuids(db);

  res.json({ yoyos: yoyoRows.length, photos: photoRows.length, videos: videoRows.length + videosKept, videosKept, photoFiles });
}

// ---- Multer / error handling ----
app.use((err, req, res, _next) => {
  console.error(err);
  // Multer aborts a multipart request the moment a part violates a limit or the
  // fileFilter, but it does NOT remove the files it already wrote for earlier
  // parts — without this sweep every rejected upload leaves orphans in uploads/.
  const written = [];
  if (req.file) written.push(req.file);
  if (Array.isArray(req.files)) written.push(...req.files);
  else if (req.files && typeof req.files === 'object') {
    for (const list of Object.values(req.files)) written.push(...list);
  }
  for (const f of written) {
    if (f?.filename) fs.rm(path.join(UPLOAD_DIR, f.filename), { force: true }, () => {});
  }
  res.status(400).json({ error: err.message || 'Something went wrong' });
});

const server = app.listen(PORT, () => {
  console.log(`🪀  Yoyo collection running at http://localhost:${PORT}`);
  // Heal quietly after boot: titles for videos saved before oEmbed lookups
  // existed (posters self-heal lazily on render instead).
  setImmediate(() => backfillVideoTitles().catch((e) => console.warn('title backfill:', e.message)));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n⚠️  Port ${PORT} is already in use — the app may already be running in another window.\n` +
      `   • Open http://localhost:${PORT} to use it, or\n` +
      `   • Stop the other instance:  lsof -ti:${PORT} | xargs kill\n` +
      `   • Or start on a different port:  PORT=3001 npm start\n`
    );
  } else {
    console.error('Server failed to start:', err);
  }
  process.exit(1);
});
