import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// GET schedule for a date range
router.get('/', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end dates are required (YYYY-MM-DD)' });
  }

  const entries = req.db.prepare(`
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes,
      tm.name as member_name, tm.color as member_color, tm.timezone,
      j.code as job_code, j.name as job_name, j.color as job_color, j.file_url as job_file_url
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    JOIN jobs j ON se.job_id = j.id
    WHERE se.date >= ? AND se.date <= ?
    ORDER BY tm.sort_order, tm.name, se.date
  `).all(start, end);

  res.json(entries);
});

// GET schedule for a specific team member
router.get('/member/:memberId', (req, res) => {
  const { start, end } = req.query;
  let query = `
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes,
      j.code as job_code, j.name as job_name, j.color as job_color, j.file_url as job_file_url
    FROM schedule_entries se
    JOIN jobs j ON se.job_id = j.id
    WHERE se.team_member_id = ?
  `;
  const params = [req.params.memberId];

  if (start && end) {
    query += ' AND se.date >= ? AND se.date <= ?';
    params.push(start, end);
  }

  query += ' ORDER BY se.date';
  const entries = req.db.prepare(query).all(...params);
  res.json(entries);
});

// PUT assign/update a schedule entry (upsert)
router.put('/', (req, res) => {
  const { team_member_id, job_id, date, notes } = req.body;
  if (!team_member_id || !job_id || !date) {
    return res.status(400).json({ error: 'team_member_id, job_id, and date are required' });
  }

  // Check if entry exists for this member+date
  const existing = req.db.prepare(
    'SELECT * FROM schedule_entries WHERE team_member_id = ? AND date = ?'
  ).get(team_member_id, date);

  const previousJobId = existing ? existing.job_id : null;
  let id;

  if (existing) {
    req.db.prepare(`
      UPDATE schedule_entries
      SET job_id = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(job_id, notes || '', existing.id);
    id = existing.id;
  } else {
    id = uuidv4();
    req.db.prepare(`
      INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, team_member_id, job_id, date, notes || '');
  }

  const entry = req.db.prepare(`
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes,
      tm.name as member_name,
      j.code as job_code, j.name as job_name, j.color as job_color
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    JOIN jobs j ON se.job_id = j.id
    WHERE se.id = ?
  `).get(id);

  // Include notification metadata
  const isNew = !existing;
  const isChanged = !isNew && previousJobId !== job_id;

  res.json({
    ...entry,
    _notification: {
      type: isNew ? 'assigned' : (isChanged ? 'changed' : 'updated'),
      team_member_id,
      date
    }
  });
});

// PUT bulk assign (assign a job across multiple dates)
router.put('/bulk', (req, res) => {
  const { team_member_id, job_id, dates, notes } = req.body;
  if (!team_member_id || !job_id || !dates || !Array.isArray(dates)) {
    return res.status(400).json({ error: 'team_member_id, job_id, and dates array are required' });
  }

  const upsert = req.db.prepare(`
    INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(team_member_id, date)
    DO UPDATE SET job_id = excluded.job_id, notes = excluded.notes, updated_at = datetime('now')
  `);

  const insertMany = req.db.transaction((dates) => {
    for (const date of dates) {
      upsert.run(uuidv4(), team_member_id, job_id, date, notes || '');
    }
  });

  insertMany(dates);

  res.json({
    success: true,
    count: dates.length,
    _notification: {
      type: 'bulk_assigned',
      team_member_id,
      dates
    }
  });
});

// DELETE remove a schedule entry
router.delete('/:id', (req, res) => {
  const existing = req.db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule entry not found' });

  req.db.prepare('DELETE FROM schedule_entries WHERE id = ?').run(req.params.id);
  res.json({
    success: true,
    _notification: {
      type: 'removed',
      team_member_id: existing.team_member_id,
      date: existing.date
    }
  });
});

// DELETE clear a member's schedule for a specific date
router.delete('/member/:memberId/date/:date', (req, res) => {
  const result = req.db.prepare(
    'DELETE FROM schedule_entries WHERE team_member_id = ? AND date = ?'
  ).run(req.params.memberId, req.params.date);

  res.json({ success: true, deleted: result.changes });
});

export default router;
