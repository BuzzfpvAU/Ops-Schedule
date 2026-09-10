import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

const USER_ALLOWED_STATUSES = ['note', 'toil', 'leave', 'unavailable'];

// GET schedule for a date range
router.get('/', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end dates are required (YYYY-MM-DD)' });
  }

  const entries = req.db.prepare(`
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes, se.status,
      tm.name as member_name, tm.color as member_color, tm.timezone,
      j.code as job_code, j.name as job_name, j.color as job_color, j.file_url as job_file_url, j.description as job_description
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
      se.id, se.team_member_id, se.job_id, se.date, se.notes, se.status,
      j.code as job_code, j.name as job_name, j.color as job_color, j.file_url as job_file_url, j.description as job_description
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
  const { team_member_id, job_id, date, notes, status, entry_id } = req.body;
  if (!team_member_id || !job_id || !date) {
    return res.status(400).json({ error: 'team_member_id, job_id, and date are required' });
  }

  // Permission check for non-admins
  if (!req.user.isAdmin) {
    if (team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }
    if (!USER_ALLOWED_STATUSES.includes(status)) {
      return res.status(403).json({ error: 'You can only add notes, TOIL, leave, or unavailable entries' });
    }
  }

  let id;
  let isNew = true;
  let previousJobId = null;

  if (entry_id) {
    // Update specific entry by ID
    const existing = req.db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(entry_id);
    if (!existing) {
      return res.status(404).json({ error: 'Schedule entry not found' });
    }
    previousJobId = existing.job_id;
    req.db.prepare(`
      UPDATE schedule_entries
      SET job_id = ?, notes = ?, status = ?, updated_at = datetime('now', '+10 hours')
      WHERE id = ?
    `).run(job_id, notes || '', status || existing.status || 'tentative', entry_id);
    id = entry_id;
    isNew = false;
  } else {
    // Check for existing entries by member+date
    const existing = req.db.prepare(
      'SELECT * FROM schedule_entries WHERE team_member_id = ? AND date = ?'
    ).all(team_member_id, date);

    if (existing.length === 1) {
      // Exactly one: update it (preserves non-admin upsert behavior)
      previousJobId = existing[0].job_id;
      req.db.prepare(`
        UPDATE schedule_entries
        SET job_id = ?, notes = ?, status = ?, updated_at = datetime('now', '+10 hours')
        WHERE id = ?
      `).run(job_id, notes || '', status || existing[0].status || 'tentative', existing[0].id);
      id = existing[0].id;
      isNew = false;
    } else if (existing.length === 0) {
      // No entries: insert new
      id = uuidv4();
      req.db.prepare(`
        INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, team_member_id, job_id, date, notes || '', status || 'tentative');
    } else {
      // Multiple entries (collision): check if this job already exists
      const sameJob = existing.find(e => e.job_id === job_id);
      if (sameJob) {
        previousJobId = sameJob.job_id;
        req.db.prepare(`
          UPDATE schedule_entries
          SET notes = ?, status = ?, updated_at = datetime('now', '+10 hours')
          WHERE id = ?
        `).run(notes || '', status || sameJob.status || 'tentative', sameJob.id);
        id = sameJob.id;
        isNew = false;
      } else {
        // Different job: insert as new collision entry
        id = uuidv4();
        req.db.prepare(`
          INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, team_member_id, job_id, date, notes || '', status || 'tentative');
      }
    }
  }

  const entry = req.db.prepare(`
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes, se.status,
      tm.name as member_name,
      j.code as job_code, j.name as job_name, j.color as job_color
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    JOIN jobs j ON se.job_id = j.id
    WHERE se.id = ?
  `).get(id);

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

// Fixed jobs backing the non-job statuses
const STATUS_JOBS = {
  toil: { code: 'TOIL', name: 'TOIL', color: '#64748b' },
  leave: { code: 'LEAVE', name: 'Leave', color: '#64748b' },
  unavailable: { code: 'NOT-AVAIL', name: 'Not Available', color: '#64748b' },
};

// Find or create the job backing a quick entry. Runs server-side so a non-admin
// can mark their own days without needing job-write permission.
function resolveQuickJob(db, status, text) {
  if (status === 'note') {
    const name = text.trim();
    const existing = db.prepare('SELECT * FROM jobs WHERE name = ?').get(name);
    if (existing) return existing;

    const slug = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    let code = 'NOTE-' + slug;
    if (db.prepare('SELECT 1 FROM jobs WHERE code = ?').get(code)) {
      code = code + '-' + Date.now().toString(36).slice(-3);
    }
    const id = uuidv4();
    db.prepare('INSERT INTO jobs (id, code, name, color) VALUES (?, ?, ?, ?)').run(id, code, name, '#3b82f6');
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  }

  const info = STATUS_JOBS[status];
  const existing = db.prepare('SELECT * FROM jobs WHERE code = ?').get(info.code);
  if (existing) return existing;

  const id = uuidv4();
  db.prepare('INSERT INTO jobs (id, code, name, color) VALUES (?, ?, ?, ?)').run(id, info.code, info.name, info.color);
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

// POST a note / TOIL / leave / unavailable entry, creating its job if needed
router.post('/quick', (req, res) => {
  const { date, status, text, team_member_id } = req.body;

  if (!date || !status) {
    return res.status(400).json({ error: 'date and status are required' });
  }
  if (!USER_ALLOWED_STATUSES.includes(status)) {
    return res.status(403).json({ error: 'You can only add notes, TOIL, leave, or unavailable entries' });
  }
  if (status === 'note' && !text?.trim()) {
    return res.status(400).json({ error: 'text is required for a note' });
  }
  if (req.user.isViewer) {
    return res.status(403).json({ error: 'Viewers cannot modify the schedule' });
  }

  const memberId = team_member_id || req.user.memberId;
  if (!memberId) {
    return res.status(400).json({ error: 'No team member to assign to' });
  }
  if (!req.user.isAdmin && memberId !== req.user.memberId) {
    return res.status(403).json({ error: 'You can only modify your own schedule' });
  }
  if (!req.db.prepare('SELECT 1 FROM team_members WHERE id = ?').get(memberId)) {
    return res.status(404).json({ error: 'Team member not found' });
  }

  let entryId;
  try {
    entryId = req.db.transaction(() => {
      const job = resolveQuickJob(req.db, status, text);

      // Same job already on this day: update it rather than duplicate
      const existing = req.db.prepare(
        'SELECT * FROM schedule_entries WHERE team_member_id = ? AND date = ? AND job_id = ?'
      ).get(memberId, date, job.id);

      if (existing) {
        req.db.prepare(`
          UPDATE schedule_entries
          SET status = ?, updated_at = datetime('now', '+10 hours')
          WHERE id = ?
        `).run(status, existing.id);
        return existing.id;
      }

      const id = uuidv4();
      req.db.prepare(`
        INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes, status)
        VALUES (?, ?, ?, ?, '', ?)
      `).run(id, memberId, job.id, date, status);
      return id;
    })();
  } catch (err) {
    console.error('Quick entry failed:', err);
    return res.status(500).json({ error: 'Failed to save entry: ' + err.message });
  }

  const entry = req.db.prepare(`
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes, se.status,
      tm.name as member_name, tm.color as member_color,
      j.code as job_code, j.name as job_name, j.color as job_color
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    JOIN jobs j ON se.job_id = j.id
    WHERE se.id = ?
  `).get(entryId);

  res.json(entry);
});

// PUT update status only (by entry_id or member+date)
router.put('/status', (req, res) => {
  const { entry_id, team_member_id, date, status } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  if (entry_id) {
    const existing = req.db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(entry_id);
    if (!existing) return res.status(404).json({ error: 'Schedule entry not found' });

    if (!req.user.isAdmin && existing.team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }

    req.db.prepare(`
      UPDATE schedule_entries SET status = ?, updated_at = datetime('now', '+10 hours') WHERE id = ?
    `).run(status, entry_id);
    res.json({ success: true });
  } else if (team_member_id && date) {
    if (!req.user.isAdmin && team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }

    const result = req.db.prepare(`
      UPDATE schedule_entries SET status = ?, updated_at = datetime('now', '+10 hours')
      WHERE team_member_id = ? AND date = ?
    `).run(status, team_member_id, date);
    if (result.changes === 0) return res.status(404).json({ error: 'Schedule entry not found' });
    res.json({ success: true });
  } else {
    return res.status(400).json({ error: 'entry_id or (team_member_id + date) required' });
  }
});

// PUT update notes only (by entry_id or member+date)
router.put('/notes', (req, res) => {
  const { entry_id, team_member_id, date, notes } = req.body;

  if (entry_id) {
    const existing = req.db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(entry_id);
    if (!existing) return res.status(404).json({ error: 'Schedule entry not found' });

    if (!req.user.isAdmin && existing.team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }

    req.db.prepare(`
      UPDATE schedule_entries SET notes = ?, updated_at = datetime('now', '+10 hours') WHERE id = ?
    `).run(notes || '', entry_id);
    res.json({ success: true });
  } else if (team_member_id && date) {
    if (!req.user.isAdmin && team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }

    const result = req.db.prepare(`
      UPDATE schedule_entries SET notes = ?, updated_at = datetime('now', '+10 hours')
      WHERE team_member_id = ? AND date = ?
    `).run(notes || '', team_member_id, date);
    if (result.changes === 0) return res.status(404).json({ error: 'Schedule entry not found' });
    res.json({ success: true });
  } else {
    return res.status(400).json({ error: 'entry_id or (team_member_id + date) required' });
  }
});

// PUT bulk assign (admin only)
router.put('/bulk', requireAdmin, (req, res) => {
  const { team_member_id, job_id, dates, notes, status } = req.body;
  if (!team_member_id || !job_id || !dates || !Array.isArray(dates)) {
    return res.status(400).json({ error: 'team_member_id, job_id, and dates array are required' });
  }

  const check = req.db.prepare(
    'SELECT id FROM schedule_entries WHERE team_member_id = ? AND job_id = ? AND date = ?'
  );
  const insert = req.db.prepare(`
    INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = req.db.transaction((dates) => {
    let inserted = 0;
    for (const date of dates) {
      if (!check.get(team_member_id, job_id, date)) {
        insert.run(uuidv4(), team_member_id, job_id, date, notes || '', status || 'tentative');
        inserted++;
      }
    }
    return inserted;
  });

  const inserted = insertMany(dates);

  res.json({
    success: true,
    count: inserted,
    _notification: {
      type: 'bulk_assigned',
      team_member_id,
      dates
    }
  });
});

