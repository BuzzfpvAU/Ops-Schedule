import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'fs';
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
import calendarRoutes from './server/src/routes/calendar.js';
import notificationRoutes from './server/src/routes/notifications.js';
import seedRoutes from './server/src/routes/seed.js';
import equipmentRoutes from './server/src/routes/equipment.js';

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
  res.json({
    status: 'ok',
    timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }),
    // Which front ends this server can actually serve. `v2` present at all
    // means the running code knows about /v2; false means it is not built.
    frontends: {
      v1: fs.existsSync(path.join(clientDist, 'index.html')),
      v2: hasV2Build(),
    },
  });
});

// Protected API routes
app.use('/api/team-members', requireAuth, teamRoutes);
app.use('/api/jobs', requireAuth, jobRoutes);
app.use('/api/schedule', requireAuth, scheduleRoutes);
app.use('/api/export', requireAuth, exportRoutes);
app.use('/api/notifications', requireAuth, notificationRoutes);
app.use('/api/seed', requireAuth, requireAdmin, seedRoutes);
app.use('/api/equipment', equipmentRoutes);
// Calendar subscription feeds: public URLS gated by per-entity tokens;
// token-management endpoints enforce auth inside the router.
app.use('/api/calendar', calendarRoutes);

// Serve static frontends. The V2 UI is a second, independent build against
// the same API; it mounts at /v2 and must be registered before the v1 SPA
// fallback, or the catch-all would swallow its routes.
const clientDist = path.join(__dirname, 'client', 'dist');
const clientV2Dist = path.join(__dirname, 'client-v2', 'dist');

const v2Index = path.join(clientV2Dist, 'index.html');
const v2BuildError = path.join(clientV2Dist, '..', '.build-error.log');
const hasV2Build = () => fs.existsSync(v2Index);

app.use('/v2', express.static(clientV2Dist));

// Both paths are registered: '/v2/*' does not match a bare '/v2', and when the
// build is missing express.static is not there to redirect it either.
app.get(['/v2', '/v2/*'], (req, res) => {
  // Never fall through to the v1 catch-all. Doing so answers 200 with the v1
  // app, which is indistinguishable from "/v2 redirected me back to v1" and
  // hides the real cause — that the V2 bundle was never built here.
  if (!hasV2Build()) {
    // The host's build log is not reachable from here, so the build script
    // leaves its error next to the client and it is shown below. Whether that
    // file exists is itself the diagnosis: present means the build ran and
    // failed; absent means it never ran, which points at the host invoking a
    // different build command rather than at the code.
    let detail = '';
    try {
      detail = fs.readFileSync(v2BuildError, 'utf8');
    } catch {
      detail = '';
    }
    const escape = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const diagnosis = detail
      ? `<h2>The build ran and failed</h2>
         <p>This is the error from the last deploy:</p>
         <pre>${escape(detail.slice(0, 4000))}</pre>`
      : `<h2>The build never ran here</h2>
         <p>No build error was recorded, so <code>scripts/build-clients.mjs</code>
         did not run on this server. The deploy is most likely invoking a build
         command other than <code>npm run build</code> — check the build command
         configured for the app.</p>`;
    return res.status(503).type('html').send(`<!doctype html>
<meta charset="utf-8"><title>V2 not built</title>
<style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
max-width:52rem;margin:8vh auto;padding:0 1.5rem;background:#0e1117;color:#e6edf6}
code{background:#1a212c;padding:.15em .4em;border-radius:4px;font-size:.92em}
pre{background:#0a0d12;border:1px solid #232c3a;border-radius:7px;padding:1rem;
overflow:auto;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
h1{font-size:1.3rem}h2{font-size:1rem;margin-top:1.8rem}a{color:#4c8dff}</style>
<h1>V2 UI is not built on this server</h1>
<p>The server is running current code — this route exists — but
<code>client-v2/dist</code> is missing, so there is nothing to serve.</p>
${diagnosis}
<h2>To build it manually</h2>
<p><code>cd ~/domains/taskz.id/nodejs &amp;&amp; npm run build</code></p>
<p>The v1 UI is unaffected: <a href="/">open it</a>.</p>`);
  }
  res.sendFile(v2Index);
});

app.use(express.static(clientDist));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ops Schedule running on port ${PORT}`);
});
