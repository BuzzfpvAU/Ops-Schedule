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

// ── GET /api/equipment/tracking-status ───────────────────────────────
// Diagnostics for the Find My pipeline, for the settings screen. Reports
// whether the server holds an ingest key WITHOUT ever returning it — a
// tracker that pushes to a server with no key set gets a 401 and fails
// silently, and that is invisible from the browser otherwise.
router.get('/tracking-status', requireAuth, requireAdmin, (req, res) => {
  const counts = req.db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN TRIM(COALESCE(airtag_name, '')) != '' THEN 1 ELSE 0 END) AS with_tag
    FROM team_members WHERE is_equipment = 1 AND active = 1
  `).get();

  const pings = req.db.prepare(`
    SELECT COUNT(*) AS total, MAX(seen_at) AS last_seen_at,
           COUNT(DISTINCT team_member_id) AS reporting_items
    FROM equipment_locations
  `).get();

  res.json({
    ingest_key_configured: !!process.env.TRACKER_INGEST_KEY,
    equipment_total: counts.total || 0,
    equipment_with_tag: counts.with_tag || 0,
    pings_total: pings.total || 0,
    reporting_items: pings.reporting_items || 0,
    last_seen_at: pings.last_seen_at || null,
  });
});

// ── GET /api/equipment/locations ─────────────────────────────────────
// Latest known position for every piece of equipment (nulls included).
router.get('/locations', requireAuth, (req, res) => {
  const rows = req.db.prepare(`
    SELECT tm.id, tm.name, tm.role, tm.color, tm.location, tm.equipment_category,
           tm.serial_number,
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

// ── Booking index (V2 equipment timeline) ────────────────────────────
// The equipment timeline needs the reverse of the job card: given a date
// window, which job_equipment assignment owns each item's booked days. The
// pads travel with the row so travel time can be adjusted from the timeline
// without first opening the job.
router.get('/bookings', requireAuth, (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end dates are required (YYYY-MM-DD)' });
  }

  const rows = req.db.prepare(`
    SELECT je.id, je.job_id, je.equipment_id, je.status, je.pad_before, je.pad_after,
           je.assigned_to, je.notes,
           j.code AS job_code, j.name AS job_name, j.color AS job_color, j.state AS job_state,
           (SELECT MIN(se.date) FROM schedule_entries se
             WHERE se.job_id = je.job_id AND se.team_member_id = je.equipment_id) AS booked_from,
           (SELECT MAX(se.date) FROM schedule_entries se
             WHERE se.job_id = je.job_id AND se.team_member_id = je.equipment_id) AS booked_to,
           (SELECT COUNT(DISTINCT se.date) FROM schedule_entries se
             WHERE se.job_id = je.job_id AND se.team_member_id = je.equipment_id) AS booked_days
    FROM job_equipment je
    JOIN jobs j ON j.id = je.job_id
    WHERE j.active = 1
  `).all();

  // Keep only assignments whose booked span overlaps the requested window.
  // Unbooked assignments are dropped — they have no bar to draw.
  const inWindow = rows.filter(
    (r) => r.booked_from && r.booked_from <= end && r.booked_to >= start
  );
  res.json(inWindow);
});

// ── Kits (named gear bundles, applied to jobs via /api/jobs/:id/apply-kit) ──

// GET all kits with their items
router.get('/kits', requireAuth, (req, res) => {
  const kits = req.db.prepare(`
    SELECT k.*, (SELECT COUNT(*) FROM equipment_kit_items i WHERE i.kit_id = k.id) AS item_count
    FROM equipment_kits k ORDER BY k.name
  `).all();
  const items = req.db.prepare(`
    SELECT eki.kit_id, tm.id, tm.name, tm.equipment_category, tm.serviceable
    FROM equipment_kit_items eki
    JOIN team_members tm ON tm.id = eki.equipment_id
    ORDER BY tm.name
  `).all();
  for (const k of kits) k.items = items.filter(i => i.kit_id === k.id);
  res.json(kits);
});

// POST create a kit (admin) — body: { name, notes?, items: [equipment_id] }
router.post('/kits', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const items = Array.isArray(req.body?.items) ? req.body.items.filter(x => typeof x === 'string' && x) : [];
  const id = uuidv4();
  const tx = req.db.transaction(() => {
    req.db.prepare('INSERT INTO equipment_kits (id, name, notes) VALUES (?, ?, ?)').run(id, name, req.body?.notes || '');
    const ins = req.db.prepare('INSERT OR IGNORE INTO equipment_kit_items (id, kit_id, equipment_id) VALUES (?, ?, ?)');
    for (const eq of items) ins.run(uuidv4(), id, eq);
  });
  tx();
  res.status(201).json(req.db.prepare('SELECT * FROM equipment_kits WHERE id = ?').get(id));
});

// PUT update a kit (admin) — name/notes and/or a full items replacement
router.put('/kits/:id', requireAuth, requireAdmin, (req, res) => {
  const kit = req.db.prepare('SELECT * FROM equipment_kits WHERE id = ?').get(req.params.id);
  if (!kit) return res.status(404).json({ error: 'Kit not found' });
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items.filter(x => typeof x === 'string' && x) : null;
  const tx = req.db.transaction(() => {
    req.db.prepare(`UPDATE equipment_kits SET name = ?, notes = ?, updated_at = datetime('now', '+10 hours') WHERE id = ?`)
      .run(b.name ?? kit.name, b.notes ?? kit.notes, req.params.id);
    if (items) {
      req.db.prepare('DELETE FROM equipment_kit_items WHERE kit_id = ?').run(req.params.id);
      const ins = req.db.prepare('INSERT OR IGNORE INTO equipment_kit_items (id, kit_id, equipment_id) VALUES (?, ?, ?)');
      for (const eq of items) ins.run(uuidv4(), req.params.id, eq);
    }
  });
  tx();
  res.json(req.db.prepare('SELECT * FROM equipment_kits WHERE id = ?').get(req.params.id));
});

// DELETE a kit (admin)
router.delete('/kits/:id', requireAuth, requireAdmin, (req, res) => {
  const result = req.db.prepare('DELETE FROM equipment_kits WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Kit not found' });
  res.json({ success: true });
});

export default router;
