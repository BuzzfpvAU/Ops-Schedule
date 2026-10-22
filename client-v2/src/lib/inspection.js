// ── Inspection webform helpers ──────────────────────────────────────
// Pure functions behind InspectionForm, kept here so they can be tested
// without a browser. The server repeats every check; these only let the
// form point at what is missing before anything is sent.

export function templateFor(templates, category) {
  const id = templates.byCategory?.[category] || templates.fallback;
  return templates.templates.find((t) => t.id === id) || templates.templates[0];
}

// A blank form for a template: no answers yet, no photos.
export function blankAnswers(template) {
  return Object.fromEntries(template.areas.map((a) => [a.key, { defects: '', notes: '', photos: [] }]));
}

// What still stops the form being sent, keyed so each area can show its
// own message. `details` and `areas` hold the per-field problems.
export function formProblems(template, details, answers) {
  const problems = { details: {}, areas: {}, count: 0 };
  const add = (bucket, key, msg) => {
    problems[bucket][key] = msg;
    problems.count += 1;
  };
  for (const f of template.details) {
    if (f.required && !String(details[f.key] ?? '').trim()) add('details', f.key, 'Required');
  }
  for (const a of template.areas) {
    const ans = answers[a.key] || {};
    const ready = (ans.photos || []).filter((p) => p.id);
    if ((ans.photos || []).some((p) => p.uploading)) add('areas', a.key, 'Wait for photos to finish uploading');
    else if (!ans.defects) add('areas', a.key, 'Answer whether defects were observed');
    else if (ans.defects === 'yes' && !String(ans.notes || '').trim()) add('areas', a.key, 'Describe the defect');
    else if (a.photos > 0 && !ready.length) add('areas', a.key, 'Add at least one photo');
  }
  return problems;
}

export const defectCount = (template, answers) =>
  template.areas.filter((a) => answers[a.key]?.defects === 'yes').length;

// The body POSTed to /api/inspections.
export function submission({ item, template, details, answers, comments, markUnserviceable }) {
  return {
    equipment_id: item.id,
    template_id: template.id,
    details,
    answers: Object.fromEntries(template.areas.map((a) => {
      const ans = answers[a.key];
      return [a.key, {
        defects: ans.defects,
        notes: ans.defects === 'yes' ? ans.notes.trim() : '',
        photos: ans.photos.filter((p) => p.id).map((p) => p.id),
      }];
    })),
    comments: comments.trim(),
    mark_unserviceable: defectCount(template, answers) > 0 && markUnserviceable,
  };
}

// Phone photos are several MB; shrink them to a size that still shows
// damage clearly, as JPEG (which also turns HEIC and the like into
// something the PDF can embed).
export async function shrinkPhoto(file, { maxSide = 1600, quality = 0.82 } = {}) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not read ${file.name || 'this photo'}`));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error(`Could not read ${file.name || 'this photo'}`);
  return blob;
}
