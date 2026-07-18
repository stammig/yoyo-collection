// Yoyo Collection — front end. Plain vanilla JS, no framework, no build step;
// loaded directly by index.html as a single <script>. Architecture:
//   - `yoyos` (below) is the one in-memory copy of the collection, loaded via
//     loadAll() and re-rendered on every change — there's no client-side cache
//     invalidation beyond "re-fetch and re-render".
//   - `render()` is the single entry point for the Collection view: it re-runs
//     filteredYoyos() and delegates to renderTiles()/renderRows(). The other
//     top-level views (renderArrivals/renderSale/renderInsights) are peers,
//     switched between by setView().
//   - Every server write goes through api(), a fetch() wrapper that adds the
//     bearer-token auth header and throws on non-2xx.
//   - The file is organized into "---- section ----" comment banners in
//     dependency order (state → helpers → each view → shared dialogs/settings);
//     search for a banner name to jump to that feature.
// ---- State ----
let yoyos = [];
let filters = {
  q: '', sort: 'brand', sortDir: 'asc',
  brands: [], compositions: [], conditions: [],
  material: '', status: '', retiredOnly: false, favOnly: false,
  paidMin: null, paidMax: null, retailMin: null, retailMax: null, weightMin: null, weightMax: null,
};
let editingId = null;
let formGen = 0;             // bumped whenever the add/edit form's target changes (open/close/switch);
                             // an in-flight submit checks this to avoid clobbering UI state the user has since moved on from
let detailId = null;        // id currently shown in the read-only detail modal
let shareMode = false;      // arrived via a /y/:id share link (focused single-yoyo view)
let cameFromDetail = false; // whether the edit form was opened from the detail view
let canEditState = true;    // whether the current viewer can edit (false = public view)
let trackingEnabledState = false; // whether any carrier tracking API is configured
let demoModeState = false;  // public demo: login works but writes are blocked server-side
let saleNotes = '';         // owner-editable shipping/sale notes shown on the For Sale page
let currentView = 'collection'; // 'collection' | 'arrivals' | 'insights'

// Lightweight toast notifications (replaces jarring alert() popups).
function toast(message, kind = '') {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) { console.warn(message); return; }
  // Announce toasts to screen readers — they're the app's only feedback for
  // most actions (saves, copies, bulk edits), so they can't be sight-only.
  if (!wrap.hasAttribute('aria-live')) { wrap.setAttribute('aria-live', 'polite'); wrap.setAttribute('role', 'status'); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="toast-dot"></span><span></span>`;
  el.lastChild.textContent = message;
  wrap.appendChild(el);
  const ttl = kind === 'error' ? 5200 : 3200;
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); }, ttl);
}

// Promise-based styled confirm dialog (replaces native confirm()).
function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal confirm-modal';
    const card = document.createElement('div');
    card.className = 'modal-card modal-confirm';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.innerHTML =
      `<div class="confirm-body"><h2></h2>${message ? '<p></p>' : ''}</div>` +
      `<div class="modal-foot"><span class="spacer"></span>` +
      `<button class="btn btn-ghost" data-act="cancel"></button>` +
      `<button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-act="ok"></button></div>`;
    card.querySelector('h2').textContent = title;
    if (message) card.querySelector('p').textContent = message;
    card.querySelector('[data-act="cancel"]').textContent = cancelText;
    card.querySelector('[data-act="ok"]').textContent = confirmText;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    overlay.appendChild(backdrop);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('click', () => close(false));
    card.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    card.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
    card.querySelector('[data-act="ok"]').focus();
  });
}

// Inline line-icon set (no emoji anywhere in the chrome).
const SVG = {
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9z"/></svg>',
  starOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.4l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.6 6.6 20.3l1-6.1L3.2 9.9l6.1-.9z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6.5 7l.9 13h9.2l.9-13"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.2 12 3l9 4.2v9.6L12 21l-9-4.2z"/><path d="M3 7.2 12 11.4l9-4.2M12 11.4V21"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
  gem: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18M9 3 6 9l6 12 6-12-3-6"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 3.5h7.2l9.8 9.8-7.2 7.2-9.8-9.8z"/><circle cx="7.5" cy="7.5" r="1.3"/></svg>',
  scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3"/><path d="M6 6h12l-2.2 7a4 4 0 0 1-7.6 0z"/><path d="M8 21h8"/></svg>',
  feather: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 5C12 5 7 9 6 16l-2 3"/><path d="M9 14h7"/><path d="M13 6l5 5"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5 9 17.5 20 6.5"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v6H4V6h6"/></svg>',
};

// Guesses the carrier from a tracking number's shape (same patterns as
// detectCarrier in carriers.js) and returns a link to that carrier's public
// tracking page — no API key needed, since it's the same page anyone gets by
// typing a tracking number into the carrier's own site. Falls back to USPS
// for anything unrecognized, since that's what most sellers ship with.
function carrierTrackingURL(tracking) {
  const s = String(tracking || '').replace(/\s+/g, '').toUpperCase();
  if (!s) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(s)) return `https://www.ups.com/track?tracknum=${encodeURIComponent(s)}`;
  if (/^\d{12}$/.test(s) || /^\d{15}$/.test(s)) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(s)}`;
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(s)}`;
}

// Hidden from public viewers (financial, shipping, ownership status).
const SENSITIVE = new Set(['retail', 'paid', 'percent_off', 'tracking', 'eta', 'in_hand', 'purchase_date', 'sold_date', 'seller', 'buyer', 'market_value', 'trade_value']);

// View prefs (persisted to localStorage).
const DEFAULT_VIEW = {
  mode: 'tile',          // 'tile' | 'row'
  size: 'md',            // 'sm' | 'md' | 'lg'
  pageSize: 24,          // number or 'all'
  page: 1,
  fields: ['color', 'composition', 'condition', 'weight_g', 'diameter_mm', 'paid', 'percent_off', 'in_hand'],
};
let view = loadView();

// ---- Field registry (brand + model are always shown as the identity) ----
const money = (n) => (n == null ? '' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const money0 = (n) => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

const FIELD_DEFS = [
  { key: 'color', label: 'Color' },
  { key: 'composition', label: 'Composition' },
  { key: 'body_material', label: 'Body Material' },
  { key: 'condition', label: 'Condition' },
  { key: 'in_hand', label: 'In Hand', fmt: (v) => (v ? '✓' : '') },
  { key: 'retail', label: 'Retail', fmt: money, num: true },
  { key: 'paid', label: 'Paid', fmt: money, num: true },
  { key: 'market_value', label: 'Est. Value', fmt: money, num: true },
  { key: 'purchase_date', label: 'Purchase Date' },
  { key: 'seller', label: 'Seller' },
  { key: 'percent_off', label: '% Off', fmt: (v) => (v == null ? '' : v + '%'), num: true },
  { key: 'sale_status', label: 'Sale' },
  { key: 'sale_price', label: 'Asking', fmt: money, num: true },
  { key: 'trade_value', label: 'Trade Value', fmt: money, num: true },
  { key: 'sold_date', label: 'Sold Date' },
  { key: 'buyer', label: 'Buyer' },
  { key: 'weight_g', label: 'Weight', fmt: (v) => (v ? v + ' g' : ''), num: true },
  { key: 'diameter_mm', label: 'Diameter', fmt: (v) => (v ? v + ' mm' : ''), num: true },
  { key: 'width_mm', label: 'Width', fmt: (v) => (v ? v + ' mm' : ''), num: true },
  { key: 'gap_mm', label: 'Gap', fmt: (v) => (v ? v + ' mm' : ''), num: true },
  { key: 'bearing_size', label: 'Bearing' },
  { key: 'response_type', label: 'Response' },
  { key: 'finish', label: 'Finish' },
  { key: 'shape', label: 'Shape' },
  { key: 'edition', label: 'Edition' },
  { key: 'serial_number', label: 'Serial #' },
  { key: 'signature', label: 'Signature / Collab' },
  { key: 'release_date', label: 'Release' },
  { key: 'tracking', label: 'Tracking' },
  { key: 'eta', label: 'ETA' },
  { key: 'description', label: 'Description' },
  { key: 'favorite', label: 'Favorite', fmt: (v) => (v ? '★' : '') },
  { key: 'retired', label: 'Retired', fmt: (v) => (v ? '✓' : '') },
];
// Custom field definitions (loaded from the server) merged with the built-ins.
let customDefs = [];
let ALL_FIELDS = FIELD_DEFS.slice();
let FIELD_BY_KEY = Object.fromEntries(ALL_FIELDS.map((f) => [f.key, f]));

// Adapts a server-side custom field definition into the same shape as a
// built-in FIELD_DEFS entry, so both can live in one ALL_FIELDS registry.
function customToDef(d) {
  return {
    key: d.key, label: d.label, custom: true, type: d.type, options: d.options || [],
    num: d.type === 'number',
    fmt: d.type === 'boolean' ? (v) => (v ? '✓' : '') : (v) => (v == null ? '' : String(v)),
  };
}
// Recomputes ALL_FIELDS/FIELD_BY_KEY after customDefs changes (loaded from the
// server, or a field added/edited/deleted in Settings).
function rebuildRegistry() {
  ALL_FIELDS = [...FIELD_DEFS, ...customDefs.map(customToDef)];
  FIELD_BY_KEY = Object.fromEntries(ALL_FIELDS.map((f) => [f.key, f]));
}

const fmtField = (key, val) => (FIELD_BY_KEY[key]?.fmt ? FIELD_BY_KEY[key].fmt(val) : (val ?? ''));
// Read a field's value whether it's a built-in column or a custom field.
const valueOf = (y, key) => (FIELD_BY_KEY[key]?.custom ? (y.custom ? y.custom[key] : undefined) : y[key]);

const NUMERIC_KEYS = new Set(['retail', 'paid', 'percent_off', 'weight_g', 'diameter_mm', 'width_mm', 'gap_mm', 'sale_price']);
const defaultDir = (key) => (NUMERIC_KEYS.has(key) || FIELD_BY_KEY[key]?.num || key === 'favorite' || key === 'in_hand' ? 'desc' : 'asc');

// Field groups for the read-only detail view.
const DETAIL_GROUPS = [
  ['Overview', ['color', 'composition', 'body_material', 'condition']],
  ['Pricing', ['retail', 'paid', 'percent_off']],
  ['Sale', ['sale_status', 'sale_price', 'trade_value', 'sold_date', 'buyer']],
  ['Specs', ['weight_g', 'diameter_mm', 'width_mm', 'gap_mm', 'bearing_size', 'response_type']],
  ['Edition & Finish', ['finish', 'shape', 'edition', 'serial_number', 'signature']],
  ['Acquisition', ['release_date', 'purchase_date', 'seller', 'tracking', 'eta']],
];

// ---- DOM ----
const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const emptyMsg = $('#empty');
const modal = $('#modal');
const form = $('#yoyoForm');
const photoStrip = $('#photoStrip');
const photoInput = $('#photoInput');

// ---- View prefs persistence ----
function loadView() {
  try {
    const saved = JSON.parse(localStorage.getItem('yoyoView') || '{}');
    return { ...DEFAULT_VIEW, ...saved, page: 1 };
  } catch { return { ...DEFAULT_VIEW }; }
}
function saveView() {
  const { page, ...rest } = view; // don't persist the page number
  localStorage.setItem('yoyoView', JSON.stringify(rest));
}

// ---- API helpers ----
async function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  // Token auth survives iframes/mobile where third-party cookies are blocked.
  let token = null;
  try { token = localStorage.getItem('yoyoToken'); } catch { /* ignore */ }
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ---- Load + render ----
let loadGen = 0; // guards against out-of-order responses: only the latest in-flight call may apply its result
// Fetches the full collection and re-renders whichever view is current.
async function loadAll() {
  const gen = ++loadGen;
  const data = await api('/api/yoyos');
  if (gen !== loadGen) return; // a newer loadAll() has since started — this one is stale, drop it
  yoyos = data;
  refreshDatalists();
  refreshCurrentView();
}


// ---- Delight: count-up numbers + grow-in bars ----
// These fire only when a view is (re)entered — never on every keystroke
// re-render — and the markup always holds the final value, so the page is
// correct without JS and under reduced motion.
function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function groupThousands(s) {
  const neg = s.startsWith('-'); if (neg) s = s.slice(1);
  const [int, frac] = s.split('.');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (frac != null ? g + '.' + frac : g);
}
// Count a stat/metric value up from 0 to its rendered number, preserving any
// prefix ($, +) and suffix (%, d, g) and thousands grouping.
function animateCounters(root) {
  if (!root || prefersReducedMotion()) return;
  root.querySelectorAll('.stat-num, .metric-value').forEach((el) => {
    if (el.dataset.counting === '1') return;
    const raw = el.textContent;
    const m = raw.match(/[\d,]*\.?\d+/);
    if (!m) return;
    const numStr = m[0];
    const target = parseFloat(numStr.replace(/,/g, ''));
    if (!isFinite(target) || target === 0) return;
    const decimals = (numStr.split('.')[1] || '').length;
    const grouped = numStr.includes(',');
    const prefix = raw.slice(0, m.index);
    const suffix = raw.slice(m.index + numStr.length);
    const dur = 620;
    let startT = 0;
    el.dataset.counting = '1';
    const step = (t) => {
      if (!startT) startT = t;
      const p = Math.min(1, (t - startT) / dur);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      let s = decimals ? (target * eased).toFixed(decimals) : String(Math.round(target * eased));
      if (grouped) s = groupThousands(s);
      el.textContent = prefix + s + suffix;
      if (p < 1) requestAnimationFrame(step);
      else { el.textContent = raw; delete el.dataset.counting; }
    };
    el.textContent = prefix + (decimals ? (0).toFixed(decimals) : '0') + suffix;
    requestAnimationFrame(step);
  });
}
// Grow the Insights bars from 0 to their final width (held in data-w), with a
// gentle stagger so the chart "draws" itself.
function animateBars(root) {
  if (!root || prefersReducedMotion()) return;
  root.querySelectorAll('.bar-fill[data-w]').forEach((el, i) => {
    const w = el.dataset.w;
    el.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transitionDelay = (i * 45) + 'ms';
      el.style.width = w + '%';
    }));
  });
}
function playViewIntro(v) {
  if (v === 'collection') animateCounters($('#stats'));
  else if (v === 'insights') { const el = $('#viewInsights'); animateCounters(el); animateBars(el); }
  else if (v === 'sold') animateCounters($('#viewSold'));
  else if (v === 'sale') animateCounters($('#saleStats'));
}
let introPending = true; // fire the entrance animation once, after first data load

// Stats reflect whatever is currently filtered/shown.
function renderStats(list) {
  let inHand = 0, paid = 0, retail = 0;
  for (const y of list) {
    if (y.in_hand) inHand++;
    paid += y.paid || 0;
    retail += y.retail || 0;
  }
  const ownedCount = ownedYoyos().length;
  const count = list.length;
  const filtered = count !== ownedCount;
  const countLabel = filtered ? `of ${ownedCount} shown` : 'Yoyos';

  // Public viewers don't see financial / ownership stats.
  if (!canEditState) {
    const brands = new Set(list.map((y) => y.brand).filter(Boolean)).size;
    $('#stats').innerHTML = `
      <div class="stat-card ${filtered ? 'filtered' : ''}"><div class="stat-num">${count}</div><div class="stat-label">${countLabel}</div></div>
      <div class="stat-card"><div class="stat-num">${brands}</div><div class="stat-label">Brands</div></div>`;
    return;
  }

  const pctSaved = retail > 0 ? Math.round(((retail - paid) / retail) * 100) : 0;
  $('#stats').innerHTML = `
    <div class="stat-card ${filtered ? 'filtered' : ''}"><div class="stat-num">${count}</div><div class="stat-label">${countLabel}</div></div>
    <div class="stat-card"><div class="stat-num">${inHand}</div><div class="stat-label">In hand</div></div>
    <div class="stat-card"><div class="stat-num">${count - inHand}</div><div class="stat-label">On order</div></div>
    <div class="stat-card"><div class="stat-num">${money0(retail)}</div><div class="stat-label">Total retail</div></div>
    <div class="stat-card"><div class="stat-num">${money0(paid)}</div><div class="stat-label">Total paid</div></div>
    <div class="stat-card"><div class="stat-num">${money0(retail - paid)}</div><div class="stat-label">Saved vs retail</div></div>
    <div class="stat-card"><div class="stat-num">${pctSaved}%</div><div class="stat-label">Percent saved</div></div>
  `;
}

// Each of these built-in fields was a dropdown in the spreadsheet. We populate
// the options from the values already in the collection (plus a few seeds), so
// the lists grow automatically — type a new value in the form and it's added.
const DATALIST_FIELD = {
  brandList: 'brand',
  materialList: 'body_material',
  compositionList: 'composition',
  conditionList: 'condition',
  bearingList: 'bearing_size',
  responseList: 'response_type',
  sellerList: 'seller',
  buyerList: 'buyer',
  finishList: 'finish',
  shapeList: 'shape',
};
const DATALIST_SEEDS = {
  compositionList: ['BI', 'MN', 'TRI'],
  conditionList: ['MiB', 'NMBTS', 'Used', 'Beat'],
  bearingList: ['Size C', 'Size D'],
  finishList: ['Blasted', 'Polished', 'Pyramatte', 'Matte', 'Satin', 'Raw'],
  shapeList: ['Organic', 'H-Shape', 'V-Shape', 'W-Shape', 'Step Round'],
};

// Rebuilds the <datalist> autocomplete options for text fields like brand,
// material, and finish from whatever values already exist in the collection.
function refreshDatalists() {
  for (const [listId, field] of Object.entries(DATALIST_FIELD)) {
    const el = document.getElementById(listId);
    if (!el) continue;
    const values = [...new Set([...(DATALIST_SEEDS[listId] || []), ...yoyos.map((y) => y[field]).filter(Boolean)])]
      .sort((a, b) => String(a).localeCompare(String(b)));
    el.innerHTML = values.map((v) => `<option value="${esc(v)}"></option>`).join('');
  }
  buildFilterPanel();
}

// Sold yoyos are history — they live on the Sold page, not in the active
// collection. Everything that means "the collection" starts from ownedYoyos().
function isSold(y) { return y.sale_status === 'Sold'; }
function ownedYoyos() { return yoyos.filter((y) => !isSold(y)); }

// Applies the current `filters` (search, checkboxes, ranges) and sort order to
// the owned (non-sold) yoyos. This is the single source of truth for "what's
// currently visible" — every render function (tiles, rows, stats, insights)
// starts from its result.
function filteredYoyos() {
  let list = ownedYoyos();
  const q = filters.q.toLowerCase();
  if (q) {
    list = list.filter((y) =>
      [y.brand, y.model, y.color, y.body_material, y.composition, y.description, y.response_type]
        .join(' ').toLowerCase().includes(q)
    );
  }
  if (filters.brands.length) list = list.filter((y) => filters.brands.includes(y.brand));
  if (filters.compositions.length) list = list.filter((y) => filters.compositions.includes(y.composition));
  if (filters.conditions.length) list = list.filter((y) => filters.conditions.includes(y.condition));
  if (filters.material) {
    const m = filters.material.toLowerCase();
    list = list.filter((y) => String(y.body_material || '').toLowerCase().includes(m));
  }
  if (filters.status === 'in') list = list.filter((y) => y.in_hand);
  else if (filters.status === 'order') list = list.filter((y) => !y.in_hand);
  if (filters.retiredOnly) list = list.filter((y) => y.retired);
  if (filters.favOnly) list = list.filter((y) => y.favorite);
  const inRange = (val, min, max) =>
    (min == null || (val != null && val >= min)) && (max == null || (val != null && val <= max));
  if (filters.paidMin != null || filters.paidMax != null) list = list.filter((y) => inRange(y.paid, filters.paidMin, filters.paidMax));
  if (filters.retailMin != null || filters.retailMax != null) list = list.filter((y) => inRange(y.retail, filters.retailMin, filters.retailMax));
  if (filters.weightMin != null || filters.weightMax != null) list = list.filter((y) => inRange(y.weight_g, filters.weightMin, filters.weightMax));

  const key = filters.sort;
  const flip = filters.sortDir === 'desc' ? -1 : 1;
  const numeric = NUMERIC_KEYS.has(key) || FIELD_BY_KEY[key]?.num;
  list.sort((a, b) => {
    const av = valueOf(a, key), bv = valueOf(b, key);
    let r;
    if (key === 'favorite' || key === 'in_hand') r = (av ? 1 : 0) - (bv ? 1 : 0);
    else if (numeric) r = (av ?? -Infinity) - (bv ?? -Infinity);
    else r = String(av || '').localeCompare(String(bv || ''));
    if (r === 0 && key !== 'brand') r = String(a.brand || '').localeCompare(String(b.brand || ''));
    return r * flip;
  });
  return list;
}

// Clicking a column header: sort by it, or flip direction if it's already the
// active sort column.
function setSort(key) {
  if (filters.sort === key) filters.sortDir = filters.sortDir === 'asc' ? 'desc' : 'asc';
  else { filters.sort = key; filters.sortDir = defaultDir(key); }
  const dd = $('#sort');
  if ([...dd.options].some((o) => o.value === key)) dd.value = key;
  render();
}

