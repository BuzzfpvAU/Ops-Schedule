import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// POST /api/seed — seed database from seedData.json (only if tables are empty)
router.post('/', (req, res) => {
  const force = req.query.force === 'true';
  const memberCount = req.db.prepare('SELECT COUNT(*) as c FROM team_members').get().c;

  if (memberCount > 0 && !force) {
    return res.json({ message: 'Database already has data. Use ?force=true to re-seed.', seeded: false });
  }

  // Look for seed data in multiple locations
  const seedPaths = [
    path.join(__dirname, '..', '..', '..', 'seedData.json'),
    path.join(__dirname, '..', '..', '..', '..', 'seedData.json'),
  ];

  let seedFile = null;
  for (const p of seedPaths) {
    if (fs.existsSync(p)) {
      seedFile = p;
      break;
    }
  }

  if (!seedFile) {
    return res.status(404).json({ error: 'seedData.json not found' });
  }

  const data = JSON.parse(fs.readFileSync(seedFile, 'utf8'));

  // Clear existing data if force
  if (force) {
    req.db.exec('DELETE FROM schedule_entries');
    req.db.exec('DELETE FROM notifications');
    req.db.exec('DELETE FROM jobs');
    req.db.exec('DELETE FROM team_members');
  }

  const insertMember = req.db.prepare(`
    INSERT OR IGNORE INTO team_members (id, name, role, location, timezone, color, sort_order, is_equipment, info_url, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertJob = req.db.prepare(`
    INSERT OR IGNORE INTO jobs (id, code, name, description, color, client, file_url, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSchedule = req.db.prepare(`
    INSERT OR IGNORE INTO schedule_entries (id, team_member_id, job_id, date, notes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedAll = req.db.transaction(() => {
    let members = 0, jobs = 0, entries = 0;

    for (const m of (data.team_members || [])) {
      insertMember.run(m.id, m.name, m.role || '', m.location || '', m.timezone || 'Australia/Sydney', m.color || '#3B82F6', m.sort_order || 0, m.is_equipment || 0, m.info_url || '', m.active ?? 1, m.created_at || new Date().toISOString(), m.updated_at || new Date().toISOString());
      members++;
    }

    for (const j of (data.jobs || [])) {
      insertJob.run(j.id, j.code, j.name, j.description || '', j.color || '#3B82F6', j.client || '', j.file_url || '', j.active ?? 1, j.created_at || new Date().toISOString(), j.updated_at || new Date().toISOString());
      jobs++;
    }

    for (const e of (data.schedule || [])) {
      insertSchedule.run(e.id, e.team_member_id, e.job_id, e.date, e.notes || '', e.status || 'tentative', e.created_at || new Date().toISOString(), e.updated_at || new Date().toISOString());
      entries++;
    }

    return { members, jobs, entries };
  });

  const counts = seedAll();
  res.json({ seeded: true, ...counts });
});

// GET /api/seed/status — check if database has data
router.get('/status', (req, res) => {
  const members = req.db.prepare('SELECT COUNT(*) as c FROM team_members').get().c;
  const jobs = req.db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
  const entries = req.db.prepare('SELECT COUNT(*) as c FROM schedule_entries').get().c;
  res.json({ members, jobs, entries, empty: members === 0 && jobs === 0 });
});

export default router;
