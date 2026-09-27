import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookedIndex, planWindow, availability, availText, resolveLocation, sortRows, summary, BASE_CITIES, bubbleFor,
  haversineKm, jobRuns, movesFor, tagChecks, usagePct, isIdle, lastUsed, nearFilter,
} from '../src/lib/equipmentPlan.js';

const e = (item, date, job = 'j1', status = 'tentative') => ({ team_member_id: item, date, job_id: job, status, job_code: 'HUN-24' });
const win = { from: '2026-10-01', to: '2026-10-14' };
const jobs = new Map([['j1', { id: 'j1', code: 'HUN-24', name: 'Hunter', site_address: 'Muswellbrook NSW', site_lat: -32.26, site_lng: 150.89, state: 'NSW' }]]);
const NOW = Date.parse('2026-10-01T02:00:00Z');

test('bookedIndex keeps work entries per item and date', () => {
  const idx = bookedIndex([e('a', '2026-10-02'), e('a', '2026-10-03'), { ...e('a', '2026-10-04'), status: 'leave' }]);
  assert.deepEqual([...idx.get('a').keys()], ['2026-10-02', '2026-10-03']);
});

test('planWindow presets and custom', () => {
  assert.deepEqual(planWindow('7', '2026-10-01'), { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(planWindow('14', '2026-10-01'), win);
  assert.deepEqual(planWindow('custom', '2026-10-01', { from: '2026-10-05', to: '2026-10-09' }), { from: '2026-10-05', to: '2026-10-09' });
  assert.deepEqual(planWindow('custom', '2026-10-01', { from: '2026-10-09', to: '2026-10-05' }), { from: '2026-10-05', to: '2026-10-09' });
});

test('availability: free, partial, booked, unserviceable', () => {
  const idx = bookedIndex([e('a', '2026-10-02'), e('a', '2026-10-03')]);
  assert.deepEqual(availability({ id: 'x' }, idx.get('x'), win), { status: 'free', freeDays: 14, totalDays: 14 });
  assert.deepEqual(availability({ id: 'a' }, idx.get('a'), win), { status: 'partial', freeDays: 12, totalDays: 14 });
  const full = bookedIndex(Array.from({ length: 7 }, (_, i) => e('b', `2026-10-0${i + 1}`)));
  assert.equal(availability({ id: 'b' }, full.get('b'), planWindow('7', '2026-10-01')).status, 'booked');
  assert.equal(availability({ id: 'x', serviceable: 0 }, undefined, win).status, 'unserviceable');
  assert.equal(availText({ status: 'partial', freeDays: 12, totalDays: 14 }), 'Free 12 of 14 days');
});

test('location: a fresh tag wins', () => {
  const loc = resolveLocation({ id: 'a', location: 'WA' }, {
    ping: { lat: -20.7, lng: 116.8, seen_at: '2026-10-01T00:00:00Z', place: 'Karratha, WA' },
    staleDays: 3, booked: bookedIndex([e('a', '2026-10-01')]).get('a'), jobsById: jobs, windowStart: '2026-10-01', nowMs: NOW,
  });
  assert.equal(loc.source, 'tag');
  assert.equal(loc.label, '📍 Karratha, WA · 2 h ago (tag)');
  assert.deepEqual([loc.lat, loc.lng, loc.approx], [-20.7, 116.8, false]);
});

test('location: a stale tag falls through to the booking', () => {
  const loc = resolveLocation({ id: 'a', location: 'WA' }, {
    ping: { lat: 1, lng: 1, seen_at: '2026-09-20T00:00:00Z' },
    staleDays: 3, booked: bookedIndex([e('a', '2026-10-01')]).get('a'), jobsById: jobs, windowStart: '2026-10-01', nowMs: NOW,
  });
  assert.equal(loc.source, 'booked');
  assert.equal(loc.label, '📍 On job HUN-24 · Muswellbrook NSW (booked)');
  assert.deepEqual([loc.lat, loc.lng, loc.jobId], [-32.26, 150.89, 'j1']);
});

test('location: last job within 14 days, else home base, else unknown', () => {
  const last = resolveLocation({ id: 'a', location: 'WA' }, {
    booked: bookedIndex([e('a', '2026-09-25'), e('a', '2026-09-26')]).get('a'), jobsById: jobs, windowStart: '2026-10-01', nowMs: NOW, staleDays: 3,
  });
  assert.equal(last.source, 'last_job');
  assert.equal(last.label, '📍 Last on HUN-24, ended 5 days ago');
  const old = resolveLocation({ id: 'a', location: 'WA' }, {
    booked: bookedIndex([e('a', '2026-09-01')]).get('a'), jobsById: jobs, windowStart: '2026-10-01', nowMs: NOW, staleDays: 3,
  });
  assert.equal(old.source, 'home');
  assert.equal(old.label, '📍 WA base (home)');
  assert.deepEqual([old.lat, old.lng, old.approx], [BASE_CITIES.WA.lat, BASE_CITIES.WA.lng, true]);
  const none = resolveLocation({ id: 'a', location: 'Processing' }, { windowStart: '2026-10-01', nowMs: NOW, staleDays: 3, jobsById: jobs });
  assert.equal(none.source, 'home');
  assert.equal(none.lat, null);
  assert.equal(resolveLocation({ id: 'a' }, { windowStart: '2026-10-01', nowMs: NOW, staleDays: 3, jobsById: jobs }).source, 'unknown');
});

test('a booked job without a site position has no point', () => {
  const j = new Map([['j1', { id: 'j1', code: 'HUN-24', site_address: '', state: 'NSW' }]]);
  const loc = resolveLocation({ id: 'a' }, { booked: bookedIndex([e('a', '2026-10-01')]).get('a'), jobsById: j, windowStart: '2026-10-01', nowMs: NOW, staleDays: 3 });
  assert.equal(loc.label, '📍 On job HUN-24 · NSW (booked)');
  assert.equal(loc.lat, null);
});

test('sortRows and summary', () => {
  const rows = [
    { item: { name: 'B' }, avail: { status: 'booked' } },
    { item: { name: 'Z' }, avail: { status: 'free' } },
    { item: { name: 'A' }, avail: { status: 'free' } },
    { item: { name: 'C' }, avail: { status: 'partial' } },
    { item: { name: 'D' }, avail: { status: 'unserviceable' } },
  ];
  assert.deepEqual(sortRows(rows).map((r) => r.item.name), ['A', 'Z', 'C', 'B', 'D']);
  assert.deepEqual(summary(rows), { free: 2, partial: 1, booked: 1, unserviceable: 1 });
});

test('bubbleFor: count, shared tone or mixed, and approx only when all are approx', () => {
  assert.deepEqual(bubbleFor([{ tone: 'ok', approx: false }]), { count: 1, tone: 'ok', approx: false });
  assert.deepEqual(bubbleFor([{ tone: 'ok', approx: true }, { tone: 'ok', approx: true }]), { count: 2, tone: 'ok', approx: true });
  assert.deepEqual(bubbleFor([{ tone: 'ok', approx: true }, { tone: 'danger', approx: false }]), { count: 2, tone: 'mixed', approx: false });
});

const J = new Map([
  ['a', { id: 'a', code: 'TST1', site_address: 'Muswellbrook NSW', site_lat: -32.27, site_lng: 150.89, state: 'NSW' }],
  ['b', { id: 'b', code: 'J2395', site_address: 'Millar Road Baldivis', site_lat: -32.28, site_lng: 115.83, state: 'WA' }],
  ['c', { id: 'c', code: 'J2396', site_address: 'Muswellbrook NSW', site_lat: -32.27, site_lng: 150.89, state: 'NSW' }],
  ['n', { id: 'n', code: 'NOPOS', site_address: '', state: 'WA' }],
  ['k', { id: 'k', code: 'J2216', site_address: 'Karratha Gas Plant', site_lat: -20.59, site_lng: 116.78, state: 'WA' }],
]);
const days = (job, from, to) => {
  const out = [];
  for (let d = from; d <= to; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) out.push(e('x', d, job));
  return out;
};
const W = { from: '2026-10-01', to: '2026-10-14' };

test('haversine: Perth to Sydney is about 3,290 km', () => {
  const km = haversineKm({ lat: -31.95, lng: 115.86 }, { lat: -33.87, lng: 151.21 });
  assert.ok(km > 3250 && km < 3320, String(km));
});

test('jobRuns splits on job change and on gaps', () => {
  const b = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('a', '2026-10-05', '2026-10-05'), ...days('b', '2026-10-06', '2026-10-07')]).get('x');
  assert.deepEqual(jobRuns(b).map((r) => [r.jobId, r.from, r.to]),
    [['a', '2026-10-01', '2026-10-02'], ['a', '2026-10-05', '2026-10-05'], ['b', '2026-10-06', '2026-10-07']]);
});