// ---- Master render ----
function filtersActive() {
  return !!(filters.q || filters.brands.length || filters.compositions.length || filters.conditions.length ||
    filters.material || filters.status || filters.retiredOnly || filters.favOnly ||
    filters.paidMin != null || filters.paidMax != null || filters.retailMin != null || filters.retailMax != null ||
    filters.weightMin != null || filters.weightMax != null);
}
// Number of distinct filters currently applied, shown as a badge on the
// filter toggle button.
function activeFilterCount() {
  let n = 0;
  n += filters.brands.length + filters.compositions.length + filters.conditions.length;
  if (filters.material) n++;
  if (filters.status) n++;
  if (filters.retiredOnly) n++;
  if (filters.favOnly) n++;
  if (filters.paidMin != null || filters.paidMax != null) n++;
  if (filters.retailMin != null || filters.retailMax != null) n++;
  if (filters.weightMin != null || filters.weightMax != null) n++;
  return n;
}

// The main re-render entry point: recomputes the filtered/sorted list, updates
// the stats bar and filter chips, paginates, and delegates to renderTiles or
// renderRows depending on the current view mode. Call this after any change
// to `filters`, `view`, or the underlying `yoyos` data.
function render() {
  const all = filteredYoyos();
  renderStats(all);
  $('#clearFilters').classList.toggle('hidden', !filtersActive());
  renderActiveFilters();
  updateFilterCount();
  emptyMsg.classList.toggle('hidden', all.length > 0);

  // Pagination math
  const size = view.pageSize === 'all' ? all.length || 1 : view.pageSize;
  const totalPages = Math.max(1, Math.ceil(all.length / size));
  if (view.page > totalPages) view.page = totalPages;
  const start = (view.page - 1) * size;
  const pageItems = view.pageSize === 'all' ? all : all.slice(start, start + size);

  if (view.mode === 'row') renderRows(pageItems);
  else renderTiles(pageItems);

  renderPager(all.length, start, pageItems.length, totalPages);
  syncViewControls();
}

// Placeholder cards shown while the initial /api/yoyos request is in flight.
function renderSkeleton(n = 10) {
  if (!grid) return;
  grid.className = `grid size-${view.size}`;
  grid.innerHTML = Array.from({ length: n }, () =>
    '<div class="skel-card"><div class="skel-photo"></div><div class="skel-lines">' +
    '<div class="skel-line w40"></div><div class="skel-line w80"></div><div class="skel-line w60"></div>' +
    '</div></div>').join('');
  emptyMsg.classList.add('hidden');
}

// Renders the card-grid view and wires up each card's click (open detail),
// double-click (jump to edit), right-click (context menu), favorite star, and
// selection checkbox.
function renderTiles(items) {
  grid.className = `grid size-${view.size}`;
  grid.innerHTML = items.map(tileHTML).join('');
  grid.querySelectorAll('.card[data-id]').forEach((el) => {
    const id = Number(el.dataset.id);
    if (selectedIds.has(id)) el.classList.add('selected');
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-fav], [data-more], [data-filt], .sel-box')) return; // handled below
      if (selectMode) { toggleSelect(id); return; }
      openDetail(id);
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('[data-fav], [data-more], [data-filt], .sel-box')) return;
      if (!selectMode && canEditState) openEdit(id); // jump straight to the editor
    });
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMode ? toggleSelect(id) : openDetail(id); }
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showCardMenu(e, id); });
  });
  grid.querySelectorAll('.sel-box[data-sel]').forEach(wireSelBox);
  grid.querySelectorAll('[data-fav]').forEach((btn) =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(Number(btn.dataset.fav)); })
  );
  grid.querySelectorAll('[data-more]').forEach((btn) =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); const r = btn.getBoundingClientRect(); showCardMenu({ clientX: r.right, clientY: r.bottom }, Number(btn.dataset.more)); })
  );
  grid.querySelectorAll('[data-filt]').forEach((el) =>
    el.addEventListener('click', (e) => { e.stopPropagation(); applyQuickFilter(el.dataset.filt); })
  );
}

// Builds the markup for one collection card: photo, brand/model, the fields
// chosen in view.fields (as tags/meta text), price line, and sale/retired badges.
function tileHTML(y) {
  const photo = y.photos[0]
    ? `<img src="${esc(y.photos[0].thumbUrl || y.photos[0].url)}" alt="${esc(y.model)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${esc(y.photos[0].url)}'" />`
    : '<span class="placeholder"></span>';

  // Selected fields shown as meta; price fields handled specially.
  const tags = [];
  const metas = [];
  let priceLine = '';
  for (const key of view.fields) {
    const v = valueOf(y, key);
    if (key === 'paid' || key === 'retail' || key === 'percent_off') continue; // handled below
    if (key === 'description') continue; // too long for a tile; shown in row/detail views
    if (v == null || v === '') continue;
    if (key === 'composition' || key === 'condition') {
      const grp = key === 'composition' ? 'compositions' : 'conditions';
      tags.push(`<span class="tag clickable" data-filt="${grp}:${esc(v)}" title="Filter by ${esc(v)}">${esc(fmtField(key, v))}</span>`);
    } else if (key === 'color') tags.push(`<span class="tag">${esc(fmtField(key, v))}</span>`);
    else if (key === 'in_hand') { if (v) metas.push('in hand'); }
    else if (key === 'favorite') { /* shown as corner star */ }
    else metas.push(esc(fmtField(key, v)));
  }
  const price = [];
  if (view.fields.includes('paid') && y.paid != null) price.push(`<strong>${money(y.paid)}</strong>`);
  if (view.fields.includes('retail') && y.retail != null) price.push(`<span class="muted-sm">${money(y.retail)} retail</span>`);
  if (view.fields.includes('percent_off') && y.percent_off != null && y.percent_off > 0) price.push(`<span class="off">${y.percent_off}% off</span>`);
  if (price.length) priceLine = `<div class="card-price">${price.join(' ')}</div>`;
  if (y.retired) tags.unshift('<span class="tag tag-retired clickable" data-filt="retiredOnly:1" title="Show retired">Retired</span>');
  if (isForSale(y.sale_status)) tags.unshift(`<span class="tag tag-sale">${esc(y.sale_status)}</span>`);
  else if (y.sale_status === 'Sold') tags.unshift('<span class="tag tag-sold">Sold</span>');
  const brandHTML = y.brand
    ? `<div class="card-brand clickable" data-filt="brands:${esc(y.brand)}" title="Filter by ${esc(y.brand)}">${esc(y.brand)}</div>`
    : '<div class="card-brand">—</div>';

  return `
    <article class="card" data-id="${y.id}" role="button" tabindex="0" aria-label="${esc(y.brand)} ${esc(y.model)}">
      <span class="sel-box ${selectedIds.has(y.id) ? 'checked' : ''}" data-sel="${y.id}"></span>
      ${(!canEditState && y.favorite) ? `<span class="card-fav">${SVG.star}</span>` : ''}
      ${canEditState ? `<div class="card-actions">
        <button type="button" class="card-fav-btn ${y.favorite ? 'on' : ''}" data-fav="${y.id}" title="${y.favorite ? 'Unfavorite' : 'Favorite'}">${y.favorite ? SVG.star : SVG.starOutline}</button>
        <button type="button" class="card-more-btn" data-more="${y.id}" title="More actions" aria-label="More actions">${SVG.dots}</button>
      </div>` : ''}
      ${canEditState && !y.in_hand ? '<span class="card-order">On order</span>' : ''}
      <div class="card-photo">${photo}</div>
      <div class="card-body">
        ${brandHTML}
        <div class="card-model">${esc(y.model) || 'Untitled'}</div>
        <div class="card-meta">
          ${tags.join('')}
          ${metas.map((m) => `<span>${m}</span>`).join('')}
        </div>
        ${priceLine}
      </div>
    </article>`;
}

