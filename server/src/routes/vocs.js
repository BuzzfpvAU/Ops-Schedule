import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAdmin } from '../middleware/auth.js';
import { VOC_CATEGORIES } from '../services/vocTemplates.js';
import {
  createAssessment, changeAssessmentDate, deleteAssessment, getAssessment, listAssessments, summarise,
  equipmentList, addEquipment, ensureCertificatePdf, certificateFilename,
} from '../services/vocs.js';

// ── Validation of Competency (VOC) ───────────────────────────────────
// Mounted at /api/vocs behind requireAuth. Admins, and the people they
// have made VOC assessors, record assessments and can see everyone's;
// only admins re-date or delete them, or choose the assessors. Everyone
// else can see and download only their own certificates. Nobody can
// assess themselves.

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO = path.join(__dirname, '..', '..', '..', 'client-v2', 'public', 'letterhead', 'auav-logo.jpg');

const person = (db, id) => db.prepare(
  'SELECT id, name FROM team_members WHERE id = ? AND COALESCE(is_equipment, 0) = 0'
).get(id);

const mayRecord = (user) => !user.isViewer && (user.isAdmin || user.isVocAssessor);
const mayView = (user, memberId) => mayRecord(user) || user.memberId === memberId;

function requireRecorder(req, res, next) {
  if (!mayRecord(req.user)) return res.status(403).json({ error: 'Only admins and VOC assessors can record VOCs' });
  next();
}

router.get('/categories', (req, res) => {
  res.json(VOC_CATEGORIES);
});

router.get('/equipment', (req, res) => {
  res.json(equipmentList(req.db));
});

router.post('/equipment', requireAdmin, (req, res) => {
  const result = addEquipment(req.db, String(req.body?.category_key || ''), req.body?.name);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(result.status).json(result.item);
});

// Take a model off the pick-list. Certificates that name it keep it.
router.delete('/equipment/:id', requireAdmin, (req, res) => {
  req.db.prepare('DELETE FROM voc_equipment WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/', (req, res) => {
  const memberId = String(req.query.member_id || '');
  if (!memberId) return res.status(400).json({ error: 'member_id is required' });
  if (!mayView(req.user, memberId)) return res.status(403).json({ error: 'You can only see your own VOCs' });
  res.json(listAssessments(req.db, memberId));
});

// Let a non-admin record VOCs (or stop them).
router.put('/assessors/:memberId', requireAdmin, (req, res) => {
  const member = person(req.db, req.params.memberId);
  if (!member) return res.status(404).json({ error: 'Team member not found' });
  const on = req.body?.is_assessor ? 1 : 0;
  req.db.prepare('UPDATE team_members SET is_voc_assessor = ? WHERE id = ?').run(on, member.id);
  res.json({ member_id: member.id, is_voc_assessor: on });
});

router.post('/', requireRecorder, async (req, res) => {
  const member = person(req.db, String(req.body?.member_id || ''));
  if (!member) return res.status(404).json({ error: 'Team member not found' });
  if (member.id === req.user.memberId) return res.status(400).json({ error: 'You cannot record a VOC for yourself' });
  const result = createAssessment(req.db, { member, body: req.body, user: req.user });
  if (result.error) return res.status(result.status).json({ error: result.error, errors: result.errors });
  // Build the certificate now so it is on file; if that fails the
  // assessment still stands and the PDF is built on first download.
  await ensureCertificatePdf(req.db, result.assessment, { logoPath: LOGO })
    .catch((e) => console.error('VOC certificate PDF failed:', e));
  res.status(201).json(summarise(result.assessment));
});

// Change the date of assessment (e.g. to back-date a VOC done earlier).
router.patch('/:id', requireAdmin, (req, res) => {
  const row = getAssessment(req.db, req.params.id);
  if (!row) return res.status(404).json({ error: 'VOC not found' });
  if (req.body?.assessed_on === undefined) return res.status(400).json({ error: 'assessed_on is required' });
  const result = changeAssessmentDate(req.db, row, String(req.body.assessed_on));
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(summarise(result.assessment));
});

router.get('/:id/pdf', async (req, res) => {
  const row = getAssessment(req.db, req.params.id);
  if (!row || !mayView(req.user, row.member_id)) return res.status(404).json({ error: 'VOC not found' });
  try {
    const file = await ensureCertificatePdf(req.db, row, { logoPath: LOGO });
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.set('Content-Disposition', `${disposition}; filename="${certificateFilename(row)}"`);
    res.type('application/pdf').sendFile(file);
  } catch (e) {
    console.error('VOC certificate PDF failed:', e);
    res.status(500).json({ error: 'Could not build the certificate' });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  const row = getAssessment(req.db, req.params.id);
  if (!row) return res.status(404).json({ error: 'VOC not found' });
  deleteAssessment(req.db, row);
  res.json({ success: true });
});

export default router;