test('a move between different sites, with distance, gap and tightness', () => {
  const b = bookedIndex([...days('a', '2026-09-28', '2026-10-02'), ...days('b', '2026-10-06', '2026-10-08')]).get('x');
  const [m] = movesFor({ id: 'x' }, { runs: jobRuns(b), jobsById: J, win: W, today: '2026-10-01' });
  assert.equal(m.from.label, 'TST1 Muswellbrook NSW');
  assert.equal(m.to.label, 'J2395 Millar Road Baldivis');
  assert.deepEqual([m.leaveAfter, m.dueBy, m.gapDays], ['2026-10-02', '2026-10-06', 3]);
  assert.ok(m.km > 4000 && m.km % 10 === 0, String(m.km));
  assert.equal(m.needDays, Math.ceil(m.km / 800));
  assert.equal(m.tight, true);
});

test('same site back-to-back is not a move; unknown position falls back to state', () => {
  const same = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('c', '2026-10-04', '2026-10-05')]).get('x');
  assert.deepEqual(movesFor({ id: 'x' }, { runs: jobRuns(same), jobsById: J, win: W, today: '2026-10-01' }), []);
  const nopos = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('n', '2026-10-09', '2026-10-10')]).get('x');
  const [m] = movesFor({ id: 'x' }, { runs: jobRuns(nopos), jobsById: J, win: W, today: '2026-10-01' });
  assert.deepEqual([m.km, m.tight], [null, false]);
});