// Renders the spreadsheet-style table view, with sortable column headers and
// (when "Edit cells" is on) inline-editable cells.
function renderRows(items) {
  grid.className = 'table-wrap';
  const cols = view.fields
    .filter((k) => canEditState || !SENSITIVE.has(k))
    .map((k) => FIELD_BY_KEY[k]).filter(Boolean);
  const editable = listEditMode && canEditState;
  const arrow = (key) => (filters.sort === key ? (filters.sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const th = (key, label, extra = '') =>
    `<th class="sortable ${extra} ${filters.sort === key ? 'sorted' : ''}" data-sort="${key}">${esc(label)}${arrow(key)}</th>`;
  const head =
    (canEditState ? '<th class="col-sel"></th>' : '') +
    '<th class="col-photo"></th>' +
    th('brand', 'Brand') +
    th('model', 'Model') +
    cols.map((c) => th(c.key, c.label, c.num ? 'num' : '')).join('');

  // Built-in cells carry data-edit whenever the owner can edit, so they're
  // double-click-editable any time; single-click editing only in "Edit cells".
  const cell = (y, key, content, extraClass = '') => {
    const canEditCell = canEditState && editableKeys().has(key) && !FIELD_BY_KEY[key]?.custom;
    return `<td class="${extraClass}${canEditCell ? ' editable' : ''}"${canEditCell ? ` data-edit="${key}"` : ''}>${content}</td>`;
  };

  const rows = items.map((y) => {
    const thumb = y.photos[0]
      ? `<img class="row-thumb" src="${esc(y.photos[0].thumbUrl || y.photos[0].url)}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${esc(y.photos[0].url)}'" />`
      : '<span class="row-thumb placeholder"></span>';
    const cells = cols.map((c) => cell(y, c.key, esc(fmtField(c.key, valueOf(y, c.key))), c.num ? 'num' : '')).join('');
    const selCell = canEditState ? `<td class="col-sel"><span class="sel-box ${selectedIds.has(y.id) ? 'checked' : ''}" data-sel="${y.id}"></span></td>` : '';
    return `
      <tr data-id="${y.id}" class="${selectedIds.has(y.id) ? 'selected' : ''}">
        ${selCell}
        <td class="col-photo">${thumb}</td>
        ${cell(y, 'brand', `${esc(y.brand)}${y.favorite ? ` <span class="row-fav">${SVG.star}</span>` : ''}`)}
        ${cell(y, 'model', `${esc(y.model)}${canEditState && !y.in_hand ? ' <span class="row-order">on order</span>' : ''}`)}
        ${cells}
      </tr>`;
  }).join('');

  grid.innerHTML = `
    <table class="data-table${editable ? ' editing' : ''}">
      <thead><tr>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  grid.querySelectorAll('tr[data-id]').forEach((el) => {
    const id = Number(el.dataset.id);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.cell-editor')) return;
      const cellEl = e.target.closest('td.editable');
      if (selectMode) { toggleSelect(id); return; }
      if (editable) { if (cellEl) startCellEdit(cellEl, id, cellEl.dataset.edit); return; }
      openDetail(id);
    });
    // Double-click a cell to edit it inline even without "Edit cells" mode.
    el.addEventListener('dblclick', (e) => {
      const cellEl = e.target.closest('td.editable');
      if (cellEl && canEditState) { closeDetail(); startCellEdit(cellEl, id, cellEl.dataset.edit); }
    });
  });
  grid.querySelectorAll('.sel-box[data-sel]').forEach(wireSelBox);
  grid.querySelectorAll('th[data-sort]').forEach((el) =>
    el.addEventListener('click', () => setSort(el.dataset.sort))
  );
}

// Renders the "Showing X-Y of Z" summary and a compact page-number strip
// (current page ± 2, plus first/last, with "…" gaps).
function renderPager(total, start, shown, totalPages) {
  const pager = $('#pager');
  if (total === 0) { pager.classList.add('hidden'); return; }
  pager.classList.remove('hidden');
  const from = total === 0 ? 0 : start + 1;
  $('#pagerInfo').textContent = `Showing ${from}–${start + shown} of ${total}`;

  $('#prevPage').disabled = view.page <= 1;
  $('#nextPage').disabled = view.page >= totalPages;

  // Compact page numbers (current ± 2, with first/last).
  const nums = [];
  const add = (n) => nums.push(n);
  const win = new Set([1, totalPages, view.page, view.page - 1, view.page + 1, view.page - 2, view.page + 2]);
  let prev = 0;
  for (let n = 1; n <= totalPages; n++) {
    if (!win.has(n)) continue;
    if (n - prev > 1) add('…');
    add(n);
    prev = n;
  }
  $('#pageNums').innerHTML = nums.map((n) =>
    n === '…' ? '<span class="ellipsis">…</span>'
      : `<button class="page-num ${n === view.page ? 'active' : ''}" data-page="${n}">${n}</button>`
  ).join('');
  $('#pageNums').querySelectorAll('[data-page]').forEach((b) =>
    b.addEventListener('click', () => { view.page = Number(b.dataset.page); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); })
  );
}

// ---- View controls ----
function syncViewControls() {
  $('#viewTile').classList.toggle('active', view.mode === 'tile');
  $('#viewRow').classList.toggle('active', view.mode === 'row');
  $('#sizeWrap').classList.toggle('hidden', view.mode !== 'tile');
  $('#tileSize').value = view.size;
  $('#pageSize').value = String(view.pageSize);
  $('#sort').value = filters.sort;
  $('#sortDirBtn').textContent = filters.sortDir === 'asc' ? '↑' : '↓';
  $('#sortDirBtn').title = filters.sortDir === 'asc' ? 'Ascending' : 'Descending';
  $('#selectBtn').classList.toggle('hidden', !canEditState);
  $('#selectBtn').classList.toggle('active', selectMode);
  // Inline cell editing only makes sense in the list view.
  const showEdit = canEditState && view.mode === 'row';
  $('#listEditBtn').classList.toggle('hidden', !showEdit);
  $('#listEditBtn').classList.toggle('active', listEditMode);
  if (!showEdit && listEditMode) setListEdit(false);
}

// Populates the "Fields ▾" popover with a checkbox per field the current
// viewer is allowed to see (public viewers don't get SENSITIVE fields).
function buildFieldsPanel() {
  const panel = $('#fieldsPanel');
  const choices = ALL_FIELDS.filter((f) => canEditState || !SENSITIVE.has(f.key));
  panel.innerHTML =
    `<div class="popover-head">Show fields</div>` +
    choices.map((f) => `
      <label class="pop-item">
        <input type="checkbox" value="${f.key}" ${view.fields.includes(f.key) ? 'checked' : ''} />
        ${esc(f.label)}
      </label>`).join('') +
    `<div class="popover-foot"><button type="button" id="fieldsReset" class="link-btn">Reset</button></div>`;

  panel.querySelectorAll('input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', () => {
      view.fields = ALL_FIELDS.map((f) => f.key).filter((k) => {
        const box = panel.querySelector(`input[value="${k}"]`);
        return box ? box.checked : view.fields.includes(k); // keep hidden fields as-is
      });
      saveView();
      render();
    })
  );
  $('#fieldsReset').addEventListener('click', () => {
    view.fields = [...DEFAULT_VIEW.fields];
    saveView();
    buildFieldsPanel();
    render();
  });
}

// ============================================================
//  View router (Collection / Arrivals / Insights)
// ============================================================
// Switches between the Collection / Arrivals / For Sale / Sold / Insights
// views, remembering the choice and rendering the newly-active one.
function setView(v) {
  if ((v === 'arrivals' || v === 'sold') && !canEditState) v = 'collection';
  currentView = v;
  try { localStorage.setItem('yoyoTab', v); } catch { /* ignore */ }
  document.querySelectorAll('#sidebarNav .nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === v));
  $('#viewCollection').classList.toggle('hidden', v !== 'collection');
  $('#viewArrivals').classList.toggle('hidden', v !== 'arrivals');
  $('#viewSale').classList.toggle('hidden', v !== 'sale');
  $('#viewSold').classList.toggle('hidden', v !== 'sold');
  $('#viewInsights').classList.toggle('hidden', v !== 'insights');
  $('#viewTitle').textContent = v === 'arrivals' ? 'Arrivals' : v === 'sale' ? 'For Sale' : v === 'sold' ? 'Sold' : v === 'insights' ? 'Insights' : 'Collection';
  updateToolbar();
  if (v === 'arrivals') renderArrivals();
  else if (v === 'sale') renderSale();
  else if (v === 'sold') renderSold();
  else if (v === 'insights') renderInsights();
  else render();
  playViewIntro(v); // count-up / grow-in on each tab entry (no-op if data not loaded yet)
}
function updateToolbar() {
  $('#collectionActions').classList.toggle('hidden', !(currentView === 'collection' && canEditState));
}
function refreshCurrentView() {
  if (currentView === 'arrivals') renderArrivals();
  else if (currentView === 'sale') renderSale();
  else if (currentView === 'sold') renderSold();
  else if (currentView === 'insights') renderInsights();
  else render();
  // Play the entrance animation once — after the first load populates the
  // view (setView on boot ran before data arrived, so its intro was a no-op).
  if (introPending) { introPending = false; playViewIntro(currentView); }
}

// ---- Quick actions (favorite / delete / context menu) ----
// Turns a loaded yoyo record back into a full PUT-able payload. Needed because
// the server's update endpoint overwrites every WRITE_COLS column from the
// body — a partial payload would blank out fields the caller didn't mean to touch.
function buildPayload(y) {
  const p = {};
  ['brand', 'model', 'color', 'body_material', 'composition', 'condition',
    'bearing_size', 'response_type', 'description', 'release_date', 'tracking', 'eta',
    'sale_status', 'purchase_date', 'sold_date', 'seller', 'buyer',
    'finish', 'shape', 'edition', 'serial_number', 'signature']
    .forEach((k) => { p[k] = y[k] ?? ''; });
  ['retail', 'paid', 'weight_g', 'diameter_mm', 'width_mm', 'gap_mm', 'sale_price', 'trade_value', 'market_value']
    .forEach((k) => { p[k] = y[k] ?? ''; });
  p.in_hand = !!y.in_hand;
  p.favorite = !!y.favorite;
  p.retired = !!y.retired;
  p.custom = y.custom || {};
  return p;
}
// Flips a yoyo's favorite star from the card/detail view.
async function toggleFavorite(id) {
  if (demoGuard()) return;
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  const p = buildPayload(y);
  p.favorite = !y.favorite;
  try {
    await api(`/api/yoyos/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}
// Delete a single yoyo from a card's context menu, after a confirm dialog.
async function deleteYoyoQuick(id) {
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  if (!await confirmDialog({ title: `Delete ${y.brand} ${y.model}?`, message: 'This removes the yoyo and its photos. This can’t be undone.', confirmText: 'Delete', danger: true })) return;
  try { await api(`/api/yoyos/${id}`, { method: 'DELETE' }); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}
function dismissCardMenu() { document.querySelectorAll('.context-menu').forEach((m) => m.remove()); }
// Right-click / "⋮" context menu for a card: favorite, in-hand, retired,
// edit, delete — positioned near the click so it never runs off-screen.
function showCardMenu(e, id) {
  if (!canEditState) return;
  dismissCardMenu();
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML =
    `<button data-act="fav">${y.favorite ? SVG.starOutline : SVG.star}<span>${y.favorite ? 'Unfavorite' : 'Favorite'}</span></button>` +
    `<button data-act="inhand">${SVG.box}<span>${y.in_hand ? 'Mark on order' : 'Mark in hand'}</span></button>` +
    `<button data-act="retired">${SVG.check}<span>${y.retired ? 'Unmark retired' : 'Mark retired'}</span></button>` +
    `<button data-act="edit">${SVG.edit}<span>Edit…</span></button>` +
    `<div class="cm-sep"></div>` +
    `<button class="danger" data-act="del">${SVG.trash}<span>Delete</span></button>`;
  document.body.appendChild(menu);
  const mw = 180, mh = menu.offsetHeight || 160;
  const x = Math.min(e.clientX, window.innerWidth - mw - 8);
  const top = Math.min(e.clientY, window.innerHeight - mh - 8);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
  const quick = (changes) => { dismissCardMenu(); patchYoyo(id, changes).then(loadAll).catch((err) => toast(err.message, 'error')); };
  menu.querySelector('[data-act="fav"]').onclick = () => { dismissCardMenu(); toggleFavorite(id); };
  menu.querySelector('[data-act="inhand"]').onclick = () => quick({ in_hand: !y.in_hand });
  menu.querySelector('[data-act="retired"]').onclick = () => quick({ retired: !y.retired });
  menu.querySelector('[data-act="edit"]').onclick = () => { dismissCardMenu(); openEdit(id); };
  menu.querySelector('[data-act="del"]').onclick = () => { dismissCardMenu(); deleteYoyoQuick(id); };
}

// Quick filter from clicking a brand/tag on a card or in the detail view.
function applyQuickFilter(spec) {
  const i = spec.indexOf(':');
  const type = spec.slice(0, i), val = spec.slice(i + 1);
  if (type === 'brands' || type === 'compositions' || type === 'conditions') filters[type] = [val];
  else if (type === 'retiredOnly') filters.retiredOnly = true;
  if (currentView !== 'collection') setView('collection');
  view.page = 1;
  buildFilterPanel();
  render();
  toast('Filtered — “Clear all” to reset.', 'ok');
}
document.addEventListener('click', dismissCardMenu);
document.addEventListener('scroll', dismissCardMenu, true);

// Update one yoyo's fields (full-payload PUT, since the server blanks omitted cols).
// Applies a partial change (e.g. { retired: true }) to one yoyo via a full
// PUT built from its current record (see buildPayload).
async function patchYoyo(id, changes) {
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  const p = buildPayload(y);
  Object.assign(p, changes);
  return api(`/api/yoyos/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
}

// Distinct existing values for a field (+ seeds), for editors/bulk pickers.
function optionsFor(key, seeds = []) {
  return [...new Set([...seeds, ...yoyos.map((y) => y[key]).filter(Boolean)])]
    .sort((a, b) => String(a).localeCompare(String(b)));
}

// ============================================================
//  Bulk selection + bulk edit
// ============================================================
let selectMode = false;
const selectedIds = new Set();

const BULK_FIELDS = [
  { key: 'in_hand', label: 'In hand', type: 'bool' },
  { key: 'favorite', label: 'Favorite', type: 'bool' },
  { key: 'retired', label: 'Retired', type: 'bool' },
  { key: 'composition', label: 'Composition', type: 'select', seeds: ['BI', 'MN', 'TRI'] },
  { key: 'condition', label: 'Condition', type: 'select', seeds: ['MiB', 'NMBTS', 'Used', 'Beat'] },
  { key: 'bearing_size', label: 'Bearing', type: 'select', seeds: ['Size C', 'Size D'] },
  { key: 'sale_status', label: 'Sale status', type: 'select', seeds: ['For Sale', 'For Trade', 'For Sale or Trade', 'Sold'] },
];

// Enters/exits multi-select mode (the checkbox-driven bulk actions bar).
function setSelectMode(on) {
  selectMode = on;
  if (!on) selectedIds.clear();
  if (on) setListEdit(false);
  document.body.classList.toggle('select-mode', on);
  const btn = $('#selectBtn');
  if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); }
  renderSelectionBar();
  render();
}
// Adds/removes one yoyo from the bulk-selection set and updates its checkbox
// in place (cheaper than a full re-render).
function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  document.querySelectorAll(`.card[data-id="${id}"], tr[data-id="${id}"]`).forEach((el) => el.classList.toggle('selected', selectedIds.has(id)));
  document.querySelectorAll(`.sel-box[data-sel="${id}"]`).forEach((el) => el.classList.toggle('checked', selectedIds.has(id)));
  renderSelectionBar();
}
// Boxes are always visible; clicking one selects the item, entering select mode
// on the first pick so the action bar appears. We flip the flag in place rather
// than calling setSelectMode() — that does a full grid re-render, which is both
// unnecessary (boxes already show) and was dropping clicks mid-interaction.
function wireSelBox(box) {
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectMode) {
      if (listEditMode) setListEdit(false); // the two modes are mutually exclusive
      selectMode = true;
      document.body.classList.add('select-mode');
      const btn = $('#selectBtn');
      if (btn) { btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true'); }
    }
    toggleSelect(Number(box.dataset.sel));
  });
}
// Renders (or removes) the floating bulk-actions bar shown while selectMode is on.
function renderSelectionBar() {
  let bar = $('#selectionBar');
  if (!selectMode) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'selectionBar'; bar.className = 'selection-bar'; document.body.appendChild(bar); }
  const n = selectedIds.size;
  bar.innerHTML =
    `<span class="sel-count">${n} selected</span>` +
    `<button class="btn btn-ghost btn-sm" data-act="all">Select all</button>` +
    `<button class="btn btn-ghost btn-sm" data-act="none" ${n ? '' : 'disabled'}>Clear</button>` +
    `<span class="spacer"></span>` +
    `<button class="btn btn-primary btn-sm" data-act="edit" ${n ? '' : 'disabled'}>Edit fields…</button>` +
    `<button class="btn btn-ghost btn-sm" data-act="dup" ${n ? '' : 'disabled'}>Duplicate</button>` +
    `<button class="btn btn-danger btn-sm" data-act="del" ${n ? '' : 'disabled'}>Delete</button>` +
    `<button class="btn btn-ghost btn-sm" data-act="done">Done</button>`;
  bar.querySelector('[data-act="all"]').onclick = () => { filteredYoyos().forEach((y) => selectedIds.add(y.id)); render(); renderSelectionBar(); };
  bar.querySelector('[data-act="none"]').onclick = () => { selectedIds.clear(); render(); renderSelectionBar(); };
  bar.querySelector('[data-act="edit"]').onclick = openBulkEdit;
  bar.querySelector('[data-act="dup"]').onclick = bulkDuplicate;
  bar.querySelector('[data-act="del"]').onclick = bulkDelete;
  bar.querySelector('[data-act="done"]').onclick = () => setSelectMode(false);
}
// Duplicates every selected yoyo (all fields except identity/derived ones;
// photos aren't copied), tagging each copy's model with "(copy)".
async function bulkDuplicate() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  if (demoGuard()) return;
  let ok = 0, fail = 0;
  for (const id of ids) {
    const y = yoyos.find((x) => x.id === id);
    if (!y) { fail++; continue; }
    // Copy every field except identity/derived ones; photos are per-yoyo files
    // and don't carry over. Tag the model so the copy is easy to spot.
    const { id: _id, created_at, updated_at, percent_off, photos, ...copy } = y;
    copy.model = `${(y.model || '').trim()} (copy)`.trim();
    try {
      await api('/api/yoyos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(copy),
      });
      ok++;
    } catch { fail++; }
  }
  setSelectMode(false);
  await loadAll();
  toast(`Duplicated ${ok} yoyo${ok === 1 ? '' : 's'}${fail ? `, ${fail} failed` : ''}.`, fail ? 'error' : 'ok');
}
// Deletes every selected yoyo, after one confirm dialog for the whole batch.
async function bulkDelete() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  if (demoGuard()) return;
  if (!await confirmDialog({ title: `Delete ${ids.length} yoyo${ids.length === 1 ? '' : 's'}?`, message: 'This removes them and their photos. This can’t be undone.', confirmText: 'Delete', danger: true })) return;
  let ok = 0;
  for (const id of ids) { try { await api(`/api/yoyos/${id}`, { method: 'DELETE' }); ok++; } catch { /* keep going */ } }
  setSelectMode(false);
  await loadAll();
  toast(`Deleted ${ok} yoyo${ok === 1 ? '' : 's'}.`, 'ok');
}
// Opens the "Edit N yoyos" dialog (BULK_FIELDS only) — every control defaults
// to "No change" so the apply step only touches fields the user actually set.
function openBulkEdit() {
  if (!selectedIds.size) return;
  if (demoGuard()) return;
  const rows = BULK_FIELDS.map((f) => {
    let control;
    if (f.type === 'bool') {
      control = `<select data-be="${f.key}" data-type="bool"><option value="">No change</option><option value="1">Yes</option><option value="0">No</option></select>`;
    } else {
      const opts = optionsFor(f.key, f.seeds).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
      control = `<select data-be="${f.key}" data-type="select"><option value="">No change</option><option value="__clear__">— Clear —</option>${opts}</select>`;
    }
    return `<div class="be-row"><label>${esc(f.label)}</label>${control}</div>`;
  }).join('');
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  const card = document.createElement('div');
  card.className = 'modal-card modal-sm';
  card.innerHTML =
    `<div class="modal-head"><h2>Edit ${selectedIds.size} yoyo${selectedIds.size === 1 ? '' : 's'}</h2></div>` +
    `<div class="form"><div class="form-section"><div class="be-grid">${rows}</div>` +
    `<p class="hint">Only fields you change are applied; the rest are left as-is.</p></div></div>` +
    `<div class="modal-foot"><span class="spacer"></span><button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="apply">Apply</button></div>`;
  const bd = document.createElement('div'); bd.className = 'modal-backdrop';
  overlay.appendChild(bd); overlay.appendChild(card); document.body.appendChild(overlay);
  const close = () => overlay.remove();
  bd.onclick = close;
  card.querySelector('[data-act="cancel"]').onclick = close;
  card.querySelector('[data-act="apply"]').onclick = async () => {
    const changes = {};
    card.querySelectorAll('[data-be]').forEach((sel) => {
      if (sel.value === '') return;
      const k = sel.dataset.be;
      if (sel.dataset.type === 'bool') changes[k] = sel.value === '1';
      else changes[k] = sel.value === '__clear__' ? '' : sel.value;
    });
    if (!Object.keys(changes).length) { toast('Choose at least one field to change.', 'error'); return; }
    close();
    const ids = [...selectedIds];
    let ok = 0, fail = 0;
    for (const id of ids) { try { await patchYoyo(id, changes); ok++; } catch { fail++; } }
    setSelectMode(false);
    await loadAll();
    toast(`Updated ${ok} yoyo${ok === 1 ? '' : 's'}${fail ? `, ${fail} failed` : ''}.`, fail ? 'error' : 'ok');
  };
}

// ============================================================
//  Smart views (saved filter sets, persisted per browser)
// ============================================================
let smartViews = loadSmartViews();
function loadSmartViews() { try { return JSON.parse(localStorage.getItem('yoyoSmartViews') || '[]'); } catch { return []; } }
function saveSmartViews() { try { localStorage.setItem('yoyoSmartViews', JSON.stringify(smartViews)); } catch { /* ignore */ } }
// Deep-copies the current filter criteria (excluding sort) for saving as a smart view.
function filterSnapshot() {
  const { sort, sortDir, ...rest } = filters; // views capture criteria, not sort
  return JSON.parse(JSON.stringify(rest));
}
// Restores a saved smart view's filter criteria and re-renders the collection.
function applySmartView(v) {
  const snap = JSON.parse(JSON.stringify(v.filters));
  Object.assign(filters, snap);
  $('#search').value = filters.q || '';
  if (currentView !== 'collection') setView('collection');
  view.page = 1;
  buildFilterPanel();
  render();
}
// Prompts for a name and saves the current filter set as a reusable smart view.
async function saveCurrentAsView() {
  if (!filtersActive()) { toast('Set some filters first, then save a view.', 'error'); return; }
  const name = await promptDialog({ title: 'Save smart view', placeholder: 'e.g. Bimetal G2s under $80', confirmText: 'Save' });
  if (!name) return;
  smartViews.push({ name: name.trim(), filters: filterSnapshot() });
  saveSmartViews();
  renderSmartViews();
  toast(`Saved view “${name.trim()}”.`, 'ok');
}
function deleteSmartView(i) {
  smartViews.splice(i, 1);
  saveSmartViews();
  renderSmartViews();
}
// Renders the sidebar's "Smart Views" list (owner-only, hidden when empty).
function renderSmartViews() {
  const wrap = $('#smartViews');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !(canEditState && smartViews.length));
  wrap.innerHTML = '<div class="nav-section">Smart Views</div>' + smartViews.map((v, i) =>
    `<div class="sv-item"><button class="nav-item sv-apply" data-sv="${i}"><svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5h12l-4.6 5.2v4.3l-2.8 1.5V8.7z"/></svg><span>${esc(v.name)}</span></button><button class="sv-del" data-svdel="${i}" title="Delete view">✕</button></div>`
  ).join('');
  wrap.querySelectorAll('[data-sv]').forEach((b) => b.addEventListener('click', () => applySmartView(smartViews[Number(b.dataset.sv)])));
  wrap.querySelectorAll('[data-svdel]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); deleteSmartView(Number(b.dataset.svdel)); }));
}

// Promise-based text prompt dialog (styled, replaces native prompt()).
function promptDialog({ title = '', placeholder = '', confirmText = 'Save', value = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal confirm-modal';
    const card = document.createElement('div');
    card.className = 'modal-card modal-confirm';
    card.innerHTML =
      `<div class="confirm-body"><h2></h2><input type="text" class="prompt-input" /></div>` +
      `<div class="modal-foot"><span class="spacer"></span><button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok"></button></div>`;
    card.querySelector('h2').textContent = title;
    const input = card.querySelector('.prompt-input');
    input.placeholder = placeholder; input.value = value;
    card.querySelector('[data-act="ok"]').textContent = confirmText;
    const bd = document.createElement('div'); bd.className = 'modal-backdrop';
    overlay.appendChild(bd); overlay.appendChild(card); document.body.appendChild(overlay);
    const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } else if (e.key === 'Enter') { e.preventDefault(); close(input.value.trim() || null); } };
    document.addEventListener('keydown', onKey, true);
    bd.onclick = () => close(null);
    card.querySelector('[data-act="cancel"]').onclick = () => close(null);
    card.querySelector('[data-act="ok"]').onclick = () => close(input.value.trim() || null);
    input.focus();
  });
}

// ============================================================
//  Inline cell editing (list view edit mode)
// ============================================================
let listEditMode = false;
const INLINE_SELECTS = {
  composition: ['BI', 'MN', 'TRI'],
  condition: ['MiB', 'NMBTS', 'Used', 'Beat'],
  bearing_size: ['Size C', 'Size D'],
  sale_status: ['Not listed', 'For Sale', 'For Trade', 'For Sale or Trade', 'Sold'],
};
// Toggles list-view inline cell editing (mutually exclusive with select mode).
function setListEdit(on) {
  listEditMode = on;
  if (on) setSelectMode(false);
  document.body.classList.toggle('list-edit', on);
  const btn = $('#listEditBtn');
  if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); }
  render();
}
// Built-in fields safe to edit inline in the list view (no photos or custom
// fields — those need the full edit form).
function editableKeys() {
  return new Set(['brand', 'model', 'color', 'body_material', 'composition', 'condition',
    'bearing_size', 'response_type', 'release_date', 'tracking', 'eta',
    'retail', 'paid', 'weight_g', 'diameter_mm', 'width_mm', 'gap_mm',
    'in_hand', 'favorite', 'retired']);
}
// Commit one cell WITHOUT a full reload — update local state + re-render in place
// so editing stays snappy and you don't lose your spot. Returns when done.
async function commitCell(id, key, raw) {
  try {
    const updated = await patchYoyo(id, { [key]: raw });
    const idx = yoyos.findIndex((y) => y.id === id);
    if (idx >= 0 && updated) yoyos[idx] = updated;
    refreshCurrentView();
  } catch (err) { toast(err.message, 'error'); refreshCurrentView(); }
}
// After a commit + re-render, move the editor to the next/prev editable cell in the row.
function focusAdjacentCell(id, key, dir) {
  const tr = document.querySelector(`tr[data-id="${id}"]`);
  if (!tr) return;
  const cells = [...tr.querySelectorAll('td[data-edit]')];
  const idx = cells.findIndex((c) => c.dataset.edit === key);
  const target = cells[idx + dir];
  if (target) startCellEdit(target, id, target.dataset.edit);
}
const BOOL_KEYS = new Set(['in_hand', 'favorite', 'retired']);
// Swaps a table cell's static text for an input/select, wires Enter/Escape/Tab
// (Tab commits and moves to the next editable cell) and blur-to-save.
function startCellEdit(td, id, key) {
  if (td.querySelector('input, select')) return;
  if (demoGuard()) return;
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  if (BOOL_KEYS.has(key)) { commitCell(id, key, !y[key]); return; } // boolean → toggle
  const cur = y[key] == null ? '' : y[key];
  let editor;
  if (INLINE_SELECTS[key]) {
    editor = document.createElement('select');
    editor.innerHTML = '<option value=""></option>' +
      [...new Set([...INLINE_SELECTS[key], ...yoyos.map((v) => v[key]).filter(Boolean)])]
        .map((o) => `<option value="${esc(o)}" ${String(o) === String(cur) ? 'selected' : ''}>${esc(o)}</option>`).join('');
  } else {
    editor = document.createElement('input');
    editor.type = NUMERIC_KEYS.has(key) || FIELD_BY_KEY[key]?.num ? 'number' : 'text';
    editor.value = cur;
  }
  editor.className = 'cell-editor';
  td.innerHTML = '';
  td.appendChild(editor);
  editor.focus();
  if (editor.select) editor.select();
  let done = false;
  const finish = (save, moveDir = 0) => {
    if (done) return; done = true;
    const go = () => { if (moveDir) focusAdjacentCell(id, key, moveDir); };
    if (save && String(editor.value) !== String(cur)) commitCell(id, key, editor.value).then(go);
    else { render(); go(); } // unchanged or cancelled — restore, then maybe move
  };
  editor.addEventListener('blur', () => finish(true));
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
  });
}

// ---- Shared little helpers for Arrivals / Insights ----
function trimNum(d) { d = Number(d); return d === Math.round(d) ? String(Math.round(d)) : String(d); }
// Small thumbnail (or a blank placeholder) for a yoyo, used in Arrivals/Insights rows.
function thumbHTML(y, cls) {
  const p = (y.photos && y.photos[0]) ? y.photos[0] : null;
  if (p) return `<img class="${cls}" src="${esc(p.thumbUrl || p.url)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${esc(p.url)}'">`;
  return `<div class="${cls}"></div>`;
}
// Simple horizontal bar chart (used on Insights) from [{ name, value, display }].
function barChart(rows, color) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  // The bar colour rides on a --bc custom property so each design language
  // decides how to render it (Classic paints a leading-edge sheen gradient +
  // gloss; Precision paints a flat ticked bar). data-w carries the final width
  // so animateBars() can grow it in on entry while the markup stays correct.
  return `<div class="barchart">` + rows.map((r) => {
    const w = Math.max(2, r.value / max * 100).toFixed(1);
    return `<div class="bar-row"><span class="bar-name" title="${esc(r.name)}">${esc(r.name)}</span>` +
      `<div class="bar-track"><div class="bar-fill" data-w="${w}" style="width:${w}%;--bc:${color}"></div></div>` +
      `<span class="bar-val">${esc(r.display)}</span></div>`;
  }).join('') + `</div>`;
}

// ============================================================
//  Arrivals (calendar of incoming on-order yoyos) — admin only
// ============================================================
let calMonth = firstOfMonth(new Date());
let calSelected = null;
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
// Parses a stored ETA (ISO "YYYY-MM-DD", "M/D/YYYY", or whatever Date() can
// handle) into a local midnight Date, or null if unparseable.
function parseETA(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return new Date(+m[1], +m[2] - 1, +m[3]);
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    let yr = +m[3]; if (yr < 100) yr += 2000;
    return new Date(yr, +m[1] - 1, +m[2]);
  }
  const d = new Date(t);
  return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
