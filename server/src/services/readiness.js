// Readiness engine — computes per-gate readiness for a job's workflow
// transitions: planning → confirmed → active → complete.
//
// Gates:
//   crew        rostered crew ≥ crew_size, nobody on leave/unavailable
//   compliance  every crew member holds the job's required credentials,
//               valid beyond the job end date (or no expired records)
//   kit         every assigned item booked for the full job window,
//               no cross-job conflicts, nothing unserviceable
//   admin       gate-critical checklist items (stage "planning") done or
//               scheduled with a due date ≤ job start
//   prep        dispatch items (stage "active") done — gates "Active"
//   closeout    return items (stage "complete") done — gates "Complete"
//   logistics   travel/accommodation/vehicles — advisory, never blocks
//
// Design: docs/superpowers/specs/2026-09-18-planning-workflow-design.md

import { findConflicts } from './conflicts.js';

const todayISO = () => new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
const iso = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const norm = (s) => String(s || '').trim().toLowerCase();

// Which gates must pass for each target status. Empty = no gate (free move).
export const TRANSITION_GATES = {
  planning: [],
  confirmed: ['crew', 'compliance', 'kit', 'admin'],
  active: ['crew', 'compliance', 'kit', 'admin', 'prep'],
  complete: ['closeout'],
  cancelled: [],
};

function makeGate(key, title, checks, { advisory = false } = {}) {
  const anyFail = checks.some((c) => !c.ok);
  let status = 'pass';
  if (anyFail) status = advisory ? 'warn' : 'fail';
  return { key, title, advisory, status, checks };
}

