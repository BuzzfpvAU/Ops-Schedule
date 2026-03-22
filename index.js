import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './server/src/db.js';
import { requireAuth, requireAdmin } from './server/src/middleware/auth.js';
import authRoutes from './server/src/routes/auth.js';
import passkeyRoutes from './server/src/routes/passkey.js';
import teamRoutes from './server/src/routes/teams.js';
import jobRoutes from './server/src/routes/jobs.js';
import scheduleRoutes from './server/src/routes/schedule.js';
import exportRoutes from './server/src/routes/export.js';
import notificationRoutes from './server/src/routes/notifications.js';
import seedRoutes from './server/src/routes/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: allow credentials from frontend origin
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.APP_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Initialize database
const db = initDb();

// Make db available to ALL routes
app.use((req, res, next) => {
  req.db = db;
  next();
});

// Auth routes (no requireAuth needed)
app.use('/api/auth', authRoutes);
app.use('/api/auth/passkey', passkeyRoutes);

// Health check (no auth)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// TEMPORARY: Upload replacement database (remove after use)
app.post('/api/upload-db', express.json({ limit: '5mb' }), (req, res) => {
  if (req.body.secret !== 'migrate-excel-2026-xK9m') return res.status(403).json({ error: 'Invalid secret' });
  try {
    const dbPath = db.pragma('database_list')[0]?.file;
    if (!dbPath) return res.status(500).json({ error: 'Cannot find database path' });
    const buf = Buffer.from(req.body.data, 'base64');
    db.close();
    const fs = require('fs');
    // Remove WAL files
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    fs.writeFileSync(dbPath, buf);
    res.json({ success: true, size: buf.length });
    // Exit so Hostinger restarts the process with new DB
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TEMPORARY: One-time data migration endpoint (remove after use)
app.post('/api/migrate-data', (req, res) => {
  const { secret, jobs, entries } = req.body;
  if (secret !== 'migrate-excel-2026-xK9m') return res.status(403).json({ error: 'Invalid secret' });
  try {
    let jobsCreated = 0, entriesCreated = 0, skipped = 0;
    for (const j of (jobs || [])) {
      const existing = db.prepare('SELECT id FROM jobs WHERE code = ?').get(j.code);
      if (!existing) {
        db.prepare("INSERT INTO jobs (id, code, name, description, color, client, file_url) VALUES (?, ?, ?, '', ?, '', '')").run(j.id, j.code, j.name, j.color || '#3B82F6');
        jobsCreated++;
      }
    }
    for (const e of (entries || [])) {
      const member = db.prepare('SELECT id FROM team_members WHERE name = ? AND active = 1').get(e.member_name);
      if (!member) { skipped++; continue; }
      const job = db.prepare('SELECT id FROM jobs WHERE name = ? AND active = 1').get(e.job_name);
      if (!job) { skipped++; continue; }
      const existing = db.prepare('SELECT id FROM schedule_entries WHERE team_member_id = ? AND date = ?').get(member.id, e.date);
      if (existing) { skipped++; continue; }
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes, status) VALUES (?, ?, ?, ?, ?, ?)').run(id, member.id, job.id, e.date, e.notes || '', e.status || 'tentative');
      entriesCreated++;
    }
    res.json({ success: true, jobsCreated, entriesCreated, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Protected API routes
app.use('/api/team-members', requireAuth, teamRoutes);
app.use('/api/jobs', requireAuth, jobRoutes);
app.use('/api/schedule', requireAuth, scheduleRoutes);
app.use('/api/export', requireAuth, exportRoutes);
app.use('/api/notifications', requireAuth, notificationRoutes);
app.use('/api/seed', requireAuth, requireAdmin, seedRoutes);

// Serve static frontend
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ops Schedule running on port ${PORT}`);
});
