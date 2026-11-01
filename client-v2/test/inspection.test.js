import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, templateForCategory } from '../../server/src/services/inspectionTemplates.js';
import { templateFor, blankAnswers, formProblems, defectCount, submission, areaQuestion, answerOptions } from '../src/lib/inspection.js';

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

test('the Woodside T4 form asks positive questions, where No is the fail', () => {
  const t4 = TEMPLATES.find((t) => t.id === 'woodside-t4');
  assert.equal(areaQuestion(t4, t4.areas[0]), 'Free from damage and in working order?');
  assert.equal(areaQuestion(t4, t4.areas.find((a) => a.key === 'paperwork')), 'Complete and ready to go?');
  assert.equal(areaQuestion(drone, drone.areas[0]), 'Defects observed?', 'other forms are unchanged');
  assert.deepEqual(answerOptions(t4).map((o) => [o.label, o.defects]), [['Yes', 'no'], ['No', 'yes'], ['N/A', 'na']]);
  assert.deepEqual(answerOptions(drone).map((o) => [o.label, o.defects]), [['No', 'no'], ['Yes', 'yes']]);

  const answers = blankAnswers(t4);
  answers.condition = { defects: 'yes', notes: '', photos: [] };
  assert.equal(formProblems(t4, {}, answers).areas.condition, 'Describe what is wrong');
});

test('N/A on the T4 form needs no note or photo and is not a defect', () => {
  const t4 = TEMPLATES.find((t) => t.id === 'woodside-t4');
  const answers = blankAnswers(t4);
  for (const a of t4.areas) answers[a.key] = { defects: 'na', notes: '', photos: [] };
  assert.equal(formProblems(t4, { site: 'Pluto LNG', job_ref: 'PO 1', dg_class: 'Not DG' }, answers).count, 0);
  assert.equal(defectCount(t4, answers), 0);
});
