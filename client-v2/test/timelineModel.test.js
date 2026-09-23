import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBars, layoutLanes, bucketBy, conflictDays, groupByEntity, groupByJob, isWork, isQuickJob, orderStatesFor,
} from '../src/lib/model.js';
import {
  addDays, diffDays, rangeOf, monthBands, isWeekend, parseISO, isoOf, fmtRange,
  ZOOMS, ZOOM_ORDER, PAST_DAYS, INITIAL_BACK_DAYS, initialWindow, extendWindow,
  clampColW, zoomIn, zoomOut, labelModeFor, MIN_COL_W, MAX_COL_W,
} from '../src/lib/dates.js';
import { makeMatcher, normalise } from '../src/lib/search.js';

const entry = (over) => ({
  id: 'e', team_member_id: 'm1', job_id: 'j1', date: '2026-09-10', status: 'confirmed', ...over,
});

// ── dates ──

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
});

test('addDays handles a leap day', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
});

test('isoOf round-trips parseISO without timezone drift', () => {
  for (const iso of ['2026-01-01', '2026-06-30', '2026-12-31']) {
    assert.equal(isoOf(parseISO(iso)), iso);
  }
});

test('diffDays counts inclusive-exclusive days', () => {
  assert.equal(diffDays('2026-09-10', '2026-09-10'), 0);
  assert.equal(diffDays('2026-09-10', '2026-09-13'), 3);
  assert.equal(diffDays('2026-09-13', '2026-09-10'), -3);
});

test('rangeOf is inclusive at both ends', () => {
  const r = rangeOf('2026-09-10', '2026-09-12');
  assert.deepEqual(r, ['2026-09-10', '2026-09-11', '2026-09-12']);
});

test('monthBands span every column exactly once', () => {
  const days = rangeOf('2026-01-28', '2026-03-03');
  const bands = monthBands(days);
  assert.deepEqual(bands.map((b) => b.label), ['Jan', 'Feb', 'Mar']);
  assert.equal(bands.reduce((n, b) => n + b.span, 0), days.length);
  assert.equal(bands[0].startIdx, 0);
  assert.equal(bands[1].startIdx, 4);
});

test('isWeekend flags Saturday and Sunday only', () => {
  // 2026-09-19 is a Saturday, 2026-09-20 a Sunday.
  assert.equal(isWeekend('2026-09-19'), true);
  assert.equal(isWeekend('2026-09-20'), true);
  assert.equal(isWeekend('2026-09-21'), false);
});


// ── bars ──

test('consecutive days on one job merge into a single bar', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10' }),
    entry({ date: '2026-09-11' }),
    entry({ date: '2026-09-12' }),
  ]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].start, '2026-09-10');
  assert.equal(bars[0].end, '2026-09-12');
  assert.equal(bars[0].entries.length, 3);
});

test('a gap in the dates splits the bar', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10' }),
    entry({ date: '2026-09-12' }),
  ]);
  assert.equal(bars.length, 2);
});

test('a different job breaks the run even on adjacent days', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10', job_id: 'j1' }),
    entry({ date: '2026-09-11', job_id: 'j2' }),
  ]);
  assert.equal(bars.length, 2);
});

test('a status change splits the bar under the default key', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10', status: 'tentative' }),
    entry({ date: '2026-09-11', status: 'confirmed' }),
  ]);
  assert.equal(bars.length, 2);
});

test('a job-only key keeps a run together across status changes', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10', status: 'tentative' }),
    entry({ date: '2026-09-11', status: 'confirmed' }),
  ], (e) => e.job_id);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].end, '2026-09-11');
});

test('entries arriving out of order still merge', () => {
  const bars = buildBars([
    entry({ date: '2026-09-12' }),
    entry({ date: '2026-09-10' }),
    entry({ date: '2026-09-11' }),
  ]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].start, '2026-09-10');
});

test('duplicate rows for one day do not create a second bar', () => {
  const bars = buildBars([
    entry({ id: 'a', date: '2026-09-10' }),
    entry({ id: 'b', date: '2026-09-10' }),
  ]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].entries.length, 2);
});

// ── lanes ──

test('non-overlapping bars share one lane', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10', job_id: 'j1' }),
    entry({ date: '2026-09-14', job_id: 'j2' }),
  ]);
  const laid = layoutLanes(bars);
  assert.equal(laid.lanes, 1);
  assert.deepEqual(laid.bars.map((b) => b.lane), [0, 0]);
});

