// Date + timeline geometry helpers.
//
// Everything is an ISO `YYYY-MM-DD` string in the app's local (AEST) sense —
// the same convention the v1 client and the API already use. We never build a
// Date from an ISO string without splitting it first, because `new Date('...')`
// parses as UTC and shifts the day for anyone east of Greenwich.

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isoOf(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

export function diffDays(fromIso, toIso) {
  return Math.round((parseISO(toIso) - parseISO(fromIso)) / 86400000);
}

/** Today in Australia/Sydney, which is the timezone the server writes in. */
export function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

export function isWeekend(iso) {
  const d = parseISO(iso).getDay();
  return d === 0 || d === 6;
}

export function fmtShort(iso) {
  if (!iso) return '';
  const d = parseISO(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtLong(iso) {
  if (!iso) return '';
  const d = parseISO(iso);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * A window label. Years are shown only when the window spans more than one,
 * which keeps the common day-zoom case short but stops a wide month-zoom
 * window from reading as though it ended this year.
 */
export function fmtRange(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const a = parseISO(startIso);
  const b = parseISO(endIso);
  if (a.getFullYear() === b.getFullYear()) {
    return `${fmtShort(startIso)} – ${fmtShort(endIso)} ${a.getFullYear()}`;
  }
  return `${fmtShort(startIso)} ${a.getFullYear()} – ${fmtShort(endIso)} ${b.getFullYear()}`;
}

/** Inclusive day range as ISO strings. */
export function rangeOf(startIso, endIso) {
  const out = [];
  let cur = startIso;
  let guard = 0;
  while (cur <= endIso && guard++ < 3000) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// ── Zoom ────────────────────────────────────────────────────────────────
// Columns are always one day wide in the data model — zoom only changes how
// many pixels a day gets, so bar geometry stays identical at every level.

// Widths are the readability budget: every level is 3x its original width,
// which is what made the compressed levels legible. Day leading at 102px is
// what lets week take its full 3x (39px) without overtaking it — at day's
// original 34px, a 3x week would have inverted the zoom control.
export const ZOOMS = {
  day:   { key: 'day',   label: 'Day',   colW: 102, before: 10, after: 50,  dayLabels: 'full' },
  week:  { key: 'week',  label: 'Week',  colW: 39,  before: 21, after: 130, dayLabels: 'full' },
  month: { key: 'month', label: 'Month', colW: 12,  before: 40, after: 240, dayLabels: 'mondays' },
};

export const ZOOM_ORDER = ['day', 'week', 'month'];

/** The visible window for a zoom level, anchored on a date. */
export function windowFor(zoomKey, anchorIso) {
  const z = ZOOMS[zoomKey] || ZOOMS.day;
  return { start: addDays(anchorIso, -z.before), end: addDays(anchorIso, z.after) };
}

/**
 * Month bands for the header: one entry per calendar month touched by `days`,
 * with the column index it starts at and how many columns it covers.
 */
export function monthBands(days) {
  const bands = [];
  for (let i = 0; i < days.length; i++) {
    const d = parseISO(days[i]);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const last = bands[bands.length - 1];
    if (last && last.key === key) {
      last.span += 1;
    } else {
      bands.push({ key, span: 1, startIdx: i, label: MONTHS[d.getMonth()], year: d.getFullYear() });
    }
  }
  return bands;
}
