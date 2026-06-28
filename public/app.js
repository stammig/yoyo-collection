// ---- State ----
let yoyos = [];
let filters = {
  q: '', sort: 'brand', sortDir: 'asc',
  brands: [], compositions: [], conditions: [],
  material: '', status: '', retiredOnly: false, favOnly: false,
  paidMin: null, paidMax: null, retailMin: null, retailMax: null, weightMin: null, weightMax: null,
};
let editingId = null;
let detailId = null;        // id currently shown in the read-only detail modal
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
};

// Hidden from public viewers (financial, shipping, ownership status).
const SENSITIVE = new Set(['retail', 'paid', 'percent_off', 'tracking', 'eta', 'in_hand']);

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
  { key: 'percent_off', label: '% Off', fmt: (v) => (v == null ? '' : v + '%'), num: true },
  { key: 'sale_status', label: 'Sale' },
  { key: 'sale_price', label: 'Asking', fmt: money, num: true },
  { key: 'weight_g', label: 'Weight', fmt: (v) => (v ? v + ' g' : ''), num: true },
  { key: 'diameter_mm', label: 'Diameter', fmt: (v) => (v ? v + ' mm' : ''), num: true },
  { key: 'width_mm', label: 'Width', fmt: (v) => (v ? v + ' mm' : ''), num: true },
  { key: 'gap_mm', label: 'Gap', fmt: (v) => (v ? v + ' mm' : ''), num: true },
  { key: 'bearing_size', label: 'Bearing' },
  { key: 'response_type', label: 'Response' },
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

function customToDef(d) {
  return {
    key: d.key, label: d.label, custom: true, type: d.type, options: d.options || [],
    num: d.type === 'number',
    fmt: d.type === 'boolean' ? (v) => (v ? '✓' : '') : (v) => (v == null ? '' : String(v)),
  };
}
function rebuildRegistry() {
  ALL_FIELDS = [...FIELD_DEFS, ...customDefs.map(customToDef)];
  FIELD_BY_KEY = Object.fromEntries(ALL_FIELDS.map((f) => [f.key, f]));
}

const fmtField = (key, val) => (FIELD_BY_KEY[key]?.fmt ? FIELD_BY_KEY[key].fmt(val) : (val ?? ''));
// Read a field's value whether it's a built-in column or a custom field.
const valueOf = (y, key) => (FIELD_BY_KEY[key]?.custom ? (y.custom ? y.custom[key] : undefined) : y[key]);

const NUMERIC_KEYS = new Set(['retail', 'paid', 'percent_off', 'weight_g', 'diameter_mm', 'width_mm', 'gap_mm']);
const defaultDir = (key) => (NUMERIC_KEYS.has(key) || FIELD_BY_KEY[key]?.num || key === 'favorite' || key === 'in_hand' ? 'desc' : 'asc');