test('overlapping bars stack into separate lanes', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10', job_id: 'j1' }),
    entry({ date: '2026-09-11', job_id: 'j1' }),
    entry({ date: '2026-09-11', job_id: 'j2' }),
  ]);
  const laid = layoutLanes(bars);
  assert.equal(laid.lanes, 2);
});

test('a freed lane is reused by a later bar', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10', job_id: 'j1' }),
    entry({ date: '2026-09-10', job_id: 'j2' }),
    entry({ date: '2026-09-20', job_id: 'j3' }),
  ]);
  const laid = layoutLanes(bars);
  assert.equal(laid.lanes, 2);
  assert.equal(laid.bars.find((b) => b.sample.job_id === 'j3').lane, 0);
});

test('layoutLanes on no bars still reports one lane', () => {
  assert.equal(layoutLanes([]).lanes, 1);
});

// ── conflicts ──

test('two jobs on one day is a conflict', () => {
  const bars = buildBars([
    entry({ date: '2026-09-11', job_id: 'j1' }),
    entry({ date: '2026-09-11', job_id: 'j2' }),
  ]);
  assert.deepEqual([...conflictDays(bars)], ['2026-09-11']);
});

test('the same job twice on one day is not a conflict', () => {
  const bars = buildBars([
    entry({ id: 'a', date: '2026-09-11', job_id: 'j1' }),
    entry({ id: 'b', date: '2026-09-11', job_id: 'j1' }),
  ]);
  assert.equal(conflictDays(bars).size, 0);
});

test('back-to-back jobs on different days do not conflict', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10', job_id: 'j1' }),
    entry({ date: '2026-09-11', job_id: 'j2' }),
  ]);
  assert.equal(conflictDays(bars).size, 0);
});

// ── grouping ──

test('bucketBy honours the given order and trails the unknowns', () => {
  const out = bucketBy(
    [{ s: 'VIC' }, { s: 'WA' }, { s: 'QLD' }, { s: null }],
    (r) => r.s,
    ['WA', 'VIC'],
    'No state'
  );
  assert.deepEqual(out.map((b) => b.key), ['WA', 'VIC', 'No state', 'QLD']);
});

test('bucketBy sends empty-string keys to the fallback bucket', () => {
  const out = bucketBy([{ s: '' }], (r) => r.s, ['WA'], 'No state');
  assert.deepEqual(out.map((b) => b.key), ['No state']);
});

test('groupByEntity and groupByJob split on the right field', () => {
  const rows = [
    entry({ team_member_id: 'm1', job_id: 'j1' }),
    entry({ team_member_id: 'm2', job_id: 'j1' }),
  ];
  assert.equal(groupByEntity(rows).size, 2);
  assert.equal(groupByJob(rows).size, 1);
});

test('leave, TOIL, notes and unavailable do not count as work', () => {
  assert.equal(isWork(entry({ status: 'confirmed' })), true);
  assert.equal(isWork(entry({ status: 'tentative' })), true);
  for (const s of ['leave', 'toil', 'note', 'unavailable']) {
    assert.equal(isWork(entry({ status: s })), false, `${s} should not be work`);
  }
});

// ── quick jobs ──

test('the jobs backing non-job statuses are recognised', () => {
  for (const code of ['TOIL', 'LEAVE', 'NOT-AVAIL']) {
    assert.equal(isQuickJob({ code }), true, `${code} should be a quick job`);
  }
});

test('generated note jobs are recognised by their prefix', () => {
  assert.equal(isQuickJob({ code: 'NOTE-MEDICALAPP' }), true);
  assert.equal(isQuickJob({ code: 'NOTE-DENTIST-x9f' }), true);
});

test('real jobs are never mistaken for quick jobs', () => {
  for (const code of ['AU-2601', 'NOTEBOOK', 'LEAVERS-01', 'TOILET-SURVEY']) {
    assert.equal(isQuickJob({ code }), false, `${code} should be a real job`);
  }
});

test('isQuickJob tolerates a missing code', () => {
  assert.equal(isQuickJob({}), false);
  assert.equal(isQuickJob(null), false);
});

// ── overlapping jobs on one row ──
//
// Regression: entries for two overlapping jobs arrive interleaved by date.
// Merging in a single date-ordered pass split each job's booking into
// fragments every time the other job's dates cut across it.

