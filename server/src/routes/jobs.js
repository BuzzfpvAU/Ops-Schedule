import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAdmin } from '../middleware/auth.js';
import { computeReadiness, TRANSITION_GATES } from '../services/readiness.js';
import { notifyAdmins, notifyCrew } from '../services/notify.js';
import { findConflicts } from '../services/conflicts.js';

const router = Router();

const JOB_STATUSES = ['planning', 'confirmed', 'active', 'complete', 'cancelled'];

// Standard readiness checklist applied to new jobs (skips labels already present).
// `required` items gate workflow transitions; `stage` groups them by phase:
//   planning → gates "Confirmed" · active → gates "Active" (dispatch)
//   confirmed → travel/logistics advisory · complete → gates close-out
const STANDARD_CHECKLIST = [
  { category: 'accommodation', label: 'Book accommodation', required: 0, stage: 'confirmed' },
  { category: 'accommodation', label: 'Confirm check-in / check-out dates', required: 0, stage: 'confirmed' },
  { category: 'accommodation', label: 'Send booking details to crew', required: 0, stage: 'confirmed' },
  { category: 'flights', label: 'Book flights', required: 0, stage: 'confirmed' },
  { category: 'flights', label: 'Confirm flight details with crew', required: 0, stage: 'confirmed' },
  { category: 'flights', label: 'Check baggage / equipment allowances', required: 0, stage: 'confirmed' },
  { category: 'vehicles', label: 'Assign vehicle', required: 0, stage: 'confirmed' },
  { category: 'vehicles', label: 'Book rental car (if required)', required: 0, stage: 'confirmed' },
  { category: 'vehicles', label: 'Confirm pickup / return details', required: 0, stage: 'confirmed' },
  { category: 'equipment', label: 'Confirm equipment kit list', required: 1, stage: 'planning' },
  { category: 'equipment', label: 'Charge batteries', required: 1, stage: 'active' },
  { category: 'equipment', label: 'Pack equipment cases', required: 1, stage: 'active' },
  { category: 'equipment', label: 'Check serviceability / calibration', required: 1, stage: 'active' },
  { category: 'equipment', label: 'Gear returned & checked in', required: 1, stage: 'complete' },
  { category: 'equipment', label: 'Serviceability inspected', required: 1, stage: 'complete' },
  { category: 'equipment', label: 'Batteries charged / stored', required: 1, stage: 'complete' },
  { category: 'admin', label: 'Site inductions arranged', required: 1, stage: 'planning' },
  { category: 'admin', label: 'SWMS / JSA completed', required: 1, stage: 'planning' },
  { category: 'admin', label: 'CASA / airspace approval', required: 1, stage: 'planning' },
  { category: 'admin', label: 'Site access passes arranged', required: 1, stage: 'planning' },
  { category: 'admin', label: 'Client site contact confirmed', required: 1, stage: 'planning' },
];