// Format any stored ETA (free-text or ISO) to YYYY-MM-DD for an <input type="date">.
function toDateInputValue(s) {
  const d = parseETA(s);
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// "Arrives in 3 days" / "Was due 2 days ago" style label for an arrival date.
function relativeETA(d) {
  const today = new Date();
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((d - a) / 86400000);
  if (days === 0) return 'Arrives today';
  if (days === 1) return 'Arrives tomorrow';
  if (days > 1) return `Arrives in ${days} days`;
  if (days === -1) return 'Was due yesterday';
  return `Was due ${-days} days ago`;
}
// Groups on-order yoyos (in_hand = false) with a parseable ETA by calendar
// day, sorted earliest first — the data the Arrivals calendar dots are drawn from.
function arrivalGroups() {
  const map = new Map();
  for (const y of yoyos) {
    if (y.in_hand) continue;
    const d = parseETA(y.eta);
    if (!d) continue;
    const key = d.getTime();
    if (!map.has(key)) map.set(key, { day: d, items: [] });
    map.get(key).items.push(y);
  }
  return [...map.values()].sort((a, b) => a.day - b.day);
}
// One row in the Arrivals list: thumbnail, editable tracking/ETA inputs, an
// optional "Query ETA" button, and a "mark as arrived" action.
function arrivalRow(y, sub) {
  const queryBtn = trackingEnabledState
    ? `<button class="btn btn-ghost btn-sm arr-query" data-track-query="${y.id}" title="Look up ETA from the carrier">${SVG.box}<span>Query ETA</span></button>`
    : '';
  const trackURL = carrierTrackingURL(y.tracking);
  const trackLink = trackURL
    ? `<a class="btn btn-ghost btn-sm" href="${esc(trackURL)}" target="_blank" rel="noopener" title="Open this tracking number on the carrier's site">${SVG.external}<span>Track</span></a>`
    : '';
  return `<div class="arrival-row" data-arr="${y.id}">${thumbHTML(y, 'arrival-thumb')}` +
    `<div class="arrival-main">` +
      `<div class="arrival-name">${esc(y.brand)} ${esc(y.model)}</div>` +
      `<div class="arrival-sub">${esc(sub)}</div>` +
      `<div class="arrival-edit">` +
        `<input class="arr-field arr-track" data-track-input="${y.id}" value="${esc(y.tracking || '')}" placeholder="Tracking number" />` +
        `<input class="arr-field arr-eta" type="date" data-eta-input="${y.id}" value="${toDateInputValue(y.eta)}" />` +
        queryBtn +
        trackLink +
      `</div>` +
    `</div>` +
    `<button class="arrival-mark" data-arrived="${y.id}" title="Mark as in hand">${SVG.check}<span>Arrived</span></button></div>`;
}
// Look up a yoyo's ETA from the carrier (UPS/USPS/FedEx) using its tracking number.
async function queryTracking(id, btn) {
  const y = yoyos.find((x) => x.id === id);
  const tn = (y?.tracking || '').trim();
  if (!tn) { toast('Add a tracking number first.', 'error'); return; }
  const orig = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Querying…';
  try {
    const r = await api('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracking: tn }),
    });
    if (r.eta) {
      await patchYoyo(id, { eta: r.eta });
      await loadAll(); // re-renders Arrivals so the row lands on the new date
      toast(`${(r.carrier || 'Carrier').toUpperCase()}: arrives ${r.eta}${r.delivered ? ' (delivered)' : ''}.`, 'ok');
    } else {
      btn.disabled = false; btn.innerHTML = orig;
      toast(`No ETA available yet${r.status ? ` — ${r.status}` : ''}.`);
    }
  } catch (err) {
    btn.disabled = false; btn.innerHTML = orig;
    toast(err.message || 'Tracking lookup failed.', 'error');
  }
}
// Renders the Arrivals view: month calendar (with a dot on days that have an
// arrival), plus a list for the selected day or all upcoming arrivals, and a
// separate "no date yet" section.
function renderArrivals() {
  const wrap = $('#viewArrivals');
  if (!canEditState) { wrap.innerHTML = `<div class="insight-note">${SVG.lock}<span>Log in to track incoming yoyos.</span></div>`; return; }
  const groups = arrivalGroups();
  const monthDays = new Set(groups
    .filter((g) => g.day.getMonth() === calMonth.getMonth() && g.day.getFullYear() === calMonth.getFullYear())
    .map((g) => g.day.getDate()));

  const lead = firstOfMonth(calMonth).getDay();
  const dim = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate();
  const today = new Date();
  let cells = '';
  for (let i = 0; i < lead; i++) cells += `<div class="cal-day empty"></div>`;
  for (let d = 1; d <= dim; d++) {
    const date = new Date(calMonth.getFullYear(), calMonth.getMonth(), d);
    const cls = [sameDay(date, today) ? 'today' : '', (calSelected && sameDay(date, calSelected)) ? 'selected' : ''].join(' ').trim();
    const dot = monthDays.has(d) ? '<span class="cal-dot"></span>' : '';
    cells += `<button class="cal-day ${cls}" data-day="${d}"><span>${d}</span>${dot}</button>`;
  }
  const weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w) => `<div class="cal-weekday">${w}</div>`).join('');
  const monthTitle = calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  let listHTML;
  if (calSelected) {
    const g = groups.find((gr) => sameDay(gr.day, calSelected));
    const head = calSelected.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    listHTML = `<div class="arrivals-block"><h3>${esc(head)}</h3>` +
      (g ? g.items.map((y) => arrivalRow(y, relativeETA(g.day))).join('') : '<p class="hint">No arrivals this day.</p>') + `</div>`;
  } else {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const upcoming = groups.filter((g) => g.day.getTime() >= start);
    listHTML = `<div class="arrivals-block"><h3>Upcoming arrivals</h3>` +
      (upcoming.length ? upcoming.flatMap((g) => g.items.map((y) => arrivalRow(y, relativeETA(g.day)))).join('') : '<p class="hint">Nothing scheduled.</p>') + `</div>`;
  }
  const nd = yoyos.filter((y) => !y.in_hand && !parseETA(y.eta));
  const ndHTML = nd.length ? `<div class="arrivals-block"><h3>On order · no date</h3>` + nd.map((y) => arrivalRow(y, 'Awaiting ship date')).join('') + `</div>` : '';

  wrap.innerHTML =
    `<div class="cal-card">
      <div class="cal-head"><button class="cal-nav" data-cal="-1">‹</button><span class="cal-title">${esc(monthTitle)}</span><button class="cal-nav" data-cal="1">›</button></div>
      <div class="cal-weekdays">${weekdays}</div>
      <div class="cal-grid">${cells}</div>
    </div>${listHTML}${ndHTML}`;

  wrap.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + Number(b.dataset.cal), 1);
    renderArrivals();
  }));
  wrap.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
    const date = new Date(calMonth.getFullYear(), calMonth.getMonth(), Number(b.dataset.day));
    calSelected = (calSelected && sameDay(calSelected, date)) ? null : date;
    renderArrivals();
  }));
  wrap.querySelectorAll('.arrival-row[data-arr]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-arrived]') || e.target.closest('.arrival-edit')) return;
    openDetail(Number(el.dataset.arr));
  }));
  // Inline edit: save tracking on blur (keep memory in sync, no full re-render).
  wrap.querySelectorAll('[data-track-input]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const id = Number(inp.dataset.trackInput);
      const val = inp.value.trim();
      const y = yoyos.find((x) => x.id === id); if (y) y.tracking = val;
      try { await patchYoyo(id, { tracking: val }); }
      catch (err) { toast(err.message, 'error'); }
    });
  });
  // Inline edit: save ETA, then reload so the calendar/groups reflect the new date.
  wrap.querySelectorAll('[data-eta-input]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const id = Number(inp.dataset.etaInput);
      try { await patchYoyo(id, { eta: inp.value }); await loadAll(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });
  wrap.querySelectorAll('[data-track-query]').forEach((btn) =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); queryTracking(Number(btn.dataset.trackQuery), btn); })
  );
  wrap.querySelectorAll('[data-arrived]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = Number(b.dataset.arrived);
    try { await patchYoyo(id, { in_hand: true }); await loadAll(); toast('Marked in hand.', 'ok'); }
    catch (err) { toast(err.message, 'error'); }
  }));
}

// ============================================================
//  For Sale (public marketplace of items listed for sale / trade)
// ============================================================
const FOR_SALE_STATUSES = new Set(['For Sale', 'For Trade', 'For Sale or Trade']);
function isForSale(status) { return FOR_SALE_STATUSES.has(String(status || '').trim()); }
function saleBadgeClass(status) {
  return status === 'For Trade' ? 'trade' : status === 'For Sale or Trade' ? 'both' : 'sale';
}
// Builds one card for the public For Sale grid: photo, sale-status badge, and
// price (or "Open to trade" when there's no asking price).
function saleCardHTML(y) {
  const thumb = y.photos[0]
    ? `<img src="${esc(y.photos[0].thumbUrl || y.photos[0].url)}" alt="${esc(y.model)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${esc(y.photos[0].url)}'" />`
    : '<span class="placeholder"></span>';
  const price = y.sale_price != null && y.sale_price !== '' ? money(y.sale_price) : '';
  const wantsTrade = y.sale_status !== 'For Sale'; // Trade or Both
  const priceLine = price
    ? `<div class="sale-price">${price}${wantsTrade ? ' <span class="sale-or">or trade</span>' : ''}</div>`
    : `<div class="sale-price">${wantsTrade ? 'Open to trade' : '—'}</div>`;
  const sub = [y.color, y.condition].filter(Boolean).map(esc).join(' · ');
  return `<article class="sale-card" data-id="${y.id}" role="button" tabindex="0" aria-label="${esc(y.brand)} ${esc(y.model)}">
      <div class="sale-photo">${thumb}<span class="sale-badge ${saleBadgeClass(y.sale_status)}">${esc(y.sale_status)}</span></div>
      <div class="sale-body">
        <div class="sale-brand">${esc(y.brand)}</div>
        <div class="sale-model">${esc(y.model)}</div>
        ${sub ? `<div class="sale-sub">${sub}</div>` : ''}
        ${priceLine}
      </div>
    </article>`;
}
// Fetches the site-wide settings (currently just the For Sale shipping notes).
async function loadSettings() {
  try { const s = await api('/api/settings'); saleNotes = s.sale_notes || ''; }
  catch { saleNotes = ''; }
}
// Notes block: an editable textarea for the owner (not in demo), read-only text
// for visitors. Only renders for visitors when there's something to show.
function saleNotesHTML() {
  if (canEditState && !demoModeState) {
    return `<div class="sale-notes-edit">
        <label for="saleNotesInput">Shipping &amp; sale notes <span class="muted-sm">(shown to buyers)</span></label>
        <textarea id="saleNotesInput" rows="3" placeholder="e.g. Ships from US · buyer pays shipping · PayPal G&amp;S · DM to buy…">${esc(saleNotes)}</textarea>
        <div><button type="button" id="saveSaleNotes" class="btn btn-primary btn-sm">Save notes</button></div>
      </div>`;
  }
  return saleNotes ? `<div class="sale-notes">${esc(saleNotes).replace(/\n/g, '<br>')}</div>` : '';
}
function wireSaleNotesSave() {
  const saveBtn = $('#saveSaleNotes');
  if (!saveBtn) return;
  saveBtn.addEventListener('click', async () => {
    const val = $('#saleNotesInput').value;
    saveBtn.disabled = true;
    try {
      await api('/api/settings/sale_notes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: val }) });
      saleNotes = val;
      toast('Notes saved.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
    saveBtn.disabled = false;
  });
}

// ---- Seller tools (owner-only: bulk actions, sort/filter/views, listing text) ----
// Independent of the Collection tab's `filters`/`selectMode` so browsing one
// page never disturbs the other's state.
let saleView = loadSaleView();
function loadSaleView() {
  const defaults = { mode: 'tile', sort: 'listed', sortDir: 'desc', status: '', q: '' };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('yoyoSaleView') || '{}') }; }
  catch { return defaults; }
}
function saveSaleView() { try { localStorage.setItem('yoyoSaleView', JSON.stringify(saleView)); } catch { /* ignore */ } }
let saleSelectMode = false;
const saleSelectedIds = new Set();

// Days since a listing first went live (sale_listed_at is stamped server-side
// — see server.js — the moment sale_status first becomes a for-sale value).
// Null when never listed or the timestamp predates this feature.
function daysListed(y) {
  if (!y.sale_listed_at) return null;
  const ms = Date.now() - new Date(y.sale_listed_at).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
const STALE_DAYS = 30; // flagged in the UI as a candidate for a price drop

function saleFilteredSorted() {
  let list = yoyos.filter((y) => isForSale(y.sale_status));
  const q = saleView.q.trim().toLowerCase();
  if (q) list = list.filter((y) => [y.brand, y.model, y.color, y.composition].join(' ').toLowerCase().includes(q));
  if (saleView.status) list = list.filter((y) => y.sale_status === saleView.status);
  const flip = saleView.sortDir === 'desc' ? -1 : 1;
  list.sort((a, b) => {
    let r;
    switch (saleView.sort) {
      case 'price': r = (a.sale_price ?? -1) - (b.sale_price ?? -1); break;
      case 'listed': r = (daysListed(a) ?? -1) - (daysListed(b) ?? -1); break;
      case 'model': r = String(a.model || '').localeCompare(String(b.model || '')); break;
      default: r = String(a.brand || '').localeCompare(String(b.brand || ''));
    }
    if (r === 0) r = String(a.brand || '').localeCompare(String(b.brand || ''));
    return r * flip;
  });
  return list;
}

// A copy-paste-ready block for one listing: title, specs, price, description.
function listingText(y) {
  const lines = [`${y.brand} ${y.model}`.trim()];
  const specs = [y.color, y.composition, y.condition].filter(Boolean).join(' · ');
  if (specs) lines.push(specs);
  const dims = [y.weight_g ? `${y.weight_g}g` : null, y.diameter_mm ? `${y.diameter_mm}mm` : null].filter(Boolean).join(' / ');
  if (dims) lines.push(dims);
  const wantsTrade = y.sale_status !== 'For Sale';
  lines.push(y.sale_price != null
    ? `${money(y.sale_price)}${wantsTrade ? ' (or trade)' : ''}`
    : (wantsTrade ? 'Open to trade' : 'Price: ask'));
  if (y.description) lines.push(y.description.trim());
  return lines.join('\n');
}
async function copyListingText(ids) {
  const items = ids.map((id) => yoyos.find((y) => y.id === id)).filter(Boolean);
  if (!items.length) return false;
  const text = items.map(listingText).join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied listing text for ${items.length} yoyo${items.length === 1 ? '' : 's'}.`, 'ok');
    return true;
  } catch {
    toast('Could not copy to clipboard.', 'error');
    return false;
  }
}

function saleStatsHTML(items) {
  const withPrice = items.filter((y) => y.sale_price != null);
  const total = withPrice.reduce((s, y) => s + y.sale_price, 0);
  const days = items.map(daysListed).filter((d) => d != null);
  const avgDays = days.length ? Math.round(days.reduce((s, d) => s + d, 0) / days.length) : null;
  const stale = items.filter((y) => (daysListed(y) ?? -1) >= STALE_DAYS).length;
  return `
    <div class="stat-card"><div class="stat-num">${items.length}</div><div class="stat-label">Listed</div></div>
    <div class="stat-card"><div class="stat-num">${money0(total)}</div><div class="stat-label">Total asking</div></div>
    ${avgDays != null ? `<div class="stat-card"><div class="stat-num">${avgDays}d</div><div class="stat-label">Avg days listed</div></div>` : ''}
    ${items.length - withPrice.length ? `<div class="stat-card"><div class="stat-num">${items.length - withPrice.length}</div><div class="stat-label">No price set</div></div>` : ''}
    ${stale ? `<div class="stat-card filtered"><div class="stat-num">${stale}</div><div class="stat-label">Stale (${STALE_DAYS}+ days)</div></div>` : ''}`;
}

function saleDaysBadge(y) {
  const d = daysListed(y);
  if (d == null) return '';
  const stale = d >= STALE_DAYS;
  // Stale carries a glyph + title, not just a color — color alone isn't a
  // signal everyone can read, and the tooltip explains what the pill means.
  return `<span class="sale-days ${stale ? 'stale' : ''}" title="Listed ${d} day${d === 1 ? '' : 's'}${stale ? ' — stale' : ''}" aria-label="Listed ${d} days${stale ? ', stale' : ''}">${stale ? '⚠ ' : ''}${d}d</span>`;
}
// Selection checkbox markup shared by the three owner sale views. Always
// visible (matching the Collection tab's always-visible checkboxes) — the
// first click on one enters selection mode implicitly, so bulk actions are
// discoverable without hunting for the Bulk edit button first. Real checkbox
// semantics (role/aria-checked/tabindex) so it works from the keyboard too.
function saleSelBoxHTML(y) {
  const sel = saleSelectedIds.has(y.id);
  return `<span class="sel-box ${sel ? 'checked' : ''}" data-sale-sel="${y.id}" role="checkbox" aria-checked="${sel}" tabindex="0" aria-label="Select ${esc(y.brand)} ${esc(y.model)}"></span>`;
}
function ownerSaleCardHTML(y) {
  const thumb = y.photos[0]
    ? `<img src="${esc(y.photos[0].thumbUrl || y.photos[0].url)}" alt="${esc(y.model)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${esc(y.photos[0].url)}'" />`
    : '<span class="placeholder"></span>';
  const wantsTrade = y.sale_status !== 'For Sale';
  const price = y.sale_price != null ? money(y.sale_price) : (wantsTrade ? 'Open to trade' : 'No price set');
  const selBox = saleSelBoxHTML(y);
  return `<article class="sale-card${saleSelectedIds.has(y.id) ? ' selected' : ''}" data-id="${y.id}">
      <div class="sale-photo">${thumb}<span class="sale-badge ${saleBadgeClass(y.sale_status)}">${esc(y.sale_status)}</span>${saleDaysBadge(y)}${selBox}</div>
      <div class="sale-body">
        <div class="sale-brand">${esc(y.brand)}</div>
        <div class="sale-model">${esc(y.model)}</div>
        <div class="sale-price">${price}</div>
        <button type="button" class="btn btn-ghost btn-sm sale-copy-btn" data-copy="${y.id}">Copy listing text</button>
      </div>
    </article>`;
}
function ownerSaleRowsHTML(items) {
  const rows = items.map((y) => {
    const thumb = y.photos[0]
      ? `<img class="row-thumb" src="${esc(y.photos[0].thumbUrl || y.photos[0].url)}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${esc(y.photos[0].url)}'" />`
      : '<span class="row-thumb placeholder"></span>';
    const selCell = saleSelBoxHTML(y);
    const d = daysListed(y);
    const staleR = d != null && d >= STALE_DAYS;
    return `<div class="sale-row${saleSelectedIds.has(y.id) ? ' selected' : ''}" data-id="${y.id}">
        ${selCell}${thumb}
        <div class="sale-row-main">
          <div class="sale-row-name">${esc(y.brand)} ${esc(y.model)}</div>
          <div class="sale-row-sub"><span class="sale-editable" data-edit="sale_status">${esc(y.sale_status)}</span>${d != null ? ` · <span class="${staleR ? 'stale' : ''}" ${staleR ? `title="Listed ${d} days — stale"` : ''}>${staleR ? '⚠ ' : ''}${d}d listed</span>` : ''}</div>
        </div>
        <div class="sale-row-price sale-editable" data-edit="sale_price">${y.sale_price != null ? money(y.sale_price) : '—'}</div>
        <button type="button" class="btn btn-ghost btn-sm sale-copy-btn" data-copy="${y.id}">Copy</button>
      </div>`;
  }).join('');
  return `<div class="sale-rows">${rows}</div>`;
}
function ownerSaleTableHTML(items) {
  const arrow = (key) => (saleView.sort === key ? (saleView.sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const th = (key, label, extra = '') => `<th class="sortable ${extra} ${saleView.sort === key ? 'sorted' : ''}" data-sale-sort="${key}">${esc(label)}${arrow(key)}</th>`;
  const head = '<th class="col-sel"></th>' +
    '<th class="col-photo"></th>' + th('brand', 'Brand') + th('model', 'Model') +
    '<th>Status</th>' + th('price', 'Price', 'num') + th('listed', 'Days listed', 'num') + '<th></th>';
  const rows = items.map((y) => {
    const thumb = y.photos[0]
      ? `<img class="row-thumb" src="${esc(y.photos[0].thumbUrl || y.photos[0].url)}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${esc(y.photos[0].url)}'" />`
      : '<span class="row-thumb placeholder"></span>';
    const selCell = `<td class="col-sel">${saleSelBoxHTML(y)}</td>`;
    const d = daysListed(y);
    const staleT = d != null && d >= STALE_DAYS;
    return `<tr data-id="${y.id}" class="${saleSelectedIds.has(y.id) ? 'selected' : ''}">
        ${selCell}<td class="col-photo">${thumb}</td>
        <td>${esc(y.brand)}</td><td>${esc(y.model)}</td>
        <td class="sale-editable" data-edit="sale_status">${esc(y.sale_status)}</td>
        <td class="num sale-editable" data-edit="sale_price">${y.sale_price != null ? money(y.sale_price) : '—'}</td>
        <td class="num${staleT ? ' stale' : ''}" ${staleT ? `title="Listed ${d} days — stale"` : ''}>${d != null ? `${staleT ? '⚠ ' : ''}${d}d` : '—'}</td>
        <td><button type="button" class="btn btn-ghost btn-sm sale-copy-btn" data-copy="${y.id}">Copy</button></td>
      </tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function setSaleSelectMode(on) {
  saleSelectMode = on;
  if (!on) saleSelectedIds.clear();
  syncSaleControls();
  renderSaleBody();
}
function toggleSaleSelect(id) {
  // Checking a box outside selection mode enters it implicitly — the boxes
  // are always visible, so the first click IS the intent to bulk-edit.
  if (!saleSelectMode) { saleSelectMode = true; syncSaleControls(); }
  if (saleSelectedIds.has(id)) saleSelectedIds.delete(id); else saleSelectedIds.add(id);
  const hadFocus = document.activeElement?.dataset?.saleSel != null;
  renderSaleBody();
  // The re-render replaced the DOM node that had keyboard focus — put focus
  // back on the same checkbox so arrowing/tabbing through the list survives.
  if (hadFocus) document.querySelector(`.sel-box[data-sale-sel="${id}"]`)?.focus();
}
function renderSaleSelectionBar() {
  let bar = $('#saleSelectionBar');
  if (!saleSelectMode) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'saleSelectionBar'; bar.className = 'selection-bar'; document.body.appendChild(bar); }
  const n = saleSelectedIds.size;
  bar.innerHTML =
    `<span class="sel-count" aria-live="polite">${n} selected</span>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-act="all">Select all</button>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-act="none" ${n ? '' : 'disabled'}>Clear</button>` +
    `<span class="spacer"></span>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-act="price" ${n ? '' : 'disabled'}>Adjust price…</button>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-act="status" ${n ? '' : 'disabled'}>Change status…</button>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-act="copy" ${n ? '' : 'disabled'}>Copy listing text</button>` +
    `<button type="button" class="btn btn-danger btn-sm" data-act="del" ${n ? '' : 'disabled'}>Delete</button>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-act="done">Done</button>`;
  bar.querySelector('[data-act="all"]').onclick = () => { saleFilteredSorted().forEach((y) => saleSelectedIds.add(y.id)); renderSaleBody(); };
  bar.querySelector('[data-act="none"]').onclick = () => { saleSelectedIds.clear(); renderSaleBody(); };
  bar.querySelector('[data-act="price"]').onclick = () => openSaleDiscountDialog([...saleSelectedIds]);
  bar.querySelector('[data-act="status"]').onclick = () => openSaleStatusDialog([...saleSelectedIds]);
  bar.querySelector('[data-act="copy"]').onclick = () => copyListingText([...saleSelectedIds]);
  bar.querySelector('[data-act="del"]').onclick = () => bulkDeleteSale([...saleSelectedIds]);
  bar.querySelector('[data-act="done"]').onclick = () => setSaleSelectMode(false);
}
async function bulkDeleteSale(ids) {
  if (!ids.length || demoGuard()) return;
  if (!await confirmDialog({
    title: `Delete ${ids.length} yoyo${ids.length === 1 ? '' : 's'}?`,
    message: 'This removes them and their photos. This can’t be undone.', confirmText: 'Delete', danger: true,
  })) return;
  let ok = 0;
  for (const id of ids) { try { await api(`/api/yoyos/${id}`, { method: 'DELETE' }); ok++; } catch { /* keep going */ } }
  setSaleSelectMode(false);
  await loadAll();
  toast(`Deleted ${ok} yoyo${ok === 1 ? '' : 's'}.`, 'ok');
}

// Simple modal scaffold shared by the two bulk dialogs below (mirrors openBulkEdit's pattern).
// Keyboard-complete: first field autofocused, Enter applies, Escape cancels.
function saleDialog(titleHTML, bodyHTML, onApply) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  const card = document.createElement('div');
  card.className = 'modal-card modal-sm';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', String(titleHTML).replace(/<[^>]*>/g, ''));
  card.innerHTML =
    `<div class="modal-head"><h2>${titleHTML}</h2></div>` +
    `<div class="form"><div class="form-section">${bodyHTML}</div></div>` +
    `<div class="modal-foot"><span class="spacer"></span><button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button><button type="button" class="btn btn-primary" data-act="apply">Apply</button></div>`;
  const bd = document.createElement('div'); bd.className = 'modal-backdrop';
  overlay.appendChild(bd); overlay.appendChild(card); document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.dataset?.act !== 'cancel') {
      e.preventDefault(); onApply(card, close);
    }
  };
  document.addEventListener('keydown', onKey, true);
  bd.onclick = close;
  card.querySelector('[data-act="cancel"]').onclick = close;
  card.querySelector('[data-act="apply"]').onclick = () => onApply(card, close);
  card.querySelector('input, select')?.focus();
  return card;
}
function openSaleDiscountDialog(ids) {
  if (!ids.length || demoGuard()) return;
  saleDialog(
    `Adjust price for ${ids.length} yoyo${ids.length === 1 ? '' : 's'}`,
    `<div class="be-row"><label>Action</label><select id="discAction">` +
      `<option value="pct-off-current">% off current price</option>` +
      `<option value="pct-off-retail">% off retail</option>` +
      `<option value="fixed">Set fixed price</option></select></div>` +
    `<div class="be-row"><label>Value</label><input type="number" id="discValue" step="0.01" placeholder="e.g. 10" /></div>` +
    `<p class="hint">"% off retail" only applies to items with a retail price on file; others are skipped.</p>`,
    async (card, close) => {
      const action = card.querySelector('#discAction').value;
      const val = Number(card.querySelector('#discValue').value);
      const validPct = action !== 'fixed' && val >= 0 && val <= 100;
      const validFixed = action === 'fixed' && val >= 0;
      if (!isFinite(val) || (!validPct && !validFixed)) {
        toast(action === 'fixed' ? 'Enter a valid price.' : 'Enter a percentage between 0 and 100.', 'error');
        return;
      }
      close();
      let ok = 0, skip = 0;
      for (const id of ids) {
        const y = yoyos.find((x) => x.id === id);
        if (!y) { skip++; continue; }
        let newPrice;
        if (action === 'fixed') newPrice = val;
        else if (action === 'pct-off-current') {
          if (y.sale_price == null) { skip++; continue; }
          newPrice = Math.round(y.sale_price * (1 - val / 100) * 100) / 100;
        } else {
          if (y.retail == null) { skip++; continue; }
          newPrice = Math.round(y.retail * (1 - val / 100) * 100) / 100;
        }
        try { await patchYoyo(id, { sale_price: newPrice }); ok++; } catch { skip++; }
      }
      setSaleSelectMode(false);
      await loadAll();
      toast(`Updated price on ${ok} yoyo${ok === 1 ? '' : 's'}${skip ? `, skipped ${skip}` : ''}.`, skip ? 'error' : 'ok');
    },
  );
}
function openSaleStatusDialog(ids) {
  if (!ids.length || demoGuard()) return;
  saleDialog(
    `Change status for ${ids.length} yoyo${ids.length === 1 ? '' : 's'}`,
    `<div class="be-row"><label>New status</label><select id="statusNew">` +
      `<option value="For Sale">For Sale</option>` +
      `<option value="For Trade">For Trade</option>` +
      `<option value="For Sale or Trade">For Sale or Trade</option>` +
      `<option value="Sold">Sold</option>` +
      `<option value="">Unlist (not for sale)</option></select></div>`,
    async (card, close) => {
      const status = card.querySelector('#statusNew').value;
      close();
      const changes = { sale_status: status };
      if (status === 'Sold') changes.sold_date = new Date().toISOString().slice(0, 10);
      let ok = 0, fail = 0;
      for (const id of ids) { try { await patchYoyo(id, changes); ok++; } catch { fail++; } }
      setSaleSelectMode(false);
      await loadAll();
      toast(`Updated ${ok} yoyo${ok === 1 ? '' : 's'}${fail ? `, ${fail} failed` : ''}.`, fail ? 'error' : 'ok');
    },
  );
}

