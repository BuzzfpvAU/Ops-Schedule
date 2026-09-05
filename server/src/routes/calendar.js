import { Router } from 'express';
import crypto from 'crypto';
import icalGenerator from 'ical-generator';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

// Calendar-subscription feeds.
//
// Public feed URLs (no cookies — calendar apps can't send them) are gated by
// an unguessable per-entity token kept in the calendar_tokens table. Tokens
// are minted lazily on first request to /me (own member feed) or
// /job/:jobId/token (admin), so nothing exists until the UI asks for it.
// The feeds are rolling: past 60 days → next 400 days, regenerated on every
// fetch, so subscribers always see the current schedule.

const router = Router();

const FEED_PAST_DAYS = 60;
const FEED_FUTURE_DAYS = 400;

function ensureToken(db, type, entityId) {
  const existing = db.prepare(
    'SELECT token FROM calendar_tokens WHERE entity_type = ? AND entity_id = ?'
  ).get(type, entityId);
  if (existing) return existing.token;
  const token = crypto.randomUUID().replace(/-/g, '');
  db.prepare(
    'INSERT OR IGNORE INTO calendar_tokens (entity_type, entity_id, token) VALUES (?, ?, ?)'
  ).run(type, entityId, token);
  const row = db.prepare(
    'SELECT token FROM calendar_tokens WHERE entity_type = ? AND entity_id = ?'
  ).get(type, entityId);
  return row ? row.token : null;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function rollingBounds() {
  const today = new Date().toISOString().slice(0, 10);
  return { start: addDays(today, -FEED_PAST_DAYS), end: addDays(today, FEED_FUTURE_DAYS) };
}

function sendFeed(res, calendar) {
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'max-age=300');
  res.send(calendar.toString());
}

// ── GET /api/calendar/member/:token.ics ──────────────────────────────
// One member's own schedule (name/job/dates, no other staff visible).
router.get('/member/:token.ics', (req, res) => {
  const row = req.db.prepare(
    'SELECT entity_id FROM calendar_tokens WHERE entity_type = ? AND token = ?'
  ).get('member', req.params.token);
  if (!row) return res.status(404).send('Not found');
  const member = req.db.prepare('SELECT * FROM team_members WHERE id = ? AND active = 1').get(row.entity_id);
  if (!member) return res.status(404).send('Not found');

  const { start, end } = rollingBounds();
  const entries = req.db.prepare(`
    SELECT se.date, se.notes, j.code, j.name as job_name, j.description as job_desc, j.file_url
    FROM schedule_entries se
    JOIN jobs j ON se.job_id = j.id
    WHERE se.team_member_id = ? AND se.date >= ? AND se.date <= ?
    ORDER BY se.date
  `).all(member.id, start, end);

  const calendar = icalGenerator({
    name: `Ops Schedule - ${member.name}`,
    timezone: member.timezone || 'Australia/Sydney',
  });

  // Group consecutive days with the same job into single events
  for (const group of groupConsecutiveEntries(entries)) {
    let description = `Job: ${group.code} - ${group.job_name}`;
    if (group.job_desc) description += `\n${group.job_desc}`;
    if (group.file_url) description += `\nFiles: ${group.file_url}`;
    if (group.notes) description += `\nNotes: ${group.notes}`;
    calendar.createEvent({
      start: new Date(`${group.startDate}T00:00:00`),
      end: new Date(`${addDays(group.endDate, 1)}T00:00:00`), // exclusive
      allDay: true,
      summary: `${group.code} - ${group.job_name}`,
      description,
      url: group.file_url || undefined,
    });
  }

  sendFeed(res, calendar);
});

// ── GET /api/calendar/job/:token.ics ─────────────────────────────────
// Everyone assigned to a job, per day. Same token rules as member feeds.
router.get('/job/:token.ics', (req, res) => {
  const row = req.db.prepare(
    'SELECT entity_id FROM calendar_tokens WHERE entity_type = ? AND token = ?'
  ).get('job', req.params.token);
  if (!row) return res.status(404).send('Not found');
  const job = req.db.prepare('SELECT * FROM jobs WHERE id = ? AND active = 1').get(row.entity_id);
  if (!job) return res.status(404).send('Not found');

  const { start, end } = rollingBounds();
  const entries = req.db.prepare(`
    SELECT se.date, tm.name as member_name
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    WHERE se.job_id = ? AND se.date >= ? AND se.date <= ?
    ORDER BY se.date, tm.name
  `).all(job.id, start, end);

  const calendar = icalGenerator({
    name: `Ops Schedule - ${job.code}`,
    timezone: 'Australia/Sydney',
  });

  const byDate = {};
  for (const entry of entries) {
    if (!byDate[entry.date]) byDate[entry.date] = [];
    byDate[entry.date].push(entry.member_name);
  }

  for (const [date, members] of Object.entries(byDate)) {
    calendar.createEvent({
      start: new Date(`${date}T00:00:00`),
      end: new Date(`${addDays(date, 1)}T00:00:00`), // exclusive
      allDay: true,
      summary: `${job.code} - ${job.name}`,
      description: `Team: ${members.join(', ')}\n${job.description || ''}${job.file_url ? '\nFiles: ' + job.file_url : ''}`,
    });
  }

  sendFeed(res, calendar);
});

// ── GET /api/calendar/me ─────────────────────────────────────────────
// Signed-in member's own subscription token (created on first request).
router.get('/me', requireAuth, (req, res) => {
  const token = ensureToken(req.db, 'member', req.user.memberId);
  if (!token) return res.status(500).json({ error: 'Could not create calendar token' });
  res.json({ token });
});

// ── GET /api/calendar/job/:jobId/token ───────────────────────────────
// Job subscription token (admin only — exposes the whole job roster).
router.get('/job/:jobId/token', requireAuth, requireAdmin, (req, res) => {
  const job = req.db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const token = ensureToken(req.db, 'job', job.id);
  if (!token) return res.status(500).json({ error: 'Could not create calendar token' });
  res.json({ token });
});

// Helper: group consecutive same-job entries (allows weekend gaps ≤ 3 days)
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
    notes: entries[0].notes,
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
        notes: entry.notes,
      };
    }
  }
  groups.push(current);
  return groups;
}

export default router;