function applyStandardChecklist(db, jobId) {
  const existing = new Set(
    db.prepare('SELECT label FROM job_checklist_items WHERE job_id = ?').all(jobId).map(r => r.label)
  );
  const insert = db.prepare(`
    INSERT INTO job_checklist_items (id, job_id, category, label, required, stage, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let added = 0;
  const tx = db.transaction(() => {
    STANDARD_CHECKLIST.forEach((item, i) => {
      if (!existing.has(item.label)) {
        insert.run(uuidv4(), jobId, item.category, item.label, item.required, item.stage, i);
        added += 1;
      }
    });
  });
  tx();
  return added;
}

// ── Gated status transitions ────────────────────────────────────────────────
// Returns a 409 payload when the move is blocked by failing gates; applies an
// override note (job notes) and notifies admins when one is supplied.
function validateTransition(db, job, nextStatus, overrideReason, { actor } = {}) {
  if (!JOB_STATUSES.includes(nextStatus)) {
    return { error: `status must be one of ${JOB_STATUSES.join(', ')}` };
  }
  const gateNames = TRANSITION_GATES[nextStatus] || [];
  if (gateNames.length === 0) return null;

  const readiness = computeReadiness(db, job.id);
  const failing = gateNames.filter((g) => readiness.gates[g]?.status === 'fail');
  if (failing.length === 0) return null;

  const reasons = failing.flatMap((g) =>
    readiness.gates[g].checks.filter((c) => !c.ok)
      .map((c) => `${readiness.gates[g].title}: ${c.label} — ${c.note}`)
  );

  if (!overrideReason) {
    notifyAdmins(db, {
      message: `Gate check failed: ${job.code} → ${nextStatus} (${reasons.length} issue${reasons.length === 1 ? '' : 's'})`,
      date: readiness.span?.start || null,
      jobCode: job.code,
      dedupePrefix: `Gate check failed: ${job.code}`,
      excludeMemberId: actor?.memberId,
    });
    return {
      error: 'Gates not satisfied',
      target_status: nextStatus,
      failing_gates: failing,
      reasons,
      can_override: true,
    };
  }

  // Override — record who/why on the job and alert the other admins.
  const stamp = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const noteLine = `[${stamp}] Status override to ${nextStatus} by ${actor?.name || 'admin'}: ${overrideReason}`;
  db.prepare(`
    UPDATE jobs SET notes = CASE WHEN TRIM(COALESCE(notes, '')) = '' THEN ? ELSE notes || char(10) || ? END
    WHERE id = ?
  `).run(noteLine, noteLine, job.id);
  notifyAdmins(db, {
    message: `Override: ${job.code} → ${nextStatus} by ${actor?.name || 'admin'} — ${overrideReason}`,
    jobCode: job.code,
    excludeMemberId: actor?.memberId,
  });
  return null;
}

// expired (before the job) / expiring (within 30 days of the job) / valid
function complianceStatus(expiresAt, refDate) {
  if (!expiresAt) return 'valid';
  if (expiresAt < refDate) return 'expired';
  const soon = new Date(refDate + 'T00:00:00Z');
  soon.setUTCDate(soon.getUTCDate() + 30);
  return expiresAt <= soon.toISOString().slice(0, 10) ? 'expiring' : 'valid';
}

// A job's state is where its project lead is from — the lead's base location (WA|VIC|QLD|NSW|NT|Processing)
function leadLocation(db, leadId) {
  if (!leadId) return null;
  const m = db.prepare('SELECT location FROM team_members WHERE id = ? AND is_equipment = 0').get(leadId);
  return m && m.location ? String(m.location).trim() : null;
}

// Job row enriched with roster dates (the "gantt") + checklist progress
const JOB_SELECT = `
  SELECT j.*,
    (SELECT MIN(e.date) FROM schedule_entries e WHERE e.job_id = j.id) AS roster_start,
    (SELECT MAX(e.date) FROM schedule_entries e WHERE e.job_id = j.id) AS roster_end,
    (SELECT COUNT(*) FROM job_checklist_items c WHERE c.job_id = j.id) AS checklist_total,
    (SELECT COUNT(*) FROM job_checklist_items c WHERE c.job_id = j.id AND c.done = 1) AS checklist_done
    ,(SELECT COUNT(DISTINCT e.team_member_id) FROM schedule_entries e
        JOIN team_members tm ON tm.id = e.team_member_id
        WHERE e.job_id = j.id AND tm.is_equipment = 0) AS crew_count
    ,(SELECT tm.name FROM team_members tm WHERE tm.id = j.lead_id) AS lead_name
  FROM jobs j
`;

// GET all jobs
router.get('/', (req, res) => {
  const jobs = req.db.prepare(`${JOB_SELECT} WHERE j.active = 1 ORDER BY j.code`).all();
  res.json(jobs);
});

// GET my jobs (member view) — jobs this user is rostered on, upcoming first
router.get('/mine', (req, res) => {
  const jobs = req.db.prepare(`
    ${JOB_SELECT}
    WHERE j.active = 1 AND j.archived = 0
      AND j.id IN (SELECT DISTINCT job_id FROM schedule_entries WHERE team_member_id = ?)
    ORDER BY
      CASE WHEN (roster_end >= date('now', '+10 hours')) THEN 0 ELSE 1 END,
      CASE WHEN (roster_end >= date('now', '+10 hours')) THEN roster_start END ASC,
      roster_end DESC
  `).all(req.user.memberId);
  res.json(jobs);
});

// GET job by code
router.get('/code/:code', (req, res) => {
  const job = req.db.prepare('SELECT * FROM jobs WHERE code = ? AND active = 1').get(req.params.code);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET jobs needing attention — unallocated or failing gates. Admins also
// trigger the opportunistic at-risk sweep (deduped, max 1/day per job).
router.get('/attention', (req, res) => {
  const db = req.db;
  const jobs = db.prepare(`
    ${JOB_SELECT}
    WHERE j.active = 1 AND j.archived = 0 AND j.status IN ('planning', 'confirmed', 'active')
  `).all();
  const out = [];
  for (const job of jobs) {
    const r = computeReadiness(db, job.id);
    if (!r) continue;
    const unallocated = (job.crew_count || 0) < (job.crew_size || 1);
    if (!r.at_risk && !unallocated) continue;
    out.push({
      id: job.id, code: job.code, name: job.name, color: job.color, status: job.status,
      start: r.span?.start || null,
      crew_count: job.crew_count || 0, crew_size: job.crew_size || 1,
      unallocated, at_risk: r.at_risk,
      reasons: r.reasons.slice(0, 5),
    });
  }
  // Opportunistic sweep: alert admins about at-risk jobs starting ≤ 7 days.
  if (req.user.isAdmin) {
    const today = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
    for (const o of out) {
      if (!o.at_risk || !o.start) continue;
      const days = Math.round((new Date(o.start + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
      if (days < 0 || days > 7) continue;
      notifyAdmins(db, {
        message: `At risk: ${o.code} starts in ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`} — ${o.reasons[0] || 'gates unmet'}`,
        date: o.start,
        jobCode: o.code,
        dedupePrefix: `At risk: ${o.code}`,
        excludeMemberId: req.user.memberId,
      });
    }
  }
  res.json(out);
});

// GET full job card: job + crew + checklist + flights + accommodation + rentals + equipment
router.get('/:id', (req, res) => {
  const db = req.db;
  const job = db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const crew = db.prepare(`
    SELECT tm.id, tm.name, tm.color, MIN(e.date) AS from_date, MAX(e.date) AS to_date,
           COUNT(DISTINCT e.date) AS days
    FROM schedule_entries e
    JOIN team_members tm ON tm.id = e.team_member_id
    WHERE e.job_id = ? AND tm.is_equipment = 0
    GROUP BY tm.id
    ORDER BY from_date
  `).all(req.params.id);

  // Attach per-person compliance, flagged against the job's start date (or today)
  const refDate = job.roster_start || new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
  if (crew.length > 0) {
    const placeholders = crew.map(() => '?').join(',');
    const compRows = db.prepare(`
      SELECT * FROM member_compliance WHERE team_member_id IN (${placeholders})
      ORDER BY CASE WHEN expires_at = '' THEN 1 ELSE 0 END, expires_at
    `).all(...crew.map(c => c.id));
    for (const c of crew) {
      c.compliance = compRows
        .filter(r => r.team_member_id === c.id)
        .map(r => ({ ...r, status: complianceStatus(r.expires_at, refDate) }));
    }
  }

  const checklist = db.prepare(`
    SELECT * FROM job_checklist_items WHERE job_id = ?
    ORDER BY category, sort_order, created_at
  `).all(req.params.id);

  const flights = db.prepare(`
    SELECT * FROM job_flights WHERE job_id = ?
    ORDER BY CASE WHEN depart_at = '' THEN 1 ELSE 0 END, depart_at, created_at
  `).all(req.params.id);

  const accommodation = db.prepare(`
    SELECT * FROM job_accommodation WHERE job_id = ?
    ORDER BY CASE WHEN check_in = '' THEN 1 ELSE 0 END, check_in, created_at
  `).all(req.params.id);

  const rentals = db.prepare(`
    SELECT * FROM job_rentals WHERE job_id = ? ORDER BY created_at
  `).all(req.params.id);

  const equipment = db.prepare(`
    SELECT je.id, je.job_id, je.equipment_id, je.assigned_to, je.notes, je.status,
           je.pad_before, je.pad_after,
           (SELECT MIN(se.date) FROM schedule_entries se
             WHERE se.job_id = je.job_id AND se.team_member_id = je.equipment_id) AS booked_from,
           (SELECT MAX(se.date) FROM schedule_entries se
             WHERE se.job_id = je.job_id AND se.team_member_id = je.equipment_id) AS booked_to,
           (SELECT COUNT(DISTINCT se.date) FROM schedule_entries se
             WHERE se.job_id = je.job_id AND se.team_member_id = je.equipment_id) AS booked_days,
           tm.name AS equipment_name, tm.equipment_category AS category,
           tm.role AS equipment_type, tm.serial_number
    FROM job_equipment je
    JOIN team_members tm ON tm.id = je.equipment_id
    WHERE je.job_id = ?
    ORDER BY COALESCE(NULLIF(tm.equipment_category, ''), 'zz'), tm.name
  `).all(req.params.id);

  // Allocation conflicts for each booked item (overlaps with other jobs)
  for (const row of equipment) {
    row.conflicts = row.booked_from
      ? findConflicts(db, row.equipment_id, row.booked_from, row.booked_to, req.params.id)
      : [];
  }

  res.json({ job, crew, checklist, flights, accommodation, rentals, equipment });
});