// Syncs the persistent toolbar controls' visible state from `saleView` — called
// after any interaction, never rebuilds the controls themselves (they're static
// markup in index.html) so focus/cursor position in the search box survives
// every re-render.
function syncSaleControls() {
  $('#saleStats').classList.toggle('hidden', !canEditState);
  $('#saleControls').classList.toggle('hidden', !canEditState);
  if (!canEditState) return;
  $('#saleSearch').value = saleView.q;
  $('#saleStatusFilter').value = saleView.status;
  $('#saleSort').value = saleView.sort;
  $('#saleSortDir').textContent = saleView.sortDir === 'asc' ? '↑' : '↓';
  document.querySelectorAll('#saleViewSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.saleView === saleView.mode));
  $('#saleSelectBtn').classList.toggle('active', saleSelectMode);
}
// Re-renders just the stats + item list + selection bar (never the toolbar
// itself) — the function every seller-tools interaction calls.
function renderSaleBody() {
  const body = $('#saleBody');
  if (!canEditState) {
    const items = yoyos.filter((y) => isForSale(y.sale_status))
      .sort((a, b) => String(a.brand || '').localeCompare(String(b.brand || '')) || String(a.model || '').localeCompare(String(b.model || '')));
    body.innerHTML = items.length
      ? `<p class="sale-intro">${items.length} yoyo${items.length === 1 ? '' : 's'} available — tap any for full specs and photos.</p>`
        + `<div class="sale-grid">${items.map(saleCardHTML).join('')}</div>`
      : '<div class="insight-note">Nothing listed for sale or trade right now — check back soon.</div>';
    const publicList = items.map((y) => y.id);
    body.querySelectorAll('.sale-card[data-id]').forEach((el) => {
      const id = Number(el.dataset.id);
      el.addEventListener('click', () => openDetail(id, publicList));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(id, publicList); } });
    });
    return;
  }

  const items = saleFilteredSorted();
  $('#saleStats').innerHTML = saleStatsHTML(items);
  if (!yoyos.some((y) => isForSale(y.sale_status))) {
    body.innerHTML = '<div class="insight-note">Nothing listed yet. Mark a yoyo For Sale or For Trade to see it here.</div>';
  } else if (!items.length) {
    body.innerHTML = '<div class="insight-note">No listings match your search/filter.</div>';
  } else if (saleView.mode === 'row') {
    body.innerHTML = ownerSaleRowsHTML(items);
  } else if (saleView.mode === 'table') {
    body.innerHTML = ownerSaleTableHTML(items);
  } else {
    body.innerHTML = `<div class="sale-grid">${items.map(ownerSaleCardHTML).join('')}</div>`;
  }
  body.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!await copyListingText([Number(btn.dataset.copy)])) return;
    // Feedback right where the eye already is, not just in the far-corner toast.
    const prev = btn.textContent;
    btn.textContent = '✓ Copied';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200);
  }));
  const saleList = items.map((y) => y.id);
  body.querySelectorAll('.sale-card[data-id], .sale-row[data-id], tr[data-id]').forEach((el) => {
    const id = Number(el.dataset.id);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.cell-editor')) return;
      if (e.target.closest('[data-copy], .sel-box')) return;
      if (saleSelectMode) { toggleSaleSelect(id); return; }
      // Price/status quick-edit (List and Table only — Grid cards carry no
      // .sale-editable elements, so this is a no-op there and falls through below).
      const editEl = e.target.closest('.sale-editable');
      if (editEl) { startCellEdit(editEl, id, editEl.dataset.edit); return; }
      openDetail(id, saleList);
    });
  });
  body.querySelectorAll('.sel-box[data-sale-sel]').forEach((box) => {
    box.addEventListener('click', (e) => { e.stopPropagation(); toggleSaleSelect(Number(box.dataset.saleSel)); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleSaleSelect(Number(box.dataset.saleSel)); }
    });
  });
  body.querySelectorAll('[data-sale-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.saleSort;
    if (saleView.sort === key) saleView.sortDir = saleView.sortDir === 'asc' ? 'desc' : 'asc';
    else { saleView.sort = key; saleView.sortDir = 'asc'; }
    saveSaleView(); syncSaleControls(); renderSaleBody();
  }));
  renderSaleSelectionBar();
}
// One-time wiring for the persistent toolbar controls (mirrors the top-level
// `$('#search').addEventListener(...)` pattern for the Collection tab) — see
// the bottom of this file where it's invoked alongside that.
function wireSaleControlsOnce() {
  $('#saleSearch').addEventListener('input', (e) => { saleView.q = e.target.value; saveSaleView(); renderSaleBody(); });
  $('#saleStatusFilter').addEventListener('change', (e) => { saleView.status = e.target.value; saveSaleView(); renderSaleBody(); });
  $('#saleSort').addEventListener('change', (e) => { saleView.sort = e.target.value; saveSaleView(); renderSaleBody(); syncSaleControls(); });
  $('#saleSortDir').addEventListener('click', () => { saleView.sortDir = saleView.sortDir === 'asc' ? 'desc' : 'asc'; saveSaleView(); syncSaleControls(); renderSaleBody(); });
  document.querySelectorAll('#saleViewSeg .seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    saleView.mode = btn.dataset.saleView; saveSaleView(); syncSaleControls(); renderSaleBody();
  }));
  $('#saleSelectBtn').addEventListener('click', () => setSaleSelectMode(!saleSelectMode));
}
// Renders the For Sale page: shipping/sale notes, then either the public
// storefront grid (visitors) or the full seller toolset (owner) — see
// renderSaleBody() for the item list itself; this handles the toolbar/notes
// and is only called on tab switch / full data reload, never per-keystroke.
function renderSale() {
  $('#saleNotesWrap').innerHTML = saleNotesHTML();
  wireSaleNotesSave();
  syncSaleControls();
  renderSaleBody();
}

// ============================================================
//  Sold (owner-only history of completed sales/trades)
// ============================================================
// How much a completed sale actually brought in. A trade takes precedence
// over an asking price left over from when the yoyo was listed — a yoyo
// can't be both a cash sale and a trade.
function recoveredAmount(y) {
  if (y.sale_status !== 'Sold') return 0;
  return y.trade_value != null ? y.trade_value : (y.sale_price != null ? y.sale_price : 0);
}
// Profit/loss on a completed sale: proceeds minus what was paid. Null when
// the original cost is unknown (can't compute a real P&L without it).
function saleNet(y) {
  if (y.sale_status !== 'Sold' || y.paid == null) return null;
  return recoveredAmount(y) - y.paid;
}
// One row in the Sold list: photo, sold date/buyer, and either the cash
// amount or the trade's valuation.
function soldCardHTML(y) {
  const thumb = y.photos[0]
    ? `<img src="${esc(y.photos[0].thumbUrl || y.photos[0].url)}" alt="${esc(y.model)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${esc(y.photos[0].url)}'" />`
    : '<span class="placeholder"></span>';
  const isTrade = y.trade_value != null;
  const amount = recoveredAmount(y);
  const net = saleNet(y);
  // Economics line: paid → proceeds with the net colored by sign, or just the
  // proceeds when the original cost was never recorded.
  let priceLine;
  if (net != null) {
    const netTxt = `${net >= 0 ? '+' : '−'}${money0(Math.abs(net))}`;
    priceLine = `<div class="sale-price">${money0(y.paid)} → ${money0(amount)}`
      + ` <span class="sale-net ${net >= 0 ? 'pos' : 'neg'}">${netTxt}</span></div>`;
  } else if (amount > 0) {
    priceLine = `<div class="sale-price">${money(amount)} <span class="sale-or">cost unknown</span></div>`;
  } else {
    priceLine = `<div class="sale-price">${isTrade ? 'Traded' : '—'}</div>`;
  }
  const sub = [y.sold_date, y.buyer].filter(Boolean).join(' · ');
  return `<article class="sale-card" data-id="${y.id}" role="button" tabindex="0" aria-label="${esc(y.brand)} ${esc(y.model)}">
      <div class="sale-photo">${thumb}<span class="sale-badge ${isTrade ? 'trade' : 'sale'}">${isTrade ? 'Traded' : 'Sold'}</span></div>
      <div class="sale-body">
        <div class="sale-brand">${esc(y.brand)}</div>
        <div class="sale-model">${esc(y.model)}</div>
        ${sub ? `<div class="sale-sub">${esc(sub)}</div>` : ''}
        ${priceLine}
      </div>
    </article>`;
}
// Renders the owner-only Sold view: every yoyo marked Sold, most recent
// first, with a ledger in logical order — how many sold, what they brought
// in, what they cost, and the net profit/loss (only over sales whose cost
// is known, noted when that's a subset).
function renderSold() {
  const wrap = $('#viewSold');
  const items = yoyos.filter(isSold)
    .sort((a, b) => String(b.sold_date || '').localeCompare(String(a.sold_date || '')));
  const proceeds = items.reduce((a, y) => a + recoveredAmount(y), 0);
  const withCost = items.filter((y) => y.paid != null);
  const cost = withCost.reduce((a, y) => a + y.paid, 0);
  const net = withCost.reduce((a, y) => a + saleNet(y), 0);
  const netTxt = `${net >= 0 ? '+' : '−'}${money0(Math.abs(net))}`;
  const netLabel = withCost.length === items.length ? 'Net' : `Net (${withCost.length} with cost)`;
  const summary = `<div class="metrics-grid sold-summary">`
    + metricCard(String(items.length), 'Sold')
    + metricCard(money0(proceeds), 'Proceeds', 'green')
    + metricCard(money0(cost), 'Cost')
    + metricCard(netTxt, netLabel, net >= 0 ? 'green' : 'red')
    + `</div>`;
  const body = items.length
    ? summary + `<div class="sale-grid">${items.map(soldCardHTML).join('')}</div>`
    : '<div class="insight-note">Nothing marked as sold yet.</div>';
  wrap.innerHTML = body;
  const soldList = items.map((y) => y.id);
  wrap.querySelectorAll('.sale-card[data-id]').forEach((el) => {
    const id = Number(el.dataset.id);
    el.addEventListener('click', () => openDetail(id, soldList));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(id, soldList); } });
  });
}

// ============================================================
//  Insights (metrics, standouts, charts)
// ============================================================
function maxBy(arr, key) { let best = null; for (const y of arr) { const v = y[key]; if (v == null) continue; if (!best || v > best[key]) best = y; } return best; }
function minBy(arr, key) { let best = null; for (const y of arr) { const v = y[key]; if (v == null) continue; if (!best || v < best[key]) best = y; } return best; }
// Counts occurrences of `key` across `arr` and returns the top `n`, most-common first.
function tallyTop(arr, key, n) {
  const m = {};
  for (const y of arr) { const k = y[key]; if (!k) continue; m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, n);
}
// Total `paid` per brand, top `n` by spend descending — for the Insights "Spend by brand" chart.
function spendByBrand(n) {
  const m = {};
  for (const y of yoyos) { if (y.paid == null || !y.brand) continue; m[y.brand] = (m[y.brand] || 0) + y.paid; }
  return Object.entries(m).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount).slice(0, n);
}
// Yoyo counts by composition (bi/mono/tri-metal) across the owned collection,
// omitting compositions with none.
function compositionTally() {
  const labels = { BI: 'Bi-metal', MN: 'Mono-metal', TRI: 'Tri-metal' };
  const owned = ownedYoyos();
  return ['BI', 'MN', 'TRI'].map((c) => ({ name: labels[c], count: owned.filter((y) => y.composition === c).length })).filter((t) => t.count > 0);
}
function metricCard(value, label, cls = '') {
  return `<div class="metric-card"><div class="metric-value ${cls}">${esc(value)}</div><div class="metric-label">${esc(label)}</div></div>`;
}
function insightCard(title, inner) { return inner ? `<div class="insight-card"><h3>${esc(title)}</h3>${inner}</div>` : ''; }

// Renders the Insights view: headline metrics, standout yoyos (most valuable,
// best deal, heaviest/lightest), and bar charts. Financial metrics (value,
// spend, savings, best-deal) are owner-only — public viewers see counts only.
function renderInsights() {
  const wrap = $('#viewInsights');
  if (!yoyos.length) { wrap.innerHTML = '<div class="insight-note">Add some yoyos to see insights.</div>'; return; }
  const admin = canEditState;
  // Owned = the active collection. Sold yoyos still count toward lifetime
  // spend (Total paid / Recovered / Net spent) but not collection metrics.
  const owned = ownedYoyos();
  const count = owned.length;
  const inHand = owned.filter((y) => y.in_hand).length;
  const totalRetail = owned.reduce((a, y) => a + (y.retail || 0), 0);
  const totalPaid = yoyos.reduce((a, y) => a + (y.paid || 0), 0);
  const saved = owned.reduce((a, y) => (y.retail != null && y.paid != null) ? a + (y.retail - y.paid) : a, 0);
  const discounts = owned.map((y) => y.percent_off).filter((v) => v != null);
  const avgDiscount = discounts.length ? discounts.reduce((a, b) => a + b, 0) / discounts.length : null;
  const paids = owned.map((y) => y.paid).filter((v) => v != null);
  const avgPaid = paids.length ? paids.reduce((a, b) => a + b, 0) / paids.length : null;
  const soldYoyos = yoyos.filter(isSold);
  const recovered = soldYoyos.reduce((a, y) => a + recoveredAmount(y), 0);
  const netSpent = totalPaid - recovered;
  const nets = soldYoyos.map(saleNet).filter((v) => v != null);
  const totalNet = nets.length ? nets.reduce((a, b) => a + b, 0) : null;

  let metrics = metricCard(String(count), 'Yoyos');
  if (admin) {
    metrics += metricCard(String(inHand), 'In hand');
    metrics += metricCard(String(count - inHand), 'On order');
    metrics += metricCard(money0(totalRetail), 'Collection value', 'accent');
    metrics += metricCard(money0(totalPaid), 'Total paid');
    metrics += metricCard(money0(saved), 'Saved', 'green');
    if (avgDiscount != null) metrics += metricCard(`${Math.round(avgDiscount)}%`, 'Avg discount', 'green');
    if (avgPaid != null) metrics += metricCard(money0(avgPaid), 'Avg paid');
    if (soldYoyos.length) {
      metrics += metricCard(String(soldYoyos.length), 'Sold');
      metrics += metricCard(money0(recovered), 'Recovered', 'green');
      metrics += metricCard(money0(netSpent), 'Net spent');
      if (totalNet != null) {
        metrics += metricCard(`${totalNet >= 0 ? '+' : '−'}${money0(Math.abs(totalNet))}`, 'Sale net',
          totalNet >= 0 ? 'green' : 'red');
      }
    }
  } else {
    metrics += metricCard(String(new Set(owned.map((y) => y.brand).filter(Boolean)).size), 'Brands');
  }

  const standouts = [];
  if (admin) { const y = maxBy(owned, 'retail'); if (y) standouts.push({ icon: SVG.gem, label: 'Most valuable', y, value: money(y.retail) }); }
  if (admin) { const y = maxBy(owned.filter((x) => (x.percent_off || 0) > 0), 'percent_off'); if (y) standouts.push({ icon: SVG.tag, label: 'Best deal', y, value: `${y.percent_off}% off` }); }
  { const y = maxBy(owned, 'weight_g'); if (y) standouts.push({ icon: SVG.scale, label: 'Heaviest', y, value: `${trimNum(y.weight_g)} g` }); }
  { const y = minBy(owned, 'weight_g'); if (y) standouts.push({ icon: SVG.feather, label: 'Lightest', y, value: `${trimNum(y.weight_g)} g` }); }
  const standoutsHTML = standouts.length ? insightCard('Standouts',
    `<div class="standouts">${standouts.map((s) =>
      `<div class="standout-row" data-arr="${s.y.id}"><span class="standout-icon">${s.icon}</span>${thumbHTML(s.y, 'standout-thumb')}` +
      `<div class="standout-main"><div class="standout-label">${esc(s.label)}</div><div class="standout-name">${esc(s.y.brand)} ${esc(s.y.model)}</div></div>` +
      `<span class="standout-value">${esc(s.value)}</span></div>`).join('')}</div>`) : '';

  const brandRows = tallyTop(owned.filter((y) => y.brand), 'brand', 8).map((t) => ({ name: t.name, value: t.count, display: String(t.count) }));
  const brandChart = insightCard('Top brands', barChart(brandRows, 'var(--accent)'));
  let spendChart = '';
  if (admin) {
    const spend = spendByBrand(6).map((t) => ({ name: t.name, value: t.amount, display: money0(t.amount) }));
    spendChart = insightCard('Spend by brand', barChart(spend, 'var(--green)'));
  }
  const comp = compositionTally().map((t) => ({ name: t.name, value: t.count, display: String(t.count) }));
  const compChart = insightCard('Composition', barChart(comp, 'var(--gold)'));

  const note = !admin ? `<div class="insight-note">${SVG.lock}<span>Log in to see value, savings, and spending insights.</span></div>` : '';
  wrap.innerHTML = `<div class="metrics-grid">${metrics}</div>${note}${standoutsHTML}${brandChart}${spendChart}${compChart}`;
  wrap.querySelectorAll('[data-arr]').forEach((el) => el.addEventListener('click', () => openDetail(Number(el.dataset.arr))));
}