test('an overlapping second job does not fragment the first', () => {
  const rows = [];
  // Job A runs the 10th to the 16th; job B the 14th to the 20th.
  for (let d = 10; d <= 16; d++) rows.push(entry({ date: `2026-09-${d}`, job_id: 'A' }));
  for (let d = 14; d <= 20; d++) rows.push(entry({ date: `2026-09-${d}`, job_id: 'B' }));
  // Interleave them the way the API's date-ordered response would.
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const bars = buildBars(rows, (e) => e.job_id);
  assert.equal(bars.length, 2, 'one bar per job, not one per interleaved segment');

  const a = bars.find((b) => b.sample.job_id === 'A');
  const b = bars.find((x) => x.sample.job_id === 'B');
  assert.equal(a.start, '2026-09-10');
  assert.equal(a.end, '2026-09-16');
  assert.equal(b.start, '2026-09-14');
  assert.equal(b.end, '2026-09-20');
});

test('three mutually overlapping jobs each stay whole', () => {
  const rows = [];
  for (const [job, from, to] of [['A', 10, 20], ['B', 12, 22], ['C', 14, 24]]) {
    for (let d = from; d <= to; d++) rows.push(entry({ date: `2026-09-${d}`, job_id: job }));
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  const bars = buildBars(rows, (e) => e.job_id);
  assert.equal(bars.length, 3);
  assert.equal(layoutLanes(bars).lanes, 3);
});

test('bars come back in start-date order', () => {
  const bars = buildBars([
    entry({ date: '2026-09-20', job_id: 'Z' }),
    entry({ date: '2026-09-10', job_id: 'A' }),
    entry({ date: '2026-09-15', job_id: 'M' }),
  ], (e) => e.job_id);
  assert.deepEqual(bars.map((b) => b.start), ['2026-09-10', '2026-09-15', '2026-09-20']);
});

test('a genuine gap still splits one job into two bars', () => {
  const rows = [
    entry({ date: '2026-09-10', job_id: 'A' }),
    entry({ date: '2026-09-11', job_id: 'A' }),
    entry({ date: '2026-09-20', job_id: 'A' }),
  ];
  const bars = buildBars(rows, (e) => e.job_id);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].end, '2026-09-11');
  assert.equal(bars[1].start, '2026-09-20');
});

// ── window label ──

test('a window inside one year shows that year once', () => {
  assert.equal(fmtRange('2026-09-05', '2026-12-03'), '5 Sep – 3 Dec 2026');
});

test('a window spanning a year boundary shows both years', () => {
  assert.equal(fmtRange('2026-07-21', '2027-10-24'), '21 Jul 2026 – 24 Oct 2027');
});

test('fmtRange is blank without both ends', () => {
  assert.equal(fmtRange('', '2026-01-01'), '');
  assert.equal(fmtRange('2026-01-01', null), '');
});

// ── zoom hierarchy ──
//
// Regression: widening the compressed levels for readability can quietly push
// a coarser level past a finer one, which inverts the zoom control — picking
// "Week" would show fewer days than "Day".

test('each zoom level is strictly denser than the one before it', () => {
  const order = ZOOM_ORDER.map((k) => ZOOMS[k]);
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      order[i].colW < order[i - 1].colW,
      `${order[i].key} (${order[i].colW}px) must be narrower than ${order[i - 1].key} (${order[i - 1].colW}px)`
    );
  }
});


test('every zoom column is wide enough for a two-digit date', () => {
  // Below roughly 10px a date cannot render, which is what made the old
  // 4px month view unreadable.
  for (const key of ZOOM_ORDER) {
    assert.ok(ZOOMS[key].colW >= 10, `${key} colW ${ZOOMS[key].colW}px is too narrow to label`);
  }
});

// ── state ordering ──

test('your own state leads the order', () => {
  assert.deepEqual(
    orderStatesFor('QLD', ['NSW', 'VIC', 'QLD', 'WA']),
    ['QLD', 'NSW', 'VIC', 'WA']
  );
});

test('no state leaves the order untouched', () => {
  const states = ['NSW', 'VIC', 'QLD'];
  assert.deepEqual(orderStatesFor(null, states), states);
  assert.deepEqual(orderStatesFor('', states), states);
});

test('a state outside the known list still leads', () => {
  assert.deepEqual(
    orderStatesFor('Antarctica', ['NSW', 'VIC']),
    ['Antarctica', 'NSW', 'VIC']
  );
});

test('the leading state is never duplicated', () => {
  const out = orderStatesFor('WA', ['NSW', 'WA', 'VIC']);
  assert.equal(out.filter((s) => s === 'WA').length, 1);
});

test('ordering feeds bucketBy so your state group comes first', () => {
  const rows = [{ s: 'NSW' }, { s: 'WA' }, { s: 'VIC' }];
  const out = bucketBy(rows, (r) => r.s, orderStatesFor('WA', ['NSW', 'VIC', 'WA']), 'No state');
  assert.equal(out[0].key, 'WA');
});

// ── window leans future ──





// ── zoom is density only ──

