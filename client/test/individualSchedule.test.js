import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupEntriesByDate, annotateSpans, withMonthHeaders,
  canEditSchedule, canDeleteEntry, defaultMemberId,
} from '../src/utils/individualSchedule.js';

const entry = (over) => ({
  id: 'e1', team_member_id: 'm1', job_id: 'j1', date: '2026-09-10', status: 'confirmed', ...over,
});

const dateObjs = (strs) => strs.map(dateStr => ({ dateStr, date: new Date(dateStr + 'T00:00:00') }));

test('groups only the viewed member entries, by date', () => {
  const schedule = [
    entry({ id: 'a', date: '2026-09-10' }),
    entry({ id: 'b', date: '2026-09-10', job_id: 'j2' }),
    entry({ id: 'c', date: '2026-09-11' }),
    entry({ id: 'd', team_member_id: 'm2' }),
  ];
  const grouped = groupEntriesByDate(schedule, 'm1');
  assert.deepEqual(Object.keys(grouped).sort(), ['2026-09-10', '2026-09-11']);
  assert.equal(grouped['2026-09-10'].length, 2);
  assert.equal(grouped['2026-09-11'].length, 1);
});

test('groups nothing when no member is selected', () => {
  assert.deepEqual(groupEntriesByDate([entry({})], null), {});
});

test('numbers consecutive days on the same job', () => {
  const dates = dateObjs(['2026-09-10', '2026-09-11', '2026-09-12']);
  const grouped = groupEntriesByDate([
    entry({ id: 'a', date: '2026-09-10' }),
    entry({ id: 'b', date: '2026-09-11' }),
    entry({ id: 'c', date: '2026-09-12' }),
  ], 'm1');
  const spans = annotateSpans(grouped, dates);
  assert.deepEqual(
    dates.map(d => spans[d.dateStr][0].spanIndex),
    [1, 2, 3]
  );
  assert.equal(spans['2026-09-11'][0].spanLength, 3);
});

test('a gap starts a new run', () => {
  const dates = dateObjs(['2026-09-10', '2026-09-11', '2026-09-12']);
  const grouped = groupEntriesByDate([
    entry({ id: 'a', date: '2026-09-10' }),
    entry({ id: 'c', date: '2026-09-12' }),
  ], 'm1');
  const spans = annotateSpans(grouped, dates);
  assert.deepEqual(spans['2026-09-10'][0], { ...grouped['2026-09-10'][0], spanIndex: 1, spanLength: 1 });
  assert.equal(spans['2026-09-12'][0].spanLength, 1);
});

test('different jobs on the same days are counted separately', () => {
  const dates = dateObjs(['2026-09-10', '2026-09-11']);
  const grouped = groupEntriesByDate([
    entry({ id: 'a', date: '2026-09-10', job_id: 'j1' }),
    entry({ id: 'b', date: '2026-09-10', job_id: 'j2' }),
    entry({ id: 'c', date: '2026-09-11', job_id: 'j1' }),
  ], 'm1');
  const spans = annotateSpans(grouped, dates);
  const [first, second] = spans['2026-09-10'];
  assert.equal(first.spanLength, 2);
  assert.equal(second.spanLength, 1);
});

test('month header appears once per month', () => {
  const tagged = withMonthHeaders(dateObjs(['2026-09-29', '2026-09-30', '2026-10-01']));
  assert.deepEqual(tagged.map(d => d.monthHeader), ['SEPTEMBER 2026', null, 'OCTOBER 2026']);
});

test('editing is allowed on your own days only', () => {
  const user = { memberId: 'm1', isAdmin: false, isViewer: false };
  assert.equal(canEditSchedule(user, 'm1'), true);
  assert.equal(canEditSchedule(user, 'm2'), false);
});

test('admins may edit anyone, viewers may edit nobody', () => {
  assert.equal(canEditSchedule({ memberId: 'm1', isAdmin: true }, 'm2'), true);
  assert.equal(canEditSchedule({ memberId: 'v', isViewer: true }, 'v'), false);
  assert.equal(canEditSchedule(null, 'm1'), false);
});

test('you may remove your own note-type entries, not assigned work', () => {
  const user = { memberId: 'm1', isAdmin: false };
  assert.equal(canDeleteEntry(user, entry({ status: 'toil' })), true);
  assert.equal(canDeleteEntry(user, entry({ status: 'confirmed' })), false);
  assert.equal(canDeleteEntry(user, entry({ status: 'toil', team_member_id: 'm2' })), false);
  assert.equal(canDeleteEntry({ memberId: 'x', isAdmin: true }, entry({ status: 'confirmed' })), true);
});

test('the view opens on you, or the first member when you have no row', () => {
  const team = [{ id: 'm1' }, { id: 'm2' }];
  assert.equal(defaultMemberId({ memberId: 'm2' }, team), 'm2');
  assert.equal(defaultMemberId({ memberId: 'viewer' }, team), 'm1');
  assert.equal(defaultMemberId({ memberId: 'm1' }, []), null);
});
