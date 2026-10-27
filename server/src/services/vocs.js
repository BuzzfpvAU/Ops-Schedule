import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { VOC_CATEGORIES, VOC_VALID_YEARS, getCategory, vocCertTypeId, certNumber } from './vocTemplates.js';

export { certNumber };
import { buildVocPdf } from './vocPdf.js';

// ── Validation of Competency (VOC) ───────────────────────────────────
// One assessment covers one person and one or more categories, and makes
// one certificate. Certificates live beside the database, with the
// inspection reports:
//   <db dir>/vocs/<assessment id>-v<layout>.pdf
//
// Every change to a person's assessments re-derives their "VOC – …" rows
// in member_certs (syncMemberVocCerts), so Certificates and the job
// requirement checks always reflect the latest competent result.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Australia/Sydney';
const MAX_EQUIPMENT_NAME = 80;

export const vocsDir = (db) => path.join(path.dirname(path.resolve(db.name)), 'vocs');
const pdfPath = (db, row) => path.join(vocsDir(db), row.pdf_file);

export const todayInSydney = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: TZ });

export function isRealDay(iso) {
  if (!ISO_DAY.test(iso || '')) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

// One year on, to the day; 29 February falls back to the 28th.
export function expiryFor(assessedOn) {
  const [y, m, d] = assessedOn.split('-').map(Number);
  const year = y + VOC_VALID_YEARS;
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

// An assessment date must be a real day and not in the future.
export function dateProblem(value, today = todayInSydney()) {
  if (!isRealDay(value)) return 'Date of assessment must be a date';
  if (value > today) return 'Date of assessment cannot be in the future';
  return null;
}

// Check a submission. Returns the cleaned results (one per category
// assessed, in the order the categories are listed) or the problems in the
// words the form uses.
export function validateSubmission(body = {}, { today } = {}) {
  const errors = [];
  const assessedOn = str(body.assessed_on);
  const dp = dateProblem(assessedOn, today);
  if (dp) errors.push(dp);
  const assessorName = str(body.assessor_name);
  if (!assessorName) errors.push('Assessor name is required');

  const raw = Array.isArray(body.results) ? body.results : [];
  const byKey = new Map();
  for (const r of raw) {
    const key = str(r?.key);
    if (!getCategory(key)) errors.push('Unknown competency category');
    else if (byKey.has(key)) errors.push(`${getCategory(key).title} is listed twice`);
    else byKey.set(key, r);
  }
  if (!byKey.size && !errors.length) errors.push('Choose at least one category to assess');

  const results = [];
  for (const category of VOC_CATEGORIES) {
    const r = byKey.get(category.key);
    if (!r) continue;
    const t = category.title;

    const equipment = [];
    const seen = new Set();
    for (const e of Array.isArray(r.equipment) ? r.equipment : []) {
      const name = str(e).replace(/\s+/g, ' ');
      if (!name) continue;
      if (name.length > MAX_EQUIPMENT_NAME) errors.push(`${t}: equipment names must be ${MAX_EQUIPMENT_NAME} characters or fewer`);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      equipment.push(name);
    }
    if (!equipment.length) errors.push(`${t}: add the ${category.equipmentLabel.toLowerCase()} assessed`);

    const tasks = {};
    for (const task of category.tasks) {
      const v = str(r.tasks?.[task.key]).toLowerCase();
      if (v !== 'competent' && v !== 'nyc') errors.push(`${t}: mark “${task.label}”`);
      tasks[task.key] = v;
    }
    const theory = str(r.theory).toLowerCase();
    const practical = str(r.practical).toLowerCase();
    if (theory !== 'pass' && theory !== 'fail') errors.push(`${t}: record the theory result`);
    if (practical !== 'pass' && practical !== 'fail') errors.push(`${t}: record the practical result`);
    let theoryScore = null;
    if (str(r.theory_score) !== '') {
      theoryScore = Number(r.theory_score);
      if (!Number.isFinite(theoryScore) || theoryScore < 0 || theoryScore > 100) {
        errors.push(`${t}: theory score must be between 0 and 100`);
        theoryScore = null;
      }
    }
    const competent = category.tasks.every((task) => tasks[task.key] === 'competent')
      && theory === 'pass' && practical === 'pass';
    const notes = str(r.notes);
    if (!competent && !notes) errors.push(`${t}: note what still needs to be demonstrated`);

    results.push({
      key: category.key,
      equipment,
      tasks,
      theory,
      theory_score: theoryScore,
      practical,
      notes,
      outcome: competent ? 'competent' : 'nyc',
    });
  }
  return { errors, results, assessedOn, assessorName, comments: str(body.comments) };
}

export function createAssessment(db, { member, body, user, today }) {
  const { errors, results, assessedOn, assessorName, comments } = validateSubmission(body, { today });
  if (errors.length) return { status: 400, error: errors[0], errors };

  const categories = results.map((r) => getCategory(r.key));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    const number = (db.prepare('SELECT MAX(number) AS n FROM voc_assessments').get().n || 0) + 1;
    db.prepare(`
      INSERT INTO voc_assessments (
        id, number, member_id, member_name, categories_json, results_json, comments,
        assessed_on, expires_on, assessor_id, assessor_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, number, member.id, member.name || '', JSON.stringify(categories), JSON.stringify(results), comments,
      assessedOn, expiryFor(assessedOn), user.memberId, assessorName, now, now,
    );
    rememberEquipment(db, results);
    syncMemberVocCerts(db, member.id);
  })();
  return { status: 201, assessment: getAssessment(db, id) };
}

// Move the date of assessment (and with it the expiry). The certificate is
// rebuilt on next open.
export function changeAssessmentDate(db, assessment, assessedOn, { today } = {}) {
  const problem = dateProblem(str(assessedOn), today);
  if (problem) return { status: 400, error: problem };
  db.transaction(() => {
    db.prepare(`
      UPDATE voc_assessments SET assessed_on = ?, expires_on = ?, updated_at = ?, pdf_file = NULL WHERE id = ?
    `).run(assessedOn, expiryFor(assessedOn), new Date().toISOString(), assessment.id);
    syncMemberVocCerts(db, assessment.member_id);
  })();
  if (assessment.pdf_file) fs.rmSync(pdfPath(db, assessment), { force: true });
  return { status: 200, assessment: getAssessment(db, assessment.id) };
}

export function deleteAssessment(db, assessment) {
  db.transaction(() => {
    db.prepare('DELETE FROM voc_assessments WHERE id = ?').run(assessment.id);
    syncMemberVocCerts(db, assessment.member_id);
  })();
  if (assessment.pdf_file) fs.rmSync(pdfPath(db, assessment), { force: true });
}

export function getAssessment(db, id) {
  return db.prepare('SELECT * FROM voc_assessments WHERE id = ?').get(id) || null;
}

export function listAssessments(db, memberId) {
  return db.prepare(
    'SELECT * FROM voc_assessments WHERE member_id = ? ORDER BY assessed_on DESC, number DESC'
  ).all(memberId).map(summarise);
}

// What the VOC drawer lists: one line per certificate.
export function summarise(row) {
  const categories = JSON.parse(row.categories_json);
  const results = JSON.parse(row.results_json);
  return {
    id: row.id,
    number: row.number,
    cert_number: certNumber(row.number),
    member_id: row.member_id,
    assessed_on: row.assessed_on,
    expires_on: row.expires_on,
    assessor_name: row.assessor_name,
    comments: row.comments,
    results: results.map((r) => ({
      key: r.key,
      title: categories.find((c) => c.key === r.key)?.title || r.key,
      equipment: r.equipment,
      outcome: r.outcome,
    })),
  };
}

// The "VOC – …" certificate rows for one person, re-derived from their
// assessments: each category's expiry is the latest one where they were
// found competent; a category with none is removed.
export function syncMemberVocCerts(db, memberId) {
  const latest = new Map();
  for (const row of db.prepare('SELECT results_json, expires_on FROM voc_assessments WHERE member_id = ?').all(memberId)) {
    for (const r of JSON.parse(row.results_json)) {
      if (r.outcome !== 'competent') continue;
      if (!latest.has(r.key) || row.expires_on > latest.get(r.key)) latest.set(r.key, row.expires_on);
    }
  }
  const typeExists = db.prepare('SELECT 1 FROM cert_types WHERE id = ?');
  const del = db.prepare('DELETE FROM member_certs WHERE member_id = ? AND cert_type_id = ?');
  const put = db.prepare(`
    INSERT INTO member_certs (member_id, cert_type_id, expiry_date, no_expiry) VALUES (?, ?, ?, 0)
    ON CONFLICT (member_id, cert_type_id) DO UPDATE SET expiry_date = excluded.expiry_date, no_expiry = 0
  `);
  for (const c of VOC_CATEGORIES) {
    const typeId = vocCertTypeId(c.key);
    if (!typeExists.get(typeId)) continue;
    if (latest.has(c.key)) put.run(memberId, typeId, latest.get(c.key));
    else del.run(memberId, typeId);
  }
}

// ── Equipment pick-list ──

// Models entered on an assessment are added to the list for next time.
export function rememberEquipment(db, results) {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO voc_equipment (id, category_key, name, created_at) VALUES (?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  for (const r of results) for (const name of r.equipment) ins.run(crypto.randomUUID(), r.key, name, now);
}

export function equipmentList(db) {
  const out = Object.fromEntries(VOC_CATEGORIES.map((c) => [c.key, []]));
  for (const row of db.prepare('SELECT id, category_key, name FROM voc_equipment ORDER BY name COLLATE NOCASE').all()) {
    (out[row.category_key] ||= []).push({ id: row.id, name: row.name });
  }
  return out;
}

export function addEquipment(db, categoryKey, rawName) {
  if (!getCategory(categoryKey)) return { status: 400, error: 'Unknown competency category' };
  const name = str(rawName).replace(/\s+/g, ' ');
  if (!name) return { status: 400, error: 'name is required' };
  if (name.length > MAX_EQUIPMENT_NAME) return { status: 400, error: `Names must be ${MAX_EQUIPMENT_NAME} characters or fewer` };
  const existing = db.prepare(
    'SELECT id, name FROM voc_equipment WHERE category_key = ? AND name = ? COLLATE NOCASE'
  ).get(categoryKey, name);
  if (existing) return { status: 200, item: existing };
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO voc_equipment (id, category_key, name, created_at) VALUES (?, ?, ?, ?)')
    .run(id, categoryKey, name, new Date().toISOString());
  return { status: 201, item: { id, name } };
}

// ── Certificate PDF ──

// Bump when the certificate layout changes so stored ones are rebuilt.
const PDF_LAYOUT = 1;
const pdfFileFor = (row) => `${row.id}-v${PDF_LAYOUT}.pdf`;

export async function ensureCertificatePdf(db, row, { logoPath } = {}) {
  if (row.pdf_file === pdfFileFor(row) && fs.existsSync(pdfPath(db, row))) return pdfPath(db, row);
  if (row.pdf_file) fs.rmSync(pdfPath(db, row), { force: true });
  const buf = await buildVocPdf({
    assessment: row,
    categories: JSON.parse(row.categories_json),
    results: JSON.parse(row.results_json),
    logoPath,
  });
  const file = pdfFileFor(row);
  fs.mkdirSync(vocsDir(db), { recursive: true });
  fs.writeFileSync(path.join(vocsDir(db), file), buf);
  db.prepare('UPDATE voc_assessments SET pdf_file = ? WHERE id = ?').run(file, row.id);
  row.pdf_file = file;
  return pdfPath(db, row);
}

// "AUAV_VOC_Sam-Jones_VOC-0007_2026-10-27.pdf"
export function certificateFilename(row) {
  const part = (s) => str(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${['AUAV_VOC', part(row.member_name), certNumber(row.number), row.assessed_on].filter(Boolean).join('_')}.pdf`;
}
