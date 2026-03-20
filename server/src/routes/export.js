import { Router } from 'express';
import icalGenerator from 'ical-generator';

const router = Router();

// GET iCal export for a team member
router.get('/ical/member/:memberId', (req, res) => {
  const { start, end } = req.query;
  const member = req.db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.memberId);
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  let query = `
    SELECT se.date, se.notes, j.code, j.name as job_name, j.description as job_desc, j.file_url
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

  const calendar = icalGenerator({
    name: `Ops Schedule - ${member.name}`,
    timezone: member.timezone || 'Australia/Sydney'
  });

  // Group consecutive days with the same job into single events
  const grouped = groupConsecutiveEntries(entries);

  for (const group of grouped) {
    const startDate = new Date(group.startDate + 'T00:00:00');
    const endDate = new Date(group.endDate + 'T23:59:59');

    let description = `Job: ${group.code} - ${group.job_name}`;
    if (group.job_desc) description += `\n${group.job_desc}`;
    if (group.file_url) description += `\nFiles: ${group.file_url}`;
    if (group.notes) description += `\nNotes: ${group.notes}`;

    calendar.createEvent({
      start: startDate,
      end: endDate,
      allDay: true,
      summary: `${group.code} - ${group.job_name}`,
      description,
      url: group.file_url || undefined
    });
  }

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="schedule-${member.name.replace(/\s+/g, '-')}.ics"`);
  res.send(calendar.toString());
});

// GET iCal export for a job
router.get('/ical/job/:jobId', (req, res) => {
  const job = req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const entries = req.db.prepare(`
    SELECT se.date, se.notes, tm.name as member_name
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    WHERE se.job_id = ?
    ORDER BY se.date, tm.name
  `).all(req.params.jobId);

  const calendar = icalGenerator({
    name: `Ops Schedule - ${job.code}`,
    timezone: 'Australia/Sydney'
  });

  // Group by date, list members per day
  const byDate = {};
  for (const entry of entries) {
    if (!byDate[entry.date]) byDate[entry.date] = [];
    byDate[entry.date].push(entry.member_name);
  }

  for (const [date, members] of Object.entries(byDate)) {
    const eventDate = new Date(date + 'T00:00:00');
    calendar.createEvent({
      start: eventDate,
      end: eventDate,
      allDay: true,
      summary: `${job.code} - ${job.name}`,
      description: `Team: ${members.join(', ')}\n${job.description || ''}${job.file_url ? '\nFiles: ' + job.file_url : ''}`
    });
  }

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="schedule-${job.code}.ics"`);
  res.send(calendar.toString());
});

// GET Google Calendar link for an entry
router.get('/gcal-link', (req, res) => {
  const { title, date, description } = req.query;
  if (!title || !date) return res.status(400).json({ error: 'title and date required' });

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

  res.json({
    url: `https://calendar.google.com/calendar/render?${params.toString()}`
  });
});

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
      // Extend current group (allow weekends gap of up to 3 days)
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

export default router;
