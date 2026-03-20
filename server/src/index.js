import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import teamRoutes from './routes/teams.js';
import jobRoutes from './routes/jobs.js';
import scheduleRoutes from './routes/schedule.js';
import exportRoutes from './routes/export.js';
import notificationRoutes from './routes/notifications.js';
import seedRoutes from './routes/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

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

// Serve static frontend files in production
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ops Schedule server running on port ${PORT}`);
  console.log(`Serving frontend from ${clientDist}`);
});
