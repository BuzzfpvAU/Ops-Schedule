import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingWindow } from '../src/lib/model.js';

const crew = [
  { id: 'a', from_date: '2026-10-05', to_date: '2026-10-08' },
  { id: 'b', from_date: '2026-10-03', to_date: '2026-10-06' },
];

test('bookingWindow: planned start and end win', () => {
  assert.deepEqual(
    bookingWindow({ planned_start: '2026-10-01', planned_end: '2026-10-02' }, crew),
    { from: '2026-10-01', to: '2026-10-02', source: 'planned' }
  );
});

test('bookingWindow: a start with no end is a one-day job (as V1 reads it)', () => {
  assert.deepEqual(
    bookingWindow({ planned_start: '2026-10-01', planned_end: '' }, []),
    { from: '2026-10-01', to: '2026-10-01', source: 'planned' }
  );
});

test('bookingWindow: no planned dates falls back to the crew span', () => {
  assert.deepEqual(
    bookingWindow({ planned_start: '', planned_end: '' }, crew),
    { from: '2026-10-03', to: '2026-10-08', source: 'crew' }
  );
});

test('bookingWindow: end before start is ignored in favour of the crew span', () => {
  assert.deepEqual(
    bookingWindow({ planned_start: '2026-10-09', planned_end: '2026-10-01' }, crew),
    { from: '2026-10-03', to: '2026-10-08', source: 'crew' }
  );
});

test('bookingWindow: nothing to go on gives null', () => {
  assert.equal(bookingWindow({}, []), null);
  assert.equal(bookingWindow({}, [{ id: 'x' }]), null);
  assert.equal(bookingWindow(null, null), null);
});