// ---- Detail (read-only) modal ----
let detailList = [];
// Opens the read-only detail modal for one yoyo, wiring prev/next navigation
// (within the currently filtered/sorted list), the hero quick-action buttons,
// and chip-click-to-filter. `list` is the ordered array of ids prev/next
// should step through — pass it explicitly from any view whose filter/sort
// isn't Collection's (Sale, Sold, the public storefront), since without it
// this used to silently fall back to Collection's own filteredYoyos(), which
// stepped through the wrong list entirely when opened from those views.
// Omit `list` when re-opening/stepping within an already-open detail (edit
// save, prev/next) so the existing context is preserved instead of reset.
function openDetail(id, list) {
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  detailId = id;
  if (list) {
    detailList = list;
  } else if (!detailList.includes(id)) {
    detailList = filteredYoyos().map((x) => x.id); // fresh open, no explicit context — default to Collection's
  }
  const i = detailList.indexOf(id);
  $('#detailPrev').disabled = i <= 0;
  $('#detailNext').disabled = i < 0 || i >= detailList.length - 1;
  $('#detailTitle').innerHTML =
    `${esc(y.brand)} ${esc(y.model)}`.trim() +
    (y.favorite ? ` <span class="card-fav-inline">${SVG.star}</span>` : '');
  $('#detailBody').innerHTML = detailHTML(y);
  $('#detailBody').querySelectorAll('img[data-full]').forEach((img) =>
    img.addEventListener('click', () => openLightbox(img.dataset.full))
  );
  // Quick actions in the hero (owner only)
  $('#detailBody').querySelectorAll('[data-da]').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.da;
    if (act === 'edit') { openEdit(id, true); return; }
    const changes = act === 'favorite' ? { favorite: !y.favorite }
      : act === 'in_hand' ? { in_hand: !y.in_hand } : { retired: !y.retired };
    patchYoyo(id, changes).then(loadAll).then(() => { if (detailId === id) openDetail(id); }).catch((err) => toast(err.message, 'error'));
  }));
  // Click a chip to filter by it
  $('#detailBody').querySelectorAll('[data-filt]').forEach((el) => el.addEventListener('click', () => { closeDetail(); applyQuickFilter(el.dataset.filt); }));
  $('#detailModal').classList.remove('hidden');
}

// Builds the detail modal's markup: a hero (lead photo, chips, price, quick
// actions), the rest of the photo gallery, grouped spec sections (DETAIL_GROUPS),
// custom fields, and the description.
function detailHTML(y) {
  // ---- Hero summary (lead media + key facts) ----
  const lead = y.photos[0]
    ? `<img src="${esc(y.photos[0].thumbUrl || y.photos[0].url)}" data-full="${esc(y.photos[0].url)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${esc(y.photos[0].url)}'" />`
    : '<span class="placeholder"></span>';

  const chips = [];
  if (y.composition) chips.push(`<span class="tag clickable" data-filt="compositions:${esc(y.composition)}">${esc(fmtField('composition', y.composition))}</span>`);
  if (y.condition) chips.push(`<span class="tag clickable" data-filt="conditions:${esc(y.condition)}">${esc(y.condition)}</span>`);
  if (y.color) chips.push(`<span class="tag">${esc(y.color)}</span>`);
  const chipHTML = chips.join('');
  const statusBadge = canEditState
    ? `<span class="status-badge ${y.in_hand ? 'in' : 'order'}">${y.in_hand ? 'In hand' : 'On order'}</span>` : '';
  const retiredBadge = y.retired ? '<span class="status-badge retired">Retired</span>' : '';

  let priceRow = '';
  if (canEditState && (y.paid != null || y.retail != null || y.market_value != null)) {
    const parts = [];
    if (y.paid != null) parts.push(`<span class="dh-paid">${money(y.paid)}</span>`);
    if (y.retail != null) parts.push(`<span class="dh-retail">${money(y.retail)} retail</span>`);
    if (y.percent_off != null && y.percent_off > 0) parts.push(`<span class="off">${y.percent_off}% off</span>`);
    if (y.market_value != null) parts.push(`<span class="dh-retail">${money(y.market_value)} est. value</span>`);
    priceRow = `<div class="detail-hero-price">${parts.join('')}</div>`;
  }

  // One-tap actions (owner only) — avoids opening the editor for a single toggle.
  const heroActions = canEditState ? `<div class="detail-hero-actions">
      <button class="hero-act ${y.favorite ? 'on' : ''}" data-da="favorite">${y.favorite ? SVG.star : SVG.starOutline}<span>${y.favorite ? 'Favorited' : 'Favorite'}</span></button>
      <button class="hero-act ${y.in_hand ? 'on' : ''}" data-da="in_hand">${SVG.box}<span>${y.in_hand ? 'In hand' : 'Mark in hand'}</span></button>
      <button class="hero-act ${y.retired ? 'on' : ''}" data-da="retired">${SVG.check}<span>${y.retired ? 'Retired' : 'Mark retired'}</span></button>
      <button class="hero-act" data-da="edit">${SVG.edit}<span>Edit</span></button>
    </div>` : '';

  const hero = `<div class="detail-hero">
      <div class="detail-hero-media">${lead}</div>
      <div class="detail-hero-info">
        ${(statusBadge || retiredBadge || chipHTML) ? `<div class="detail-hero-chips">${statusBadge}${retiredBadge}${chipHTML}</div>` : ''}
        ${priceRow}
        ${heroActions}
      </div>
    </div>`;

  // Remaining photos (the first is the hero lead).
  const rest = y.photos.slice(1);
  const gallery = rest.length
    ? `<div class="detail-gallery">${rest.map((p) => `<img src="${esc(p.thumbUrl || p.url)}" data-full="${esc(p.url)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${esc(p.url)}'" />`).join('')}</div>`
    : '';

  // Pricing + status live in the hero, so omit those groups here.
  const groups = DETAIL_GROUPS.filter(([title]) => title !== 'Pricing').map(([title, keys]) => {
    const rows = keys
      .map((k) => [FIELD_BY_KEY[k].label, fmtField(k, y[k]), y[k]])
      .filter(([, , raw]) => raw != null && raw !== '')
      .map(([label, val]) => `<div class="dl-row"><dt>${esc(label)}</dt><dd>${esc(val)}</dd></div>`)
      .join('');
    return rows ? `<section class="detail-group"><h3>${title}</h3><dl>${rows}</dl></section>` : '';
  }).join('');

  const customRows = customDefs
    .map((d) => [d.label, fmtField(d.key, y.custom ? y.custom[d.key] : undefined), y.custom ? y.custom[d.key] : undefined])
    .filter(([, , raw]) => raw != null && raw !== '')
    .map(([label, val]) => `<div class="dl-row"><dt>${esc(label)}</dt><dd>${esc(val)}</dd></div>`)
    .join('');
  const customGroup = customRows ? `<section class="detail-group"><h3>More</h3><dl>${customRows}</dl></section>` : '';

  const desc = y.description
    ? `<section class="detail-group full"><h3>Description</h3><p class="detail-desc">${esc(y.description)}</p></section>`
    : '';

  return hero + gallery + `<div class="detail-grid">${groups}${customGroup}</div>` + desc;
}

// Open a yoyo from a /y/:id share link: a focused, read-only single-yoyo view
// (the rest of the app's chrome is hidden until the visitor closes it).
function openShareView(id) {
  const y = yoyos.find((x) => x.id === id);
  if (!y) { toast('That yoyo could not be found.', 'error'); return; }
  shareMode = true;
  document.body.classList.add('share-mode');
  openDetail(id);
}
// Closes the detail modal. When it was opened from a /y/:id share link, also
// drops back to the app's normal "/" path and exits share mode.
function closeDetail() {
  $('#detailModal').classList.add('hidden');
  detailId = null;
  if (shareMode) {
    // Closing a shared view drops the /y/:id path and reveals the full collection.
    shareMode = false;
    document.body.classList.remove('share-mode');
    try { history.replaceState(null, '', '/'); } catch { /* ignore */ }
  }
}
// Moves the detail modal to the previous (-1) or next (1) yoyo in detailList.
function detailStep(dir) {
  const i = detailList.indexOf(detailId);
  if (i < 0) return;
  const j = i + dir;
  if (j >= 0 && j < detailList.length) openDetail(detailList[j]);
}
$('#detailPrev').addEventListener('click', () => detailStep(-1));
$('#detailNext').addEventListener('click', () => detailStep(1));

$('#detailEdit').addEventListener('click', () => { if (detailId) openEdit(detailId, true); });
$('#detailDelete').addEventListener('click', async () => {
  if (!detailId) return;
  if (demoGuard()) return;
  if (!await confirmDialog({ title: 'Delete this yoyo?', message: 'This removes the yoyo and its photos. This can’t be undone.', confirmText: 'Delete', danger: true })) return;
  try {
    await api(`/api/yoyos/${detailId}`, { method: 'DELETE' });
    closeDetail();
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
});

// ---- Share card (downloadable PNG) ----
// Renders a self-contained image of one yoyo (photo + key specs) on a canvas so
// it can be saved and posted/messaged anywhere. Entirely client-side — no server
// route needed. Available to everyone, including public read-only viewers.

const cssVar = (name, fallback) =>
  (getComputedStyle(document.body).getPropertyValue(name).trim() || fallback);

// Promise-wraps Image loading so the share-card canvas can `await` a photo.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Photos are same-origin, so the canvas stays untainted without crossOrigin.
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('photo failed to load'));
    img.src = src;
  });
}

// Traces a rounded-rectangle path on the canvas context (no native roundRect
// fallback needed across the browsers this targets).
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// The share card mirrors the collection's visible-field selection (`view.fields`).
// Identity (brand + model) and the lead photo are always shown; everything else
// follows whatever fields the user has chosen to display. These groupings decide
// how each visible field is rendered, matching the tile-card conventions.
const CARD_CHIP_KEYS = ['composition', 'condition', 'color'];   // rendered as pills
const CARD_PRICE_KEYS = ['paid', 'retail', 'percent_off'];      // rendered as a price line
// Keys handled specially — never rendered as a generic spec row.
const CARD_SPECIAL_KEYS = new Set([
  ...CARD_CHIP_KEYS, ...CARD_PRICE_KEYS,
  'favorite', 'retired', 'sale_status', 'sale_price', 'trade_value', 'in_hand', 'description',
]);

// Wrap a string to at most maxLines lines for the (already-set) ctx font,
// adding an ellipsis to the final line when truncated.
function wrapToLines(ctx, str, maxW, maxLines) {
  const out = []; let line = ''; let truncated = false;
  for (const w of String(str).split(/\s+/).filter(Boolean)) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      out.push(line); line = w;
      if (out.length === maxLines) { truncated = true; line = ''; break; }
    } else line = test;
  }
  if (line && out.length < maxLines) out.push(line);
  if (truncated && out.length) {
    let last = out[out.length - 1];
    while (ctx.measureText(last + '…').width > maxW && last.length > 1) last = last.slice(0, -1);
    out[out.length - 1] = last + '…';
  }
  return out;
}

// Draws one yoyo's share card on an off-screen <canvas> and resolves the
// finished image. Runs a measure pass first (title/chip/spec layout) so the
// canvas height exactly fits whatever fields are visible, then a draw pass.
// Everything here is already commented inline section-by-section; see
// shareCard() below for how the resulting canvas becomes a downloadable PNG.
async function renderCardBlob(y) {
  const W = 1080, M = 48, PAD = 56;
  const innerX = M + PAD, innerR = W - M - PAD, maxW = innerR - innerX;

  const bg = cssVar('--bg', '#f5f5f7');
  const surface = cssVar('--surface', '#ffffff');
  const surface2 = cssVar('--surface-2', '#f5f5f7');
  const surface3 = cssVar('--surface-3', '#ececed');
  const text = cssVar('--text', '#1d1d1f');
  const muted = cssVar('--muted', '#86868b');
  const accent = cssVar('--accent', '#5e5ce6');
  const onAccent = cssVar('--on-accent', '#ffffff');
  const accentSoft = cssVar('--accent-soft', 'rgba(94,92,230,0.12)');
  const border = cssVar('--border', 'rgba(0,0,0,0.08)');
  const font = cssVar('--font', '-apple-system, BlinkMacSystemFont, sans-serif');

  // Visible fields = the collection's current selection, filtered by the same
  // public-sensitivity rule the rest of the UI uses.
  const visible = (Array.isArray(view?.fields) ? view.fields : [])
    .filter((k) => canEditState || !SENSITIVE.has(k));
  const seen = (k) => visible.includes(k);
  const has = (k) => { const v = valueOf(y, k); return v != null && v !== ''; };

  // ---- Measure pass ----------------------------------------------------------
  // Positions are anchored from the top; the card's total height is derived from
  // the actual content so nothing can overlap or overflow, whatever the field
  // selection is. A throwaway context is used purely for text measurement.
  const mc = document.createElement('canvas').getContext('2d');
  const imgX = M + 40, imgW = W - 2 * M - 80, imgTop = M + 40, imgH = 660;

  // Title (+ favorite star), wrapped to at most 2 lines.
  const fav = !!y.favorite;
  mc.font = `600 62px ${font}`;
  const title = `${y.brand || ''} ${y.model || ''}`.trim() || 'Untitled';
  const titleLines = wrapToLines(mc, title, maxW - (fav ? 56 : 0), 2);

  // Chips: always-on Retired status, then visible composition/condition/color,
  // then In hand (when that field is shown and true). Wrapped across rows.
  const chipDefs = [];
  if (y.retired) chipDefs.push({ text: 'Retired', tone: 'muted' });
  for (const k of visible) {
    if (CARD_CHIP_KEYS.includes(k) && has(k)) chipDefs.push({ text: String(fmtField(k, valueOf(y, k))), tone: 'accent' });
  }
  if (seen('in_hand') && y.in_hand) chipDefs.push({ text: 'In hand', tone: 'accent' });
  const chipH = 56, chipPad = 26, chipGap = 14, chipRowGap = 14;
  mc.font = `500 30px ${font}`;
  for (const c of chipDefs) c.w = mc.measureText(c.text).width + chipPad * 2;
  const chipRows = [];
  let crow = [], crowW = 0;
  for (const c of chipDefs) {
    if (crow.length && crowW + chipGap + c.w > maxW) { chipRows.push(crow); crow = []; crowW = 0; }
    crow.push(c); crowW += (crow.length > 1 ? chipGap : 0) + c.w;
  }
  if (crow.length) chipRows.push(crow);
  for (const r of chipRows) { let x = innerX; for (const c of r) { c.x = x; x += c.w + chipGap; } }

  // Sale badge: always shown when a yoyo has a sale status (mirrors the tile / For
  // Sale views, which surface it independent of the field picker).
  let sale = null;
  if (y.sale_status) {
    const label = has('sale_price') ? `${y.sale_status} · ${money(y.sale_price)}` : y.sale_status;
    mc.font = `600 32px ${font}`;
    sale = { label, w: mc.measureText(label).width + 60, h: 64, sold: y.sale_status === 'Sold' };
  }

  // Price line: whichever of paid / retail / % off are visible and present.
  const priceParts = [];
  if (seen('paid') && has('paid')) priceParts.push({ text: money(y.paid), kind: 'main' });
  if (seen('retail') && has('retail')) priceParts.push({ text: money(y.retail) + ' retail', kind: 'muted' });
  if (seen('percent_off') && y.percent_off != null && y.percent_off > 0) priceParts.push({ text: y.percent_off + '% off', kind: 'accent' });

  // Spec grid: every other visible field that has a value, in selection order.
  const specs = visible
    .filter((k) => !CARD_SPECIAL_KEYS.has(k) && has(k))
    .map((k) => [FIELD_BY_KEY[k]?.label || k, String(fmtField(k, valueOf(y, k)))]);
  const rowH = 96, colGap = 40;
  const colW = (maxW - colGap) / 2;
  const specRows = Math.ceil(specs.length / 2);

  // Description (wrapped), when that field is shown.
  let descLines = null;
  if (seen('description') && has('description')) {
    mc.font = `400 32px ${font}`;
    descLines = wrapToLines(mc, String(valueOf(y, 'description')), maxW, 4);
  }

  // ---- Vertical layout -------------------------------------------------------
  // Each optional block advances `cy` only when present, so the card is exactly
  // as tall as its content.
  let cy = imgTop + imgH + 78;                          // first title baseline
  const titleBaselines = titleLines.map((_, i) => cy + i * 74);
  cy = titleBaselines[titleBaselines.length - 1] ?? cy; // baseline of last title line

  let chipsTop = 0;
  if (chipRows.length) {
    chipsTop = cy + 28;
    cy = chipsTop + chipRows.length * chipH + (chipRows.length - 1) * chipRowGap;
  }
  let saleY = 0;
  if (sale) { saleY = cy + 24; cy = saleY + sale.h; }
  let priceBaseline = 0;
  if (priceParts.length) { priceBaseline = cy + 60; cy = priceBaseline + 8; }
  let specStartY = 0;
  if (specs.length) {
    specStartY = cy + 56;                                // label baseline of first row
    cy = specStartY + (specRows - 1) * rowH + 46;        // value baseline of last row
  }
  let descTop = 0;
  if (descLines) {
    descTop = cy + 48;                                   // baseline of first description line
    cy = descTop + (descLines.length - 1) * 44;
  }
  const dividerY = cy + 40;
  const footerY = dividerY + 44;
  const H = Math.round(footerY + 52);

  // ---- Draw pass -------------------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Page background, then a rounded surface "card" with a soft shadow.
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  roundRectPath(ctx, M, M, W - 2 * M, H - 2 * M, 40);
  ctx.fillStyle = surface;
  ctx.fill();
  ctx.restore();

  // Photo (cover-fit into a rounded box).
  ctx.save();
  roundRectPath(ctx, imgX, imgTop, imgW, imgH, 28);
  ctx.clip();
  const photo = y.photos && y.photos[0];
  let img = null;
  if (photo) { try { img = await loadImage(photo.url); } catch { img = null; } }
  if (img) {
    const s = Math.max(imgW / img.width, imgH / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, imgX + (imgW - dw) / 2, imgTop + (imgH - dh) / 2, dw, dh);
  } else {
    // Placeholder: brand initial on a soft fill.
    ctx.fillStyle = surface2;
    ctx.fillRect(imgX, imgTop, imgW, imgH);
    ctx.fillStyle = muted;
    ctx.font = `600 200px ${font}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((y.brand || y.model || '?').trim().charAt(0).toUpperCase(), imgX + imgW / 2, imgTop + imgH / 2);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  // Title (+ favorite star).
  ctx.fillStyle = text; ctx.font = `600 62px ${font}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  titleLines.forEach((l, i) => ctx.fillText(l, innerX, titleBaselines[i]));
  if (fav && titleLines.length) {
    const lastLine = titleLines[titleLines.length - 1];
    const lastBase = titleBaselines[titleBaselines.length - 1];
    const lw = ctx.measureText(lastLine).width;
    ctx.fillStyle = accent; ctx.font = `600 46px ${font}`;
    ctx.fillText('★', innerX + lw + 18, lastBase);
  }

  // Chips (wrapped rows).
  if (chipRows.length) {
    ctx.font = `500 30px ${font}`;
    chipRows.forEach((r, ri) => {
      const ry = chipsTop + ri * (chipH + chipRowGap);
      for (const c of r) {
        roundRectPath(ctx, c.x, ry, c.w, chipH, chipH / 2);
        ctx.fillStyle = c.tone === 'muted' ? surface3 : accentSoft; ctx.fill();
        ctx.fillStyle = c.tone === 'muted' ? muted : accent;
        ctx.textBaseline = 'middle';
        ctx.fillText(c.text, c.x + chipPad, ry + chipH / 2 + 1);
      }
    });
    ctx.textBaseline = 'alphabetic';
  }

  // Sale badge.
  if (sale) {
    ctx.font = `600 32px ${font}`;
    roundRectPath(ctx, innerX, saleY, sale.w, sale.h, sale.h / 2);
    ctx.fillStyle = sale.sold ? surface3 : accent; ctx.fill();
    ctx.fillStyle = sale.sold ? muted : onAccent;
    ctx.textBaseline = 'middle';
    ctx.fillText(sale.label, innerX + 30, saleY + sale.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }

  // Price line.
  if (priceParts.length) {
    let px = innerX;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    for (const p of priceParts) {
      if (p.kind === 'main') { ctx.font = `600 46px ${font}`; ctx.fillStyle = text; }
      else if (p.kind === 'muted') { ctx.font = `500 30px ${font}`; ctx.fillStyle = muted; }
      else { ctx.font = `600 30px ${font}`; ctx.fillStyle = accent; }
      ctx.fillText(p.text, px, priceBaseline);
      px += ctx.measureText(p.text).width + 20;
    }
  }

  // Spec grid (2 columns).
  specs.forEach(([label, val], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = innerX + col * (colW + colGap);
    const ry = specStartY + row * rowH;
    ctx.fillStyle = muted;
    ctx.font = `600 24px ${font}`;
    ctx.fillText(String(label).toUpperCase(), x, ry);
    ctx.fillStyle = text;
    ctx.font = `500 40px ${font}`;
    let v = String(val);
    while (ctx.measureText(v).width > colW && v.length > 1) v = v.slice(0, -2) + '…';
    ctx.fillText(v, x, ry + 46);
  });

  // Description.
  if (descLines) {
    ctx.fillStyle = text; ctx.font = `400 32px ${font}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    descLines.forEach((l, i) => ctx.fillText(l, innerX, descTop + i * 44));
  }

  // Footer attribution.
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(innerX, dividerY); ctx.lineTo(innerR, dividerY); ctx.stroke();
  const siteName = (document.querySelector('.brand-name')?.textContent || 'Yoyo Collection').trim();
  ctx.fillStyle = muted;
  ctx.font = `500 26px ${font}`;
  ctx.textAlign = 'left'; ctx.fillText('🪀 ' + siteName, innerX, footerY);
  ctx.textAlign = 'right'; ctx.fillText(location.host, innerR, footerY);
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas export failed'))), 'image/png'));
}

// Renders and triggers a browser download of one yoyo's share card PNG.
async function shareCard(id) {
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  const btn = $('#detailShare');
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Rendering…'; }
  try {
    const blob = await renderCardBlob(y);
    const slug = `${y.brand || ''}-${y.model || ''}`.trim()
      .replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'yoyo';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${slug}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Card image downloaded', 'success');
  } catch (err) {
    toast('Could not create card: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}
$('#detailShare').addEventListener('click', () => { if (detailId) shareCard(detailId); });
$('#detailCopyLink').addEventListener('click', async () => {
  if (!detailId) return;
  const url = `${location.origin}/y/${detailId}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied', 'success');
  } catch {
    // Clipboard API blocked (e.g. insecure context) — show the link to copy by hand.
    toast(url, 'success');
  }
});

// ---- Modal: add / edit ----
let addAnother = false;   // set by "Save & add another"
// Opens the add/edit form in "add" mode: always a fully blank form.
function openAdd() {
  editingId = null;
  formGen++;
  cameFromDetail = false;
  $('#modalTitle').textContent = 'Add a yoyo';
  $('#saveBtn').textContent = 'Add to collection';
  form.reset();
  // form.reset() can't blank the tile-picker fields (composition, condition):
  // for a hidden <input>, the `value` IDL attribute IS the default value, so
  // the tile click handler's `input.value = ...` permanently overwrites what
  // reset() would restore. Clear them explicitly instead.
  document.querySelectorAll('#yoyoForm .tile-group').forEach((group) => {
    const input = form.elements[group.dataset.for];
    if (input) input.value = '';
  });
  $('#deleteBtn').classList.add('hidden');
  $('#saveAddAnotherBtn').classList.remove('hidden'); // only meaningful when adding
  renderPhotoStrip([]);
  renderCustomFields({});
  updatePercentOff();
  syncTiles();
  setSaleType('cash');
  updateHero();
  showModal();
}

// Opens the add/edit form pre-filled with an existing yoyo's data. `fromDetail`
// tracks whether Cancel/Save should return to the detail modal.
function openEdit(id, fromDetail = false) {
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  editingId = id;
  formGen++;
  cameFromDetail = fromDetail;
  $('#detailModal').classList.add('hidden'); // hide detail while editing
  $('#modalTitle').textContent = `${y.brand} ${y.model}`.trim() || 'Edit Yoyo';
  $('#saveBtn').textContent = 'Save changes';
  form.reset();
  for (const [k, v] of Object.entries(y)) {
    const field = form.elements[k];
    if (!field || field.tagName === undefined) continue;
    if (field.type === 'checkbox') field.checked = !!v;
    else if (field.type === 'date') field.value = toDateInputValue(v); // date inputs need YYYY-MM-DD
    else field.value = v == null ? '' : v;
  }
  $('#deleteBtn').classList.remove('hidden');
  $('#saveAddAnotherBtn').classList.add('hidden'); // editing an existing one
  renderPhotoStrip(y.photos);
  renderCustomFields(y.custom || {});
  updatePercentOff();
  syncTiles();
  setSaleType(y.trade_value != null ? 'trade' : 'cash');
  updateHero();
  showModal();
}

// Live-updates the "% off" readout in the form as retail/paid change.
function updatePercentOff() {
  const retail = parseFloat(form.retail.value);
  const paid = parseFloat(form.paid.value);
  const out = $('#percentOff');
  if (retail > 0 && !isNaN(paid)) {
    const pct = Math.round(((retail - paid) / retail) * 10000) / 100;
    const save = retail - paid;
    out.textContent = save > 0 ? `${pct}% off · save ${money(save)}` : `${pct}%`;
    out.classList.toggle('has', save > 0);
  } else {
    out.textContent = '—';
    out.classList.remove('has');
  }
}

// ---- Live preview hero + tile pickers (Add/Edit form) ----
// Live preview card at the top of the add/edit form, reflecting the fields as
// they're typed (brand/model/color/composition/condition) before saving.
function updateHero() {
  const hero = $('#editHero');
  if (!hero) return;
  const brand = form.brand.value.trim();
  const model = form.model.value.trim();
  const color = form.color.value.trim();
  const comp = form.composition.value.trim();
  const cond = form.condition.value.trim();
  const y = editingId ? yoyos.find((x) => x.id === editingId) : null;
  const photo = (y && y.photos && y.photos[0]) ? y.photos[0].url : null;
  const thumb = photo ? `<img src="${photo}" alt="">` : '<span class="placeholder"></span>';
  const chips = [color, comp, cond].filter(Boolean).map((c) => `<span class="tag">${esc(c)}</span>`).join('');
  hero.innerHTML =
    `<div class="hero-thumb">${thumb}</div>` +
    `<div class="hero-main">` +
      (brand ? `<div class="hero-brand">${esc(brand)}</div>` : '') +
      `<div class="hero-title">${esc(model || brand || 'New yoyo')}</div>` +
      (chips ? `<div class="hero-meta">${chips}</div>` : '') +
    `</div>`;
}

// Shows the Cash/Trade toggle only once Sale Status is "Sold", and the Trade
// Value field only when "Trade" is the selected type.
function syncSaleType() {
  const isSold = form.sale_status.value === 'Sold';
  $('#saleTypeRow').classList.toggle('hidden', !isSold);
  const isTrade = $('#saleTypeSeg').querySelector('.seg-btn.active')?.dataset.saleType === 'trade';
  $('#tradeValueField').classList.toggle('hidden', !(isSold && isTrade));
}
// Sets which Cash/Trade segment is active and refreshes field visibility.
function setSaleType(type) {
  $('#saleTypeSeg').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.saleType === type));
  syncSaleType();
}

