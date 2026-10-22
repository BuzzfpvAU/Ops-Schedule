import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runsFor, runWhen, kitStatus, kitOnMyJobs, ago, mapsUrl } from '../src/lib/fieldView.js';
import { pickLayout } from '../src/lib/layout.js';

const e = (member, job, date, status = 'confirmed', notes = '') => ({
  team_member_id: member, job_id: job, job_code: job.toUpperCase(), job_name: `Job ${job}`, date, status, notes,
});

const schedule = [
  e('me', 'a', '2026-10-20'), e('me', 'a', '2026-10-21'), e('me', 'a', '2026-10-22', 'confirmed', 'Site induction 7am'),
  e('me', 'a', '2026-10-23'),
  e('me', 'b', '2026-10-27', 'tentative'), e('me', 'b', '2026-10-28', 'tentative'),
  e('me', 'b', '2026-10-30', 'tentative'), // a gap starts a new run
  e('me', 'old', '2026-10-01'),
  e('drone', 'a', '2026-10-21'), e('drone', 'a', '2026-10-22'), e('drone', 'c', '2026-11-03'),
  e('battery', 'b', '2026-10-28'),
  e('other', 'x', '2026-10-22'), e('spare', 'x', '2026-10-22'),
];
const today = '2026-10-22';

test('my days are grouped into runs per job, and past runs drop off', () => {
  const runs = runsFor(schedule, 'me', today);
  assert.deepEqual(runs.map((r) => [r.job_id, r.start, r.end, r.days]), [
    ['a', '2026-10-20', '2026-10-23', 4],
    ['b', '2026-10-27', '2026-10-28', 2],
    ['b', '2026-10-30', '2026-10-30', 1],
  ]);
  assert.deepEqual(runs[0].notes, [{ date: '2026-10-22', text: 'Site induction 7am' }]);
});

test('a change of status on the same job starts a new run', () => {
  const runs = runsFor([e('me', 'a', '2026-10-22'), e('me', 'a', '2026-10-23', 'tentative')], 'me', today);
  assert.equal(runs.length, 2);
});

test('runs are labelled now, tomorrow or in n days', () => {
  const [now, next] = runsFor(schedule, 'me', today);
  assert.equal(runWhen(now, today), 'Now');
  assert.equal(runWhen(next, today), 'In 5 days');
  assert.equal(runWhen({ start: '2026-10-23' }, today), 'Tomorrow');
});

test('kit shows the job it is on now and its next booking', () => {
  const s = kitStatus(schedule, 'drone', today);
  assert.equal(s.now.job_id, 'a');
  assert.equal(s.now.end, '2026-10-22');
  assert.equal(s.next.job_id, 'c');
  assert.deepEqual(kitStatus(schedule, 'nothing', today), { now: null, next: null });
});

test('kit on my jobs is what is booked to jobs I am on from today', () => {
  assert.deepEqual([...kitOnMyJobs(schedule, 'me', today)].sort(), ['battery', 'drone']);
});

test('last seen reads as minutes, hours or days ago', () => {
  const now = Date.parse('2026-10-22T10:00:00Z');
  assert.equal(ago('2026-10-22T09:55:00+00:00', now), '5 min ago');
  assert.equal(ago('2026-10-22T07:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-10-19T10:00:00Z', now), '3 d ago');
  assert.equal(ago('', now), '');
});

test('maps links prefer coordinates, then the address', () => {
  assert.match(mapsUrl({ lat: -31.95, lng: 115.86, address: 'x' }), /query=-31.95,115.86$/);
  assert.match(mapsUrl({ address: '1 Hay St, Perth' }), /query=1%20Hay%20St%2C%20Perth$/);
  assert.equal(mapsUrl({}), null);
});

test('phones get the phone layout unless someone chose otherwise', () => {
  assert.equal(pickLayout('auto', true), 'mobile');
  assert.equal(pickLayout('auto', false), 'full');
  assert.equal(pickLayout('full', true), 'full');
  assert.equal(pickLayout('mobile', false), 'mobile');
});