test('presets stay strictly ordered by width', () => {
  const widths = ZOOM_ORDER.map((k) => ZOOMS[k].colW);
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] < widths[i - 1], `${ZOOM_ORDER[i]} must be narrower than ${ZOOM_ORDER[i - 1]}`);
  }
});

test('zoom steps move, and stop at the limits', () => {
  assert.ok(zoomIn(50) > 50);
  assert.ok(zoomOut(50) < 50);
  assert.equal(clampColW(MAX_COL_W + 500), MAX_COL_W);
  assert.equal(clampColW(-10), MIN_COL_W);
  assert.equal(zoomIn(MAX_COL_W), MAX_COL_W, 'zooming in at the limit stays put');
  assert.equal(zoomOut(MIN_COL_W), MIN_COL_W, 'zooming out at the limit stays put');
});

test('repeated zooming terminates at the bounds rather than drifting', () => {
  let w = 40;
  for (let i = 0; i < 100; i++) w = zoomIn(w);
  assert.equal(w, MAX_COL_W);
  for (let i = 0; i < 100; i++) w = zoomOut(w);
  assert.equal(w, MIN_COL_W);
});

test('label density follows width, not a preset name', () => {
  assert.equal(labelModeFor(ZOOMS.day.colW), 'full');
  assert.equal(labelModeFor(ZOOMS.week.colW), 'full');
  assert.equal(labelModeFor(ZOOMS.month.colW), 'mondays');
  assert.equal(labelModeFor(20), 'dom');
  assert.equal(labelModeFor(MIN_COL_W), 'none');
});

test('every preset is wide enough to carry a label', () => {
  for (const key of ZOOM_ORDER) {
    assert.notEqual(labelModeFor(ZOOMS[key].colW), 'none', `${key} would show no dates at all`);
  }
});

// ── the window is independent of zoom ──

test('more history is loaded than is shown, so back-scroll can trigger', () => {
  assert.ok(
    INITIAL_BACK_DAYS > PAST_DAYS,
    'a window starting at the visible edge fires no scroll event to extend from'
  );
});

test('the opening window leans towards the future', () => {
  const w = initialWindow('2026-09-20');
  const days = rangeOf(w.start, w.end);
  const idx = days.indexOf('2026-09-20');
  assert.equal(idx, INITIAL_BACK_DAYS);
  assert.ok(days.length - idx > idx, 'more of the window should be ahead than behind');
});

test('extending grows only the edge asked for', () => {
  const w = initialWindow('2026-09-20');
  const back = extendWindow(w, -1, '2026-09-20');
  assert.ok(back.start < w.start, 'start moves earlier');
  assert.equal(back.end, w.end, 'end is untouched');

  const fwd = extendWindow(w, 1, '2026-09-20');
  assert.ok(fwd.end > w.end, 'end moves later');
  assert.equal(fwd.start, w.start, 'start is untouched');
});

test('extending back repeatedly stops at the cap', () => {
  const today = '2026-09-20';
  let w = initialWindow(today);
  for (let i = 0; i < 500; i++) w = extendWindow(w, -1, today);
  assert.equal(extendWindow(w, -1, today), w, 'at the cap it returns the same reference');
  assert.ok(w.start > '2019-01-01', 'the cap actually bounds how far back it goes');
});

test('extending forward repeatedly stops at its cap', () => {
  const today = '2026-09-20';
  let w = initialWindow(today);
  for (let i = 0; i < 500; i++) w = extendWindow(w, 1, today);
  assert.equal(extendWindow(w, 1, today), w);
});

test('a window extended both ways still contains today', () => {
  const today = '2026-09-20';
  let w = initialWindow(today);
  for (let i = 0; i < 5; i++) {
    w = extendWindow(w, -1, today);
    w = extendWindow(w, 1, today);
  }
  assert.ok(w.start <= today && today <= w.end);
});

test('extending reaches years out, which the old fixed window could not', () => {
  const today = '2026-09-20';
  let w = initialWindow(today);
  for (let i = 0; i < 8; i++) w = extendWindow(w, 1, today);
  assert.ok(w.end > '2028-01-01', `only reached ${w.end}`);
});

// ── search ──

test('an empty query matches everything', () => {
  const match = makeMatcher('');
  assert.equal(match('anything'), true);
  assert.equal(match(''), true);
  assert.equal(makeMatcher('   ')('x'), true);
});

test('matching is case and position insensitive', () => {
  const match = makeMatcher('HUNTER');
  assert.equal(match('Hunter Valley Corridor'), true);
  assert.equal(match('the hunter'), true);
  assert.equal(match('Pilbara'), false);
});

