// carriers.js — package-tracking lookups for UPS, USPS, and FedEx.
//
// Each carrier needs OAuth client credentials, supplied as environment
// variables (see configuredCarriers below). Nothing here runs unless the
// matching credentials are present, so the feature is opt-in per carrier.
//
// The public surface:
//   configuredCarriers(env) -> { ups, usps, fedex }  (booleans)
//   track(trackingNumber, carrier, env) -> { carrier, eta, status, delivered }
//
// `track` resolves to an object with `eta` as a YYYY-MM-DD string (or null).
// It throws with a human-readable message on auth/network/not-found failures.

// ---- OAuth token cache (per carrier, refreshed before expiry) ----
const tokenCache = {}; // carrier -> { token, exp }
async function cachedToken(key, fetcher) {
  const c = tokenCache[key];
  if (c && c.exp > Date.now() + 30_000) return c.token;
  const { token, ttl } = await fetcher();
  tokenCache[key] = { token, exp: Date.now() + (ttl || 3600) * 1000 };
  return token;
}

// ---- Date normalisation: carriers report dates a few different ways ----
const pad = (n) => String(n).padStart(2, '0');
function ymd(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO date or date-time
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{4})(\d{2})(\d{2})$/);       // compact YYYYMMDD (UPS)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(str);                          // fall back to Date parsing
  return isNaN(d) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function configuredCarriers(env) {
  return {
    ups: !!(env.UPS_CLIENT_ID && env.UPS_CLIENT_SECRET),
    usps: !!(env.USPS_CLIENT_ID && env.USPS_CLIENT_SECRET),
    fedex: !!(env.FEDEX_API_KEY && env.FEDEX_SECRET_KEY),
  };
}

// Best-effort carrier guess from the tracking-number shape. Returns null when
// ambiguous (the caller then tries each configured carrier in turn).
export function detectCarrier(tn) {
  const s = String(tn || '').replace(/\s+/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(s)) return 'ups';
  if (/^[A-Z]{2}\d{9}US$/.test(s)) return 'usps';        // international S10 format
  if (/^(94|93|92|95|420)\d{18,}$/.test(s)) return 'usps'; // IMpb / USPS impb
  if (/^\d{12}$/.test(s) || /^\d{15}$/.test(s)) return 'fedex';
  return null;
}

// ---- UPS ----
async function upsToken(env) {
  return cachedToken('ups', async () => {
    const basic = Buffer.from(`${env.UPS_CLIENT_ID}:${env.UPS_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://onlinetools.ups.com/security/v1/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok) throw new Error(`UPS authentication failed (${r.status})`);
    const j = await r.json();
    return { token: j.access_token, ttl: Number(j.expires_in) };
  });
}
async function trackUPS(tn, env) {
  const token = await upsToken(env);
  const r = await fetch(`https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(tn)}`, {
    headers: { Authorization: `Bearer ${token}`, transId: `yoyo-${Date.now()}`, transactionSrc: 'yoyocollection' },
  });
  if (r.status === 404) throw new Error('UPS: tracking number not found');
  if (!r.ok) throw new Error(`UPS lookup failed (${r.status})`);
  const j = await r.json();
  const pkg = j?.trackResponse?.shipment?.[0]?.package?.[0];
  if (!pkg) throw new Error('UPS: no tracking detail');
  const dates = pkg.deliveryDate || [];
  const del = dates.find((d) => d.type === 'DEL');
  const est = dates.find((d) => d.type === 'EDW') || dates.find((d) => d.type === 'RDD') || dates[0];
  const chosen = del || est;
  const status = pkg.currentStatus?.description || pkg.activity?.[0]?.status?.description || '';
  return { carrier: 'ups', eta: chosen ? ymd(chosen.date) : null, status, delivered: !!del };
}

// ---- USPS (apis.usps.com v3) ----
async function uspsToken(env) {
  return cachedToken('usps', async () => {
    const r = await fetch('https://apis.usps.com/oauth2/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.USPS_CLIENT_ID, client_secret: env.USPS_CLIENT_SECRET }),
    });
    if (!r.ok) throw new Error(`USPS authentication failed (${r.status})`);
    const j = await r.json();
    return { token: j.access_token, ttl: Number(j.expires_in) };
  });
}
async function trackUSPS(tn, env) {
  const token = await uspsToken(env);
  const r = await fetch(`https://apis.usps.com/tracking/v3/tracking/${encodeURIComponent(tn)}?expand=DETAIL`, {
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (r.status === 404) throw new Error('USPS: tracking number not found');
  if (!r.ok) throw new Error(`USPS lookup failed (${r.status})`);
  const j = await r.json();
  const eta = j.expectedDeliveryDate || j.predictedDeliveryDate || j.estimatedDeliveryDate || null;
  const status = j.status || j.statusCategory || j.statusSummary || '';
  return { carrier: 'usps', eta: eta ? ymd(eta) : null, status, delivered: /delivered/i.test(status) };
}

// ---- FedEx ----
async function fedexToken(env) {
  return cachedToken('fedex', async () => {
    const r = await fetch('https://apis.fedex.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.FEDEX_API_KEY, client_secret: env.FEDEX_SECRET_KEY }).toString(),
    });
    if (!r.ok) throw new Error(`FedEx authentication failed (${r.status})`);
    const j = await r.json();
    return { token: j.access_token, ttl: Number(j.expires_in) };
  });
}
async function trackFedEx(tn, env) {
  const token = await fedexToken(env);
  const r = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
    body: JSON.stringify({ includeDetailedScans: false, trackingInfo: [{ trackingNumberInfo: { trackingNumber: tn } }] }),
  });
  if (!r.ok) throw new Error(`FedEx lookup failed (${r.status})`);
  const j = await r.json();
  const tr = j?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!tr || tr.error) throw new Error(tr?.error?.message || 'FedEx: no tracking detail');
  const dts = tr.dateAndTimes || [];
  const actual = dts.find((d) => d.type === 'ACTUAL_DELIVERY');
  const estWindow = tr.estimatedDeliveryTimeWindow?.window?.ends;
  const est = dts.find((d) => d.type === 'ESTIMATED_DELIVERY') || (estWindow ? { dateTime: estWindow } : null);
  const chosen = actual || est;
  const status = tr.latestStatusDetail?.description || tr.latestStatusDetail?.statusByLocale || '';
  return { carrier: 'fedex', eta: chosen ? ymd(chosen.dateTime) : null, status, delivered: !!actual };
}

const FNS = { ups: trackUPS, usps: trackUSPS, fedex: trackFedEx };

// Look up a tracking number. If `carrier` is given it's used directly; otherwise
// we guess from the number shape and, failing a confident guess, try each
// configured carrier until one returns a result.
export async function track(tn, carrier, env) {
  const cfg = configuredCarriers(env);
  let order;
  if (carrier && FNS[carrier]) order = [carrier];
  else {
    const detected = detectCarrier(tn);
    order = detected ? [detected, ...Object.keys(FNS).filter((c) => c !== detected)] : Object.keys(FNS);
  }
  order = order.filter((c) => cfg[c]);
  if (!order.length) throw new Error('No carrier tracking credentials are configured on the server.');

  let lastErr;
  for (const c of order) {
    try {
      const res = await FNS[c](tn, env);
      if (res && (res.eta || res.status)) return res;
      lastErr = new Error(`${c.toUpperCase()}: no result`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Tracking lookup failed.');
}
