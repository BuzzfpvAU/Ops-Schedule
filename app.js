import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './server/src/db.js';
import teamRoutes from './server/src/routes/teams.js';
import jobRoutes from './server/src/routes/jobs.js';
import scheduleRoutes from './server/src/routes/schedule.js';
import exportRoutes from './server/src/routes/export.js';
import notificationRoutes from './server/src/routes/notifications.js';
import seedRoutes from './server/src/routes/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize database
const db = initDb();

// Make db available to routes
app.use((req, res, next) => {
  req.db = db;
  next();
});

// API Routes
app.use('/api/team-members', teamRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/seed', seedRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static frontend
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ops Schedule running on port ${PORT}`);
});
