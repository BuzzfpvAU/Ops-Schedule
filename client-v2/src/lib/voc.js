// ── VOC form helpers ────────────────────────────────────────────────
// Pure functions behind VocForm, kept here so they can be tested without a
// browser. The server repeats every check; these only let the form point
// at what is missing before anything is sent.

// A blank result for one category: nothing ticked or marked yet.
export function blankResult() {
  return { equipment: [], tasks: {}, theory: '', theory_score: '', practical: '', notes: '' };
}

// Competent when no task is NYC and at least one is Competent (N/A tasks
// are left out), and both theory and practical were passed; null while
// anything is still unanswered.
export function outcomeOf(category, r) {
  const marks = category.tasks.map((t) => r.tasks[t.key]);
  if (marks.some((m) => !m) || !r.theory || !r.practical) return null;
  const tasksOk = !marks.includes('nyc') && marks.includes('competent');
  return tasksOk && r.theory === 'pass' && r.practical === 'pass' ? 'competent' : 'nyc';
}

// What still stops the form being sent. `general` holds form-wide problems;
// `categories` one message per category, keyed by category key.
export function formProblems(categories, { assessedOn, assessorName, results, today }) {
  const problems = { general: {}, categories: {}, count: 0 };
  const add = (bucket, key, msg) => {
    if (problems[bucket][key]) return;
    problems[bucket][key] = msg;
    problems.count += 1;
  };
  if (!assessedOn) add('general', 'assessedOn', 'Required');
  else if (today && assessedOn > today) add('general', 'assessedOn', 'Cannot be in the future');
  if (!String(assessorName || '').trim()) add('general', 'assessorName', 'Required');
  const chosen = categories.filter((c) => results[c.key]);
  if (!chosen.length) add('general', 'categories', 'Choose at least one category');

  for (const c of chosen) {
    const r = results[c.key];
    const score = String(r.theory_score ?? '').trim();
    if (!r.equipment.length) add('categories', c.key, `Tick or add the ${c.equipmentLabel.toLowerCase()} assessed`);
    else if (c.tasks.some((t) => !r.tasks[t.key])) add('categories', c.key, 'Mark every task');
    else if (!r.theory || !r.practical) add('categories', c.key, 'Record the theory and practical results');
    else if (score && !(Number(score) >= 0 && Number(score) <= 100)) add('categories', c.key, 'Theory score must be 0–100');
    else if (outcomeOf(c, r) === 'nyc' && !r.notes.trim()) add('categories', c.key, 'Note what still needs to be demonstrated');
  }
  return problems;
}

// The body POSTed to /api/vocs.
export function submission({ member, categories, assessedOn, assessorName, results, comments }) {
  return {
    member_id: member.id,
    assessed_on: assessedOn,
    assessor_name: assessorName.trim(),
    comments: comments.trim(),
    results: categories.filter((c) => results[c.key]).map((c) => {
      const r = results[c.key];
      return {
        key: c.key,
        equipment: r.equipment,
        tasks: r.tasks,
        theory: r.theory,
        theory_score: String(r.theory_score ?? '').trim() === '' ? null : Number(r.theory_score),
        practical: r.practical,
        notes: r.notes.trim(),
      };
    }),
  };
}

// Add a typed model to a pick-list without doubling one already there
// (ignoring case and spacing). Returns the name as it should be ticked.
export function mergeEquipment(list, typed) {
  const name = String(typed || '').trim().replace(/\s+/g, ' ');
  if (!name) return { list, name: '' };
  const existing = list.find((e) => e.toLowerCase() === name.toLowerCase());
  if (existing) return { list, name: existing };
  return { list: [...list, name].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })), name };
}

// A VOC's state on a given day: expired, expiring within 60 days, or current.
// One with nothing found competent certifies nothing.
export function vocStatus(voc, today) {
  if (!voc.results.some((r) => r.outcome === 'competent')) return 'nyc';
  if (voc.expires_on < today) return 'expired';
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 60);
  if (voc.expires_on <= soon.toISOString().slice(0, 10)) return 'soon';
  return 'current';
}
