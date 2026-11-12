// Calendar-day helpers shared by server.js and normalize-dates.mjs.
//
// Two kinds of time live in this app, and they must not be mixed:
//  - Calendar days (purchase_date, sold_date, eta) have no time zone. They are
//    stored as "YYYY-MM-DD" in the user's local calendar, produced by the
//    browser, and never derived from a UTC instant or converted here.
//  - Instants stay UTC: SQLite "YYYY-MM-DD HH:MM:SS" for created_at /
//    updated_at / deleted_at, ISO-with-Z for sale_listed_at. Sync compares
//    these as strings, so their formats are fixed.
// Free-text dates (release_date: "2025", "Spring 2024") are left as typed.
// The browser's parseDay() in public/app.js applies the same rules.
export const DAY_FIELDS = ['purchase_date', 'sold_date'];

// "YYYY-MM-DD" for a real calendar date, or null (rejects 2026-02-30 etc.).
function isoDay(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Normalizes a stored day to "YYYY-MM-DD". Accepts ISO and a/b/yyyy, where
// a/b is month/day (what the edit form has always assumed) unless a > 12,
// which can only be day/month. Anything else is returned as typed — nothing is
// ever lost, it just stays unnormalized. eta is deliberately not run through
// this: carriers and people write it loosely, and the browser copes.
export function normalizeDay(s) {
  const t = String(s ?? '').trim();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return isoDay(+m[1], +m[2], +m[3]) || t;
  if ((m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/))) {
    let yr = +m[3];
    // Two-digit years: 20xx unless that is more than a year ahead, then 19xx
    // (so "6/1/98" is 1998, and next year's release date still reads as 20xx).
    if (m[3].length === 2) yr += (2000 + yr > new Date().getFullYear() + 1) ? 1900 : 2000;
    const [a, b] = [+m[1], +m[2]];
    return (a > 12 ? isoDay(yr, b, a) : isoDay(yr, a, b)) || t;
  }
  return t;
}

// Today's date in the server's local zone (honours TZ), for download filenames.
export function localDayStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
