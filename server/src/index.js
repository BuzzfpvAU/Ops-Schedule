import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import teamRoutes from './routes/teams.js';
import jobRoutes from './routes/jobs.js';
import scheduleRoutes from './routes/schedule.js';
import exportRoutes from './routes/export.js';
import notificationRoutes from './routes/notifications.js';

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

// Routes
app.use('/api/team-members', teamRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/notifications', notificationRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Ops Schedule server running on port ${PORT}`);
});
