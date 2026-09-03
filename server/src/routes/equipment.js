import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

// ── Ingest authorisation ─────────────────────────────────────────────
// POST accepts either an authenticated admin session (manual updates from
// the web UI) or a static ingest key (the Mac-side AirTag tracker).

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Populate req.user from the session cookie if present, without rejecting
// requests that carry no cookie (the tracker uses X-Ingest-Key instead).
function softAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = req.db.prepare(
      'SELECT id, name, email, is_admin, is_viewer, active, must_change_password FROM team_members WHERE id = ?'
    ).get(payload.memberId);
    if (user && user.active) {
      req.user = {
        memberId: user.id,
        name: user.name,
        email: user.email,
        isAdmin: user.is_admin === 1,
        isViewer: user.is_viewer === 1,
        mustChangePassword: user.must_change_password === 1,
      };
    }
  } catch {
    // invalid/expired token → treat as anonymous
  }
  next();
}

function ingestKeyMatches(req) {
  const expected = process.env.TRACKER_INGEST_KEY;
  const given = req.get('x-ingest-key');
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function resolveMember(db, { member_id, airtag_name }) {
  if (member_id) {
    return db.prepare('SELECT * FROM team_members WHERE id = ? AND is_equipment = 1').get(member_id) || null;
  }
  if (airtag_name) {
    return db.prepare(
      "SELECT * FROM team_members WHERE is_equipment = 1 AND airtag_name = ? COLLATE NOCASE AND active = 1"
    ).get(airtag_name.trim()) || null;
  }
  return null;
}

// ── GET /api/equipment/locations ─────────────────────────────────────
// Latest known position for every piece of equipment (nulls included).
router.get('/locations', requireAuth, (req, res) => {
  const rows = req.db.prepare(`
    SELECT tm.id, tm.name, tm.role, tm.color, tm.location, tm.serial_number,
           tm.airtag_name, tm.serviceable,
           el.lat, el.lng, el.accuracy, el.battery, el.source, el.seen_at
    FROM team_members tm
    LEFT JOIN equipment_locations el ON el.id = (
      SELECT id FROM equipment_locations
      WHERE team_member_id = tm.id
      ORDER BY seen_at DESC, created_at DESC
      LIMIT 1
    )
    WHERE tm.is_equipment = 1 AND tm.active = 1
    ORDER BY el.seen_at IS NULL, el.seen_at DESC
  `).all();
  res.json(rows);
});

// ── GET /api/equipment/locations/:memberId/history ───────────────────
router.get('/locations/:memberId/history', requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  const rows = req.db.prepare(`
    SELECT lat, lng, accuracy, battery, source, seen_at
    FROM equipment_locations
    WHERE team_member_id = ?
      AND seen_at >= datetime('now', ?)
    ORDER BY seen_at DESC
    LIMIT 500
  `).all(req.params.memberId, `-${days} days`);
  res.json(rows);
});

// ── POST /api/equipment/locations ────────────────────────────────────
// Ingest one or many positions. Accepts admin sessions or X-Ingest-Key.
// Body: { locations: [{ member_id | airtag_name, lat, lng, accuracy?,
//                        battery?, seen_at?, source? }] }
// or a single object of the same shape.
router.post('/locations', softAuth, (req, res) => {
  const isAdminSession = req.user?.isAdmin;
  if (!isAdminSession && !ingestKeyMatches(req)) {
    return res.status(401).json({ error: 'Admin session or valid X-Ingest-Key required' });
  }

  const body = req.body;
  const items = Array.isArray(body) ? body : (body?.locations ? body.locations : [body]);
  if (!items.length) return res.status(400).json({ error: 'No locations provided' });

  const now = new Date().toISOString();
  const inserted = [];
  const unmatched = [];
  const invalid = [];

  const insertStmt = req.db.prepare(`
    INSERT INTO equipment_locations (id, team_member_id, lat, lng, accuracy, battery, source, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = req.db.transaction(() => {
    for (const item of items) {
      const lat = Number(item.lat);
      const lng = Number(item.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
          lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        invalid.push({ item });
        continue;
      }
      const member = resolveMember(req.db, item);
      if (!member) {
        unmatched.push({ member_id: item.member_id || null, airtag_name: item.airtag_name || null });
        continue;
      }
      const seenAt = item.seen_at || now;
      insertStmt.run(
        uuidv4(), member.id, lat, lng,
        item.accuracy != null ? Number(item.accuracy) : null,
        item.battery || '',
        item.source || 'airtag',
        seenAt
      );
      inserted.push({ member_id: member.id, name: member.name, lat, lng, seen_at: seenAt });
    }
  });
  tx();

  res.status(201).json({
    inserted: inserted.length,
    unmatched,
    invalid: invalid.length,
    details: inserted,
  });
});

// ── DELETE /api/equipment/locations/:memberId (clear history, admin) ─
router.delete('/locations/:memberId', requireAuth, requireAdmin, (req, res) => {
  const result = req.db.prepare(
    'DELETE FROM equipment_locations WHERE team_member_id = ?'
  ).run(req.params.memberId);
  res.json({ success: true, deleted: result.changes });
});

export default router;
