import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import passkeyRoutes from './routes/passkey.js';
import teamRoutes from './routes/teams.js';
import jobRoutes from './routes/jobs.js';
import scheduleRoutes from './routes/schedule.js';
import exportRoutes from './routes/export.js';
import notificationRoutes from './routes/notifications.js';
import seedRoutes from './routes/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// CORS: allow credentials from frontend origin
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3001',
  process.env.APP_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (same-origin, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Initialize database
const db = initDb();

// Make db available to ALL routes (including auth)
app.use((req, res, next) => {
  req.db = db;
  next();
});

// Auth routes (no requireAuth needed — they handle their own auth)
app.use('/api/auth', authRoutes);
app.use('/api/auth/passkey', passkeyRoutes);

// Health check (no auth)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) });
});

// Protected API routes (require login)
app.use('/api/team-members', requireAuth, teamRoutes);
app.use('/api/jobs', requireAuth, jobRoutes);
app.use('/api/schedule', requireAuth, scheduleRoutes);
app.use('/api/export', requireAuth, exportRoutes);
app.use('/api/notifications', requireAuth, notificationRoutes);
app.use('/api/seed', requireAuth, requireAdmin, seedRoutes);

// Serve static frontend files in production
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ops Schedule server running on port ${PORT}`);
});
