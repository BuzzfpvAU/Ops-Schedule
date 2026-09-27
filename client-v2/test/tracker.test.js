import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupItems, headerCounts, statusText } from '../src/lib/tracker.js';

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