// Field groups for the read-only detail view.
const DETAIL_GROUPS = [
  ['Overview', ['color', 'composition', 'body_material', 'condition']],
  ['Pricing', ['retail', 'paid', 'percent_off']],
  ['Specs', ['weight_g', 'diameter_mm', 'width_mm', 'gap_mm', 'bearing_size', 'response_type']],
  ['Acquisition', ['release_date', 'tracking', 'eta']],
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
async function loadAll() {
  yoyos = await api('/api/yoyos');
  refreshDatalists();
  refreshCurrentView();
}


// Stats reflect whatever is currently filtered/shown.
function renderStats(list) {
  let inHand = 0, paid = 0, retail = 0;
  for (const y of list) {
    if (y.in_hand) inHand++;
    paid += y.paid || 0;
    retail += y.retail || 0;
  }
  const count = list.length;
  const filtered = count !== yoyos.length;
  const countLabel = filtered ? `of ${yoyos.length} shown` : 'Yoyos';

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
};
const DATALIST_SEEDS = {
  compositionList: ['BI', 'MN', 'TRI'],
  conditionList: ['MiB', 'NMBTS', 'Used', 'Beat'],
  bearingList: ['Size C', 'Size D'],
};

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

function filteredYoyos() {
  let list = yoyos.slice();
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

function renderSkeleton(n = 10) {
  if (!grid) return;
  grid.className = `grid size-${view.size}`;
  grid.innerHTML = Array.from({ length: n }, () =>
    '<div class="skel-card"><div class="skel-photo"></div><div class="skel-lines">' +
    '<div class="skel-line w40"></div><div class="skel-line w80"></div><div class="skel-line w60"></div>' +
    '</div></div>').join('');
  emptyMsg.classList.add('hidden');
}

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
function setView(v) {
  if (v === 'arrivals' && !canEditState) v = 'collection';
  currentView = v;
  try { localStorage.setItem('yoyoTab', v); } catch { /* ignore */ }
  document.querySelectorAll('#sidebarNav .nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === v));
  $('#viewCollection').classList.toggle('hidden', v !== 'collection');
  $('#viewArrivals').classList.toggle('hidden', v !== 'arrivals');
  $('#viewSale').classList.toggle('hidden', v !== 'sale');
  $('#viewInsights').classList.toggle('hidden', v !== 'insights');
  $('#viewTitle').textContent = v === 'arrivals' ? 'Arrivals' : v === 'sale' ? 'For Sale' : v === 'insights' ? 'Insights' : 'Collection';
  updateToolbar();
  if (v === 'arrivals') renderArrivals();
  else if (v === 'sale') renderSale();
  else if (v === 'insights') renderInsights();
  else render();
}
function updateToolbar() {
  $('#collectionActions').classList.toggle('hidden', !(currentView === 'collection' && canEditState));
}
function refreshCurrentView() {
  if (currentView === 'arrivals') renderArrivals();
  else if (currentView === 'sale') renderSale();
  else if (currentView === 'insights') renderInsights();
  else render();
}

// ---- Quick actions (favorite / delete / context menu) ----
function buildPayload(y) {
  const p = {};
  ['brand', 'model', 'color', 'body_material', 'composition', 'condition',
    'bearing_size', 'response_type', 'description', 'release_date', 'tracking', 'eta', 'sale_status']
    .forEach((k) => { p[k] = y[k] ?? ''; });
  ['retail', 'paid', 'weight_g', 'diameter_mm', 'width_mm', 'gap_mm', 'sale_price']
    .forEach((k) => { p[k] = y[k] ?? ''; });
  p.in_hand = !!y.in_hand;
  p.favorite = !!y.favorite;
  p.retired = !!y.retired;
  p.custom = y.custom || {};
  return p;
}
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
async function deleteYoyoQuick(id) {
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  if (!await confirmDialog({ title: `Delete ${y.brand} ${y.model}?`, message: 'This removes the yoyo and its photos. This can’t be undone.', confirmText: 'Delete', danger: true })) return;
  try { await api(`/api/yoyos/${id}`, { method: 'DELETE' }); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}
function dismissCardMenu() { document.querySelectorAll('.context-menu').forEach((m) => m.remove()); }
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
function filterSnapshot() {
  const { sort, sortDir, ...rest } = filters; // views capture criteria, not sort
  return JSON.parse(JSON.stringify(rest));
}
function applySmartView(v) {
  const snap = JSON.parse(JSON.stringify(v.filters));
  Object.assign(filters, snap);
  $('#search').value = filters.q || '';
  if (currentView !== 'collection') setView('collection');
  view.page = 1;
  buildFilterPanel();
  render();
}
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
};
function setListEdit(on) {
  listEditMode = on;
  if (on) setSelectMode(false);
  document.body.classList.toggle('list-edit', on);
  const btn = $('#listEditBtn');
  if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); }
  render();
}
function editableKeys() {
  // built-in fields safe to edit inline (no photos/custom here)
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
    render();
  } catch (err) { toast(err.message, 'error'); render(); }
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
function thumbHTML(y, cls) {
  const p = (y.photos && y.photos[0]) ? y.photos[0] : null;
  if (p) return `<img class="${cls}" src="${esc(p.thumbUrl || p.url)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${esc(p.url)}'">`;
  return `<div class="${cls}"></div>`;
}
function barChart(rows, color) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  return `<div class="barchart">` + rows.map((r) =>
    `<div class="bar-row"><span class="bar-name" title="${esc(r.name)}">${esc(r.name)}</span>` +
    `<div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, r.value / max * 100).toFixed(1)}%;background:${color}"></div></div>` +
    `<span class="bar-val">${esc(r.display)}</span></div>`
  ).join('') + `</div>`;
}

