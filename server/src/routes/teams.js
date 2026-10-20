import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();
const BCRYPT_ROUNDS = 12;

// UN numbers arrive as a list or a comma-separated string, typed with or
// without the "UN" prefix. Stored normalised and deduplicated; anything that
// is not four digits is refused rather than silently dropped.
function readUnCodes(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,;\n]+/);
  const codes = [];
  for (const part of parts) {
    const text = String(part).trim();
    if (!text) continue;
    const m = text.toUpperCase().replace(/\s+/g, '').match(/^(?:UN)?(\d{4})$/);
    if (!m) return { error: `"${text}" is not a UN number (expected e.g. UN3480)` };
    const code = `UN${m[1]}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return { value: codes.join(',') };
}

// Unticking dangerous goods clears its codes, so an item never carries
// codes it is not flagged for.
function readDangerousGoods(body, existing = {}) {
  const flag = body.dangerous_goods !== undefined
    ? (body.dangerous_goods ? 1 : 0)
    : (existing.dangerous_goods ?? 0);
  if (!flag) return { flag, codes: '' };
  if (body.un_codes === undefined) return { flag, codes: existing.un_codes ?? '' };
  const r = readUnCodes(body.un_codes);
  return r.error ? { error: r.error } : { flag, codes: r.value };
}

// GET all team members (excluding equipment)
router.get('/', (req, res) => {
  const members = req.db
    .prepare('SELECT * FROM team_members WHERE active = 1 AND is_equipment = 0 AND (is_viewer = 0 OR is_viewer IS NULL) ORDER BY sort_order, name')
    .all();
  res.json(members);
});

// GET all equipment. Deactivated items are hidden by default, but must be
// reachable somehow or deactivating one would strand it: nothing could list it
// again to turn it back on.
router.get('/equipment', (req, res) => {
  const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  const equipment = req.db
    .prepare(`SELECT * FROM team_members
              WHERE is_equipment = 1 ${includeInactive ? '' : 'AND active = 1'}
              ORDER BY sort_order, name`)
    .all();
  res.json(equipment);
});

// GET single team member
router.get('/:id', (req, res) => {
  const member = req.db
    .prepare('SELECT * FROM team_members WHERE id = ?')
    .get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Team member not found' });
  res.json(member);
});

// POST create team member or equipment (admin only)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { role, location, timezone, color, sort_order, is_equipment, info_url, email, password, is_admin, serial_number, dimensions, weight, serviceable, sds_url, airtag_name, equipment_category, contents, description } = req.body;
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    // Two active items with the same name are indistinguishable in every
    // picker and on the map, so equipment names must be unique.
    if (is_equipment) {
      const dup = req.db.prepare(
        'SELECT id FROM team_members WHERE is_equipment = 1 AND active = 1 AND LOWER(TRIM(name)) = LOWER(?)'
      ).get(name);
      if (dup) return res.status(409).json({ error: `Equipment called "${name}" already exists` });
    }
    const dg = readDangerousGoods(req.body);
    if (dg.error) return res.status(400).json({ error: dg.error });

    const id = uuidv4();
    req.db.prepare(`
      INSERT INTO team_members (id, name, role, location, timezone, color, sort_order, is_equipment, info_url, serial_number, dimensions, weight, serviceable, sds_url, airtag_name, equipment_category, contents, description, dangerous_goods, un_codes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, role || '', location || '', timezone || 'Australia/Sydney', color || '#3B82F6', sort_order || 0, is_equipment || 0, info_url || '', serial_number || '', dimensions || '', weight || '', serviceable !== undefined ? (serviceable ? 1 : 0) : 1, sds_url || '', airtag_name || '', equipment_category || '', contents || '', description || '', dg.flag, dg.codes);

    // Set credentials if provided
    if (email || password || is_admin !== undefined) {
      const updates = [];
      const params = [];
      if (email) { updates.push('email = ?'); params.push(email.trim().toLowerCase()); }
      if (password) { updates.push('password_hash = ?'); params.push(await bcrypt.hash(password, BCRYPT_ROUNDS)); }
      if (is_admin !== undefined) { updates.push('is_admin = ?'); params.push(is_admin ? 1 : 0); }
      if (updates.length > 0) {
        params.push(id);
        req.db.prepare(`UPDATE team_members SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
    }

    const member = req.db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
    res.status(201).json(member);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) return res.status(400).json({ error: 'Email already in use' });
    res.status(500).json({ error: err.message });
  }
});

// PUT update team member (admin only)
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role, location, timezone, color, sort_order, info_url, email, password, is_admin, serial_number, dimensions, weight, serviceable, sds_url, airtag_name, equipment_category, contents, description, active } = req.body;
    const existing = req.db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Team member not found' });
    const dg = readDangerousGoods(req.body, existing);
    if (dg.error) return res.status(400).json({ error: dg.error });

    req.db.prepare(`
      UPDATE team_members
      SET name = ?, role = ?, location = ?, timezone = ?, color = ?, sort_order = ?, info_url = ?,
          serial_number = ?, dimensions = ?, weight = ?, serviceable = ?, sds_url = ?, airtag_name = ?,
          equipment_category = ?, contents = ?, description = ?, active = ?,
          dangerous_goods = ?, un_codes = ?,
          updated_at = datetime('now', '+10 hours')
      WHERE id = ?
    `).run(
      name || existing.name,
      role ?? existing.role,
      location ?? existing.location,
      timezone || existing.timezone,
      color || existing.color,
      sort_order ?? existing.sort_order,
      info_url ?? existing.info_url,
      serial_number ?? existing.serial_number ?? '',
      dimensions ?? existing.dimensions ?? '',
      weight ?? existing.weight ?? '',
      serviceable !== undefined ? (serviceable ? 1 : 0) : (existing.serviceable ?? 1),
      sds_url ?? existing.sds_url ?? '',
      airtag_name ?? existing.airtag_name ?? '',
      equipment_category ?? existing.equipment_category ?? '',
      contents ?? existing.contents ?? '',
      description ?? existing.description ?? '',
      active !== undefined ? (active ? 1 : 0) : (existing.active ?? 1),
      dg.flag,
      dg.codes,
      req.params.id
    );

    // Update credentials if provided
    if (email !== undefined || password || is_admin !== undefined) {
      const updates = [];
      const params = [];
      if (email !== undefined) { updates.push('email = ?'); params.push(email ? email.trim().toLowerCase() : null); }
      if (password) { updates.push('password_hash = ?'); params.push(await bcrypt.hash(password, BCRYPT_ROUNDS)); }
      if (is_admin !== undefined) { updates.push('is_admin = ?'); params.push(is_admin ? 1 : 0); }
      if (updates.length > 0) {
        params.push(req.params.id);
        req.db.prepare(`UPDATE team_members SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
    }

    const member = req.db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
    res.json(member);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) return res.status(400).json({ error: 'Email already in use' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE (soft delete) team member (admin only)
router.delete('/:id', requireAdmin, (req, res) => {
  const result = req.db
    .prepare('UPDATE team_members SET active = 0, updated_at = datetime(\'now\', \'+10 hours\') WHERE id = ?')
    .run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Team member not found' });
  res.json({ success: true });
});

// ── Per-person compliance (site inductions, White Card, licences…) ─────────

// GET compliance records for a member
router.get('/:id/compliance', (req, res) => {
  const member = req.db.prepare('SELECT id FROM team_members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Team member not found' });
  const rows = req.db.prepare(`
    SELECT * FROM member_compliance WHERE team_member_id = ?
    ORDER BY CASE WHEN expires_at = '' THEN 1 ELSE 0 END, expires_at, type
  `).all(req.params.id);
  res.json(rows);
});

// POST add compliance record (admin only)
router.post('/:id/compliance', requireAdmin, (req, res) => {
  const { type, reference, site, issued_at, expires_at, file_url, notes } = req.body;
  if (!type) return res.status(400).json({ error: 'Type is required' });
  const member = req.db.prepare('SELECT id FROM team_members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO member_compliance (id, team_member_id, type, reference, site, issued_at, expires_at, file_url, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, type, reference || '', site || '', issued_at || '', expires_at || '', file_url || '', notes || '');
  res.status(201).json(req.db.prepare('SELECT * FROM member_compliance WHERE id = ?').get(id));
});

// PUT update compliance record (admin only)
router.put('/compliance/:id', requireAdmin, (req, res) => {
  const row = req.db.prepare('SELECT * FROM member_compliance WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Compliance record not found' });
  const b = req.body;
  req.db.prepare(`
    UPDATE member_compliance
    SET type = ?, reference = ?, site = ?, issued_at = ?, expires_at = ?, file_url = ?, notes = ?,
        updated_at = datetime('now', '+10 hours')
    WHERE id = ?
  `).run(
    b.type || row.type, b.reference ?? row.reference, b.site ?? row.site,
    b.issued_at ?? row.issued_at, b.expires_at ?? row.expires_at,
    b.file_url ?? row.file_url, b.notes ?? row.notes, req.params.id
  );
  res.json(req.db.prepare('SELECT * FROM member_compliance WHERE id = ?').get(req.params.id));
});

// DELETE compliance record (admin only)
router.delete('/compliance/:id', requireAdmin, (req, res) => {
  const result = req.db.prepare('DELETE FROM member_compliance WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Compliance record not found' });
  res.json({ success: true });
});

export default router;