// Highlights the active tile-picker option (e.g. composition/shape) to match
// its hidden form field's current value.
function syncTiles() {
  document.querySelectorAll('#yoyoForm .tile-group').forEach((group) => {
    const input = form.elements[group.dataset.for];
    const val = input ? input.value : '';
    group.querySelectorAll('.tile').forEach((t) => t.classList.toggle('active', t.dataset.val === val));
  });
}

// Tile click sets the hidden field (re-click clears it), then refreshes UI.
$('#yoyoForm').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const group = tile.closest('.tile-group');
  const input = group && form.elements[group.dataset.for];
  if (!input) return;
  input.value = (input.value === tile.dataset.val) ? '' : tile.dataset.val;
  syncTiles();
  updateHero();
});

// Sale-type toggle (Cash sale / Trade) — only relevant once Sale Status is
// Sold; picking Trade reveals the Trade Value field.
$('#saleTypeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  setSaleType(btn.dataset.saleType);
});
form.sale_status.addEventListener('change', syncSaleType);

// Renders the form's photo thumbnail strip, with per-photo remove/reorder
// controls and a "cover" badge on the first one.
function renderPhotoStrip(photos) {
  // Dropzone only makes sense once the yoyo exists (uploads need an id).
  $('#dropzone').classList.toggle('hidden', !editingId);
  const note = !editingId ? '<p class="hint">Save first to start adding photos.</p>' : '';
  const hint = (editingId && photos.length > 1)
    ? '<p class="hint photo-hint">Drag to reorder — the first photo is the cover.</p>' : '';
  photoStrip.innerHTML =
    photos.map((p, i) => `
      <div class="photo-thumb" draggable="true" data-pid="${p.id}">
        <img src="${esc(p.thumbUrl || p.url)}" alt="" data-full="${esc(p.url)}" draggable="false" loading="lazy" onerror="this.onerror=null;this.src='${esc(p.url)}'" />
        ${i === 0 ? '<span class="cover-badge">Cover</span>' : ''}
        <button type="button" class="photo-del" data-photo="${p.id}" title="Remove photo">✕</button>
        <div class="photo-move">
          <button type="button" data-pmove="${p.id}:-1" ${i === 0 ? 'disabled' : ''} title="Move earlier">‹</button>
          <button type="button" data-pmove="${p.id}:1" ${i === photos.length - 1 ? 'disabled' : ''} title="Move later">›</button>
        </div>
      </div>`).join('') + hint + note;

  photoStrip.querySelectorAll('.photo-del').forEach((btn) =>
    btn.addEventListener('click', () => deletePhoto(Number(btn.dataset.photo)))
  );
  photoStrip.querySelectorAll('[data-pmove]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const [pid, dir] = btn.dataset.pmove.split(':').map(Number);
      movePhoto(pid, dir);
    })
  );
  photoStrip.querySelectorAll('img[data-full]').forEach((img) =>
    img.addEventListener('click', () => openLightbox(img.dataset.full))
  );
  wirePhotoDragDrop();
}

// Drag-to-reorder photos; first = cover. Persists order on drop.
function wirePhotoDragDrop() {
  photoStrip.querySelectorAll('.photo-thumb').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', el.dataset.pid); } catch { /* ignore */ }
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      savePhotoOrder();
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = photoStrip.querySelector('.photo-thumb.dragging');
      if (!dragging || dragging === el) return;
      const rect = el.getBoundingClientRect();
      const after = (e.clientX - rect.left) > rect.width / 2;
      photoStrip.insertBefore(dragging, after ? el.nextSibling : el);
    });
  });
}

// Saves a new photo order to the server and refreshes the strip + collection.
async function persistPhotoOrder(ids) {
  if (!editingId || ids.length < 2) return;
  try {
    const updated = await api(`/api/yoyos/${editingId}/photos/order`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    });
    renderPhotoStrip(updated.photos);
    updateHero();
    await loadAll();
  } catch (err) { toast('Could not save photo order: ' + err.message, 'error'); }
}
function savePhotoOrder() {
  const ids = [...photoStrip.querySelectorAll('.photo-thumb')].map((el) => Number(el.dataset.pid));
  persistPhotoOrder(ids);
}
// Touch-friendly reorder (the drag version is mouse-only).
function movePhoto(pid, dir) {
  const ids = [...photoStrip.querySelectorAll('.photo-thumb')].map((el) => Number(el.dataset.pid));
  const i = ids.indexOf(pid), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  persistPhotoOrder(ids);
}

// Renders the add/edit form's custom-fields section, one input per field
// definition (select fields use a datalist so a new value can be typed in).
function renderCustomFields(values) {
  const wrap = $('#customFields');
  $('#customSection').hidden = customDefs.length === 0;
  const v = values || {};
  wrap.innerHTML = customDefs.map((d) => {
    const cur = v[d.key] != null ? v[d.key] : '';
    let input;
    if (d.type === 'select') {
      // datalist input: pick an existing option or type a new one (auto-added on save)
      input = `<input list="cflist_${esc(d.key)}" data-cf="${esc(d.key)}" value="${esc(cur)}" placeholder="Choose or type new…">` +
        `<datalist id="cflist_${esc(d.key)}">${d.options.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>`;
    } else if (d.type === 'boolean') {
      input = `<label class="switch"><input type="checkbox" data-cf="${esc(d.key)}" ${cur ? 'checked' : ''}><span class="track"></span></label>`;
    } else if (d.type === 'number') {
      input = `<input type="number" step="any" data-cf="${esc(d.key)}" value="${cur === '' ? '' : esc(cur)}">`;
    } else {
      input = `<input type="text" data-cf="${esc(d.key)}" value="${esc(cur)}">`;
    }
    return `<div class="field"><label>${esc(d.label)}</label>${input}</div>`;
  }).join('');
}

