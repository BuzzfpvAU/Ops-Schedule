import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getTemplate } from './inspectionTemplates.js';
import { buildInspectionPdf } from './inspectionPdf.js';

// ── Equipment inspections ────────────────────────────────────────────
// Photos are uploaded one at a time while the form is being filled in
// (staged: no inspection yet), then the submission claims them by id.
// Files live beside the database so they are kept, and backed up, with it:
//   <db dir>/inspections/photos/<photo id>.jpg|png
//   <db dir>/inspections/reports/<inspection id>.pdf

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const STAGED_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;

export function inspectionsDir(db) {
  return path.join(path.dirname(path.resolve(db.name)), 'inspections');
}
const photosDir = (db) => path.join(inspectionsDir(db), 'photos');
const reportsDir = (db) => path.join(inspectionsDir(db), 'reports');

export const photoPath = (db, photo) => path.join(photosDir(db), photo.file);
export const reportPath = (db, inspection) => path.join(reportsDir(db), inspection.pdf_file);

// The type is read from the file itself, not the request header: only JPEG
// and PNG are kept, as those are what the PDF can embed.
export function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  return null;
}

export function savePhoto(db, buf, uploadedBy) {
  const kind = sniffImage(buf);
  if (!kind) return { error: 'Photos must be JPEG or PNG images' };
  if (buf.length > MAX_PHOTO_BYTES) return { error: 'Photo is too large' };
  removeStalePhotos(db);
  const id = crypto.randomUUID();
  const file = `${id}.${kind.ext}`;
  fs.mkdirSync(photosDir(db), { recursive: true });
  fs.writeFileSync(path.join(photosDir(db), file), buf);
  db.prepare(`
    INSERT INTO equipment_inspection_photos (id, file, mime, size, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, file, kind.mime, buf.length, uploadedBy, new Date().toISOString());
  return { id };
}

export function deletePhotoFiles(db, photos) {
  for (const p of photos) fs.rmSync(photoPath(db, p), { force: true });
}

// Uploads from forms that were abandoned are cleared after a day.
export function removeStalePhotos(db, now = Date.now()) {
  const cutoff = new Date(now - STAGED_PHOTO_TTL_MS).toISOString();
  const stale = db.prepare(
    'SELECT * FROM equipment_inspection_photos WHERE inspection_id IS NULL AND uploaded_at < ?'
  ).all(cutoff);
  if (!stale.length) return 0;
  deletePhotoFiles(db, stale);
  db.prepare('DELETE FROM equipment_inspection_photos WHERE inspection_id IS NULL AND uploaded_at < ?').run(cutoff);
  return stale.length;
}

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

// Check a submission against its template. Returns the cleaned details and
// answers, or a list of problems in the words the form uses.
export function validateSubmission(template, body = {}) {
  const errors = [];
  const details = {};
  for (const f of template.details) {
    const value = str(body.details?.[f.key]);
    if (f.required && !value) errors.push(`${f.label} is required`);
    if (value && f.type === 'choice' && !f.options.includes(value)) errors.push(`${f.label}: choose one of the listed options`);
    if (value && f.type === 'number' && !Number.isFinite(Number(value))) errors.push(`${f.label} must be a number`);
    if (value && f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${f.label} must be a date`);
    details[f.key] = value;
  }

  const answers = {};
  const seen = new Set();
  for (const a of template.areas) {
    const raw = body.answers?.[a.key] || {};
    const defects = str(raw.defects).toLowerCase();
    const notes = str(raw.notes);
    const photos = Array.isArray(raw.photos) ? raw.photos.map(str).filter(Boolean) : [];
    if (defects !== 'yes' && defects !== 'no') errors.push(`${a.label}: answer whether defects were observed`);
    if (defects === 'yes' && !notes) errors.push(`${a.label}: describe the defect`);
    if (a.photos > 0 && !photos.length) errors.push(`${a.label}: add at least one photo`);
    for (const id of photos) {
      if (seen.has(id)) errors.push(`${a.label}: a photo is used twice`);
      seen.add(id);
    }
    answers[a.key] = { defects, notes: defects === 'yes' ? notes : '', photos };
  }
  return { errors, details, answers, photoIds: [...seen] };
}

