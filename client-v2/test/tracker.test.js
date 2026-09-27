import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupItems, headerCounts, statusText, inviteStatusText, portalOnline } from '../src/lib/tracker.js';

const items = [
  { identifier: 'd1', account: 'droneops', kind: 'device', included: 0, status: 'excluded' },
  { identifier: 't1', account: 'droneops', kind: 'tag', included: 1, equipment_id: 'eq1', status: 'ok' },
  { identifier: 't2', account: 'droneops', kind: 'tag', included: 1, equipment_id: 'eq2', status: 'stale' },
  { identifier: 't3', account: 'site', kind: 'tag', included: 0, status: 'excluded' },
];

test('groupItems splits each account into tags and devices', () => {
  const g = groupItems(items);
  assert.deepEqual(g.map((x) => x.account), ['droneops', 'site']);
  assert.deepEqual(g[0].tags.map((i) => i.identifier), ['t1', 't2']);
  assert.deepEqual(g[0].devices.map((i) => i.identifier), ['d1']);
});

test('headerCounts', () => {
  assert.deepEqual(headerCounts(items), { tags: 3, tracked: 2, stale: 1, devicesHidden: 1 });
});

test('statusText', () => {
  assert.equal(statusText({ status: 'stale', last_seen_at: '2026-09-20T00:00:00Z' }, Date.parse('2026-09-25T00:00:00Z')), 'Stale · 5 days');
  assert.equal(statusText({ status: 'unlinked' }), 'Not linked');
  assert.equal(statusText({ status: 'ok', last_seen_at: '2026-09-25T00:00:00Z', battery: 'Full' }, Date.parse('2026-09-25T02:00:00Z')), 'Seen 2 h ago · Full');
});


test('inviteStatusText', () => {
  assert.equal(inviteStatusText({ status: 'pending', attempts_left: 3 }), 'Waiting');
  assert.equal(inviteStatusText({ status: 'pending', attempts_left: 1 }), 'Waiting · 1 try left');
  assert.equal(inviteStatusText({ status: 'done', tags_saved: 2 }), 'Done · 2 tags');
  assert.equal(inviteStatusText({ status: 'cleanup_needed' }), 'Cleanup needed');
  assert.equal(inviteStatusText({ status: 'expired' }), 'Expired');
});

test('portalOnline is true within an hour of the last good report', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  assert.equal(portalOnline({ portal_last_ok_at: '2026-09-27T11:30:00Z' }, now), true);
  assert.equal(portalOnline({ portal_last_ok_at: '2026-09-27T10:30:00Z' }, now), false);
  assert.equal(portalOnline({ portal_last_ok_at: null }, now), false);
});
