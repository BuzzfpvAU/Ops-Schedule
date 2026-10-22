import { Router } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAdmin } from '../middleware/auth.js';
import { TEMPLATES, templateForCategory } from '../services/inspectionTemplates.js';
import {
  MAX_PHOTO_BYTES, savePhoto, photoPath, deletePhotoFiles, createInspection, getInspection,
  listInspections, summarise, ensureReportPdf, deleteInspection, reportFilename,
} from '../services/inspections.js';

// ── Equipment inspections ────────────────────────────────────────────
// Mounted at /api/inspections behind requireAuth. Any staff member can
// fill in an inspection; the shared viewer account cannot, and only
// admins can delete a report.

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO = path.join(__dirname, '..', '..', '..', 'client-v2', 'public', 'letterhead', 'auav-logo.jpg');

function noViewer(req, res, next) {
  if (req.user.isViewer) return res.status(403).json({ error: 'The viewer account cannot record inspections' });
  next();
}

const equipmentItem = (db, id) => db.prepare(
  'SELECT id, name, serial_number, equipment_category FROM team_members WHERE id = ? AND is_equipment = 1'
).get(id);

router.get('/templates', (req, res) => {
  const byCategory = {};
  for (const t of TEMPLATES) for (const c of t.categories) byCategory[c] = t.id;
  res.json({ templates: TEMPLATES, byCategory, fallback: templateForCategory('').id });
});

router.get('/', (req, res) => {
  const id = String(req.query.equipment_id || '');
  if (!id) return res.status(400).json({ error: 'equipment_id is required' });
  res.json(listInspections(req.db, id));
});

router.post('/', noViewer, (req, res) => {
  const item = equipmentItem(req.db, String(req.body?.equipment_id || ''));
  if (!item) return res.status(404).json({ error: 'Equipment not found' });
  const result = createInspection(req.db, { item, body: req.body, user: req.user });
  if (result.error) return res.status(result.status).json({ error: result.error, errors: result.errors });
  const { inspection } = result;
  // Build the PDF now so it is on file; if that fails the report still
  // stands and its PDF is built on first download instead.
  ensureReportPdf(req.db, inspection, { logoPath: LOGO })
    .catch((e) => console.error('Inspection PDF failed:', e))
    .finally(() => res.status(201).json(summarise(inspection)));
});

// Photos are posted as the raw image body, one per request.
router.post(
  '/photos',
  noViewer,
  express.raw({ type: ['image/jpeg', 'image/png'], limit: MAX_PHOTO_BYTES }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send a JPEG or PNG image' });
    const result = savePhoto(req.db, req.body, req.user.memberId);
    if (result.error) return res.status(400).json(result);
    res.status(201).json(result);
  },
);

router.get('/photos/:id', (req, res) => {
  const photo = req.db.prepare('SELECT * FROM equipment_inspection_photos WHERE id = ?').get(req.params.id);
  if (!photo || !fs.existsSync(photoPath(req.db, photo))) return res.status(404).json({ error: 'Photo not found' });
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(photo.mime).sendFile(photoPath(req.db, photo));
});

// Only a photo still on the form (not yet in a report) can be removed, by
// the person who added it.
router.delete('/photos/:id', (req, res) => {
  const photo = req.db.prepare('SELECT * FROM equipment_inspection_photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.json({ success: true });
  if (photo.inspection_id || photo.uploaded_by !== req.user.memberId) {
    return res.status(403).json({ error: 'This photo is part of a report' });
  }
  req.db.prepare('DELETE FROM equipment_inspection_photos WHERE id = ?').run(photo.id);
  deletePhotoFiles(req.db, [photo]);
  res.json({ success: true });
});

router.get('/:id/pdf', async (req, res) => {
  const inspection = getInspection(req.db, req.params.id);
  if (!inspection) return res.status(404).json({ error: 'Report not found' });
  try {
    const file = await ensureReportPdf(req.db, inspection, { logoPath: LOGO });
    const item = equipmentItem(req.db, inspection.equipment_id);
    const name = reportFilename(item, inspection);
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.set('Content-Disposition', `${disposition}; filename="${name}"`);
    res.type('application/pdf').sendFile(file);
  } catch (e) {
    console.error('Inspection PDF failed:', e);
    res.status(500).json({ error: 'Could not build the PDF' });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  const inspection = getInspection(req.db, req.params.id);
  if (!inspection) return res.status(404).json({ error: 'Report not found' });
  deleteInspection(req.db, inspection);
  res.json({ success: true });
});

export default router;