// GET job planner: per-day view of the people + equipment on a job, plus notes.
// Powers the "project planner" modal (people grid, equipment grid, notes list).
router.get('/:id/planner', (req, res) => {
  const db = req.db;
  const job = db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Every member (person or equipment) with at least one roster entry on this job
  const rows = db.prepare(`
    SELECT tm.id, tm.name, tm.color, tm.role, tm.is_equipment,
           COALESCE(NULLIF(tm.equipment_category, ''), '') AS category,
           MIN(e.date) AS from_date, MAX(e.date) AS to_date,
           COUNT(DISTINCT e.date) AS days
    FROM schedule_entries e
    JOIN team_members tm ON tm.id = e.team_member_id
    WHERE e.job_id = ?
    GROUP BY tm.id
    ORDER BY tm.is_equipment, from_date, tm.name
  `).all(req.params.id);

  const entries = db.prepare(`
    SELECT id, team_member_id, date, status, COALESCE(notes, '') AS notes
    FROM schedule_entries
    WHERE job_id = ?
    ORDER BY date
  `).all(req.params.id);

  const byMember = new Map();
  for (const e of entries) {
    if (!byMember.has(e.team_member_id)) byMember.set(e.team_member_id, []);
    byMember.get(e.team_member_id).push({ id: e.id, date: e.date, status: e.status || 'tentative', notes: e.notes });
  }

  // Display span: the job's roster span (else its planned window)
  const span_start = job.roster_start || job.planned_start || null;
  const span_end = job.roster_end || job.planned_end || null;

  // Other-bookings window: ?from&to (the planner widens this as you scroll
  // left/right), default = span ± 6 weeks.
  const isoDate = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const DEFAULT_WINDOW_PAD = 42;
  let win_start = isoDate(req.query.from);
  let win_end = isoDate(req.query.to);
  if ((!win_start || !win_end) && span_start && span_end) {
    win_start = addDays(span_start, -DEFAULT_WINDOW_PAD);
    win_end = addDays(span_end, DEFAULT_WINDOW_PAD);
  }
  if (win_start && win_end && win_end < win_start) {
    const t = win_start; win_start = win_end; win_end = t;
  }

  // Other jobs/bookings the same members have inside that window — so the
  // planner can show them faintly and flag conflicts with this job.
  const otherByMember = new Map();
  if (win_start && win_end && rows.length > 0) {
    const placeholders = rows.map(() => '?').join(',');
    const others = db.prepare(`
      SELECT e.team_member_id, e.date, e.status, e.job_id,
             j.code AS job_code, j.name AS job_name, j.color AS job_color
      FROM schedule_entries e
      JOIN jobs j ON j.id = e.job_id
      WHERE e.team_member_id IN (${placeholders})
        AND e.job_id != ?
        AND e.date >= ? AND e.date <= ?
      ORDER BY e.date
    `).all(...rows.map(r => r.id), req.params.id, win_start, win_end);
    for (const o of others) {
      if (!otherByMember.has(o.team_member_id)) otherByMember.set(o.team_member_id, []);
      otherByMember.get(o.team_member_id).push(o);
    }
  }

  const withEntries = (r) => ({
    ...r,
    entries: byMember.get(r.id) || [],
    otherEntries: otherByMember.get(r.id) || [],
  });
  const people = rows.filter(r => !r.is_equipment).map(withEntries);
  const equipment = rows.filter(r => r.is_equipment).map(withEntries);

  // Allocation info (status + pads) for the equipment rows — powers the
  // planner's status chips and padded-day shading.
  const jeRows = db.prepare(
    'SELECT equipment_id, status, pad_before, pad_after FROM job_equipment WHERE job_id = ?'
  ).all(req.params.id);
  const jeById = new Map(jeRows.map(r => [r.equipment_id, r]));
  for (const e of equipment) {
    const je = jeById.get(e.id);
    e.allocation_status = je ? (je.status || 'tentative') : '';
    e.pad_before = je ? (je.pad_before || 0) : 0;
    e.pad_after = je ? (je.pad_after || 0) : 0;
  }

  // Kit assigned to the job but with no booked days yet
  const kit = db.prepare(`
    SELECT tm.id, tm.name, COALESCE(NULLIF(tm.equipment_category, ''), '') AS category
    FROM job_equipment je
    JOIN team_members tm ON tm.id = je.equipment_id
    WHERE je.job_id = ?
  `).all(req.params.id);
  const bookedIds = new Set(equipment.map(e => e.id));
  const unbooked = kit.filter(k => !bookedIds.has(k.id));

  // Per-day notes across the whole job (people + equipment)
  const notes = db.prepare(`
    SELECT e.date, e.notes, e.status, tm.name AS member_name, tm.is_equipment
    FROM schedule_entries e
    JOIN team_members tm ON tm.id = e.team_member_id
    WHERE e.job_id = ? AND TRIM(COALESCE(e.notes, '')) != ''
    ORDER BY e.date, tm.name
  `).all(req.params.id);

  // Append-only per-day log, keyed by entity + date. Independent of the
  // roster, so a day with no booking can still carry a dispatch note.
  const day_notes = db.prepare(`
    SELECT n.id, n.entity_id, n.date, n.text, n.author_name, n.created_at,
           tm.name AS entity_name, tm.is_equipment
    FROM job_day_notes n
    LEFT JOIN team_members tm ON tm.id = n.entity_id
    WHERE n.job_id = ?
    ORDER BY n.date, n.created_at
  `).all(req.params.id);

  res.json({ job, span: span_start ? { start: span_start, end: span_end } : null, window: win_start && win_end ? { start: win_start, end: win_end } : null, people, equipment, unbooked, notes, day_notes });
});