test('moves only when the next job starts within the window plus 14 days', () => {
  const late = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('b', '2026-10-29', '2026-10-30')]).get('x');
  assert.equal(movesFor({ id: 'x' }, { runs: jobRuns(late), jobsById: J, win: W, today: '2026-10-01' }).length, 0);
  const edge = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('b', '2026-10-28', '2026-10-28')]).get('x');
  assert.equal(movesFor({ id: 'x' }, { runs: jobRuns(edge), jobsById: J, win: W, today: '2026-10-01' }).length, 1);
});

test('a first job far from the home base is a base move; near the base is not', () => {
  const far = bookedIndex(days('k', '2026-10-05', '2026-10-07')).get('x');
  const [m] = movesFor({ id: 'x', location: 'WA' }, { runs: jobRuns(far), jobsById: J, win: W, today: '2026-10-01' });
  assert.equal(m.from.label, 'WA base (Perth)');
  assert.equal(m.to.label, 'J2216 Karratha Gas Plant');
  assert.equal(m.leaveAfter, null);
  assert.equal(m.gapDays, 4);
  const near = bookedIndex(days('b', '2026-10-05', '2026-10-07')).get('x');
  assert.equal(movesFor({ id: 'x', location: 'WA' }, { runs: jobRuns(near), jobsById: J, win: W, today: '2026-10-01' }).length, 0);
});

test('tight boundary: gap equal to need is fine', () => {
  // Karratha → Baldivis ≈ 1,300 km × 1.3 ≈ 1,700 km → needs 3 days
  const b = bookedIndex([...days('k', '2026-10-01', '2026-10-02'), ...days('b', '2026-10-06', '2026-10-06')]).get('x');
  const [m] = movesFor({ id: 'x' }, { runs: jobRuns(b), jobsById: J, win: W, today: '2026-10-01' });
  assert.equal(m.gapDays, 3);
  assert.equal(m.needDays, 3);
  assert.equal(m.tight, false);
});