// ============================================================
//  Arrivals (calendar of incoming on-order yoyos) — admin only
// ============================================================
let calMonth = firstOfMonth(new Date());
let calSelected = null;
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
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
function arrivalRow(y, sub) {
  const queryBtn = trackingEnabledState
    ? `<button class="btn btn-ghost btn-sm arr-query" data-track-query="${y.id}" title="Look up ETA from the carrier">${SVG.box}<span>Query ETA</span></button>`
    : '';
  return `<div class="arrival-row" data-arr="${y.id}">${thumbHTML(y, 'arrival-thumb')}` +
    `<div class="arrival-main">` +
      `<div class="arrival-name">${esc(y.brand)} ${esc(y.model)}</div>` +
      `<div class="arrival-sub">${esc(sub)}</div>` +
      `<div class="arrival-edit">` +
        `<input class="arr-field arr-track" data-track-input="${y.id}" value="${esc(y.tracking || '')}" placeholder="Tracking number" />` +
        `<input class="arr-field arr-eta" type="date" data-eta-input="${y.id}" value="${toDateInputValue(y.eta)}" />` +
        queryBtn +
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
function renderSale() {
  const wrap = $('#viewSale');
  const items = yoyos.filter((y) => isForSale(y.sale_status))
    .sort((a, b) => String(a.brand || '').localeCompare(String(b.brand || '')) || String(a.model || '').localeCompare(String(b.model || '')));
  const body = items.length
    ? `<p class="sale-intro">${items.length} yoyo${items.length === 1 ? '' : 's'} available — tap any for full specs and photos.</p>`
      + `<div class="sale-grid">${items.map(saleCardHTML).join('')}</div>`
    : '<div class="insight-note">Nothing listed for sale or trade right now — check back soon.</div>';
  wrap.innerHTML = saleNotesHTML() + body;

  const saveBtn = $('#saveSaleNotes');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const val = $('#saleNotesInput').value;
    saveBtn.disabled = true;
    try {
      await api('/api/settings/sale_notes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: val }) });
      saleNotes = val;
      toast('Notes saved.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
    saveBtn.disabled = false;
  });
  wrap.querySelectorAll('.sale-card[data-id]').forEach((el) => {
    const id = Number(el.dataset.id);
    el.addEventListener('click', () => openDetail(id));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(id); } });
  });
}

// ============================================================
//  Insights (metrics, standouts, charts)
// ============================================================
function maxBy(arr, key) { let best = null; for (const y of arr) { const v = y[key]; if (v == null) continue; if (!best || v > best[key]) best = y; } return best; }
function minBy(arr, key) { let best = null; for (const y of arr) { const v = y[key]; if (v == null) continue; if (!best || v < best[key]) best = y; } return best; }
function tallyTop(arr, key, n) {
  const m = {};
  for (const y of arr) { const k = y[key]; if (!k) continue; m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, n);
}
function spendByBrand(n) {
  const m = {};
  for (const y of yoyos) { if (y.paid == null || !y.brand) continue; m[y.brand] = (m[y.brand] || 0) + y.paid; }
  return Object.entries(m).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount).slice(0, n);
}
function compositionTally() {
  const labels = { BI: 'Bi-metal', MN: 'Mono-metal', TRI: 'Tri-metal' };
  return ['BI', 'MN', 'TRI'].map((c) => ({ name: labels[c], count: yoyos.filter((y) => y.composition === c).length })).filter((t) => t.count > 0);
}
function metricCard(value, label, cls = '') {
  return `<div class="metric-card"><div class="metric-value ${cls}">${esc(value)}</div><div class="metric-label">${esc(label)}</div></div>`;
}
function insightCard(title, inner) { return inner ? `<div class="insight-card"><h3>${esc(title)}</h3>${inner}</div>` : ''; }

