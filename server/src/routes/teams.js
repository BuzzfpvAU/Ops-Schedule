import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();
const BCRYPT_ROUNDS = 12;

// GET all team members (excluding equipment)
router.get('/', (req, res) => {
  const members = req.db
    .prepare('SELECT * FROM team_members WHERE active = 1 AND is_equipment = 0 AND (is_viewer = 0 OR is_viewer IS NULL) ORDER BY sort_order, name')
    .all();
  res.json(members);
});

// GET all equipment
router.get('/equipment', (req, res) => {
  const equipment = req.db
    .prepare('SELECT * FROM team_members WHERE active = 1 AND is_equipment = 1 ORDER BY sort_order, name')
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
    const { name, role, location, timezone, color, sort_order, is_equipment, info_url, email, password, is_admin, serial_number, dimensions, weight, serviceable, sds_url } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const id = uuidv4();
    req.db.prepare(`
      INSERT INTO team_members (id, name, role, location, timezone, color, sort_order, is_equipment, info_url, serial_number, dimensions, weight, serviceable, sds_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, role || '', location || '', timezone || 'Australia/Sydney', color || '#3B82F6', sort_order || 0, is_equipment || 0, info_url || '', serial_number || '', dimensions || '', weight || '', serviceable !== undefined ? (serviceable ? 1 : 0) : 1, sds_url || '');

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
    const { name, role, location, timezone, color, sort_order, info_url, email, password, is_admin, serial_number, dimensions, weight, serviceable, sds_url } = req.body;
    const existing = req.db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Team member not found' });

    req.db.prepare(`
      UPDATE team_members
      SET name = ?, role = ?, location = ?, timezone = ?, color = ?, sort_order = ?, info_url = ?,
          serial_number = ?, dimensions = ?, weight = ?, serviceable = ?, sds_url = ?,
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

export default router;
