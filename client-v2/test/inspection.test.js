import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, templateForCategory } from '../../server/src/services/inspectionTemplates.js';
import { templateFor, blankAnswers, formProblems, defectCount, submission } from '../src/lib/inspection.js';

// The shape GET /api/inspections/templates returns.
const byCategory = {};
for (const t of TEMPLATES) for (const c of t.categories) byCategory[c] = t.id;
const served = { templates: TEMPLATES, byCategory, fallback: templateForCategory('').id };
const drone = TEMPLATES.find((t) => t.id === 'drone-basic');

const filled = () => {
  const answers = blankAnswers(drone);
  for (const a of drone.areas) answers[a.key] = { defects: 'no', notes: '', photos: [{ tempId: a.key, id: `p-${a.key}` }] };
  return answers;
};
const details = { reason: 'Scheduled maintenance', inspection_type: '100 hr' };

test('each category opens on its own form, uncategorised kit on the general one', () => {
  assert.equal(templateFor(served, 'Drones').id, 'drone-basic');
  assert.equal(templateFor(served, 'Batteries').id, 'battery');
  assert.equal(templateFor(served, '').id, 'general');
});

test('a blank form lists every area as unanswered', () => {
  const p = formProblems(drone, {}, blankAnswers(drone));
  assert.equal(Object.keys(p.areas).length, drone.areas.length);
  assert.ok(p.details.reason && p.details.inspection_type);
});

test('a Yes needs a note before the form can be sent', () => {
  const answers = filled();
  answers.motor_2.defects = 'yes';
  assert.equal(formProblems(drone, details, answers).areas.motor_2, 'Describe the defect');
  answers.motor_2.notes = 'Chipped bell housing';
  assert.equal(formProblems(drone, details, answers).count, 0);
  assert.equal(defectCount(drone, answers), 1);
});

test('an area waits for its photos to finish uploading', () => {
  const answers = filled();
  answers.prop_1.photos = [{ tempId: 1, uploading: true }];
  assert.match(formProblems(drone, details, answers).areas.prop_1, /uploading/);
});

test('the submission sends photo ids, drops notes on a No and only asks for unserviceable with a defect', () => {
  const answers = filled();
  answers.motor_1.notes = 'left over from a Yes';
  const body = submission({ item: { id: 'd1' }, template: drone, details, answers, comments: ' ok ', markUnserviceable: true });
  assert.deepEqual(body.answers.motor_1, { defects: 'no', notes: '', photos: ['p-motor_1'] });
  assert.equal(body.comments, 'ok');
  assert.equal(body.mark_unserviceable, false);
});
