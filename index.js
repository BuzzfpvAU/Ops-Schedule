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

// Protected API routes
app.use('/api/team-members', requireAuth, requireAdmin, teamRoutes);
app.use('/api/jobs', requireAuth, requireAdmin, jobRoutes);
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