function renderInsights() {
  const wrap = $('#viewInsights');
  if (!yoyos.length) { wrap.innerHTML = '<div class="insight-note">Add some yoyos to see insights.</div>'; return; }
  const admin = canEditState;
  const count = yoyos.length;
  const inHand = yoyos.filter((y) => y.in_hand).length;
  const totalRetail = yoyos.reduce((a, y) => a + (y.retail || 0), 0);
  const totalPaid = yoyos.reduce((a, y) => a + (y.paid || 0), 0);
  const saved = yoyos.reduce((a, y) => (y.retail != null && y.paid != null) ? a + (y.retail - y.paid) : a, 0);
  const discounts = yoyos.map((y) => y.percent_off).filter((v) => v != null);
  const avgDiscount = discounts.length ? discounts.reduce((a, b) => a + b, 0) / discounts.length : null;
  const paids = yoyos.map((y) => y.paid).filter((v) => v != null);
  const avgPaid = paids.length ? paids.reduce((a, b) => a + b, 0) / paids.length : null;

  let metrics = metricCard(String(count), 'Yoyos');
  if (admin) {
    metrics += metricCard(String(inHand), 'In hand');
    metrics += metricCard(String(count - inHand), 'On order');
    metrics += metricCard(money0(totalRetail), 'Collection value', 'accent');
    metrics += metricCard(money0(totalPaid), 'Total paid');
    metrics += metricCard(money0(saved), 'Saved', 'green');
    if (avgDiscount != null) metrics += metricCard(`${Math.round(avgDiscount)}%`, 'Avg discount', 'green');
    if (avgPaid != null) metrics += metricCard(money0(avgPaid), 'Avg paid');
  } else {
    metrics += metricCard(String(new Set(yoyos.map((y) => y.brand).filter(Boolean)).size), 'Brands');
  }

  const standouts = [];
  if (admin) { const y = maxBy(yoyos, 'retail'); if (y) standouts.push({ icon: SVG.gem, label: 'Most valuable', y, value: money(y.retail) }); }
  if (admin) { const y = maxBy(yoyos.filter((x) => (x.percent_off || 0) > 0), 'percent_off'); if (y) standouts.push({ icon: SVG.tag, label: 'Best deal', y, value: `${y.percent_off}% off` }); }
  { const y = maxBy(yoyos, 'weight_g'); if (y) standouts.push({ icon: SVG.scale, label: 'Heaviest', y, value: `${trimNum(y.weight_g)} g` }); }
  { const y = minBy(yoyos, 'weight_g'); if (y) standouts.push({ icon: SVG.feather, label: 'Lightest', y, value: `${trimNum(y.weight_g)} g` }); }
  const standoutsHTML = standouts.length ? insightCard('Standouts',
    `<div class="standouts">${standouts.map((s) =>
      `<div class="standout-row" data-arr="${s.y.id}"><span class="standout-icon">${s.icon}</span>${thumbHTML(s.y, 'standout-thumb')}` +
      `<div class="standout-main"><div class="standout-label">${esc(s.label)}</div><div class="standout-name">${esc(s.y.brand)} ${esc(s.y.model)}</div></div>` +
      `<span class="standout-value">${esc(s.value)}</span></div>`).join('')}</div>`) : '';

  const brandRows = tallyTop(yoyos.filter((y) => y.brand), 'brand', 8).map((t) => ({ name: t.name, value: t.count, display: String(t.count) }));
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
function openDetail(id) {
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  detailId = id;
  detailList = filteredYoyos().map((x) => x.id); // for prev/next, in the current order
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
  if (canEditState && (y.paid != null || y.retail != null)) {
    const parts = [];
    if (y.paid != null) parts.push(`<span class="dh-paid">${money(y.paid)}</span>`);
    if (y.retail != null) parts.push(`<span class="dh-retail">${money(y.retail)} retail</span>`);
    if (y.percent_off != null && y.percent_off > 0) parts.push(`<span class="off">${y.percent_off}% off</span>`);
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

function closeDetail() { $('#detailModal').classList.add('hidden'); detailId = null; }
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

// ---- Modal: add / edit ----
let addAnother = false;   // set by "Save & add another"
let lastBrand = '';       // carried over between add-another saves
function openAdd(prefillBrand = '') {
  editingId = null;
  cameFromDetail = false;
  $('#modalTitle').textContent = 'Add a yoyo';
  $('#saveBtn').textContent = 'Add to collection';
  form.reset();
  $('#deleteBtn').classList.add('hidden');
  $('#saveAddAnotherBtn').classList.remove('hidden'); // only meaningful when adding
  if (prefillBrand) form.brand.value = prefillBrand;
  renderPhotoStrip([]);
  renderCustomFields({});
  updatePercentOff();
  syncTiles();
  updateHero();
  showModal();
}

function openEdit(id, fromDetail = false) {
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  editingId = id;
  cameFromDetail = fromDetail;
  $('#detailModal').classList.add('hidden'); // hide detail while editing
  $('#modalTitle').textContent = `${y.brand} ${y.model}`.trim() || 'Edit Yoyo';
  $('#saveBtn').textContent = 'Save changes';
  form.reset();
  for (const [k, v] of Object.entries(y)) {
    const field = form.elements[k];
    if (!field || field.tagName === undefined) continue;
    if (field.type === 'checkbox') field.checked = !!v;
    else if (k === 'eta') field.value = toDateInputValue(v); // date input needs YYYY-MM-DD
    else field.value = v == null ? '' : v;
  }
  $('#deleteBtn').classList.remove('hidden');
  $('#saveAddAnotherBtn').classList.add('hidden'); // editing an existing one
  renderPhotoStrip(y.photos);
  renderCustomFields(y.custom || {});
  updatePercentOff();
  syncTiles();
  updateHero();
  showModal();
}

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

function renderPhotoStrip(photos) {
  // Dropzone only makes sense once the yoyo exists (uploads need an id).
  $('#dropzone').classList.toggle('hidden', !editingId);
  const note = !editingId ? '<p class="hint">Save first to start adding photos.</p>' : '';
  const hint = (editingId && photos.length > 1)
    ? '<p class="hint photo-hint">Drag to reorder — the first photo is the cover.</p>' : '';
  photoStrip.innerHTML =
    photos.map((p, i) => `
      <div class="photo-thumb" draggable="true" data-pid="${p.id}">
        <img src="${esc(p.thumbUrl || p.url)}" alt="" data-full="${p.url}" draggable="false" loading="lazy" onerror="this.onerror=null;this.src='${p.url}'" />
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
  // If the form was opened from the detail view, return to it.
  if (id && cameFromDetail) { cameFromDetail = false; openDetail(id); }
}

// ---- Form submit ----
form.addEventListener('input', (e) => {
  if (e.target.name === 'retail' || e.target.name === 'paid') updatePercentOff();
  e.target.classList?.remove('ai-filled'); // it's yours once you touch it
  updateHero();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (demoGuard()) return;
  const data = Object.fromEntries(new FormData(form).entries());
  data.in_hand = form.in_hand.checked;
  data.favorite = form.favorite.checked;
  data.retired = form.retired.checked;
  data.custom = collectCustom();
  delete data.id;

  const isNew = !editingId;
  const another = addAnother; addAnother = false;
  try {
    let saved;
    if (editingId) {
      saved = await api(`/api/yoyos/${editingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
    } else {
      saved = await api('/api/yoyos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      editingId = saved.id;
    }
    await loadAll();
    if (isNew && another) {
      lastBrand = (data.brand || '').trim();
      editingId = null;
      openAdd(lastBrand); // straight into a fresh form, brand carried over
      toast('Saved. Add the next one…', 'ok');
    } else if (isNew) {
      openEdit(editingId); // new yoyo: stay in the form to add photos right away
      toast('Saved — add photos below, or close.', 'ok');
    } else {
      const id = editingId;
      modal.classList.add('hidden');
      editingId = null;
      cameFromDetail = false;
      openDetail(id); // edited existing: show the updated detail view
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

function updateFilterCount() {
  const badge = $('#filterCount');
  if (!badge) return;
  const n = activeFilterCount();
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

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
  if (!canEditState && currentView === 'arrivals') setView('collection');
  updateToolbar();
  renderSmartViews();
  applySortVisibility();
}

// In public view, the financial sort options would sort by hidden data, so hide them.
function applySortVisibility() {
  const sensitive = ['paid', 'retail', 'percent_off'];
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
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else { delete document.documentElement.dataset.theme; t = 'auto'; }
  try { localStorage.setItem('yoyoTheme', t); } catch { /* ignore */ }
  syncThemeSeg();
}
document.querySelectorAll('#themeSeg .seg-btn').forEach((b) =>
  b.addEventListener('click', () => applyTheme(b.dataset.theme))
);

// ---- Settings modal ----
$('#settingsBtn').addEventListener('click', () => {
  syncThemeSeg();
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
  status.className = 'autofill-status';
  status.classList.remove('hidden');
  status.textContent = 'Generating thumbnails… this can take a minute.';
  try {
    const r = await api('/api/photos/optimize', { method: 'POST' });
    status.className = 'autofill-status ok';
    status.textContent = `Done — ${r.processed} optimized, ${r.skipped} already done${r.failed ? `, ${r.failed} failed` : ''} (of ${r.total}).`;
    await loadAll();
  } catch (err) {
    status.className = 'autofill-status warn';
    status.textContent = 'Failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---- Settings: custom field management ----
async function loadFields() {
  try { customDefs = await api('/api/fields'); } catch { customDefs = []; }
  rebuildRegistry();
}
function pruneViewFields() {
  const keys = new Set(ALL_FIELDS.map((f) => f.key));
  view.fields = view.fields.filter((k) => keys.has(k));
  saveView();
}
let editingFieldId = null;

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

async function deleteField(id) {
  const d = customDefs.find((x) => x.id === id);
  if (!await confirmDialog({ title: `Delete the “${d ? d.label : ''}” field?`, message: 'Its values will be removed from every yoyo.', confirmText: 'Delete', danger: true })) return;
  try {
    customDefs = await api('/api/fields/' + id, { method: 'DELETE' });
    rebuildRegistry(); pruneViewFields(); renderFieldList(); buildFieldsPanel();
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

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
  // Deep link: yoyo.example.com/#sale opens the For Sale page directly (shareable).
  const hash = (location.hash || '').replace('#', '').toLowerCase();
  if (hash === 'sale' || hash === 'for-sale') {
    setView('sale');
  } else {
    try {
      const t = localStorage.getItem('yoyoTab');
      if (t && t !== 'collection') setView(t);
    } catch { /* ignore */ }
  }
  if (currentView === 'collection') renderSkeleton();
  loadAll().catch((err) => toast('Failed to load: ' + err.message, 'error'));
})();