// POST move schedule entries atomically (admin only)
router.post('/move', requireAdmin, (req, res) => {
  const { entry_ids, target_member_id, target_start_date } = req.body;
  if (!entry_ids || !Array.isArray(entry_ids) || entry_ids.length === 0) {
    return res.status(400).json({ error: 'entry_ids array is required' });
  }
  if (!target_member_id || !target_start_date) {
    return res.status(400).json({ error: 'target_member_id and target_start_date are required' });
  }

  // Validate target member exists
  const targetMember = req.db.prepare('SELECT id FROM team_members WHERE id = ?').get(target_member_id);
  if (!targetMember) {
    return res.status(400).json({ error: 'Target member not found' });
  }

  // Look up all source entries
  const placeholders = entry_ids.map(() => '?').join(',');
  const sourceEntries = req.db.prepare(
    `SELECT * FROM schedule_entries WHERE id IN (${placeholders}) ORDER BY date ASC`
  ).all(...entry_ids);

  if (sourceEntries.length !== entry_ids.length) {
    const found = new Set(sourceEntries.map(e => e.id));
    const missing = entry_ids.filter(id => !found.has(id));
    return res.status(400).json({ error: `Entries not found: ${missing.join(', ')}` });
  }

  // Calculate date offset from first source entry to target start date
  const firstSourceDate = new Date(sourceEntries[0].date);
  const targetDate = new Date(target_start_date);
  const dayOffset = Math.round((targetDate - firstSourceDate) / 86400000);

  // Perform move in a single transaction
  const moveTransaction = req.db.transaction(() => {
    const newEntries = [];
    const insertStmt = req.db.prepare(`
      INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const deleteStmt = req.db.prepare('DELETE FROM schedule_entries WHERE id = ?');

    for (const entry of sourceEntries) {
      const oldDate = new Date(entry.date);
      const newDate = new Date(oldDate);
      newDate.setDate(newDate.getDate() + dayOffset);
      const newDateStr = newDate.toISOString().slice(0, 10);
      const newId = uuidv4();

      insertStmt.run(newId, target_member_id, entry.job_id, newDateStr, entry.notes || '', entry.status || 'tentative');
      deleteStmt.run(entry.id);

      newEntries.push({
        id: newId,
        team_member_id: target_member_id,
        job_id: entry.job_id,
        date: newDateStr,
        notes: entry.notes,
        status: entry.status
      });
    }
    return newEntries;
  });

  try {
    const newEntries = moveTransaction();

    const newPlaceholders = newEntries.map(() => '?').join(',');
    const fullEntries = req.db.prepare(`
      SELECT
        se.id, se.team_member_id, se.job_id, se.date, se.notes, se.status,
        tm.name as member_name, tm.color as member_color, tm.timezone,
        j.code as job_code, j.name as job_name, j.color as job_color,
        j.file_url as job_file_url, j.description as job_description
      FROM schedule_entries se
      JOIN team_members tm ON se.team_member_id = tm.id
      JOIN jobs j ON se.job_id = j.id
      WHERE se.id IN (${newPlaceholders})
      ORDER BY se.date ASC
    `).all(...newEntries.map(e => e.id));

    res.json({
      success: true,
      entries: fullEntries,
      _notification: {
        type: 'moved',
        team_member_id: target_member_id,
        dates: fullEntries.map(e => e.date)
      }
    });
  } catch (err) {
    console.error('Move transaction failed:', err);
    res.status(500).json({ error: 'Move failed: ' + err.message });
  }
});

// DELETE remove a schedule entry
router.delete('/:id', (req, res) => {
  const existing = req.db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule entry not found' });

  // Non-admins may only remove their own note/TOIL/leave/unavailable entries
  if (!req.user.isAdmin) {
    if (existing.team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }
    if (!USER_ALLOWED_STATUSES.includes(existing.status)) {
      return res.status(403).json({ error: 'You cannot remove admin-assigned entries' });
    }
  }

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
  // Permission check for non-admins
  if (!req.user.isAdmin) {
    if (req.params.memberId !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only clear your own schedule' });
    }
    // Check ALL entries for this cell — if any has a non-user-allowed status, reject
    const entries = req.db.prepare(
      'SELECT status FROM schedule_entries WHERE team_member_id = ? AND date = ?'
    ).all(req.params.memberId, req.params.date);
    const hasAdminEntry = entries.some(e => !USER_ALLOWED_STATUSES.includes(e.status));
    if (hasAdminEntry) {
      return res.status(403).json({ error: 'You cannot remove admin-assigned entries' });
    }
  }

  const result = req.db.prepare(
    'DELETE FROM schedule_entries WHERE team_member_id = ? AND date = ?'
  ).run(req.params.memberId, req.params.date);

  res.json({ success: true, deleted: result.changes });
});

export default router;
