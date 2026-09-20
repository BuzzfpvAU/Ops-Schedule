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

// ── Zoom ────────────────────────────────────────────────────────────────
// Zoom is density only: how many pixels one day gets. It deliberately says
// nothing about which dates are loaded — that is the window's job, and the two
// used to be welded together, which is why changing zoom moved you in time and
// why you could not scroll past the edges.

export const MIN_COL_W = 5;
export const MAX_COL_W = 160;
const ZOOM_STEP = 1.35;

export function clampColW(w) {
  return Math.min(MAX_COL_W, Math.max(MIN_COL_W, Math.round(w)));
}

export const zoomIn = (w) => clampColW(w * ZOOM_STEP);
export const zoomOut = (w) => clampColW(w / ZOOM_STEP);

/** Named presets. These are shortcuts to a width, not modes. */
export const ZOOMS = {
  day:   { key: 'day',   label: 'Day',   colW: 102 },
  week:  { key: 'week',  label: 'Week',  colW: 39 },
  month: { key: 'month', label: 'Month', colW: 12 },
};

export const ZOOM_ORDER = ['day', 'week', 'month'];

/**
 * How much of a date a column can carry, decided by its real width rather
 * than by which preset happens to be selected — the width is now continuous,
 * so a preset name no longer describes it.
 */
export function labelModeFor(colW) {
  if (colW >= 34) return 'full';    // weekday name over the date
  if (colW >= 16) return 'dom';     // date on every column
  if (colW >= 6) return 'mondays';  // date on Mondays only
  return 'none';
}

// ── Window ──────────────────────────────────────────────────────────────
// A schedule is about what is coming, so the window opens with just enough
// history for context. It then grows in both directions as you scroll, up to
// a cap that only exists to stop runaway memory.

// What you SEE before today when a view opens.
export const PAST_DAYS = 3;
// What is LOADED before today. Deliberately more than is shown: if the window
// began exactly at the left edge of the viewport, scrolling further back would
// fire no scroll event, so the timeline could never ask for more history.
export const INITIAL_BACK_DAYS = 45;
export const INITIAL_FORWARD_DAYS = 120;
export const EXTEND_DAYS = 90;
export const MAX_BACK_DAYS = 365 * 5;
export const MAX_FORWARD_DAYS = 365 * 5;

export function initialWindow(anchorIso) {
  return {
    start: addDays(anchorIso, -INITIAL_BACK_DAYS),
    end: addDays(anchorIso, INITIAL_FORWARD_DAYS),
  };
}

/**
 * Grow the window one chunk in `dir` (-1 past, +1 future), stopping at the
 * cap. Returns the same object when there is nowhere left to go, so callers
 * can treat an unchanged reference as "already at the limit".
 */
export function extendWindow(win, dir, todayIso) {
  if (dir < 0) {
    const limit = addDays(todayIso, -MAX_BACK_DAYS);
    if (win.start <= limit) return win;
    const next = addDays(win.start, -EXTEND_DAYS);
    return { ...win, start: next < limit ? limit : next };
  }
  const limit = addDays(todayIso, MAX_FORWARD_DAYS);
  if (win.end >= limit) return win;
  const next = addDays(win.end, EXTEND_DAYS);
  return { ...win, end: next > limit ? limit : next };
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
