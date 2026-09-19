import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBars, layoutLanes, bucketBy, conflictDays, groupByEntity, groupByJob, isWork, isQuickJob,
} from '../src/lib/model.js';
import {
  addDays, diffDays, rangeOf, monthBands, windowFor, isWeekend, parseISO, isoOf, fmtRange, ZOOMS,
} from '../src/lib/dates.js';

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

test('every zoom level produces a window containing its anchor', () => {
  for (const key of Object.keys(ZOOMS)) {
    const w = windowFor(key, '2026-09-19');
    assert.ok(w.start < '2026-09-19', `${key} starts before anchor`);
    assert.ok(w.end > '2026-09-19', `${key} ends after anchor`);
  }
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
