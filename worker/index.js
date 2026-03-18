import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono({ strict: false });
const api = new Hono();

api.use('/api/*', cors());

// Helper: generate UUID
function uuid() {
  return crypto.randomUUID();
}

// Health check
api.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Team Members ───

api.get('/api/team-members', async (c) => {
  const db = c.env.DB;
  const { results } = await db.prepare('SELECT * FROM team_members WHERE active = 1 ORDER BY sort_order, name').all();
  return c.json(results);
});

api.get('/api/team-members/:id', async (c) => {
  const db = c.env.DB;
  const member = await db.prepare('SELECT * FROM team_members WHERE id = ?').bind(c.req.param('id')).first();
  if (!member) return c.json({ error: 'Team member not found' }, 404);
  return c.json(member);
});

api.post('/api/team-members', async (c) => {
  const db = c.env.DB;
  const { name, role, location, timezone, color, sort_order } = await c.req.json();
  if (!name) return c.json({ error: 'Name is required' }, 400);

  const id = uuid();
  await db.prepare(
    'INSERT INTO team_members (id, name, role, location, timezone, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, name, role || '', location || '', timezone || 'Australia/Sydney', color || '#3B82F6', sort_order || 0).run();

  const member = await db.prepare('SELECT * FROM team_members WHERE id = ?').bind(id).first();
  return c.json(member, 201);
});

api.put('/api/team-members/:id', async (c) => {
  const db = c.env.DB;
  const { name, role, location, timezone, color, sort_order } = await c.req.json();
  const existing = await db.prepare('SELECT * FROM team_members WHERE id = ?').bind(c.req.param('id')).first();
  if (!existing) return c.json({ error: 'Team member not found' }, 404);

  await db.prepare(
    "UPDATE team_members SET name = ?, role = ?, location = ?, timezone = ?, color = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(
    name || existing.name,
    role ?? existing.role,
    location ?? existing.location,
    timezone || existing.timezone,
    color || existing.color,
    sort_order ?? existing.sort_order,
    c.req.param('id')
  ).run();

  const member = await db.prepare('SELECT * FROM team_members WHERE id = ?').bind(c.req.param('id')).first();
  return c.json(member);
});

api.delete('/api/team-members/:id', async (c) => {
  const db = c.env.DB;
  const result = await db.prepare(
    "UPDATE team_members SET active = 0, updated_at = datetime('now') WHERE id = ?"
  ).bind(c.req.param('id')).run();
  if (result.meta.changes === 0) return c.json({ error: 'Team member not found' }, 404);
  return c.json({ success: true });
});

// ─── Jobs ───

api.get('/api/jobs', async (c) => {
  const db = c.env.DB;
  const { results } = await db.prepare('SELECT * FROM jobs WHERE active = 1 ORDER BY code').all();
  return c.json(results);
});

api.get('/api/jobs/:id', async (c) => {
  const db = c.env.DB;
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(c.req.param('id')).first();
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json(job);
});

api.get('/api/jobs/code/:code', async (c) => {
  const db = c.env.DB;
  const job = await db.prepare('SELECT * FROM jobs WHERE code = ? AND active = 1').bind(c.req.param('code')).first();
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json(job);
});

api.post('/api/jobs', async (c) => {
  const db = c.env.DB;
  const { code, name, description, color, client, file_url } = await c.req.json();
  if (!code || !name) return c.json({ error: 'Code and name are required' }, 400);

  const existing = await db.prepare('SELECT id FROM jobs WHERE code = ?').bind(code).first();
  if (existing) return c.json({ error: 'Job code already exists' }, 409);

  const id = uuid();
  await db.prepare(
    'INSERT INTO jobs (id, code, name, description, color, client, file_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, code, name, description || '', color || '#3B82F6', client || '', file_url || '').run();

  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  return c.json(job, 201);
});

api.put('/api/jobs/:id', async (c) => {
  const db = c.env.DB;
  const { code, name, description, color, client, file_url } = await c.req.json();
  const existing = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(c.req.param('id')).first();
  if (!existing) return c.json({ error: 'Job not found' }, 404);

  if (code && code !== existing.code) {
    const dup = await db.prepare('SELECT id FROM jobs WHERE code = ? AND id != ?').bind(code, c.req.param('id')).first();
    if (dup) return c.json({ error: 'Job code already exists' }, 409);
  }

  await db.prepare(
    "UPDATE jobs SET code = ?, name = ?, description = ?, color = ?, client = ?, file_url = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(
    code || existing.code,
    name || existing.name,
    description ?? existing.description,
    color || existing.color,
    client ?? existing.client,
    file_url ?? existing.file_url,
    c.req.param('id')
  ).run();

  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(c.req.param('id')).first();
  return c.json(job);
});

api.delete('/api/jobs/:id', async (c) => {
  const db = c.env.DB;
  const result = await db.prepare(
    "UPDATE jobs SET active = 0, updated_at = datetime('now') WHERE id = ?"
  ).bind(c.req.param('id')).run();
  if (result.meta.changes === 0) return c.json({ error: 'Job not found' }, 404);
  return c.json({ success: true });
});

// ─── Schedule ───

api.get('/api/schedule', async (c) => {
  const db = c.env.DB;
  const { start, end } = c.req.query();
  if (!start || !end) return c.json({ error: 'start and end dates are required (YYYY-MM-DD)' }, 400);

  const { results } = await db.prepare(`
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes,
      tm.name as member_name, tm.color as member_color, tm.timezone,
      j.code as job_code, j.name as job_name, j.color as job_color, j.file_url as job_file_url
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    JOIN jobs j ON se.job_id = j.id
    WHERE se.date >= ? AND se.date <= ?
    ORDER BY tm.sort_order, tm.name, se.date
  `).bind(start, end).all();

  return c.json(results);
});

api.get('/api/schedule/member/:memberId', async (c) => {
  const db = c.env.DB;
  const { start, end } = c.req.query();
  const memberId = c.req.param('memberId');

  let query = `
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes,
      j.code as job_code, j.name as job_name, j.color as job_color, j.file_url as job_file_url
    FROM schedule_entries se
    JOIN jobs j ON se.job_id = j.id
    WHERE se.team_member_id = ?
  `;
  const params = [memberId];

  if (start && end) {
    query += ' AND se.date >= ? AND se.date <= ?';
    params.push(start, end);
  }

  query += ' ORDER BY se.date';
  const { results } = await db.prepare(query).bind(...params).all();
  return c.json(results);
});

api.put('/api/schedule', async (c) => {
  const db = c.env.DB;
  const { team_member_id, job_id, date, notes } = await c.req.json();
  if (!team_member_id || !job_id || !date) {
    return c.json({ error: 'team_member_id, job_id, and date are required' }, 400);
  }

  const existing = await db.prepare(
    'SELECT * FROM schedule_entries WHERE team_member_id = ? AND date = ?'
  ).bind(team_member_id, date).first();

  const previousJobId = existing ? existing.job_id : null;
  let id;

  if (existing) {
    await db.prepare(
      "UPDATE schedule_entries SET job_id = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(job_id, notes || '', existing.id).run();
    id = existing.id;
  } else {
    id = uuid();
    await db.prepare(
      'INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, team_member_id, job_id, date, notes || '').run();
  }

  const entry = await db.prepare(`
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes,
      tm.name as member_name,
      j.code as job_code, j.name as job_name, j.color as job_color
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    JOIN jobs j ON se.job_id = j.id
    WHERE se.id = ?
  `).bind(id).first();

  const isNew = !existing;
  const isChanged = !isNew && previousJobId !== job_id;

  return c.json({
    ...entry,
    _notification: {
      type: isNew ? 'assigned' : (isChanged ? 'changed' : 'updated'),
      team_member_id,
      date
    }
  });
});

api.put('/api/schedule/bulk', async (c) => {
  const db = c.env.DB;
  const { team_member_id, job_id, dates, notes } = await c.req.json();
  if (!team_member_id || !job_id || !dates || !Array.isArray(dates)) {
    return c.json({ error: 'team_member_id, job_id, and dates array are required' }, 400);
  }

  const stmts = dates.map(date =>
    db.prepare(
      "INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_member_id, date) DO UPDATE SET job_id = excluded.job_id, notes = excluded.notes, updated_at = datetime('now')"
    ).bind(uuid(), team_member_id, job_id, date, notes || '')
  );

  await db.batch(stmts);

  return c.json({
    success: true,
    count: dates.length,
    _notification: {
      type: 'bulk_assigned',
      team_member_id,
      dates
    }
  });
});

api.delete('/api/schedule/:id', async (c) => {
  const db = c.env.DB;
  const existing = await db.prepare('SELECT * FROM schedule_entries WHERE id = ?').bind(c.req.param('id')).first();
  if (!existing) return c.json({ error: 'Schedule entry not found' }, 404);

  await db.prepare('DELETE FROM schedule_entries WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({
    success: true,
    _notification: {
      type: 'removed',
      team_member_id: existing.team_member_id,
      date: existing.date
    }
  });
});

api.delete('/api/schedule/member/:memberId/date/:date', async (c) => {
  const db = c.env.DB;
  const result = await db.prepare(
    'DELETE FROM schedule_entries WHERE team_member_id = ? AND date = ?'
  ).bind(c.req.param('memberId'), c.req.param('date')).run();

  return c.json({ success: true, deleted: result.meta.changes });
});

// ─── Notifications ───

api.get('/api/notifications/member/:memberId', async (c) => {
  const db = c.env.DB;
  const { results } = await db.prepare(
    'SELECT * FROM notifications WHERE team_member_id = ? ORDER BY read ASC, created_at DESC LIMIT 50'
  ).bind(c.req.param('memberId')).all();
  return c.json(results);
});

api.get('/api/notifications/member/:memberId/unread', async (c) => {
  const db = c.env.DB;
  const result = await db.prepare(
    'SELECT COUNT(*) as count FROM notifications WHERE team_member_id = ? AND read = 0'
  ).bind(c.req.param('memberId')).first();
  return c.json({ count: result.count });
});

api.post('/api/notifications', async (c) => {
  const db = c.env.DB;
  const { team_member_id, type, message, date, job_code } = await c.req.json();
  if (!team_member_id || !message) {
    return c.json({ error: 'team_member_id and message required' }, 400);
  }

  const id = uuid();
  await db.prepare(
    'INSERT INTO notifications (id, team_member_id, type, message, date, job_code) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, team_member_id, type || 'info', message, date || null, job_code || null).run();

  const notification = await db.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first();
  return c.json(notification, 201);
});

api.put('/api/notifications/:id/read', async (c) => {
  const db = c.env.DB;
  await db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ success: true });
});

api.put('/api/notifications/member/:memberId/read-all', async (c) => {
  const db = c.env.DB;
  await db.prepare('UPDATE notifications SET read = 1 WHERE team_member_id = ?').bind(c.req.param('memberId')).run();
  return c.json({ success: true });
});

// ─── Export ───

api.get('/api/export/ical/member/:memberId', async (c) => {
  const db = c.env.DB;
  const { start, end } = c.req.query();
  const member = await db.prepare('SELECT * FROM team_members WHERE id = ?').bind(c.req.param('memberId')).first();
  if (!member) return c.json({ error: 'Team member not found' }, 404);

  let query = `
    SELECT se.date, se.notes, j.code, j.name as job_name, j.description as job_desc, j.file_url
    FROM schedule_entries se
    JOIN jobs j ON se.job_id = j.id
    WHERE se.team_member_id = ?
  `;
  const params = [c.req.param('memberId')];

  if (start && end) {
    query += ' AND se.date >= ? AND se.date <= ?';
    params.push(start, end);
  }

  query += ' ORDER BY se.date';
  const { results: entries } = await db.prepare(query).bind(...params).all();

  const grouped = groupConsecutiveEntries(entries);
  const tz = member.timezone || 'Australia/Sydney';
  const calName = `Ops Schedule - ${member.name}`;

  let ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ops Schedule//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:${calName}\r\nX-WR-TIMEZONE:${tz}\r\n`;

  for (const group of grouped) {
    const startDate = group.startDate.replace(/-/g, '');
    const endDateObj = new Date(group.endDate);
    endDateObj.setDate(endDateObj.getDate() + 1);
    const endDate = endDateObj.toISOString().slice(0, 10).replace(/-/g, '');

    let description = `Job: ${group.code} - ${group.job_name}`;
    if (group.job_desc) description += `\\n${group.job_desc}`;
    if (group.file_url) description += `\\nFiles: ${group.file_url}`;
    if (group.notes) description += `\\nNotes: ${group.notes}`;

    ical += `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${startDate}\r\nDTEND;VALUE=DATE:${endDate}\r\nSUMMARY:${group.code} - ${group.job_name}\r\nDESCRIPTION:${description}\r\n${group.file_url ? `URL:${group.file_url}\r\n` : ''}UID:${crypto.randomUUID()}@ops-schedule\r\nEND:VEVENT\r\n`;
  }

  ical += 'END:VCALENDAR\r\n';

  return new Response(ical, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="schedule-${member.name.replace(/\s+/g, '-')}.ics"`
    }
  });
});

api.get('/api/export/ical/job/:jobId', async (c) => {
  const db = c.env.DB;
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(c.req.param('jobId')).first();
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const { results: entries } = await db.prepare(`
    SELECT se.date, se.notes, tm.name as member_name
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    WHERE se.job_id = ?
    ORDER BY se.date, tm.name
  `).bind(c.req.param('jobId')).all();

  const byDate = {};
  for (const entry of entries) {
    if (!byDate[entry.date]) byDate[entry.date] = [];
    byDate[entry.date].push(entry.member_name);
  }

  let ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ops Schedule//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:Ops Schedule - ${job.code}\r\nX-WR-TIMEZONE:Australia/Sydney\r\n`;

  for (const [date, members] of Object.entries(byDate)) {
    const dateStr = date.replace(/-/g, '');
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const endStr = nextDay.toISOString().slice(0, 10).replace(/-/g, '');

    const description = `Team: ${members.join(', ')}${job.description ? '\\n' + job.description : ''}${job.file_url ? '\\nFiles: ' + job.file_url : ''}`;

    ical += `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${dateStr}\r\nDTEND;VALUE=DATE:${endStr}\r\nSUMMARY:${job.code} - ${job.name}\r\nDESCRIPTION:${description}\r\nUID:${crypto.randomUUID()}@ops-schedule\r\nEND:VEVENT\r\n`;
  }

  ical += 'END:VCALENDAR\r\n';

  return new Response(ical, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="schedule-${job.code}.ics"`
    }
  });
});

api.get('/api/export/gcal-link', (c) => {
  const { title, date, description } = c.req.query();
  if (!title || !date) return c.json({ error: 'title and date required' }, 400);

  const dateStr = date.replace(/-/g, '');
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);
  const endStr = nextDay.toISOString().slice(0, 10).replace(/-/g, '');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${dateStr}/${endStr}`,
    details: description || '',
  });

  return c.json({
    url: `https://calendar.google.com/calendar/render?${params.toString()}`
  });
});

// Mount api routes under /ops
app.route('/ops', api);

// Redirect root to /ops
app.get('/', (c) => c.redirect('/ops/'));

// Helper: group consecutive same-job entries
function groupConsecutiveEntries(entries) {
  if (entries.length === 0) return [];

  const groups = [];
  let current = {
    startDate: entries[0].date,
    endDate: entries[0].date,
    code: entries[0].code,
    job_name: entries[0].job_name,
    job_desc: entries[0].job_desc,
    file_url: entries[0].file_url,
    notes: entries[0].notes
  };

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    const prevDate = new Date(current.endDate);
    const currDate = new Date(entry.date);
    const diffDays = (currDate - prevDate) / (1000 * 60 * 60 * 24);

    if (entry.code === current.code && diffDays <= 3) {
      current.endDate = entry.date;
      if (entry.notes && !current.notes) current.notes = entry.notes;
    } else {
      groups.push(current);
      current = {
        startDate: entry.date,
        endDate: entry.date,
        code: entry.code,
        job_name: entry.job_name,
        job_desc: entry.job_desc,
        file_url: entry.file_url,
        notes: entry.notes
      };
    }
  }
  groups.push(current);
  return groups;
}

export default app;