// Reads the custom-fields section back into a { key: value } object for submit.
function collectCustom() {
  const out = {};
  $('#customFields').querySelectorAll('[data-cf]').forEach((el) => {
    out[el.dataset.cf] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return out;
}

function showModal() { modal.classList.remove('hidden'); }
function closeModal() {
  modal.classList.add('hidden');
  const id = editingId;
  editingId = null;
  formGen++;
  // If the form was opened from the detail view, return to it.
  if (id && cameFromDetail) { cameFromDetail = false; openDetail(id); }
}

// ---- Form submit ----
form.addEventListener('input', (e) => {
  if (e.target.name === 'retail' || e.target.name === 'paid') updatePercentOff();
  updateHero();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (demoGuard()) return;
  const myGen = formGen; // snapshot: detects if the form's target changes while this save is in flight
  const data = Object.fromEntries(new FormData(form).entries());
  data.in_hand = form.in_hand.checked;
  data.favorite = form.favorite.checked;
  data.retired = form.retired.checked;
  data.custom = collectCustom();
  delete data.id;

  const targetId = editingId; // capture now — editingId may be reassigned while we await below
  const isNew = !targetId;
  const another = addAnother; addAnother = false;
  try {
    let saved;
    if (targetId) {
      saved = await api(`/api/yoyos/${targetId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
    } else {
      saved = await api('/api/yoyos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      // Only claim editingId if nothing else has taken over the form in the
      // meantime (e.g. the user closed this form and opened a different yoyo's
      // edit while this POST was in flight) — otherwise we'd silently redirect
      // that other, currently-open edit session onto this new yoyo's id.
      if (formGen === myGen) editingId = saved.id;
    }
    await loadAll();
    // The user may have closed this form, or moved on to editing something else,
    // while the save was in flight. The data's already saved either way — just
    // don't yank their current screen back to reflect this stale submission.
    if (formGen !== myGen) return;
    if (isNew && another) {
      editingId = null;
      openAdd(); // straight into a fresh, fully blank form
      toast('Saved. Add the next one…', 'ok');
    } else if (isNew) {
      openEdit(editingId); // new yoyo: stay in the form to add photos right away
      toast('Saved — add photos below, or close.', 'ok');
    } else {
      modal.classList.add('hidden');
      editingId = null;
      cameFromDetail = false;
      openDetail(targetId); // edited existing: show the updated detail view
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#saveAddAnotherBtn').addEventListener('click', () => { addAnother = true; form.requestSubmit(); });

// ---- Delete yoyo ----
$('#deleteBtn').addEventListener('click', async () => {
  if (!editingId) return;
  if (demoGuard()) return;
  if (!await confirmDialog({ title: 'Delete this yoyo?', message: 'This removes the yoyo and its photos. This can’t be undone.', confirmText: 'Delete', danger: true })) return;
  try {
    await api(`/api/yoyos/${editingId}`, { method: 'DELETE' });
    closeModal();
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---- Photos ----
// Uploads dropped/picked image files to the currently-editing yoyo (uploads
// require an existing id, so this is a no-op on a not-yet-saved "add" form).
async function uploadFiles(fileList) {
  if (!editingId) { toast('Save the yoyo first, then add photos.', 'error'); return; }
  const images = [...(fileList || [])].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  const fd = new FormData();
  for (const f of images) fd.append('photos', f);
  try {
    const updated = await api(`/api/yoyos/${editingId}/photos`, { method: 'POST', body: fd });
    renderPhotoStrip(updated.photos);
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

photoInput.addEventListener('change', async () => {
  await uploadFiles(photoInput.files);
  photoInput.value = '';
});

// Drag & drop onto the dropzone
const dropzone = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); })
);
dropzone.addEventListener('drop', (e) => { uploadFiles(e.dataTransfer.files); });

async function deletePhoto(photoId) {
  try {
    await api(`/api/photos/${photoId}`, { method: 'DELETE' });
    const y = await api(`/api/yoyos/${editingId}`);
    renderPhotoStrip(y.photos);
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- Lightbox ----
function openLightbox(url) {
  $('#lightboxImg').src = url;
  $('#lightbox').classList.remove('hidden');
}
// Clicking anywhere on the lightbox (including the image) closes it.
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));

// ---- CSV import ----
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await api('/api/import', { method: 'POST', body: fd });
    await loadAll();
    toast(`Import complete — added ${r.created}, updated ${r.updated}${r.skipped ? `, skipped ${r.skipped}` : ''}.`, 'ok');
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
});

// ---- Events: filters ----
$('#search').addEventListener('input', (e) => { filters.q = e.target.value; view.page = 1; render(); });
$('#sort').addEventListener('change', (e) => { filters.sort = e.target.value; filters.sortDir = defaultDir(e.target.value); render(); });
$('#sortDirBtn').addEventListener('click', () => { filters.sortDir = filters.sortDir === 'asc' ? 'desc' : 'asc'; render(); });
$('#clearFilters').addEventListener('click', clearAllFilters);
wireSaleControlsOnce();

// Resets every filter (search, checkboxes, ranges) back to defaults.
function clearAllFilters() {
  filters.q = '';
  filters.brands = []; filters.compositions = []; filters.conditions = [];
  filters.material = ''; filters.status = ''; filters.retiredOnly = false; filters.favOnly = false;
  filters.paidMin = filters.paidMax = filters.retailMin = filters.retailMax = filters.weightMin = filters.weightMax = null;
  $('#search').value = '';
  view.page = 1;
  buildFilterPanel();
  render();
}

// ---- Advanced filter panel ----
function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

// Rebuilds the advanced filter popover (brand checklist with counts,
// composition/condition chips, material text, status, ranges) and wires each
// control to mutate `filters` and re-render — not rebuilt on every keystroke,
// so focus isn't lost while typing in a range input.
function buildFilterPanel() {
  const panel = $('#filterPanel');
  if (!panel) return;
  const brands = [...new Set(yoyos.map((y) => y.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const conds = [...new Set([...(DATALIST_SEEDS.conditionList || []), ...yoyos.map((y) => y.condition).filter(Boolean)])];
  const comps = ['BI', 'MN', 'TRI'];
  const chip = (group, val, label) =>
    `<button type="button" class="filter-chip ${filters[group].includes(val) ? 'active' : ''}" data-group="${group}" data-val="${esc(val)}">${esc(label)}</button>`;
  const money$ = canEditState;

  panel.innerHTML =
    `<div class="filter-section"><div class="filter-label">Brand</div>
       <div class="filter-checks">${brands.map((b) => {
         const n = yoyos.filter((y) => y.brand === b).length;
         return `<label class="filter-check"><input type="checkbox" data-brand="${esc(b)}" ${filters.brands.includes(b) ? 'checked' : ''}><span>${esc(b)}</span><span class="filter-num">${n}</span></label>`;
       }).join('') || '<span class="hint">No brands yet.</span>'}</div>
     </div>` +
    `<div class="filter-section"><div class="filter-label">Composition</div>
       <div class="filter-chip-row">${comps.map((c) => chip('compositions', c, c)).join('')}</div></div>` +
    `<div class="filter-section"><div class="filter-label">Condition</div>
       <div class="filter-chip-row">${conds.map((c) => chip('conditions', c, c)).join('')}</div></div>` +
    `<div class="filter-section"><div class="filter-label">Material contains</div>
       <input type="text" id="fMaterial" placeholder="e.g. AL, Ti, SS" value="${esc(filters.material)}"></div>` +
    (money$ ? `<div class="filter-section"><div class="filter-label">Status</div>
       <div class="seg" id="fStatus">
         <button type="button" class="seg-btn ${!filters.status ? 'active' : ''}" data-status="">All</button>
         <button type="button" class="seg-btn ${filters.status === 'in' ? 'active' : ''}" data-status="in">In hand</button>
         <button type="button" class="seg-btn ${filters.status === 'order' ? 'active' : ''}" data-status="order">On order</button>
       </div></div>` : '') +
    `<div class="filter-section filter-toggles">
       <label class="filter-check"><input type="checkbox" id="fRetired" ${filters.retiredOnly ? 'checked' : ''}><span>Retired only</span></label>
       <label class="filter-check"><input type="checkbox" id="fFav" ${filters.favOnly ? 'checked' : ''}><span>Favorites only</span></label>
     </div>` +
    (money$ ? `<div class="filter-section"><div class="filter-label">Paid ($)</div>
       <div class="filter-range"><input type="number" id="fPaidMin" placeholder="min" value="${filters.paidMin ?? ''}"><span>–</span><input type="number" id="fPaidMax" placeholder="max" value="${filters.paidMax ?? ''}"></div></div>` : '') +
    (money$ ? `<div class="filter-section"><div class="filter-label">Retail ($)</div>
       <div class="filter-range"><input type="number" id="fRetailMin" placeholder="min" value="${filters.retailMin ?? ''}"><span>–</span><input type="number" id="fRetailMax" placeholder="max" value="${filters.retailMax ?? ''}"></div></div>` : '') +
    `<div class="filter-section"><div class="filter-label">Weight (g)</div>
       <div class="filter-range"><input type="number" id="fWeightMin" placeholder="min" value="${filters.weightMin ?? ''}"><span>–</span><input type="number" id="fWeightMax" placeholder="max" value="${filters.weightMax ?? ''}"></div></div>`;

  // Wire interactions (mutate state, re-render; don't rebuild to keep focus).
  panel.querySelectorAll('[data-brand]').forEach((cb) => cb.addEventListener('change', () => {
    const b = cb.dataset.brand;
    if (cb.checked) { if (!filters.brands.includes(b)) filters.brands.push(b); }
    else filters.brands = filters.brands.filter((x) => x !== b);
    view.page = 1; render();
  }));
  panel.querySelectorAll('.filter-chip').forEach((btn) => btn.addEventListener('click', () => {
    const g = btn.dataset.group, v = btn.dataset.val;
    if (filters[g].includes(v)) filters[g] = filters[g].filter((x) => x !== v);
    else filters[g].push(v);
    btn.classList.toggle('active');
    view.page = 1; render();
  }));
  const onInput = (id, fn) => { const el = panel.querySelector(id); if (el) el.addEventListener('input', () => { fn(el.value); view.page = 1; render(); }); };
  onInput('#fMaterial', (v) => { filters.material = v.trim(); });
  onInput('#fPaidMin', (v) => { filters.paidMin = num(v); });
  onInput('#fPaidMax', (v) => { filters.paidMax = num(v); });
  onInput('#fRetailMin', (v) => { filters.retailMin = num(v); });
  onInput('#fRetailMax', (v) => { filters.retailMax = num(v); });
  onInput('#fWeightMin', (v) => { filters.weightMin = num(v); });
  onInput('#fWeightMax', (v) => { filters.weightMax = num(v); });
  panel.querySelectorAll('#fStatus [data-status]').forEach((b) => b.addEventListener('click', () => {
    filters.status = b.dataset.status;
    panel.querySelectorAll('#fStatus .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    view.page = 1; render();
  }));
  const fRet = panel.querySelector('#fRetired'); if (fRet) fRet.addEventListener('change', () => { filters.retiredOnly = fRet.checked; view.page = 1; render(); });
  const fFav = panel.querySelector('#fFav'); if (fFav) fFav.addEventListener('change', () => { filters.favOnly = fFav.checked; view.page = 1; render(); });
}

// Updates the numeric badge on the filter toggle button.
function updateFilterCount() {
  const badge = $('#filterCount');
  if (!badge) return;
  const n = activeFilterCount();
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

// Renders the row of removable "chips" below the toolbar summarizing every
// active filter, plus a "Save view" button when the owner has any filters set.
function renderActiveFilters() {
  const wrap = $('#activeFilters');
  if (!wrap) return;
  const chips = [];
  const add = (label, onRemove) => chips.push({ label, onRemove });
  filters.brands.forEach((b) => add(b, () => { filters.brands = filters.brands.filter((x) => x !== b); }));
  filters.compositions.forEach((c) => add(c, () => { filters.compositions = filters.compositions.filter((x) => x !== c); }));
  filters.conditions.forEach((c) => add(c, () => { filters.conditions = filters.conditions.filter((x) => x !== c); }));
  if (filters.material) add(`Material: ${filters.material}`, () => { filters.material = ''; });
  if (filters.status === 'in') add('In hand', () => { filters.status = ''; });
  if (filters.status === 'order') add('On order', () => { filters.status = ''; });
  if (filters.retiredOnly) add('Retired', () => { filters.retiredOnly = false; });
  if (filters.favOnly) add('Favorites', () => { filters.favOnly = false; });
  const rangeLabel = (name, min, max, fmt = (v) => v) =>
    min != null && max != null ? `${name} ${fmt(min)}–${fmt(max)}` : min != null ? `${name} ≥ ${fmt(min)}` : `${name} ≤ ${fmt(max)}`;
  if (filters.paidMin != null || filters.paidMax != null) add(rangeLabel('Paid', filters.paidMin, filters.paidMax, (v) => '$' + v), () => { filters.paidMin = filters.paidMax = null; });
  if (filters.retailMin != null || filters.retailMax != null) add(rangeLabel('Retail', filters.retailMin, filters.retailMax, (v) => '$' + v), () => { filters.retailMin = filters.retailMax = null; });
  if (filters.weightMin != null || filters.weightMax != null) add(rangeLabel('Weight', filters.weightMin, filters.weightMax, (v) => v + 'g'), () => { filters.weightMin = filters.weightMax = null; });

  wrap.classList.toggle('hidden', chips.length === 0);
  const saveBtn = (canEditState && chips.length) ? '<button type="button" class="btn btn-ghost btn-sm save-view-btn">＋ Save view</button>' : '';
  wrap.innerHTML = chips.map((c, i) => `<button type="button" class="chip-remove" data-i="${i}">${esc(c.label)}<span class="x">✕</span></button>`).join('') + saveBtn;
  wrap.querySelectorAll('[data-i]').forEach((btn) => btn.addEventListener('click', () => {
    chips[Number(btn.dataset.i)].onRemove();
    view.page = 1;
    buildFilterPanel();
    render();
  }));
  const sb = wrap.querySelector('.save-view-btn');
  if (sb) sb.addEventListener('click', saveCurrentAsView);
}

// Filter panel open/close
$('#filterBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('#filterPanel').classList.toggle('hidden');
  $('#filterBtn').setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.filter-menu')) $('#filterPanel').classList.add('hidden');
});

// ---- Events: view ----
$('#viewTile').addEventListener('click', () => { view.mode = 'tile'; saveView(); render(); });
$('#viewRow').addEventListener('click', () => { view.mode = 'row'; saveView(); render(); });
$('#selectBtn').addEventListener('click', () => setSelectMode(!selectMode));
$('#listEditBtn').addEventListener('click', () => setListEdit(!listEditMode));
$('#tileSize').addEventListener('change', (e) => { view.size = e.target.value; saveView(); render(); });
$('#pageSize').addEventListener('change', (e) => {
  view.pageSize = e.target.value === 'all' ? 'all' : Number(e.target.value);
  view.page = 1; saveView(); render();
});
$('#prevPage').addEventListener('click', () => { if (view.page > 1) { view.page--; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
$('#nextPage').addEventListener('click', () => { view.page++; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

// Fields popover
$('#fieldsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('#fieldsPanel');
  const open = panel.classList.toggle('hidden');
  $('#fieldsBtn').setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.fields-menu')) $('#fieldsPanel').classList.add('hidden');
});

$('#addBtn').addEventListener('click', () => openAdd());

// ---- Sidebar navigation ----
document.querySelectorAll('#sidebarNav .nav-item').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view))
);

// ---- Toolbar data menu (Import / Export / Backup / Restore) ----
$('#dataMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('#dataPanel');
  const open = panel.classList.toggle('hidden');
  $('#dataMenuBtn').setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.data-menu')) $('#dataPanel').classList.add('hidden');
});
$('#dataPanel').addEventListener('click', () => $('#dataPanel').classList.add('hidden'));

document.querySelectorAll('[data-close]').forEach((el) =>
  el.addEventListener('click', (e) => {
    if (e.target !== el) return;
    if (el.closest('#lightbox')) $('#lightbox').classList.add('hidden');
    else if (el.closest('#settingsModal')) closeSettings();
    else if (el.closest('#loginModal')) closeLogin();
    else if (el.closest('#detailModal')) closeDetail();
    else closeModal();
  })
);
document.addEventListener('keydown', (e) => {
  // ⌘K / Ctrl+K → jump to search
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (currentView !== 'collection') setView('collection');
    const s = $('#search'); if (s) { s.focus(); s.select(); }
    return;
  }
  // ←/→ steps through yoyos while the detail view is open (not while typing)
  const detailOpen = !$('#detailModal').classList.contains('hidden');
  if (detailOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    detailStep(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (e.key !== 'Escape') return;
  if (!$('#lightbox').classList.contains('hidden')) $('#lightbox').classList.add('hidden');
  else if (!$('#settingsModal').classList.contains('hidden')) closeSettings();
  else if (!$('#loginModal').classList.contains('hidden')) closeLogin();
  else if (!modal.classList.contains('hidden')) closeModal();
  else if (detailOpen) closeDetail();
});

// ---- Focus trap: keep Tab within the topmost open modal ----
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const modals = [...document.querySelectorAll('.modal')].filter((m) => !m.classList.contains('hidden') && m.offsetParent !== null);
  const top = modals[modals.length - 1];
  if (!top) return;
  const f = [...top.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ---- Utils ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---- Access / login ----
// On a public demo, show a friendly "editing is disabled" message instead of
// letting a write hit the server and come back a 403. Returns true if blocked.
const DEMO_LOCK_MSG = 'This is a read-only demo — editing is disabled.';
function demoGuard() {
  if (!demoModeState) return false;
  toast(DEMO_LOCK_MSG, 'error');
  return true;
}

// Banner + tooltips for a public demo so visitors know what they're looking at
// and that editing is off. (Writes are also blocked server-side regardless.)
function renderDemoBanner(loggedIn) {
  document.body.classList.toggle('demo-mode', demoModeState);
  const tip = demoModeState ? 'Editing is disabled in this demo' : '';
  ['#addBtn', '#saveBtn', '#saveAddAnotherBtn', '#deleteBtn', '#detailEdit', '#detailDelete', '#selectBtn']
    .forEach((sel) => { const el = $(sel); if (el) el.title = tip; });

  let bar = document.getElementById('demoBanner');
  if (!demoModeState) { if (bar) bar.remove(); return; }
  const content = document.querySelector('.content');
  if (!content) return;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'demoBanner';
    bar.className = 'demo-banner';
    content.prepend(bar);
  }
  bar.innerHTML = loggedIn
    ? '🪀 <strong>Demo</strong> — this is the owner view. Editing is disabled in the demo.'
    : '🪀 <strong>Live demo.</strong> Log in with password <strong>demo</strong> to see the owner view. Editing is disabled.';
}

// Fetches /api/config (edit permission, login/demo state, whether carrier
// tracking is configured) and updates the chrome accordingly — this runs once
// on load and again after login/logout.
async function loadConfig() {
  let c = { canEdit: true, loginEnabled: false, loggedIn: false };
  try { c = await api('/api/config'); } catch { /* default: editable */ }
  canEditState = !!c.canEdit;
  trackingEnabledState = !!c.trackingEnabled;
  demoModeState = !!c.demoMode;
  renderDemoBanner(!!c.loggedIn);
  document.body.classList.toggle('read-only', !c.canEdit);
  $('#loginBtn').classList.toggle('hidden', !c.loginEnabled || c.loggedIn);
  $('#logoutBtn').classList.toggle('hidden', !c.loggedIn);
  $('#navArrivals').classList.toggle('hidden', !canEditState); // Arrivals is owner-only
  $('#navSold').classList.toggle('hidden', !canEditState); // Sold history is owner-only
  if (!canEditState && (currentView === 'arrivals' || currentView === 'sold')) setView('collection');
  updateToolbar();
  renderSmartViews();
  applySortVisibility();
}

// In public view, the financial sort options would sort by hidden data, so hide them.
function applySortVisibility() {
  const sensitive = ['paid', 'retail', 'percent_off', 'purchase_date', 'sold_date', 'market_value'];
  [...$('#sort').options].forEach((o) => {
    const hide = !canEditState && sensitive.includes(o.value);
    o.hidden = hide;
    o.disabled = hide;
  });
  if (!canEditState && sensitive.includes(filters.sort)) {
    filters.sort = 'brand'; filters.sortDir = 'asc'; $('#sort').value = 'brand';
  }
}

$('#loginBtn').addEventListener('click', () => {
  $('#loginError').classList.add('hidden');
  $('#loginForm').reset();
  $('#loginModal').classList.remove('hidden');
  $('#loginForm').password.focus();
});
function closeLogin() { $('#loginModal').classList.add('hidden'); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#loginForm').password.value }),
    });
    if (r && r.token) { try { localStorage.setItem('yoyoToken', r.token); } catch { /* ignore */ } }
    closeLogin();
    await loadConfig();
    await loadAll();
  } catch (err) {
    $('#loginError').textContent = err.message || 'Incorrect password.';
    $('#loginError').classList.remove('hidden');
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  try { localStorage.removeItem('yoyoToken'); } catch { /* ignore */ }
  closeModal(); closeDetail();
  await loadConfig();
  await loadAll();
});

// ---- Backup / restore ----
$('#restoreBtn').addEventListener('click', () => $('#restoreInput').click());
$('#restoreInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!await confirmDialog({ title: 'Restore from backup?', message: 'This REPLACES your entire collection — all yoyos and photos — with the contents of this backup.', confirmText: 'Restore', danger: true })) {
    e.target.value = '';
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await api('/api/restore', { method: 'POST', body: fd });
    await loadAll();
    toast(`Restore complete — ${r.yoyos} yoyos, ${r.photoFiles} photos.`, 'ok');
  } catch (err) {
    toast('Restore failed: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
});

// ---- Settings: theme (Auto follows the OS; Light/Dark force it) ----
function syncThemeSeg() {
  const cur = document.documentElement.dataset.theme || 'auto';
  document.querySelectorAll('#themeSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === cur));
}
// Applies and persists a theme choice ('auto' follows the OS; 'light'/'dark' force it).
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else { delete document.documentElement.dataset.theme; t = 'auto'; }
  try { localStorage.setItem('yoyoTheme', t); } catch { /* ignore */ }
  syncThemeSeg();
}
document.querySelectorAll('#themeSeg .seg-btn').forEach((b) =>
  b.addEventListener('click', () => applyTheme(b.dataset.theme))
);

// ---- Settings: design language (independent of light/dark theme) ----
function syncDesignSeg() {
  const cur = document.documentElement.dataset.design || 'precision';
  document.querySelectorAll('#designSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.design === cur));
}
// Applies and persists a design language. Sets data-design to the chosen
// value; only [data-design="precision"] has a rule layer, so 'classic' simply
// falls through to the base look.
function applyDesign(d) {
  document.documentElement.dataset.design = d;
  try { localStorage.setItem('yoyoDesign', d); } catch { /* ignore */ }
  syncDesignSeg();
}
document.querySelectorAll('#designSeg .seg-btn').forEach((b) =>
  b.addEventListener('click', () => applyDesign(b.dataset.design))
);

// ---- Settings modal ----
$('#settingsBtn').addEventListener('click', () => {
  syncThemeSeg();
  syncDesignSeg();
  renderFieldList();
  resetAddFieldForm();
  $('#settingsModal').classList.remove('hidden');
});

function closeSettings() { $('#settingsModal').classList.add('hidden'); }

// Generate thumbnails for existing photos (one-time, cuts image bandwidth).
$('#optimizePhotosBtn').addEventListener('click', async () => {
  const btn = $('#optimizePhotosBtn');
  const status = $('#optimizeStatus');
  btn.disabled = true;
  status.className = 'status-banner';
  status.classList.remove('hidden');
  status.textContent = 'Generating thumbnails… this can take a minute.';
  try {
    const r = await api('/api/photos/optimize', { method: 'POST' });
    status.className = 'status-banner ok';
    status.textContent = `Done — ${r.processed} optimized, ${r.skipped} already done${r.failed ? `, ${r.failed} failed` : ''} (of ${r.total}).`;
    await loadAll();
  } catch (err) {
    status.className = 'status-banner warn';
    status.textContent = 'Failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---- Settings: custom field management ----
// Fetches custom field definitions from the server and rebuilds ALL_FIELDS.
async function loadFields() {
  try { customDefs = await api('/api/fields'); } catch { customDefs = []; }
  rebuildRegistry();
}
// Drops any view.fields entries pointing at a custom field that's since been
// deleted, so a stale key doesn't linger in the field picker/localStorage.
function pruneViewFields() {
  const keys = new Set(ALL_FIELDS.map((f) => f.key));
  view.fields = view.fields.filter((k) => keys.has(k));
  saveView();
}
let editingFieldId = null;

// Renders the Settings → custom fields list, with reorder/edit/delete controls.
function renderFieldList() {
  const list = $('#fieldList');
  if (!customDefs.length) { list.innerHTML = '<p class="hint">No custom fields yet.</p>'; return; }
  const typeLabel = { text: 'Text', number: 'Number', select: 'Choice', boolean: 'Yes/No' };
  list.innerHTML = customDefs.map((d, i) => `
    <div class="field-row">
      <div class="field-row-main"><strong>${esc(d.label)}</strong>
        <span class="muted-sm">${typeLabel[d.type] || d.type}${d.type === 'select' ? ': ' + esc(d.options.join(', ')) : ''}</span>
      </div>
      <div class="field-row-actions">
        <button class="icon-btn" data-up="${d.id}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="icon-btn" data-down="${d.id}" ${i === customDefs.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button class="icon-btn" data-edit-field="${d.id}" title="Edit field">✎</button>
        <button class="icon-btn" data-del-field="${d.id}" title="Delete field">✕</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-del-field]').forEach((b) => b.addEventListener('click', () => deleteField(Number(b.dataset.delField))));
  list.querySelectorAll('[data-edit-field]').forEach((b) => b.addEventListener('click', () => editField(Number(b.dataset.editField))));
  list.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => reorderField(Number(b.dataset.up), -1)));
  list.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => reorderField(Number(b.dataset.down), 1)));
}

// Deletes a custom field definition (after confirming) and strips its values
// out of every yoyo — the server does the same on its side.
async function deleteField(id) {
  const d = customDefs.find((x) => x.id === id);
  if (!await confirmDialog({ title: `Delete the “${d ? d.label : ''}” field?`, message: 'Its values will be removed from every yoyo.', confirmText: 'Delete', danger: true })) return;
  try {
    customDefs = await api('/api/fields/' + id, { method: 'DELETE' });
    rebuildRegistry(); pruneViewFields(); renderFieldList(); buildFieldsPanel();
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

// Swaps a custom field with its neighbor (up/down) and persists the new order.
async function reorderField(id, dir) {
  const idx = customDefs.findIndex((d) => d.id === id);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= customDefs.length) return;
  const ids = customDefs.map((d) => d.id);
  [ids[idx], ids[j]] = [ids[j], ids[idx]];
  try {
    customDefs = await api('/api/fields/reorder', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    });
    rebuildRegistry(); renderFieldList(); buildFieldsPanel();
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

// Opens the add-field form pre-filled for editing an existing custom field
// (its type is locked — only text/select fields can add options after creation).
function editField(id) {
  const d = customDefs.find((x) => x.id === id);
  if (!d) return;
  editingFieldId = id;
  const f = $('#addFieldForm');
  f.classList.remove('hidden');
  $('#newFieldBtn').classList.add('hidden');
  f.label.value = d.label;
  f.type.value = d.type;
  f.type.disabled = true; // type can't change after creation
  $('#optionsWrap').hidden = d.type !== 'select';
  f.options.value = d.type === 'select' ? d.options.join(', ') : '';
  $('#fieldError').classList.add('hidden');
  $('#fieldSubmitBtn').textContent = 'Save changes';
  f.label.focus();
}

// Clears and hides the add/edit-field form, back to its "Add field" state.
function resetAddFieldForm() {
  const f = $('#addFieldForm');
  f.reset();
  f.classList.add('hidden');
  f.type.disabled = false;
  editingFieldId = null;
  $('#fieldSubmitBtn').textContent = 'Add field';
  $('#newFieldBtn').classList.remove('hidden');
  $('#optionsWrap').hidden = true;
  $('#fieldError').classList.add('hidden');
}
$('#newFieldBtn').addEventListener('click', () => {
  resetAddFieldForm();
  $('#addFieldForm').classList.remove('hidden');
  $('#newFieldBtn').classList.add('hidden');
  $('#addFieldForm').label.focus();
});
$('#cancelAddField').addEventListener('click', resetAddFieldForm);
$('#addFieldForm').type.addEventListener('change', (e) => {
  $('#optionsWrap').hidden = e.target.value !== 'select';
});
$('#addFieldForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const editing = editingFieldId;
  const type = editing ? customDefs.find((d) => d.id === editing).type : f.type.value;
  const body = { label: f.label.value };
  if (!editing) body.type = type;
  if (type === 'select') body.options = f.options.value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    customDefs = await api(editing ? '/api/fields/' + editing : '/api/fields', {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    rebuildRegistry(); renderFieldList(); resetAddFieldForm(); buildFieldsPanel();
    await loadAll();
  } catch (err) {
    $('#fieldError').textContent = err.message;
    $('#fieldError').classList.remove('hidden');
  }
});

// ---- Iframe auto-resize: tell a parent page (e.g. WordPress) our height ----
// Tells an embedding parent page (e.g. WordPress via ?embed=1) our current
// content height, via postMessage, so the host iframe can resize to fit.
function postHeight() {
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'yoyo-collection-height', height: document.documentElement.scrollHeight }, '*');
    }
  } catch { /* ignore */ }
}
if (window.ResizeObserver) new ResizeObserver(postHeight).observe(document.body);
window.addEventListener('load', postHeight);

// When embedded, the host page tells us which slice of the iframe is on screen,
// so modals/lightbox open where the user is looking (not at the iframe's top).
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'yoyo-host-viewport') return;
  if (typeof d.top === 'number') document.documentElement.style.setProperty('--host-top', Math.max(0, d.top) + 'px');
  if (typeof d.height === 'number') document.documentElement.style.setProperty('--host-height', d.height + 'px');
  document.body.classList.add('host-scroll');
});

// ---- Embed mode (?embed=1): hide the app's own title/login so it nests cleanly
//      as a section inside another page. Theme is set via ?theme= in the head. ----
if (new URLSearchParams(location.search).get('embed')) document.body.classList.add('embed');

// ---- Go ----
(async () => {
  await loadConfig();
  await Promise.all([loadFields(), loadSettings()]);
  buildFieldsPanel();
  // Deep link: /y/:id opens one yoyo as a focused, shareable read-only view.
  const shareId = Number((location.pathname.match(/^\/y\/(\d+)/) || [])[1]) || null;
  // Deep link: yoyo.example.com/#sale opens the For Sale page directly (shareable).
  const hash = (location.hash || '').replace('#', '').toLowerCase();
  if (shareId) {
    // Stay on the collection underneath; the share view opens once data loads.
  } else if (hash === 'sale' || hash === 'for-sale') {
    setView('sale');
  } else {
    try {
      const t = localStorage.getItem('yoyoTab');
      if (t && t !== 'collection') setView(t);
    } catch { /* ignore */ }
  }
  if (currentView === 'collection') renderSkeleton();
  loadAll()
    .then(() => { if (shareId) openShareView(shareId); })
    .catch((err) => toast('Failed to load: ' + err.message, 'error'));
})();
