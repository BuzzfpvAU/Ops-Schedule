import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUnCode, parseUnCodes, formatUnCodes, describeUnCode, dgSummary, UN_CODES,
} from '../src/lib/dangerousGoods.js';

test('a UN number can be typed with or without the prefix', () => {
  assert.equal(normalizeUnCode('3480'), 'UN3480');
  assert.equal(normalizeUnCode(' un 3481 '), 'UN3481');
  assert.equal(normalizeUnCode('UN1203'), 'UN1203');
  assert.equal(normalizeUnCode('UN34'), null);
  assert.equal(normalizeUnCode('lithium'), null);
});

test('a list is split, normalised and deduplicated, with unreadable parts reported', () => {
  assert.deepEqual(parseUnCodes('UN3480, 3481; un3480\nabc'), { codes: ['UN3480', 'UN3481'], invalid: ['abc'] });
  assert.deepEqual(parseUnCodes(''), { codes: [], invalid: [] });
  assert.equal(formatUnCodes(['UN3480', 'UN3481']), 'UN3480,UN3481');
});

test('known codes are described; unknown ones are shown as-is', () => {
  assert.equal(describeUnCode('UN3481'), 'UN3481 — Lithium ion batteries in or with equipment (Class 9)');
  assert.equal(describeUnCode('UN9999'), 'UN9999');
});

test('the tooltip lists every code an item carries', () => {
  assert.equal(dgSummary({ un_codes: 'UN3480,UN9999' }),
    'Contains dangerous goods:\nUN3480 — Lithium ion batteries (Class 9)\nUN9999');
  assert.equal(dgSummary({ un_codes: '' }), 'Contains dangerous goods');
});

test('the reference list has no duplicate or malformed codes', () => {
  const codes = UN_CODES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.equal(normalizeUnCode(c), c);
});
