import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pastJobs } from '../src/lib/cleanup.js';

const j = (id, roster_end, extra = {}) => ({ id, code: id, name: id, roster_end, ...extra });

test('past jobs: finished, still active, real projects, most recent first', () => {
  const jobs = [
    j('old', '2026-08-01'),
    j('recent', '2026-10-01'),
    j('today', '2026-10-07'),
    j('future', '2026-11-01'),
    j('none', null),
    j('done', '2026-01-01', { archived: 1 }),
    j('leave', '2026-09-01', { code: 'LEAVE' }),
  ];
  assert.deepEqual(pastJobs(jobs, '2026-10-07').map((x) => x.id), ['recent', 'old']);
});
