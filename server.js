// Yoyo Collection — Express app + REST API.
//
// Single-file server: auth/access control, the yoyo/photo/field-def CRUD API,
// CSV import/export, and full zip backup/restore. Talks to SQLite through
// db.js and to carrier tracking APIs through carriers.js. No build step — this
// runs directly with `node server.js` (see app.cjs for the CommonJS startup
// shim some hosts require).
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
import { track as trackPackage, configuredCarriers } from './carriers.js';
import db, { DB_PATH, openDatabase, backfillUuids, backfillPhotoUuids, nextRev } from './db.js';

// sharp (image thumbnails) is native; on some shared hosts it may not install.
// Load it optionally so the app still boots and just serves full images.
let sharp = null;
try { ({ default: sharp } = await import('sharp')); }
catch (e) { console.warn('sharp unavailable — thumbnails disabled, serving full images:', e.message); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
    // protect the API, so photo GETs pass through uncounted.
    if (req.method === 'GET' && req.path.startsWith('/uploads/')) return next();
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

const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update(`yoyo-session:${ADMIN_PASSWORD}`).digest('hex');
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
function canEdit(req) {
  return isLoggedIn(req) || (!READ_ONLY && !LOGIN_ENABLED);
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
  if (isWrite && !canEdit(req)) {
    // Sync clients distinguish "token expired — re-login silently" (401) from
    // "writes are off here" (403, e.g. demo mode above). Only sync routes get
    // the 401; the web client's own error handling expects 403 elsewhere.
    if (req.path.startsWith('/api/sync/')) {
      return res.status(401).json({ error: 'Please sign in to sync.' });
    }
    return res.status(403).json({
      error: LOGIN_ENABLED ? 'Please log in to make changes.' : 'This collection is read-only.',
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
// Stored filenames get their extension from this fixed table, keyed by the
// already-validated mimetype — NOT from the client-supplied original filename.
// The original filename is attacker-controlled and can contain arbitrary
// characters (quotes, angle brackets, etc.); deriving the extension from it
// would let a crafted upload name inject those characters into a filename
// that later gets embedded in HTML (photo URLs are rendered client-side).
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 12 }, // 10MB each, up to 12 at once
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed (jpg, png, webp, gif).'));
  },
});

// CSV imports are parsed in memory rather than written to disk.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Backup zips can be large (they include photos).
const uploadZip = multer({
  storage: multer.memoryStorage(),
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
function sanitizeYoyo(body) {
  const out = {};
  for (const f of TEXT_FIELDS) out[f] = body[f] == null ? '' : String(body[f]).trim();
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

// Expands a raw `yoyos` row into the shape the API/client expects: attaches
// its photos (in sort order, as URLs), parses the `custom` JSON blob back into
// an object, and adds the computed `percent_off`.
function decorate(yoyo) {
  const photos = db
    .prepare('SELECT id, uuid, filename FROM photos WHERE yoyo_id = ? ORDER BY sort_order, id')
    .all(yoyo.id)
    .map((p) => ({ id: p.id, uuid: p.uuid, url: `/uploads/${p.filename}`, thumbUrl: `/uploads/${thumbName(p.filename)}` }));
  let custom = {};
  try { custom = JSON.parse(yoyo.custom || '{}'); } catch { /* ignore bad JSON */ }
  return { ...yoyo, custom, percent_off: percentOff(yoyo), photos };
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
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
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
  const editable = canEdit(req);
  const rows = db.prepare('SELECT * FROM yoyos WHERE deleted_at IS NULL ORDER BY brand, model, color').all();
  res.json(rows.map((r) => publicSafe(decorate(r), editable)));
});

app.get('/api/yoyos/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(publicSafe(decorate(row), canEdit(req)));
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

  // Free the disk now (a tombstone doesn't need its photos) — remove both the
  // full images and their thumbnails, then drop the photo rows.
  const photos = db.prepare('SELECT filename FROM photos WHERE yoyo_id = ?').all(req.params.id);
  for (const p of photos) {
    fs.rm(path.join(UPLOAD_DIR, p.filename), { force: true }, () => {});
    fs.rm(path.join(UPLOAD_DIR, thumbName(p.filename)), { force: true }, () => {});
  }
  // Keep the yoyo row as a tombstone (deleted_at set) so the deletion propagates
  // to other devices on sync, rather than re-appearing from a device that still has it.
  db.transaction(() => {
    db.prepare('DELETE FROM photos WHERE yoyo_id = ?').run(req.params.id);
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

app.delete('/api/photos/:photoId', (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.photoId);
    touchYoyo(photo.yoyo_id);
  })();
  fs.rm(path.join(UPLOAD_DIR, photo.filename), { force: true }, () => {});
  fs.rm(path.join(UPLOAD_DIR, thumbName(photo.filename)), { force: true }, () => {});
  res.json({ ok: true });
});

// One-time backfill: generate thumbnails for existing photos (idempotent).
app.post('/api/photos/optimize', async (req, res) => {
  if (!sharp) return res.status(503).json({ error: 'Image processing (sharp) is not installed on this server.' });
  const rows = db.prepare('SELECT filename FROM photos').all();
  let processed = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    if (fs.existsSync(path.join(UPLOAD_DIR, thumbName(r.filename)))) { skipped++; continue; }
    try { await makeThumb(r.filename); processed++; } catch (e) { console.error('optimize:', e.message); failed++; }
  }
  res.json({ total: rows.length, processed, skipped, failed });
});

// Reorder a yoyo's photos (first = cover). Body: { ids: [photoId, ...] }.
app.put('/api/yoyos/:id/photos/order', (req, res) => {
  const yoyo = db.prepare('SELECT id FROM yoyos WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!yoyo) return res.status(404).json({ error: 'Not found' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
  const upd = db.prepare('UPDATE photos SET sort_order = ? WHERE id = ? AND yoyo_id = ?');
  db.transaction(() => {
    ids.forEach((pid, i) => upd.run(i, pid, req.params.id));
    touchYoyo(req.params.id);
  })();
  res.json(decorate(db.prepare('SELECT * FROM yoyos WHERE id = ?').get(req.params.id)));
});

// ---- API: sync (native apps) ----
// Hub-and-spoke sync: apps pull rows changed since a rev cursor (tombstones
// included), push batched uuid-keyed upserts resolved by last-writer-wins on
// updated_at, and transfer photo files incrementally. See yoyo-ios-plan.md.

const SQL_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MANIFEST_EXTS = new Set(['jpg', 'png', 'webp', 'gif']);

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
  const photosFor = db.prepare('SELECT uuid, filename, sort_order FROM photos WHERE yoyo_id = ? ORDER BY sort_order, id');
  const yoyos = rows.map((r) => {
    let custom = {};
    try { custom = JSON.parse(r.custom || '{}'); } catch { /* ignore bad JSON */ }
    const photos = r.deleted_at ? [] : photosFor.all(r.id).map((p) => ({
      uuid: p.uuid,
      sort_order: p.sort_order,
      url: `/uploads/${p.filename}`,
      thumb_url: `/uploads/${thumbName(p.filename)}`,
    }));
    return { ...r, custom, photos };
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
    entries.push({ uuid: m.uuid, sort_order: Number(m.sort_order) || 0, ext });
  }
  const keep = new Set(entries.map((e) => e.uuid));
  for (const p of db.prepare('SELECT * FROM photos WHERE yoyo_id = ?').all(yoyoId)) {
    if (keep.has(p.uuid)) continue;
    db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    fs.rm(path.join(UPLOAD_DIR, p.filename), { force: true }, () => {});
    fs.rm(path.join(UPLOAD_DIR, thumbName(p.filename)), { force: true }, () => {});
  }
  for (const e of entries) {
    const row = db.prepare('SELECT * FROM photos WHERE uuid = ?').get(e.uuid);
    if (row) {
      if (row.yoyo_id !== yoyoId) continue; // uuid belongs to another yoyo — ignore
      db.prepare('UPDATE photos SET sort_order = ? WHERE id = ?').run(e.sort_order, row.id);
      if (!fs.existsSync(path.join(UPLOAD_DIR, row.filename))) missing.push(e.uuid);
    } else {
      db.prepare('INSERT INTO photos (yoyo_id, uuid, filename, sort_order) VALUES (?, ?, ?, ?)')
        .run(yoyoId, e.uuid, `${e.uuid}.${e.ext}`, e.sort_order);
      missing.push(e.uuid);
    }
  }
  return missing;
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
        // A pushed delete mirrors DELETE /api/yoyos/:id — photo files go now.
        if (deletedAt && !existing.deleted_at) {
          for (const p of db.prepare('SELECT filename FROM photos WHERE yoyo_id = ?').all(existing.id)) {
            fs.rm(path.join(UPLOAD_DIR, p.filename), { force: true }, () => {});
            fs.rm(path.join(UPLOAD_DIR, thumbName(p.filename)), { force: true }, () => {});
          }
          db.prepare('DELETE FROM photos WHERE yoyo_id = ?').run(existing.id);
        }
        const rev = nextRev();
        db.prepare(SYNC_UPDATE_SQL).run({ ...y, updated_at: updatedAt, deleted_at: deletedAt, rev, id: existing.id });
        const missingPhotos = (!deletedAt && rec.photos !== undefined)
          ? applyPhotoManifest(existing.id, rec.photos) : [];
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
    filename: (req, file, cb) => cb(null, `${req.params.photoUuid}${EXT_BY_MIME[file.mimetype] || '.jpg'}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed (jpg, png, webp, gif).'));
  },
});

app.post('/api/sync/photos/:yoyoUuid/:photoUuid', (req, res, next) => {
  // Validate BEFORE multer touches the filesystem — the uuid becomes a filename.
  if (!UUID_RE.test(req.params.yoyoUuid) || !UUID_RE.test(req.params.photoUuid)) {
    return res.status(400).json({ error: 'Bad identifier.' });
  }
  next();
}, uploadSyncPhoto.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });
  const yoyo = db.prepare('SELECT id FROM yoyos WHERE uuid = ? AND deleted_at IS NULL').get(req.params.yoyoUuid);
  if (!yoyo) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(404).json({ error: 'Yoyo not found.' });
  }

  let rev;
  db.transaction(() => {
    const row = db.prepare('SELECT * FROM photos WHERE uuid = ?').get(req.params.photoUuid);
    if (row && row.yoyo_id === yoyo.id) {
      db.prepare('UPDATE photos SET filename = ? WHERE id = ?').run(req.file.filename, row.id);
    } else if (!row) {
      const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM photos WHERE yoyo_id = ?').get(yoyo.id);
      db.prepare('INSERT INTO photos (yoyo_id, uuid, filename, sort_order) VALUES (?, ?, ?, ?)')
        .run(yoyo.id, req.params.photoUuid, req.file.filename, maxRow.m + 1);
    }
    rev = nextRev();
    db.prepare('UPDATE yoyos SET rev = ? WHERE id = ?').run(rev, yoyo.id);
  })();

  await makeThumb(req.file.filename).catch((e) => console.error('thumb error:', e.message));
  res.json({ ok: true, url: `/uploads/${req.file.filename}`, rev });
});

// ---- API: config ----
app.get('/api/config', (req, res) => res.json({
  canEdit: canEdit(req),
  loginEnabled: LOGIN_ENABLED,
  loggedIn: isLoggedIn(req),
  trackingEnabled: Object.values(configuredCarriers(process.env)).some(Boolean),
  demoMode: DEMO_MODE,
}));

// ---- API: site settings (key/value; e.g. For Sale shipping notes) ----
// Only these keys are readable/writable through the API.
const PUBLIC_SETTINGS = ['sale_notes'];
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
  if (!canEdit(req)) return res.json({ count: totals.count, byBrand });
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
  if (!canEdit(req)) return res.status(403).json({ error: 'Log in to export.' });
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
  const date = new Date().toISOString().slice(0, 10);
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
       AND deleted_at IS NULL`
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
        const matches = matchByIdentity.all({ brand: y.brand, model: y.model, color: y.color });
        if (matches.length === 1) id = matches[0].id;
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
        updated++;
      } else {
        y.uuid = crypto.randomUUID();
        y.rev = nextRev();
        insertSql.run(y);
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

  const date = new Date().toISOString().slice(0, 10);
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
app.post('/api/restore', uploadZip.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No backup file uploaded.' });

  let entries;
  try { entries = new AdmZip(req.file.buffer).getEntries(); }
  catch { return res.status(400).json({ error: 'That file is not a valid .zip backup.' }); }

  const dbEntry = entries.find((e) => !e.isDirectory && path.basename(e.entryName) === 'yoyos.db');
  if (!dbEntry) return res.status(400).json({ error: 'Backup is missing yoyos.db — is this a yoyo backup?' });

  // Open the backup DB from a temp file (read-only) and copy its rows in.
  const tmp = path.join(os.tmpdir(), `yoyo-restore-${Date.now()}.db`);
  let yoyoRows, photoRows;
  try {
    fs.writeFileSync(tmp, dbEntry.getData());
    const src = openDatabase(tmp, { readOnly: true });
    yoyoRows = src.prepare('SELECT * FROM yoyos').all();
    photoRows = src.prepare('SELECT * FROM photos').all();
    src.close();
  } catch (err) {
    return res.status(400).json({ error: `Could not read backup database: ${err.message}` });
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  const yoyoCols = new Set(db.prepare('PRAGMA table_info(yoyos)').all().map((c) => c.name));
  const photoCols = new Set(db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name));
  const insertFrom = (table, cols, row) => {
    const keys = Object.keys(row).filter((k) => cols.has(k));
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
      .run(row);
  };

  db.transaction(() => {
    db.prepare('DELETE FROM yoyos').run(); // cascades to photos
    for (const r of yoyoRows) insertFrom('yoyos', yoyoCols, r);
    for (const p of photoRows) insertFrom('photos', photoCols, p);
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

  // Restore photo files (basename only — never trust paths inside the zip).
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  let photoFiles = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    const parts = e.entryName.split('/');
    if (parts[0] !== 'uploads') continue;
    fs.writeFileSync(path.join(UPLOAD_DIR, path.basename(e.entryName)), e.getData());
    photoFiles++;
  }

  res.json({ yoyos: yoyoRows.length, photos: photoRows.length, photoFiles });
});

// ---- Multer / error handling ----
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Something went wrong' });
});

const server = app.listen(PORT, () => {
  console.log(`🪀  Yoyo collection running at http://localhost:${PORT}`);
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
