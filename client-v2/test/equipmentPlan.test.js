import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookedIndex, planWindow, availability, availText, resolveLocation, sortRows, summary, BASE_CITIES,
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