test('tag checks: not at site, not returned, and nothing for a stale ping', () => {
  const now = Date.parse('2026-10-03T01:00:00Z');
  const onJob = jobRuns(bookedIndex(days('a', '2026-10-01', '2026-10-05')).get('x'));
  const far = { lat: -31.95, lng: 115.86, seen_at: '2026-10-03T00:00:00Z' };
  const [c] = tagChecks({ id: 'x' }, { ping: far, staleDays: 3, runs: onJob, jobsById: J, today: '2026-10-03', nowMs: now });
  assert.equal(c.kind, 'not_at_site');
  const ended = jobRuns(bookedIndex(days('a', '2026-09-25', '2026-09-29')).get('x'));
  const atSite = { lat: -32.27, lng: 150.9, seen_at: '2026-10-03T00:00:00Z' };
  const [r] = tagChecks({ id: 'x' }, { ping: atSite, staleDays: 3, runs: ended, jobsById: J, today: '2026-10-03', nowMs: now });
  assert.equal(r.kind, 'not_returned');
  const stale = { ...far, seen_at: '2026-09-20T00:00:00Z' };
  assert.deepEqual(tagChecks({ id: 'x' }, { ping: stale, staleDays: 3, runs: onJob, jobsById: J, today: '2026-10-03', nowMs: now }), []);
});

test('usage over the last 30 days, idle, last used', () => {
  const b = bookedIndex([...days('a', '2026-09-01', '2026-09-15'), ...days('a', '2026-10-01', '2026-10-01')]).get('x');
  assert.equal(usagePct(b, '2026-10-01'), 50); // 1–15 Sep inside 1 Sep..30 Sep = 15/30
  assert.equal(usagePct(b, '2026-10-02'), 50); // 2 Sep..1 Oct: 14 + 1
  assert.equal(usagePct(undefined, '2026-10-01'), 0);
  assert.equal(lastUsed(b, '2026-10-01'), '2026-09-15');
  const old = bookedIndex(days('a', '2026-08-01', '2026-08-05')).get('x');
  assert.equal(isIdle({ id: 'x' }, old, '2026-10-01'), true);
  assert.equal(isIdle({ id: 'x' }, b, '2026-10-01'), false);
  assert.equal(isIdle({ id: 'x', active: 0 }, old, '2026-10-01'), false);
  assert.equal(isIdle({ id: 'x', serviceable: 0 }, old, '2026-10-01'), false);
});

test('nearFilter keeps rows within the radius, nearest first', () => {
  const rows = [
    { id: 'p', loc: { lat: -31.95, lng: 115.86 } },
    { id: 'k', loc: { lat: -20.59, lng: 116.78 } },
    { id: 'u', loc: { lat: null, lng: null } },
  ];
  const out = nearFilter(rows, { lat: -32.28, lng: 115.83 }, 500);
  assert.deepEqual(out.map((r) => r.id), ['p']);
  assert.ok(out[0].distKm < 50);
  assert.deepEqual(nearFilter(rows, { lat: -32.28, lng: 115.83 }, 1500).map((r) => r.id), ['p', 'k']);
});

test('moves into a job that has already started are not listed', () => {
  const started = bookedIndex(days('k', '2026-10-01', '2026-10-03')).get('x');
  assert.equal(movesFor({ id: 'x', location: 'WA' }, { runs: jobRuns(started), jobsById: J, win: W, today: '2026-10-01' }).length, 0);
  const b = bookedIndex([...days('a', '2026-09-28', '2026-09-30'), ...days('b', '2026-10-01', '2026-10-02')]).get('x');
  assert.equal(movesFor({ id: 'x' }, { runs: jobRuns(b), jobsById: J, win: W, today: '2026-10-01' }).length, 0);
});