// ── Per-day job notes (append-only log) ─────────────────────────────────

router.post('/:id/day-notes', (req, res) => {
  const { entity_id, date, text } = req.body;
  if (!entity_id || !date || !String(text || '').trim()) {
    return res.status(400).json({ error: 'entity_id, date and text are required' });
  }
  if (req.user.isViewer) {
    return res.status(403).json({ error: 'Viewers cannot add notes' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  if (!req.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (!req.db.prepare('SELECT 1 FROM team_members WHERE id = ?').get(entity_id)) {
    return res.status(404).json({ error: 'Person or equipment not found' });
  }

  const author = req.db.prepare('SELECT name FROM team_members WHERE id = ?').get(req.user.memberId);
  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO job_day_notes (id, job_id, entity_id, date, text, author_id, author_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, entity_id, date, String(text).trim(), req.user.memberId || '', author?.name || '');

  res.json(req.db.prepare(`
    SELECT n.id, n.entity_id, n.date, n.text, n.author_name, n.created_at,
           tm.name AS entity_name, tm.is_equipment
    FROM job_day_notes n
    LEFT JOIN team_members tm ON tm.id = n.entity_id
    WHERE n.id = ?
  `).get(id));
});

// Authors can remove their own notes; admins can remove any. The log is
// otherwise append-only — editing would defeat the point of keeping history.
router.delete('/day-notes/:noteId', (req, res) => {
  const note = req.db.prepare('SELECT * FROM job_day_notes WHERE id = ?').get(req.params.noteId);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  if (!req.user.isAdmin && note.author_id !== req.user.memberId) {
    return res.status(403).json({ error: 'You can only remove your own notes' });
  }
  req.db.prepare('DELETE FROM job_day_notes WHERE id = ?').run(req.params.noteId);
  res.json({ success: true });
});

// GET readiness — per-gate workflow status for the job card
router.get('/:id/readiness', (req, res) => {
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(computeReadiness(req.db, req.params.id));
});

// POST status — gated transition (admin only). Body: { status, override_reason? }
router.post('/:id/status', requireAdmin, (req, res) => {
  const job = req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { status, override_reason } = req.body || {};
  if (status === job.status) {
    return res.json({ job: req.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(job.id), readiness: computeReadiness(req.db, job.id) });
  }
  const blocked = validateTransition(req.db, job, status, override_reason, { actor: req.user });
  if (blocked) return res.status(blocked.failing_gates ? 409 : 400).json(blocked);
  req.db.prepare(`UPDATE jobs SET status = ?, updated_at = datetime('now', '+10 hours') WHERE id = ?`).run(status, job.id);
  notifyCrew(req.db, job.id, {
    message: `${job.code} ${job.name}: now ${status}`,
    jobCode: job.code,
    excludeMemberId: req.user.memberId,
  });
  res.json({
    job: req.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(job.id),
    readiness: computeReadiness(req.db, job.id),
  });
});

// POST create job (admin only)
router.post('/', requireAdmin, (req, res) => {
  const {
    code, name, description, color, client, file_url,
    job_number, sharepoint_url, status, site_address, site_contact, notes, rental_required,
    state, crew_size, planned_start, planned_end, lead_id,
    job_type,
    applyTemplate,
  } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Code and name are required' });

  // Check for duplicate code
  const existing = req.db.prepare('SELECT id FROM jobs WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ error: 'Job code already exists' });

  // State follows the project lead's base location when one is assigned
  const derivedState = leadLocation(req.db, lead_id);
  const finalState = derivedState !== null ? derivedState : (state || '');

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO jobs (id, code, name, description, color, client, file_url,
                      job_number, sharepoint_url, job_type, status, site_address, site_contact, notes, rental_required,
                      state, crew_size, planned_start, planned_end, lead_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, code, name, description || '', color || '#3B82F6', client || '', file_url || '',
    job_number || '', sharepoint_url || '', job_type || '', status || 'planning', site_address || '',
    site_contact || '', notes || '', rental_required ? 1 : 0,
    finalState, Math.max(1, parseInt(crew_size, 10) || 1), planned_start || '', planned_end || '',
    lead_id || ''
  );

  if (applyTemplate !== false) applyStandardChecklist(req.db, id);

  const job = req.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id);
  res.status(201).json(job);
});

// PUT update job (admin only)
router.put('/:id', requireAdmin, (req, res) => {
  const {
    code, name, description, color, client, file_url,
    job_number, sharepoint_url, job_type, status, site_address, site_contact, notes, rental_required,
    state, crew_size, planned_start, planned_end, lead_id,
  } = req.body;
  const existing = req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  // Check for duplicate code if changing it
  if (code && code !== existing.code) {
    const dup = req.db.prepare('SELECT id FROM jobs WHERE code = ? AND id != ?').get(code, req.params.id);
    if (dup) return res.status(409).json({ error: 'Job code already exists' });
  }

  // Status changes are gated: validate transitions through the readiness engine.
  const nextStatus = status || existing.status;
  if (nextStatus !== existing.status) {
    const blocked = validateTransition(req.db, existing, nextStatus, req.body.override_reason, { actor: req.user });
    if (blocked) return res.status(blocked.failing_gates ? 409 : 400).json(blocked);
  }

  // State follows the project lead's base location when one is assigned;
  // only falls back to the manually-picked state for jobs without a located lead.
  const nextLeadId = lead_id !== undefined ? String(lead_id || '') : (existing.lead_id || '');
  const derivedState = leadLocation(req.db, nextLeadId);
  const nextState = derivedState !== null
    ? derivedState
    : (state !== undefined ? String(state ?? '') : existing.state);

  req.db.prepare(`
    UPDATE jobs
    SET code = ?, name = ?, description = ?, color = ?, client = ?, file_url = ?,
        job_number = ?, sharepoint_url = ?, job_type = ?, status = ?, site_address = ?, site_contact = ?, notes = ?,
        rental_required = ?, state = ?, crew_size = ?, planned_start = ?, planned_end = ?, lead_id = ?,
        updated_at = datetime('now', '+10 hours')
    WHERE id = ?
  `).run(
    code || existing.code,
    name || existing.name,
    description ?? existing.description,
    color || existing.color,
    client ?? existing.client,
    file_url ?? existing.file_url,
    job_number ?? existing.job_number,
    sharepoint_url ?? existing.sharepoint_url,
    job_type ?? existing.job_type,
    nextStatus,
    site_address ?? existing.site_address,
    site_contact ?? existing.site_contact,
    notes ?? existing.notes,
    rental_required !== undefined ? (rental_required ? 1 : 0) : existing.rental_required,
    nextState,
    crew_size !== undefined ? Math.max(1, parseInt(crew_size, 10) || 1) : existing.crew_size,
    planned_start ?? existing.planned_start,
    planned_end ?? existing.planned_end,
    nextLeadId,
    req.params.id
  );

  const job = req.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(req.params.id);
  res.json(job);
});

// DELETE (soft delete) job (admin only)
router.delete('/:id', requireAdmin, (req, res) => {
  const result = req.db
    .prepare('UPDATE jobs SET active = 0, updated_at = datetime(\'now\', \'+10 hours\') WHERE id = ?')
    .run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true });
});

// POST archive job (admin only)
router.post('/:id/archive', requireAdmin, (req, res) => {
  const result = req.db.prepare(`
    UPDATE jobs SET archived = 1, archived_at = datetime('now', '+10 hours'),
                    updated_at = datetime('now', '+10 hours')
    WHERE id = ?
  `).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Job not found' });
  res.json(req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
});

// POST unarchive job (admin only)
router.post('/:id/unarchive', requireAdmin, (req, res) => {
  const result = req.db.prepare(`
    UPDATE jobs SET archived = 0, archived_at = '', updated_at = datetime('now', '+10 hours')
    WHERE id = ?
  `).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Job not found' });
  res.json(req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
});

// POST archive many jobs at once (admin only) — the Jobs-tab cleanup flow
router.post('/archive-bulk', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(x => typeof x === 'string' && x) : [];
  if (!ids.length) return res.status(400).json({ error: 'No job ids provided' });
  const placeholders = ids.map(() => '?').join(',');
  const result = req.db.prepare(`
    UPDATE jobs SET archived = 1, archived_at = datetime('now', '+10 hours'),
                    updated_at = datetime('now', '+10 hours')
    WHERE archived = 0 AND id IN (${placeholders})
  `).run(...ids);
  res.json({ archived: result.changes });
});

// ── Checklists ──────────────────────────────────────────────────────────────

// POST add checklist item (admin only)
router.post('/:id/checklist', requireAdmin, (req, res) => {
  const { category, label, notes, due_date, assigned_to } = req.body;
  if (!label) return res.status(400).json({ error: 'Label is required' });
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const maxOrder = req.db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM job_checklist_items WHERE job_id = ?'
  ).get(req.params.id).m;

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO job_checklist_items (id, job_id, category, label, notes, due_date, assigned_to, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, category || 'other', label, notes || '', due_date || '', assigned_to || '', maxOrder + 1);

  const item = req.db.prepare('SELECT * FROM job_checklist_items WHERE id = ?').get(id);
  res.status(201).json(item);
});

// POST apply the standard checklist (admin only)
router.post('/:id/checklist/template', requireAdmin, (req, res) => {
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const added = applyStandardChecklist(req.db, req.params.id);
  res.json({ added });
});

// PUT update checklist item (admin only — admins complete the checklists)
router.put('/checklist/:itemId', requireAdmin, (req, res) => {
  const db = req.db;
  const item = db.prepare('SELECT * FROM job_checklist_items WHERE id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });

  const body = req.body || {};

  db.prepare(`
    UPDATE job_checklist_items
    SET label = ?, category = ?, notes = ?, due_date = ?, assigned_to = ?, done = ?,
        done_by = ?, done_at = ?, sort_order = ?,
        updated_at = datetime('now', '+10 hours')
    WHERE id = ?
  `).run(
    body.label ?? item.label,
    body.category || item.category,
    body.notes ?? item.notes,
    body.due_date ?? item.due_date,
    body.assigned_to ?? item.assigned_to,
    body.done !== undefined ? (body.done ? 1 : 0) : item.done,
    body.done !== undefined
      ? (body.done ? (body.done_by || req.user.memberId) : '')
      : item.done_by,
    body.done !== undefined
      ? (body.done ? new Date().toISOString() : '')
      : item.done_at,
    body.sort_order ?? item.sort_order,
    req.params.itemId
  );

  const updated = db.prepare('SELECT * FROM job_checklist_items WHERE id = ?').get(req.params.itemId);
  res.json(updated);
});

// DELETE checklist item (admin only)
router.delete('/checklist/:itemId', requireAdmin, (req, res) => {
  const result = req.db.prepare('DELETE FROM job_checklist_items WHERE id = ?').run(req.params.itemId);
  if (result.changes === 0) return res.status(404).json({ error: 'Checklist item not found' });
  res.json({ success: true });
});

// ── Flights ─────────────────────────────────────────────────────────────────

router.post('/:id/flights', requireAdmin, (req, res) => {
  const { person_id, person_name, direction, airline, flight_number, depart_airport, depart_at,
          arrive_airport, arrive_at, booking_ref, notes } = req.body;
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO job_flights (id, job_id, person_id, person_name, direction, airline, flight_number,
                             depart_airport, depart_at, arrive_airport, arrive_at, booking_ref, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, person_id || '', person_name || '', direction || 'out', airline || '',
         flight_number || '', depart_airport || '', depart_at || '', arrive_airport || '',
         arrive_at || '', booking_ref || '', notes || '');
  res.status(201).json(req.db.prepare('SELECT * FROM job_flights WHERE id = ?').get(id));
});

router.put('/flights/:id', requireAdmin, (req, res) => {
  const row = req.db.prepare('SELECT * FROM job_flights WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Flight not found' });
  const b = req.body;
  req.db.prepare(`
    UPDATE job_flights
    SET person_id = ?, person_name = ?, direction = ?, airline = ?, flight_number = ?,
        depart_airport = ?, depart_at = ?, arrive_airport = ?, arrive_at = ?, booking_ref = ?, notes = ?
    WHERE id = ?
  `).run(
    b.person_id ?? row.person_id, b.person_name ?? row.person_name, b.direction || row.direction,
    b.airline ?? row.airline, b.flight_number ?? row.flight_number, b.depart_airport ?? row.depart_airport,
    b.depart_at ?? row.depart_at, b.arrive_airport ?? row.arrive_airport, b.arrive_at ?? row.arrive_at,
    b.booking_ref ?? row.booking_ref, b.notes ?? row.notes, req.params.id
  );
  res.json(req.db.prepare('SELECT * FROM job_flights WHERE id = ?').get(req.params.id));
});

router.delete('/flights/:id', requireAdmin, (req, res) => {
  const result = req.db.prepare('DELETE FROM job_flights WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Flight not found' });
  res.json({ success: true });
});

// ── Accommodation ───────────────────────────────────────────────────────────

router.post('/:id/accommodation', requireAdmin, (req, res) => {
  const { person_id, person_name, venue, address, check_in, check_out, booking_ref, notes } = req.body;
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO job_accommodation (id, job_id, person_id, person_name, venue, address, check_in, check_out, booking_ref, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, person_id || '', person_name || '', venue || '', address || '',
         check_in || '', check_out || '', booking_ref || '', notes || '');
  res.status(201).json(req.db.prepare('SELECT * FROM job_accommodation WHERE id = ?').get(id));
});

router.put('/accommodation/:id', requireAdmin, (req, res) => {
  const row = req.db.prepare('SELECT * FROM job_accommodation WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Accommodation not found' });
  const b = req.body;
  req.db.prepare(`
    UPDATE job_accommodation
    SET person_id = ?, person_name = ?, venue = ?, address = ?, check_in = ?, check_out = ?, booking_ref = ?, notes = ?
    WHERE id = ?
  `).run(
    b.person_id ?? row.person_id, b.person_name ?? row.person_name, b.venue ?? row.venue,
    b.address ?? row.address, b.check_in ?? row.check_in, b.check_out ?? row.check_out,
    b.booking_ref ?? row.booking_ref, b.notes ?? row.notes, req.params.id
  );
  res.json(req.db.prepare('SELECT * FROM job_accommodation WHERE id = ?').get(req.params.id));
});