export function computeReadiness(db, jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;

  // ── Span: crew roster first, then any entries, then the planned window ──
  const crewSpan = db.prepare(`
    SELECT MIN(e.date) AS s, MAX(e.date) AS e
    FROM schedule_entries e
    JOIN team_members tm ON tm.id = e.team_member_id
    WHERE e.job_id = ? AND tm.is_equipment = 0
  `).get(jobId);
  const allSpan = db.prepare('SELECT MIN(date) AS s, MAX(date) AS e FROM schedule_entries WHERE job_id = ?').get(jobId);
  const spanStart = crewSpan.s || allSpan.s || iso(job.planned_start);
  const spanEnd = crewSpan.e || allSpan.e || iso(job.planned_end) || spanStart;
  const span = spanStart ? { start: spanStart, end: spanEnd || spanStart } : null;
  const refEnd = span ? span.end : todayISO();
  const today = todayISO();

  // ── Crew ─────────────────────────────────────────────────────────────────
  const crew = db.prepare(`
    SELECT tm.id, tm.name
    FROM schedule_entries e
    JOIN team_members tm ON tm.id = e.team_member_id
    WHERE e.job_id = ? AND tm.is_equipment = 0
    GROUP BY tm.id
    ORDER BY tm.name
  `).all(jobId);
  const crewIds = crew.map((c) => c.id);

  const crewChecks = [{
    label: 'Crew assigned',
    ok: crew.length >= (job.crew_size || 1),
    note: `${crew.length} of ${job.crew_size || 1} assigned`,
  }];
  if (span && crewIds.length) {
    const ph = crewIds.map(() => '?').join(',');
    const clashes = db.prepare(`
      SELECT e.team_member_id, e.status, MIN(e.date) AS d1, MAX(e.date) AS d2
      FROM schedule_entries e
      WHERE e.team_member_id IN (${ph})
        AND e.job_id != ?
        AND e.status IN ('leave', 'unavailable')
        AND e.date >= ? AND e.date <= ?
      GROUP BY e.team_member_id, e.status
      ORDER BY d1
    `).all(...crewIds, jobId, span.start, span.end);
    for (const c of clashes) {
      const member = crew.find((m) => m.id === c.team_member_id);
      crewChecks.push({
        label: member ? member.name : c.team_member_id,
        ok: false,
        note: `marked ${c.status} ${c.d1}–${c.d2}`,
      });
    }
  }
  const crewGate = makeGate('crew', 'Crew', crewChecks);

  // ── Compliance ───────────────────────────────────────────────────────────
  const requirements = db.prepare('SELECT compliance_type FROM job_requirements WHERE job_id = ?').all(jobId)
    .map((r) => r.compliance_type);
  const compRows = crewIds.length
    ? db.prepare(`SELECT * FROM member_compliance WHERE team_member_id IN (${crewIds.map(() => '?').join(',')})`).all(...crewIds)
    : [];
  const compChecks = crew.map((m) => {
    const mine = compRows.filter((r) => r.team_member_id === m.id);
    const issues = [];
    if (requirements.length) {
      for (const req of requirements) {
        const rec = mine.find((r) => norm(r.type) === norm(req));
        if (!rec) issues.push(`missing ${req}`);
        else if (rec.expires_at && rec.expires_at < refEnd) issues.push(`${req} expired ${rec.expires_at}`);
      }
    } else {
      for (const r of mine) {
        if (r.expires_at && r.expires_at < refEnd) issues.push(`${r.type} expired ${r.expires_at}`);
      }
    }
    const requiredNote = requirements.length
      ? `${requirements.length} required type${requirements.length === 1 ? '' : 's'}`
      : `${mine.length} record${mine.length === 1 ? '' : 's'}`;
    return { label: m.name, ok: issues.length === 0, note: issues.join('; ') || `valid (${requiredNote})` };
  });
  if (crew.length === 0) compChecks.push({ label: 'No crew yet', ok: true, note: 'compliance checked once crew is rostered' });
  const complianceGate = makeGate('compliance', 'Compliance', compChecks);

  // ── Kit ──────────────────────────────────────────────────────────────────
  const kitRows = db.prepare(`
    SELECT je.id AS je_id, tm.id, tm.name, tm.serviceable, tm.equipment_category
    FROM job_equipment je
    JOIN team_members tm ON tm.id = je.equipment_id
    WHERE je.job_id = ?
    ORDER BY COALESCE(NULLIF(tm.equipment_category, ''), 'zz'), tm.name
  `).all(jobId);
  const kitChecks = [];
  for (const item of kitRows) {
    const booking = db.prepare(`
      SELECT MIN(date) AS f, MAX(date) AS t, COUNT(DISTINCT date) AS days
      FROM schedule_entries WHERE job_id = ? AND team_member_id = ?
    `).get(jobId, item.id);
    const issues = [];
    if (span) {
      if (!booking.f) issues.push('not booked');
      else if (booking.f > span.start || booking.t < span.end) {
        issues.push(`booked ${booking.f}–${booking.t}, job runs ${span.start}–${span.end}`);
      }
    }
    const winFrom = booking.f || span?.start || today;
    const winTo = booking.t || span?.end || today;
    const conflicts = findConflicts(db, item.id, winFrom, winTo, jobId);
    if (conflicts.length) {
      issues.push('overlaps ' + conflicts.map((c) => `${c.code} (${c.from}–${c.to})`).join(', '));
    }
    if (item.serviceable !== 1) issues.push('marked unserviceable');
    kitChecks.push({
      label: item.name,
      ok: issues.length === 0,
      note: issues.join('; ') || (booking.f ? `booked ${booking.f}–${booking.t} (${booking.days} days)` : 'booked'),
    });
  }
  if (kitRows.length === 0) {
    kitChecks.push({ label: 'No equipment assigned', ok: true, note: 'add kit if this job needs gear' });
  }
  const kitGate = makeGate('kit', 'Equipment', kitChecks);

  // ── Checklist-driven gates ───────────────────────────────────────────────
  const items = db.prepare(`
    SELECT * FROM job_checklist_items WHERE job_id = ? ORDER BY category, sort_order, created_at
  `).all(jobId);
  const stageItems = (stage) => items.filter((i) => i.stage === stage && i.required === 1);

  const adminChecks = stageItems('planning').map((i) => {
    const done = i.done === 1;
    const d = iso(i.due_date);
    const dueOk = d && d >= today && (!span || d <= span.start);
    return {
      label: i.label,
      ok: done || dueOk,
      note: done ? 'done' : (dueOk ? `scheduled (due ${d})` : (d ? `overdue since ${d}` : 'not done')),
    };
  });
  if (adminChecks.length === 0) adminChecks.push({ label: 'No admin items', ok: true, note: 'apply the standard checklist on the job card' });
  const adminGate = makeGate('admin', 'Admin & access', adminChecks);

  const prepChecks = stageItems('active').map((i) => ({
    label: i.label, ok: i.done === 1, note: i.done === 1 ? 'done' : 'not done',
  }));
  if (prepChecks.length === 0) prepChecks.push({ label: 'No dispatch items', ok: true, note: 'apply the standard checklist on the job card' });
  const prepGate = makeGate('prep', 'Dispatch preparation', prepChecks);

  const closeoutChecks = stageItems('complete').map((i) => ({
    label: i.label, ok: i.done === 1, note: i.done === 1 ? 'done' : 'not done',
  }));
  if (closeoutChecks.length === 0) closeoutChecks.push({ label: 'No close-out items', ok: true, note: '' });
  const closeoutGate = makeGate('closeout', 'Close-out', closeoutChecks);

  const logisticsChecks = items
    .filter((i) => i.stage === 'confirmed')
    .map((i) => ({ label: i.label, ok: i.done === 1, note: i.done === 1 ? 'done' : 'not done' }));
  if (logisticsChecks.length === 0) logisticsChecks.push({ label: 'No travel items', ok: true, note: '' });
  const logisticsGate = makeGate('logistics', 'Travel & logistics', logisticsChecks, { advisory: true });

  const gates = { crew: crewGate, compliance: complianceGate, kit: kitGate, admin: adminGate, prep: prepGate, closeout: closeoutGate, logistics: logisticsGate };

  // ── Roll-ups ─────────────────────────────────────────────────────────────
  const ready = ['crew', 'compliance', 'kit', 'admin'].every((g) => gates[g].status === 'pass');
  const failingGates = Object.values(gates).filter((g) => g.status === 'fail' && g.key !== 'closeout').map((g) => g.key);

  let at_risk = false;
  if (failingGates.length) {
    if (job.status === 'confirmed' || job.status === 'active') at_risk = true;
    else if (span) {
      const days = daysBetween(today, span.start);
      if (days >= 0 && days <= 7) at_risk = true;
    }
  }

  const reasons = [];
  for (const g of Object.values(gates)) {
    if (g.status === 'pass') continue;
    for (const c of g.checks) {
      if (c.ok) continue;
      reasons.push(`${g.advisory ? 'Advisory' : 'Blocker'} · ${g.title}: ${c.label} — ${c.note}`);
    }
  }

  return {
    job_id: jobId,
    job_code: job.code,
    job_name: job.name,
    status: job.status,
    span,
    gates,
    ready,
    at_risk,
    failing_gates: failingGates,
    reasons,
    generated_at: today,
  };
}
