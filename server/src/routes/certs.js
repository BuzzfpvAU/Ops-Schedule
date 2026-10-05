import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ── Certificate types (the business-wide list) ──────────────────────────

router.get('/types', (req, res) => {
  res.json(req.db.prepare('SELECT id, name, active FROM cert_types ORDER BY sort, name').all());
});

router.post('/types', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (req.db.prepare('SELECT 1 FROM cert_types WHERE name = ? COLLATE NOCASE').get(name)) {
    return res.status(409).json({ error: 'That certificate already exists' });
  }
  const id = uuidv4();
  const sort = req.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM cert_types').get().n;
  req.db.prepare('INSERT INTO cert_types (id, name, sort) VALUES (?, ?, ?)').run(id, name, sort);
  res.status(201).json({ id, name, active: 1 });
});

// Rename, or retire (active: false hides it from pickers; holders keep it).
router.put('/types/:id', requireAdmin, (req, res) => {
  const t = req.db.prepare('SELECT * FROM cert_types WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Certificate type not found' });
  const name = req.body.name === undefined ? t.name : String(req.body.name).trim();
  if (!name) return res.status(400).json({ error: 'name cannot be empty' });
  const clash = req.db.prepare('SELECT 1 FROM cert_types WHERE name = ? COLLATE NOCASE AND id != ?').get(name, t.id);
  if (clash) return res.status(409).json({ error: 'That certificate already exists' });
  const active = req.body.active === undefined ? t.active : (req.body.active ? 1 : 0);
  req.db.prepare('UPDATE cert_types SET name = ?, active = ? WHERE id = ?').run(name, active, t.id);
  res.json({ id: t.id, name, active });
});

// ── What each person holds ──────────────────────────────────────────────

router.get('/members', (req, res) => {
  res.json(req.db.prepare('SELECT member_id, cert_type_id, expiry_date FROM member_certs').all());
});

// Replace one person's set of certificates.
router.put('/members/:memberId', requireAdmin, (req, res) => {
  const { certs } = req.body;
  if (!Array.isArray(certs)) return res.status(400).json({ error: 'certs array is required' });
  if (!req.db.prepare('SELECT 1 FROM team_members WHERE id = ?').get(req.params.memberId)) {
    return res.status(404).json({ error: 'Team member not found' });
  }
  const seen = new Set();
  for (const c of certs) {
    if (!req.db.prepare('SELECT 1 FROM cert_types WHERE id = ?').get(c.cert_type_id)) {
      return res.status(404).json({ error: 'Certificate type not found' });
    }
    if (seen.has(c.cert_type_id)) return res.status(400).json({ error: 'Duplicate certificate' });
    seen.add(c.cert_type_id);
    if (c.expiry_date && !ISO_DAY.test(c.expiry_date)) {
      return res.status(400).json({ error: 'expiry_date must be YYYY-MM-DD' });
    }
  }
  req.db.transaction(() => {
    req.db.prepare('DELETE FROM member_certs WHERE member_id = ?').run(req.params.memberId);
    const ins = req.db.prepare('INSERT INTO member_certs (member_id, cert_type_id, expiry_date) VALUES (?, ?, ?)');
    for (const c of certs) ins.run(req.params.memberId, c.cert_type_id, c.expiry_date || null);
  })();
  res.json(req.db.prepare(
    'SELECT member_id, cert_type_id, expiry_date FROM member_certs WHERE member_id = ?'
  ).all(req.params.memberId));
});

// ── What a job requires ─────────────────────────────────────────────────

router.get('/jobs/:jobId', (req, res) => {
  res.json({
    cert_type_ids: req.db.prepare('SELECT cert_type_id FROM job_required_certs WHERE job_id = ?')
      .all(req.params.jobId).map((r) => r.cert_type_id),
  });
});

router.put('/jobs/:jobId', requireAdmin, (req, res) => {
  const ids = req.body.cert_type_ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'cert_type_ids array is required' });
  if (!req.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(req.params.jobId)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  for (const id of ids) {
    if (!req.db.prepare('SELECT 1 FROM cert_types WHERE id = ?').get(id)) {
      return res.status(404).json({ error: 'Certificate type not found' });
    }
  }
  req.db.transaction(() => {
    req.db.prepare('DELETE FROM job_required_certs WHERE job_id = ?').run(req.params.jobId);
    const ins = req.db.prepare('INSERT INTO job_required_certs (job_id, cert_type_id) VALUES (?, ?)');
    for (const id of new Set(ids)) ins.run(req.params.jobId, id);
  })();
  res.json({ cert_type_ids: [...new Set(ids)] });
});

export default router;