test('a query searches across every field it is given', () => {
  const match = makeMatcher('powerlink');
  assert.equal(match('AU-2601', 'Hunter Valley', 'Powerlink'), true);
  assert.equal(match('AU-2601', 'Hunter Valley'), false, 'not in the fields passed');
});

test('extra words narrow rather than widen', () => {
  const job = ['AU-2601', 'Hunter Valley Corridor', 'LiDAR corridor capture'];
  assert.equal(makeMatcher('hunter')(...job), true);
  assert.equal(makeMatcher('hunter lidar')(...job), true, 'both terms present, in different fields');
  assert.equal(makeMatcher('hunter thermal')(...job), false, 'one term missing');
});

test('term order does not matter', () => {
  const job = ['AU-2601', 'Hunter Valley Corridor'];
  assert.equal(makeMatcher('valley hunter')(...job), true);
  assert.equal(makeMatcher('hunter valley')(...job), true);
});

test('null and undefined fields are skipped, not stringified', () => {
  const match = makeMatcher('alpha');
  assert.equal(match(null, undefined, 'Alpha'), true);
  assert.equal(makeMatcher('null')(null, 'Alpha'), false, '"null" must not become searchable text');
  assert.equal(makeMatcher('undefined')(undefined, 'Alpha'), false);
});

test('numbers are searchable', () => {
  assert.equal(makeMatcher('2601')('AU-2601'), true);
  assert.equal(makeMatcher('12')(12, 'crew'), true);
});

test('surrounding whitespace in the query is ignored', () => {
  assert.equal(makeMatcher('  hunter  ')('Hunter Valley'), true);
});

test('a query matching nothing returns false rather than throwing', () => {
  assert.equal(makeMatcher('zzzz')('Hunter Valley', null, 42), false);
});

// ── lanes from column geometry ──
//
// Regression: layoutLanes compared bar.start, but the single-project view's
// bars carry only column geometry. Every comparison against undefined was
// false, so each bar was handed its own lane and a person's row grew taller
// with every booking, whether or not anything overlapped.

const geoBar = (startIdx, span) => ({ startIdx, span });

test('bars with geometry but no dates still share a lane when they do not overlap', () => {
  const bars = [geoBar(0, 5), geoBar(10, 3), geoBar(20, 2)];
  const laid = layoutLanes(bars);
  assert.equal(laid.lanes, 1, 'three separate bookings, one lane');
  assert.deepEqual(laid.bars.map((b) => b.lane), [0, 0, 0]);
});

test('bars with geometry stack only where they genuinely overlap', () => {
  //  0..6 and 4..8 overlap; 10..12 does not.
  const laid = layoutLanes([geoBar(0, 7), geoBar(4, 5), geoBar(10, 3)]);
  assert.equal(laid.lanes, 2);
  const byStart = Object.fromEntries(laid.bars.map((b) => [b.startIdx, b.lane]));
  assert.equal(byStart[0], 0);
  assert.equal(byStart[4], 1, 'the overlapping bar moves down');
  assert.equal(byStart[10], 0, 'the later bar reuses the freed lane');
});

test('bars touching end to end do not stack', () => {
  // 0..4 then 5..9 — adjacent days, no shared day.
  const laid = layoutLanes([geoBar(0, 5), geoBar(5, 5)]);
  assert.equal(laid.lanes, 1);
});

test('bars sharing a single day do stack', () => {
  // 0..4 and 4..8 share column 4.
  const laid = layoutLanes([geoBar(0, 5), geoBar(4, 5)]);
  assert.equal(laid.lanes, 2);
});

test('a single-column bar inside a longer one stacks', () => {
  const laid = layoutLanes([geoBar(0, 10), geoBar(5, 1)]);
  assert.equal(laid.lanes, 2);
});

test('date-shaped bars still work, so the other views are unaffected', () => {
  const bars = buildBars([
    entry({ date: '2026-09-10', job_id: 'A' }),
    entry({ date: '2026-09-11', job_id: 'A' }),
    entry({ date: '2026-09-20', job_id: 'B' }),
  ], (e) => e.job_id);
  assert.equal(layoutLanes(bars).lanes, 1, 'no overlap, one lane');
});

test('a bar with neither geometry nor dates shares lane 0 rather than claiming its own', () => {
  const laid = layoutLanes([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  assert.equal(laid.lanes, 1);
  assert.deepEqual(laid.bars.map((b) => b.lane), [0, 0, 0]);
});

test('lane count never drops below one, even with no bars', () => {
  assert.equal(layoutLanes([]).lanes, 1);
});
