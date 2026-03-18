import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// GET all team members
router.get('/', (req, res) => {
  const members = req.db
    .prepare('SELECT * FROM team_members WHERE active = 1 ORDER BY sort_order, name')
    .all();
  res.json(members);
});

// GET single team member
router.get('/:id', (req, res) => {
  const member = req.db
    .prepare('SELECT * FROM team_members WHERE id = ?')
    .get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Team member not found' });
  res.json(member);
});

// POST create team member
router.post('/', (req, res) => {
  const { name, role, location, timezone, color, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO team_members (id, name, role, location, timezone, color, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, role || '', location || '', timezone || 'Australia/Sydney', color || '#3B82F6', sort_order || 0);

  const member = req.db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
  res.status(201).json(member);
});

// PUT update team member
router.put('/:id', (req, res) => {
  const { name, role, location, timezone, color, sort_order } = req.body;
  const existing = req.db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Team member not found' });

  req.db.prepare(`
    UPDATE team_members
    SET name = ?, role = ?, location = ?, timezone = ?, color = ?, sort_order = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name || existing.name,
    role ?? existing.role,
    location ?? existing.location,
    timezone || existing.timezone,
    color || existing.color,
    sort_order ?? existing.sort_order,
    req.params.id
  );

  const member = req.db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  res.json(member);
});

// DELETE (soft delete) team member
router.delete('/:id', (req, res) => {
  const result = req.db
    .prepare('UPDATE team_members SET active = 0, updated_at = datetime(\'now\') WHERE id = ?')
    .run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Team member not found' });
  res.json({ success: true });
});

export default router;