router.delete('/accommodation/:id', requireAdmin, (req, res) => {
  const result = req.db.prepare('DELETE FROM job_accommodation WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Accommodation not found' });
  res.json({ success: true });
});

// ── Rentals ─────────────────────────────────────────────────────────────────

router.post('/:id/rentals', requireAdmin, (req, res) => {
  const { company, vehicle_desc, rego, pickup_location, pickup_at, return_at, booked_under, booking_ref, notes } = req.body;
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO job_rentals (id, job_id, company, vehicle_desc, rego, pickup_location, pickup_at, return_at, booked_under, booking_ref, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, company || '', vehicle_desc || '', rego || '', pickup_location || '',
         pickup_at || '', return_at || '', booked_under || '', booking_ref || '', notes || '');
  res.status(201).json(req.db.prepare('SELECT * FROM job_rentals WHERE id = ?').get(id));
});

router.put('/rentals/:id', requireAdmin, (req, res) => {
  const row = req.db.prepare('SELECT * FROM job_rentals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Rental not found' });
  const b = req.body;
  req.db.prepare(`
    UPDATE job_rentals
    SET company = ?, vehicle_desc = ?, rego = ?, pickup_location = ?, pickup_at = ?, return_at = ?,
        booked_under = ?, booking_ref = ?, notes = ?
    WHERE id = ?
  `).run(
    b.company ?? row.company, b.vehicle_desc ?? row.vehicle_desc, b.rego ?? row.rego,
    b.pickup_location ?? row.pickup_location, b.pickup_at ?? row.pickup_at, b.return_at ?? row.return_at,
    b.booked_under ?? row.booked_under, b.booking_ref ?? row.booking_ref, b.notes ?? row.notes, req.params.id
  );
  res.json(req.db.prepare('SELECT * FROM job_rentals WHERE id = ?').get(req.params.id));
});

