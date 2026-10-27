import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankResult, outcomeOf, formProblems, submission, mergeEquipment, vocStatus } from '../src/lib/voc.js';

const cat = {
  key: 'payload',
  title: 'Payloads',
  equipmentLabel: 'Payloads',
  tasks: [{ key: 'mounting', label: 'Mounting' }, { key: 'operation', label: 'Operation' }],
};
const done = (patch = {}) => ({
  ...blankResult(),
  equipment: ['Zenmuse L2'],
  tasks: { mounting: 'competent', operation: 'competent' },
  theory: 'pass',
  practical: 'pass',
  ...patch,
});

test('outcome waits for every answer, then needs all competent and both passes', () => {
  assert.equal(outcomeOf(cat, blankResult()), null);
  assert.equal(outcomeOf(cat, done()), 'competent');
  assert.equal(outcomeOf(cat, done({ practical: 'fail' })), 'nyc');
  assert.equal(outcomeOf(cat, done({ tasks: { mounting: 'nyc', operation: 'competent' } })), 'nyc');
});

test('form problems point at what is missing, one message per category', () => {
  const base = { assessedOn: '2026-10-01', assessorName: 'Alex', today: '2026-10-27' };
  assert.equal(formProblems([cat], { ...base, results: {} }).general.categories, 'Choose at least one category');
  assert.match(formProblems([cat], { ...base, results: { payload: blankResult() } }).categories.payload, /payloads assessed/);
  assert.equal(formProblems([cat], { ...base, results: { payload: done({ tasks: {} }) } }).categories.payload, 'Mark every task');
  assert.match(formProblems([cat], { ...base, results: { payload: done({ practical: 'fail' }) } }).categories.payload, /still needs/);
  assert.equal(formProblems([cat], { ...base, results: { payload: done() } }).count, 0);
  assert.equal(
    formProblems([cat], { ...base, assessedOn: '2026-11-01', results: { payload: done() } }).general.assessedOn,
    'Cannot be in the future',
  );
});

test('submission sends only the chosen categories, with a blank score as null', () => {
  const body = submission({
    member: { id: 'm2' },
    categories: [cat, { ...cat, key: 'other' }],
    assessedOn: '2026-10-01',
    assessorName: ' Alex ',
    results: { payload: done({ theory_score: '', notes: ' ok ' }) },
    comments: '',
  });
  assert.equal(body.assessor_name, 'Alex');
  assert.deepEqual(body.results.map((r) => r.key), ['payload']);
  assert.equal(body.results[0].theory_score, null);
  assert.equal(body.results[0].notes, 'ok');
});

test('typed equipment joins the list once, whatever the case', () => {
  let { list, name } = mergeEquipment(['Zenmuse P1'], '  zenmuse   l2 ');
  assert.deepEqual(list, ['zenmuse l2', 'Zenmuse P1']);
  assert.equal(name, 'zenmuse l2');
  ({ list, name } = mergeEquipment(list, 'ZENMUSE P1'));
  assert.equal(list.length, 2);
  assert.equal(name, 'Zenmuse P1');
});

test('VOC status: current, expiring soon, expired, or nothing certified', () => {
  const voc = (expires_on, outcome = 'competent') => ({ expires_on, results: [{ outcome }] });
  assert.equal(vocStatus(voc('2027-06-01'), '2026-10-27'), 'current');
  assert.equal(vocStatus(voc('2026-12-01'), '2026-10-27'), 'soon');
  assert.equal(vocStatus(voc('2026-10-26'), '2026-10-27'), 'expired');
  assert.equal(vocStatus(voc('2027-06-01', 'nyc'), '2026-10-27'), 'nyc');
});
