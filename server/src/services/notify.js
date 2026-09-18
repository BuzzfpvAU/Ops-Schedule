// Notification helpers — thin wrappers over the `notifications` table so
// workflow code (readiness gates, status transitions, sweeps) doesn't have to
// repeat insert/dedupe logic. The bell UI reads the same table.

import { v4 as uuidv4 } from 'uuid';

export function notifyMember(db, { memberId, type = 'info', message, date = null, jobCode = null }) {
  if (!memberId || !message) return null;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO notifications (id, team_member_id, type, message, date, job_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, memberId, type, message, date, jobCode);
  return id;
}

export function notifyAdmins(db, { message, date = null, jobCode = null, dedupePrefix = null, excludeMemberId = null, type = 'alert' }) {
  const admins = db.prepare(
    'SELECT id FROM team_members WHERE is_admin = 1 AND active = 1 AND is_equipment = 0'
  ).all();
  const dedupeStmt = dedupePrefix
    ? db.prepare(`
        SELECT id FROM notifications
        WHERE team_member_id = ?
          AND message LIKE ?
          AND COALESCE(job_code, '') = COALESCE(?, '')
          AND created_at >= datetime('now', '-1 day')
        LIMIT 1
      `)
    : null;
  let sent = 0;
  for (const a of admins) {
    if (excludeMemberId && a.id === excludeMemberId) continue;
    if (dedupeStmt && dedupeStmt.get(a.id, dedupePrefix + '%', jobCode)) continue;
    notifyMember(db, { memberId: a.id, type, message, date, jobCode });
    sent += 1;
  }
  return sent;
}

export function notifyCrew(db, jobId, { message, date = null, jobCode = null, excludeMemberId = null }) {
  const crew = db.prepare(`
    SELECT DISTINCT tm.id
    FROM schedule_entries e
    JOIN team_members tm ON tm.id = e.team_member_id
    WHERE e.job_id = ? AND tm.is_equipment = 0 AND tm.active = 1
  `).all(jobId);
  for (const m of crew) {
    if (excludeMemberId && m.id === excludeMemberId) continue;
    notifyMember(db, { memberId: m.id, message, date, jobCode });
  }
}