// Save a submitted inspection and claim its photos. The PDF is generated
// afterwards (see ensureReportPdf); a report whose PDF failed to build is
// rebuilt the first time it is downloaded.
export function createInspection(db, { item, body, user }) {
  const template = getTemplate(str(body.template_id));
  if (!template) return { status: 400, error: 'Unknown inspection form' };

  const { errors, details, answers, photoIds } = validateSubmission(template, body);
  if (photoIds.length) {
    const found = db.prepare(
      `SELECT id, inspection_id, uploaded_by FROM equipment_inspection_photos WHERE id IN (${photoIds.map(() => '?').join(',')})`
    ).all(...photoIds);
    const usable = new Set(found.filter((p) => !p.inspection_id && p.uploaded_by === user.memberId).map((p) => p.id));
    if (photoIds.some((id) => !usable.has(id))) errors.push('A photo has expired or is not yours – remove it and add it again');
  }
  if (errors.length) return { status: 400, error: errors[0], errors };

  const defectCount = template.areas.filter((a) => answers[a.key].defects === 'yes').length;
  const markUnserviceable = defectCount > 0 && !!body.mark_unserviceable;
  const id = crypto.randomUUID();

  db.transaction(() => {
    const number = (db.prepare('SELECT MAX(number) AS n FROM equipment_inspections').get().n || 0) + 1;
    db.prepare(`
      INSERT INTO equipment_inspections (
        id, number, equipment_id, template_id, template_json, details_json, answers_json, comments,
        defect_count, marked_unserviceable, inspected_by_id, inspected_by_name, inspected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, number, item.id, template.id, JSON.stringify(template), JSON.stringify(details), JSON.stringify(answers),
      str(body.comments), defectCount, markUnserviceable ? 1 : 0, user.memberId, user.name || '', new Date().toISOString(),
    );
    const claim = db.prepare('UPDATE equipment_inspection_photos SET inspection_id = ?, area_key = ?, sort = ? WHERE id = ?');
    for (const a of template.areas) answers[a.key].photos.forEach((pid, i) => claim.run(id, a.key, i, pid));
    if (markUnserviceable) db.prepare('UPDATE team_members SET serviceable = 0 WHERE id = ?').run(item.id);
  })();

  return { status: 201, inspection: getInspection(db, id) };
}

export function getInspection(db, id) {
  return db.prepare('SELECT * FROM equipment_inspections WHERE id = ?').get(id) || null;
}

// What the equipment drawer lists: one line per report, newest first.
export function listInspections(db, equipmentId) {
  return db.prepare(`
    SELECT i.*, (SELECT COUNT(*) FROM equipment_inspection_photos p WHERE p.inspection_id = i.id) AS photo_count
    FROM equipment_inspections i WHERE i.equipment_id = ? ORDER BY i.inspected_at DESC, i.number DESC
  `).all(equipmentId).map(summarise);
}

export function summarise(row) {
  const template = JSON.parse(row.template_json);
  return {
    id: row.id,
    number: row.number,
    equipment_id: row.equipment_id,
    template_id: row.template_id,
    title: template.title,
    area_count: template.areas.length,
    defect_count: row.defect_count,
    marked_unserviceable: row.marked_unserviceable === 1,
    inspected_by_name: row.inspected_by_name,
    inspected_at: row.inspected_at,
    photo_count: row.photo_count ?? undefined,
  };
}

// The PDF for a report, building and saving it if it is not on disk yet.
export async function ensureReportPdf(db, inspection, { logoPath } = {}) {
  if (inspection.pdf_file && fs.existsSync(reportPath(db, inspection))) return reportPath(db, inspection);
  const item = db.prepare('SELECT id, name, serial_number, equipment_category FROM team_members WHERE id = ?')
    .get(inspection.equipment_id) || { name: '', serial_number: '' };
  const photos = db.prepare(
    'SELECT * FROM equipment_inspection_photos WHERE inspection_id = ? ORDER BY area_key, sort'
  ).all(inspection.id).map((p) => ({ ...p, path: photoPath(db, p) }));
  const buf = await buildInspectionPdf({
    inspection,
    template: JSON.parse(inspection.template_json),
    details: JSON.parse(inspection.details_json),
    answers: JSON.parse(inspection.answers_json),
    item,
    photos,
    logoPath,
  });
  const file = `${inspection.id}.pdf`;
  fs.mkdirSync(reportsDir(db), { recursive: true });
  fs.writeFileSync(path.join(reportsDir(db), file), buf);
  db.prepare('UPDATE equipment_inspections SET pdf_file = ? WHERE id = ?').run(file, inspection.id);
  inspection.pdf_file = file;
  return reportPath(db, inspection);
}

export function deleteInspection(db, inspection) {
  const photos = db.prepare('SELECT * FROM equipment_inspection_photos WHERE inspection_id = ?').all(inspection.id);
  db.prepare('DELETE FROM equipment_inspections WHERE id = ?').run(inspection.id);
  deletePhotoFiles(db, photos);
  if (inspection.pdf_file) fs.rmSync(reportPath(db, inspection), { force: true });
}

// "AUAV_Inspection_M4T_1581F7K3C24C600A0RZP_2026-10-22.pdf" — the naming
// the Microsoft Forms reports used (item name, then serial) plus the date,
// so an item's reports do not overwrite each other in Downloads.
export function reportFilename(item, inspection) {
  const part = (s) => str(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const day = new Date(inspection.inspected_at).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  return `${['AUAV_Inspection', part(item?.name), part(item?.serial_number), day].filter(Boolean).join('_')}.pdf`;
}
