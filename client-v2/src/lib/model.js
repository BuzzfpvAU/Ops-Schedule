// Turning flat schedule_entries into timeline bars.
//
// The API hands back one row per (entity, date, job). Every view here wants
// the opposite shape: contiguous runs of days, laid out in lanes so that
// double-bookings are visible rather than hidden behind each other.

import { addDays } from './dates.js';

/**
 * Collapse entries for one row into contiguous bars.
 *
 * `keyOf` decides what counts as "the same booking" — the projects and team
 * views split on job + status so a tentative day reads differently from a
 * confirmed one, while the equipment view splits on job alone because a kit's
 * status changes mid-booking are noise there.
 */
export function buildBars(entries, keyOf = (e) => `${e.job_id}|${e.status || 'tentative'}`) {
  // Partition first, then merge within each partition. Merging in one pass
  // over date-sorted entries looks simpler but is wrong: when a row carries
  // two overlapping jobs, their entries interleave by date and each switch
  // would end the run, splitting one continuous booking into fragments.
  const byKey = new Map();
  for (const e of entries) {
    const key = keyOf(e);
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }

  const bars = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let cur = null;
    for (const e of sorted) {
      if (cur && (cur.end === e.date || addDays(cur.end, 1) === e.date)) {
        // Same day means a duplicate row, not a new bar.
        cur.end = e.date;
        cur.entries.push(e);
        continue;
      }
      cur = { key, start: e.date, end: e.date, entries: [e], sample: e };
      bars.push(cur);
    }
  }

  return bars.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/**
 * Assign bars to lanes so overlapping bars stack instead of colliding.
 * Returns the same bar objects with a `lane` index, plus the lane count.
 */
export function layoutLanes(bars) {
  const sorted = [...bars].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const laneEnds = [];
  for (const bar of sorted) {
    let lane = laneEnds.findIndex((end) => end < bar.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(bar.end);
    } else {
      laneEnds[lane] = bar.end;
    }
    bar.lane = lane;
  }
  return { bars: sorted, lanes: Math.max(1, laneEnds.length) };
}

/** Group entries by the entity they belong to. */
export function groupByEntity(entries) {
  const map = new Map();
  for (const e of entries) {
    const list = map.get(e.team_member_id);
    if (list) list.push(e);
    else map.set(e.team_member_id, [e]);
  }
  return map;
}

/** Group entries by job. */
export function groupByJob(entries) {
  const map = new Map();
  for (const e of entries) {
    const list = map.get(e.job_id);
    if (list) list.push(e);
    else map.set(e.job_id, [e]);
  }
  return map;
}

/**
 * Bucket rows under a heading, preserving the order of `order` and pushing
 * anything unrecognised into a trailing bucket.
 */
export function bucketBy(rows, keyOf, order, fallback = 'Unassigned') {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyOf(row) || fallback;
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  const known = order.filter((k) => buckets.has(k));
  const extra = [...buckets.keys()].filter((k) => !order.includes(k)).sort();
  return [...known, ...extra].map((key) => ({ key, rows: buckets.get(key) }));
}

/**
 * Days where a row carries bars from more than one job — a genuine
 * double-booking rather than two bars that merely sit in the same row.
 */
export function conflictDays(bars) {
  const byDay = new Map();
  for (const bar of bars) {
    for (const e of bar.entries) {
      const set = byDay.get(e.date) || new Set();
      set.add(e.job_id);
      byDay.set(e.date, set);
    }
  }
  const out = new Set();
  for (const [date, jobs] of byDay) if (jobs.size > 1) out.add(date);
  return out;
}

/**
 * Jobs that only exist to back a non-job schedule entry.
 *
 * `POST /api/schedule/quick` creates a real `jobs` row for leave, TOIL,
 * unavailability and each distinct note, so these come back from
 * `GET /api/jobs` looking like any other job. They are not projects and must
 * never appear on the project timeline. See STATUS_JOBS and resolveQuickJob
 * in server/src/routes/schedule.js for the codes.
 */
const QUICK_JOB_CODES = new Set(['TOIL', 'LEAVE', 'NOT-AVAIL', 'NOTE']);

export function isQuickJob(job) {
  const code = job?.code || '';
  return QUICK_JOB_CODES.has(code) || code.startsWith('NOTE-');
}

/**
 * State order with the signed-in user's own state first.
 *
 * Every grouped view leads with the region you actually work in rather than
 * whichever one sorts first, so the rows you care about are on screen without
 * scrolling. Works for a state outside the known list too, since bucketBy only
 * keeps the entries that have rows.
 */
export function orderStatesFor(myState, states) {
  if (!myState) return states;
  return [myState, ...states.filter((s) => s !== myState)];
}

/** Non-job statuses — leave, TOIL and friends are not "work". */
export const NON_WORK = new Set(['leave', 'toil', 'unavailable', 'note']);

export function isWork(entry) {
  return !NON_WORK.has(entry.status || 'tentative');
}
