import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// GET all jobs
router.get('/', (req, res) => {
  const jobs = req.db
    .prepare('SELECT * FROM jobs WHERE active = 1 ORDER BY code')
    .all();
  res.json(jobs);
});

// GET single job
router.get('/:id', (req, res) => {
  const job = req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET job by code
router.get('/code/:code', (req, res) => {
  const job = req.db.prepare('SELECT * FROM jobs WHERE code = ? AND active = 1').get(req.params.code);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// POST create job
router.post('/', (req, res) => {
  const { code, name, description, color, client, file_url } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Code and name are required' });

  // Check for duplicate code
  const existing = req.db.prepare('SELECT id FROM jobs WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ error: 'Job code already exists' });

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO jobs (id, code, name, description, color, client, file_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, code, name, description || '', color || '#3B82F6', client || '', file_url || '');

  const job = req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  res.status(201).json(job);
});

// PUT update job
router.put('/:id', (req, res) => {
  const { code, name, description, color, client, file_url } = req.body;
  const existing = req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  // Check for duplicate code if changing it
  if (code && code !== existing.code) {
    const dup = req.db.prepare('SELECT id FROM jobs WHERE code = ? AND id != ?').get(code, req.params.id);
    if (dup) return res.status(409).json({ error: 'Job code already exists' });
  }

  req.db.prepare(`
    UPDATE jobs
    SET code = ?, name = ?, description = ?, color = ?, client = ?, file_url = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    code || existing.code,
    name || existing.name,
    description ?? existing.description,
    color || existing.color,
    client ?? existing.client,
    file_url ?? existing.file_url,
    req.params.id
  );

  const job = req.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  res.json(job);
});

// DELETE (soft delete) job
router.delete('/:id', (req, res) => {
  const result = req.db
    .prepare('UPDATE jobs SET active = 0, updated_at = datetime(\'now\') WHERE id = ?')
    .run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true });
});

export default router;
