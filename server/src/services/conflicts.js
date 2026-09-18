// Conflict detection — equipment booked on overlapping jobs.
// Used by the allocation write path (warnings) and the readiness kit gate.

export function findConflicts(db, equipmentId, from, to, excludeJobId) {
  if (!equipmentId || !from || !to) return [];
  const rows = db.prepare(`
    SELECT e.date, e.job_id, j.code, j.name, j.color
    FROM schedule_entries e
    JOIN jobs j ON j.id = e.job_id
    WHERE e.team_member_id = ?
      AND e.job_id != ?
      AND e.date >= ? AND e.date <= ?
      AND j.active = 1
    ORDER BY e.date
  `).all(equipmentId, excludeJobId || '', from, to);

  const byJob = new Map();
  for (const r of rows) {
    if (!byJob.has(r.job_id)) {
      byJob.set(r.job_id, { job_id: r.job_id, code: r.code, name: r.name, color: r.color, from: r.date, to: r.date, days: 0 });
    }
    const g = byJob.get(r.job_id);
    if (r.date < g.from) g.from = r.date;
    if (r.date > g.to) g.to = r.date;
    g.days += 1;
  }
  return [...byJob.values()];
}
