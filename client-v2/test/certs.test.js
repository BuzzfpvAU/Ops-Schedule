import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certStatus, heldIndex, candidatesFor, worstStatus, NO_EXPIRY } from '../src/lib/certs.js';

const today = '2026-10-05';

test('certStatus: expired, lapses during the job, expiring soon, no date, current', () => {
  assert.equal(certStatus('2026-10-04', { today }), 'expired');
  assert.equal(certStatus('2026-10-20', { today, jobEnd: '2026-11-01' }), 'lapses');
  assert.equal(certStatus('2026-11-20', { today }), 'soon');
  assert.equal(certStatus('2027-06-01', { today, jobEnd: '2026-11-01' }), 'valid');
  assert.equal(certStatus(null, { today }), 'nodate');
});

test('candidates are everyone who has held every required cert, best first, expired included', () => {
  const held = heldIndex([
    { member_id: 'a', cert_type_id: 'msic', expiry_date: '2027-06-01' },
    { member_id: 'a', cert_type_id: 'asic', expiry_date: '2027-06-01' },
    { member_id: 'b', cert_type_id: 'msic', expiry_date: '2025-01-01' },
    { member_id: 'b', cert_type_id: 'asic', expiry_date: '2027-06-01' },
    { member_id: 'c', cert_type_id: 'msic', expiry_date: '2027-06-01' },
  ]);
  const members = [{ id: 'c', name: 'Cy' }, { id: 'b', name: 'Bo' }, { id: 'a', name: 'Al' }];
  const got = candidatesFor(members, held, ['msic', 'asic'], { today, jobEnd: '2026-11-01' });
  assert.deepEqual(got.map((c) => [c.member.id, c.worst]), [['a', 'valid'], ['b', 'expired']]);
  assert.deepEqual(candidatesFor(members, held, [], { today }), []);
});

test('worstStatus summarises everything a person holds', () => {
  const mine = new Map([['msic', '2027-06-01'], ['asic', '2026-01-01']]);
  assert.equal(worstStatus(mine, { today }), 'expired');
  assert.equal(worstStatus(undefined, { today }), 'valid');
});

test('a certificate that never expires is current, never warned about, and sorts with the clean ones', () => {
  assert.equal(certStatus(NO_EXPIRY, { today, jobEnd: '2030-01-01' }), 'never');
  const held = heldIndex([
    { member_id: 'a', cert_type_id: 'asic', expiry_date: null, no_expiry: 1 },
    { member_id: 'b', cert_type_id: 'asic', expiry_date: null, no_expiry: 0 },
  ]);
  assert.equal(held.get('a').get('asic'), NO_EXPIRY);
  assert.equal(held.get('b').get('asic'), null);
  const got = candidatesFor([{ id: 'a', name: 'Al' }, { id: 'b', name: 'Bo' }], held, ['asic'], { today });
  assert.deepEqual(got.map((c) => [c.member.id, c.worst]), [['a', 'valid'], ['b', 'nodate']]);
  assert.equal(worstStatus(held.get('a'), { today }), 'valid');
});