router.delete('/rentals/:id', requireAdmin, (req, res) => {
  const result = req.db.prepare('DELETE FROM job_rentals WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Rental not found' });
  res.json({ success: true });
});

// ── Equipment bookings (schedule_entries for kit equipment) ─────────────────
// A kit assignment "adopts" the job timeframe: entries are created for every
// date in the job's current roster range (MIN/MAX over all its entries).
// The per-row +/− controls grow/shrink that range one day at a time.

function aestToday() {
  return new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function jobRange(db, jobId) {
  return db.prepare(`
    SELECT MIN(date) AS from_date, MAX(date) AS to_date
    FROM schedule_entries WHERE job_id = ?
  `).get(jobId);
}

function bookingRange(db, jobId, equipmentId) {
  return db.prepare(`
    SELECT MIN(date) AS from_date, MAX(date) AS to_date,
           COUNT(DISTINCT date) AS days
    FROM schedule_entries WHERE job_id = ? AND team_member_id = ?
  `).get(jobId, equipmentId);
}

function ensureBookingDay(db, jobId, equipmentId, date) {
  const exists = db.prepare(
    'SELECT id FROM schedule_entries WHERE job_id = ? AND team_member_id = ? AND date = ? LIMIT 1'
  ).get(jobId, equipmentId, date);
  if (exists) return false;
  db.prepare(`
    INSERT INTO schedule_entries (id, team_member_id, job_id, date, status)
    VALUES (?, ?, ?, ?, 'tentative')
  `).run(uuidv4(), equipmentId, jobId, date);
  return true;
}

// ── Equipment kit / owned vehicles ──────────────────────────────────────────

router.post('/:id/equipment', requireAdmin, (req, res) => {
  const { equipment_id, assigned_to, notes, pad_before, pad_after } = req.body || {};
  if (!equipment_id) return res.status(400).json({ error: 'equipment_id is required' });
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const equip = req.db.prepare('SELECT id FROM team_members WHERE id = ? AND is_equipment = 1').get(equipment_id);
  if (!equip) return res.status(404).json({ error: 'Equipment not found' });

  const existing = req.db.prepare(
    'SELECT id FROM job_equipment WHERE job_id = ? AND equipment_id = ?'
  ).get(req.params.id, equipment_id);
  if (existing) return res.status(409).json({ error: 'Already assigned to this job' });

  const padB = Number.isInteger(pad_before) ? Math.max(0, pad_before) : 1;
  const padA = Number.isInteger(pad_after) ? Math.max(0, pad_after) : 1;

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO job_equipment (id, job_id, equipment_id, assigned_to, notes, pad_before, pad_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, equipment_id, assigned_to || '', notes || '', padB, padA);

  // Adopt the job's timeframe with buffer pads: book the span ± pads for
  // pack-out, transport and turnaround (per the planned workflow design).
  const range = jobRange(req.db, req.params.id);
  if (range.from_date) {
    for (const d of dateRange(addDays(range.from_date, -padB), addDays(range.to_date, padA))) {
      ensureBookingDay(req.db, req.params.id, equipment_id, d);
    }
  }
  const after = bookingRange(req.db, req.params.id, equipment_id);
  const conflicts = after.from_date
    ? findConflicts(req.db, equipment_id, after.from_date, after.to_date, req.params.id)
    : [];
  res.status(201).json({
    id,
    booked_from: after.from_date || null,
    booked_to: after.to_date || null,
    booked_days: after.days || 0,
    pad_before: padB,
    pad_after: padA,
    conflicts,
  });
});

router.delete('/equipment/:id', requireAdmin, (req, res) => {
  const assignment = req.db.prepare(
    'SELECT job_id, equipment_id FROM job_equipment WHERE id = ?'
  ).get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  // Clear the booking entries so no ghost range lingers on the roster.
  req.db.prepare(
    'DELETE FROM schedule_entries WHERE job_id = ? AND team_member_id = ?'
  ).run(assignment.job_id, assignment.equipment_id);
  req.db.prepare('DELETE FROM job_equipment WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Extend/trim one edge of an equipment booking by a day.
// Body: { edge: 'start'|'end', delta: 1|-1 }
router.post('/equipment/:id/booking', requireAdmin, (req, res) => {
  const { edge, delta } = req.body;
  if (edge !== 'start' && edge !== 'end') {
    return res.status(400).json({ error: "edge must be 'start' or 'end'" });
  }
  const n = Number(delta);
  if (n !== 1 && n !== -1) {
    return res.status(400).json({ error: 'delta must be 1 or -1' });
  }
  const a = req.db.prepare(
    'SELECT job_id, equipment_id, pad_before, pad_after FROM job_equipment WHERE id = ?'
  ).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found' });

  let cur = bookingRange(req.db, a.job_id, a.equipment_id);
  if (!cur.from_date) {
    // No booking yet: adopt the job range (with pads) first, else start today.
    const jr = jobRange(req.db, a.job_id);
    if (jr.from_date) {
      for (const d of dateRange(
        addDays(jr.from_date, -(a.pad_before || 0)),
        addDays(jr.to_date, a.pad_after || 0)
      )) {
        ensureBookingDay(req.db, a.job_id, a.equipment_id, d);
      }
    } else {
      ensureBookingDay(req.db, a.job_id, a.equipment_id, aestToday());
    }
    cur = bookingRange(req.db, a.job_id, a.equipment_id);
  }

  if (n === 1) {
    ensureBookingDay(req.db, a.job_id, a.equipment_id,
      edge === 'start' ? addDays(cur.from_date, -1) : addDays(cur.to_date, 1));
  } else {
    // Trim the boundary day (one entry — never touches other days).
    const boundary = edge === 'start' ? cur.from_date : cur.to_date;
    req.db.prepare(`DELETE FROM schedule_entries WHERE id = (
      SELECT id FROM schedule_entries
      WHERE job_id = ? AND team_member_id = ? AND date = ? LIMIT 1
    )`).run(a.job_id, a.equipment_id, boundary);
  }

  const after = bookingRange(req.db, a.job_id, a.equipment_id);
  const conflicts = after.from_date
    ? findConflicts(req.db, a.equipment_id, after.from_date, after.to_date, a.job_id)
    : [];
  res.json({
    success: true,
    booked_from: after.from_date || null,
    booked_to: after.to_date || null,
    booked_days: after.days || 0,
    conflicts,
  });
});

// ── Per-job required compliance ─────────────────────────────────────────────

// GET required compliance types for a job
router.get('/:id/requirements', (req, res) => {
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(req.db.prepare('SELECT * FROM job_requirements WHERE job_id = ? ORDER BY compliance_type').all(req.params.id));
});

// POST add a requirement (admin only)
router.post('/:id/requirements', requireAdmin, (req, res) => {
  const type = String(req.body?.compliance_type || '').trim();
  if (!type) return res.status(400).json({ error: 'compliance_type is required' });
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const existing = req.db.prepare('SELECT id FROM job_requirements WHERE job_id = ? AND lower(compliance_type) = lower(?)').get(req.params.id, type);
  if (existing) return res.status(409).json({ error: 'Requirement already exists' });
  const id = uuidv4();
  req.db.prepare('INSERT INTO job_requirements (id, job_id, compliance_type) VALUES (?, ?, ?)').run(id, req.params.id, type);
  res.status(201).json(req.db.prepare('SELECT * FROM job_requirements WHERE id = ?').get(id));
});

// DELETE a requirement (admin only)
router.delete('/requirements/:id', requireAdmin, (req, res) => {
  const result = req.db.prepare('DELETE FROM job_requirements WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Requirement not found' });
  res.json({ success: true });
});

// ── Allocation confirmation + kits ──────────────────────────────────────────

// Confirm the job's kit allocation (admin). Blocked by cross-job conflicts
// unless an override reason is given (recorded on the job, admins notified).
router.post('/:id/equipment/confirm', requireAdmin, (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT id, code FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const rows = db.prepare(`
    SELECT je.id, je.equipment_id, tm.name,
           (SELECT MIN(date) FROM schedule_entries WHERE job_id = je.job_id AND team_member_id = je.equipment_id) AS f,
           (SELECT MAX(date) FROM schedule_entries WHERE job_id = je.job_id AND team_member_id = je.equipment_id) AS t
    FROM job_equipment je
    JOIN team_members tm ON tm.id = je.equipment_id
    WHERE je.job_id = ?
  `).all(req.params.id);
  if (!rows.length) return res.status(400).json({ error: 'No equipment assigned to this job' });

  const conflicts = [];
  for (const item of rows) {
    if (!item.f) continue;
    for (const c of findConflicts(db, item.equipment_id, item.f, item.t, req.params.id)) {
      conflicts.push({ equipment_id: item.equipment_id, equipment_name: item.name, ...c });
    }
  }

  const { override_reason } = req.body || {};
  if (conflicts.length && !override_reason) {
    return res.status(409).json({ error: 'Allocation conflicts', conflicts, can_override: true });
  }
  db.prepare(`UPDATE job_equipment SET status = 'confirmed' WHERE job_id = ?`).run(req.params.id);
  if (conflicts.length && override_reason) {
    const stamp = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const noteLine = `[${stamp}] Kit allocation confirmed with ${conflicts.length} conflict(s) by ${req.user?.name || 'admin'}: ${override_reason}`;
    db.prepare(`
      UPDATE jobs SET notes = CASE WHEN TRIM(COALESCE(notes, '')) = '' THEN ? ELSE notes || char(10) || ? END
      WHERE id = ?
    `).run(noteLine, noteLine, req.params.id);
    notifyAdmins(db, {
      message: `Override: ${job.code} kit allocation confirmed with conflicts by ${req.user?.name || 'admin'} — ${override_reason}`,
      jobCode: job.code,
      excludeMemberId: req.user?.memberId,
    });
  }
  res.json({ confirmed: rows.length, conflicts });
});

// Apply a kit template to the job: adds every kit item (skips unserviceable /
// already-assigned) and books each for the job window with 1-day pads.
router.post('/:id/apply-kit', requireAdmin, (req, res) => {
  const db = req.db;
  const { kit_id } = req.body || {};
  const kit = db.prepare('SELECT * FROM equipment_kits WHERE id = ?').get(kit_id);
  if (!kit) return res.status(404).json({ error: 'Kit not found' });
  const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const items = db.prepare(`
    SELECT tm.id, tm.name, tm.serviceable
    FROM equipment_kit_items eki
    JOIN team_members tm ON tm.id = eki.equipment_id
    WHERE eki.kit_id = ?
    ORDER BY tm.name
  `).all(kit_id);

  const added = [];
  const skipped = [];
  const range = jobRange(db, req.params.id);
  const tx = db.transaction(() => {
    for (const item of items) {
      const already = db.prepare('SELECT id FROM job_equipment WHERE job_id = ? AND equipment_id = ?').get(req.params.id, item.id);
      if (already) { skipped.push({ id: item.id, name: item.name, reason: 'already on this job' }); continue; }
      if (item.serviceable !== 1) { skipped.push({ id: item.id, name: item.name, reason: 'unserviceable' }); continue; }
      db.prepare(`
        INSERT INTO job_equipment (id, job_id, equipment_id, assigned_to, notes, pad_before, pad_after)
        VALUES (?, ?, ?, '', ?, 1, 1)
      `).run(uuidv4(), req.params.id, item.id, `from kit: ${kit.name}`);
      if (range.from_date) {
        for (const d of dateRange(addDays(range.from_date, -1), addDays(range.to_date, 1))) {
          ensureBookingDay(db, req.params.id, item.id, d);
        }
      }
      added.push({ id: item.id, name: item.name });
    }
  });
  tx();
  res.status(201).json({ kit: { id: kit.id, name: kit.name }, added, skipped });
});

export default router;
