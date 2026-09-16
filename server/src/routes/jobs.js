import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

// Standard readiness checklist applied to new jobs (skips labels already present)
const STANDARD_CHECKLIST = [
  { category: 'accommodation', label: 'Book accommodation' },
  { category: 'accommodation', label: 'Confirm check-in / check-out dates' },
  { category: 'accommodation', label: 'Send booking details to crew' },
  { category: 'flights', label: 'Book flights' },
  { category: 'flights', label: 'Confirm flight details with crew' },
  { category: 'flights', label: 'Check baggage / equipment allowances' },
  { category: 'vehicles', label: 'Assign vehicle' },
  { category: 'vehicles', label: 'Book rental car (if required)' },
  { category: 'vehicles', label: 'Confirm pickup / return details' },
  { category: 'equipment', label: 'Confirm equipment kit list' },
  { category: 'equipment', label: 'Charge batteries' },
  { category: 'equipment', label: 'Pack equipment cases' },
  { category: 'equipment', label: 'Check serviceability / calibration' },
  { category: 'admin', label: 'Site inductions arranged' },
  { category: 'admin', label: 'SWMS / JSA completed' },
  { category: 'admin', label: 'CASA / airspace approval' },
  { category: 'admin', label: 'Site access passes arranged' },
  { category: 'admin', label: 'Client site contact confirmed' },
];

function applyStandardChecklist(db, jobId) {
  const existing = new Set(
    db.prepare('SELECT label FROM job_checklist_items WHERE job_id = ?').all(jobId).map(r => r.label)
  );
  const insert = db.prepare(`
    INSERT INTO job_checklist_items (id, job_id, category, label, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  let added = 0;
  const tx = db.transaction(() => {
    STANDARD_CHECKLIST.forEach((item, i) => {
      if (!existing.has(item.label)) {
        insert.run(uuidv4(), jobId, item.category, item.label, i);
        added += 1;
      }
    });
  });
  tx();
  return added;
}

// expired (before the job) / expiring (within 30 days of the job) / valid
function complianceStatus(expiresAt, refDate) {
  if (!expiresAt) return 'valid';
  if (expiresAt < refDate) return 'expired';
  const soon = new Date(refDate + 'T00:00:00Z');
  soon.setUTCDate(soon.getUTCDate() + 30);
  return expiresAt <= soon.toISOString().slice(0, 10) ? 'expiring' : 'valid';
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
    WHERE e.job_id = ?
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
    SELECT je.id, je.job_id, je.equipment_id, je.assigned_to, je.notes,
           tm.name AS equipment_name, tm.equipment_category AS category,
           tm.role AS equipment_type, tm.serial_number
    FROM job_equipment je
    JOIN team_members tm ON tm.id = je.equipment_id
    WHERE je.job_id = ?
    ORDER BY COALESCE(NULLIF(tm.equipment_category, ''), 'zz'), tm.name
  `).all(req.params.id);

  res.json({ job, crew, checklist, flights, accommodation, rentals, equipment });
});

// POST create job (admin only)
router.post('/', requireAdmin, (req, res) => {
  const {
    code, name, description, color, client, file_url,
    job_number, sharepoint_url, status, site_address, site_contact, notes, rental_required,
    state, crew_size, planned_start, planned_end,
    applyTemplate,
  } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Code and name are required' });

  // Check for duplicate code
  const existing = req.db.prepare('SELECT id FROM jobs WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ error: 'Job code already exists' });

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO jobs (id, code, name, description, color, client, file_url,
                      job_number, sharepoint_url, status, site_address, site_contact, notes, rental_required,
                      state, crew_size, planned_start, planned_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, code, name, description || '', color || '#3B82F6', client || '', file_url || '',
    job_number || '', sharepoint_url || '', status || 'planning', site_address || '',
    site_contact || '', notes || '', rental_required ? 1 : 0,
    state || '', Math.max(1, parseInt(crew_size, 10) || 1), planned_start || '', planned_end || ''
  );

  if (applyTemplate !== false) applyStandardChecklist(req.db, id);

  const job = req.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id);
  res.status(201).json(job);
});

// PUT update job (admin only)
router.put('/:id', requireAdmin, (req, res) => {
  const {
    code, name, description, color, client, file_url,
    job_number, sharepoint_url, status, site_address, site_contact, notes, rental_required,
    state, crew_size, planned_start, planned_end,
  } = req.body;
  const existing = req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  // Check for duplicate code if changing it
  if (code && code !== existing.code) {
    const dup = req.db.prepare('SELECT id FROM jobs WHERE code = ? AND id != ?').get(code, req.params.id);
    if (dup) return res.status(409).json({ error: 'Job code already exists' });
  }

  req.db.prepare(`
    UPDATE jobs
    SET code = ?, name = ?, description = ?, color = ?, client = ?, file_url = ?,
        job_number = ?, sharepoint_url = ?, status = ?, site_address = ?, site_contact = ?, notes = ?,
        rental_required = ?, state = ?, crew_size = ?, planned_start = ?, planned_end = ?,
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
    status || existing.status,
    site_address ?? existing.site_address,
    site_contact ?? existing.site_contact,
    notes ?? existing.notes,
    rental_required !== undefined ? (rental_required ? 1 : 0) : existing.rental_required,
    state ?? existing.state,
    crew_size !== undefined ? Math.max(1, parseInt(crew_size, 10) || 1) : existing.crew_size,
    planned_start ?? existing.planned_start,
    planned_end ?? existing.planned_end,
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

// ── Equipment kit / owned vehicles ──────────────────────────────────────────

router.post('/:id/equipment', requireAdmin, (req, res) => {
  const { equipment_id, assigned_to, notes } = req.body;
  if (!equipment_id) return res.status(400).json({ error: 'equipment_id is required' });
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const equip = req.db.prepare('SELECT id FROM team_members WHERE id = ? AND is_equipment = 1').get(equipment_id);
  if (!equip) return res.status(404).json({ error: 'Equipment not found' });

  const existing = req.db.prepare(
    'SELECT id FROM job_equipment WHERE job_id = ? AND equipment_id = ?'
  ).get(req.params.id, equipment_id);
  if (existing) return res.status(409).json({ error: 'Already assigned to this job' });

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO job_equipment (id, job_id, equipment_id, assigned_to, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.params.id, equipment_id, assigned_to || '', notes || '');
  res.status(201).json({ id });
});

router.delete('/equipment/:id', requireAdmin, (req, res) => {
  const result = req.db.prepare('DELETE FROM job_equipment WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Assignment not found' });
  res.json({ success: true });
});

export default router;
