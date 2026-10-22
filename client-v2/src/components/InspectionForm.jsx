import React, { useEffect, useRef, useState } from 'react';
import { Drawer, Section } from './ui.jsx';
import { uploadInspectionPhoto, deleteInspectionPhoto, submitInspection } from '../api.js';
import { blankAnswers, formProblems, defectCount, submission, shrinkPhoto } from '../lib/inspection.js';

// ── Inspection webform ──────────────────────────────────────────────
// Fills in one inspection of an equipment item. The questions come from
// the template for the item's category (switchable); each area asks
// "Defects observed?" and a Yes opens a notes box that must be filled.
// Photos upload as they are added, so a slow connection is spread over
// the inspection rather than all at the end.

let tempSeq = 0;

export default function InspectionForm({ item, templates, initialTemplate, onClose, onSubmitted, showToast }) {
  const [template, setTemplate] = useState(initialTemplate);
  const [details, setDetails] = useState({});
  const [answers, setAnswers] = useState(() => blankAnswers(initialTemplate));
  const [comments, setComments] = useState('');
  const [markUnserviceable, setMarkUnserviceable] = useState(true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const previews = useRef([]);

  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const problems = formProblems(template, details, answers);
  const defects = defectCount(template, answers);
  const touched = Object.values(answers).some((a) => a.defects || a.photos.length) || comments.trim();

  const setArea = (key, patch) => setAnswers((all) => ({ ...all, [key]: { ...all[key], ...patch } }));
  const updatePhoto = (key, tempId, patch) => setAnswers((all) => ({
    ...all,
    [key]: { ...all[key], photos: all[key].photos.map((p) => (p.tempId === tempId ? { ...p, ...patch } : p)) },
  }));

  const addPhotos = async (key, files) => {
    for (const file of files) {
      const tempId = ++tempSeq;
      const preview = URL.createObjectURL(file);
      previews.current.push(preview);
      setAnswers((all) => ({
        ...all, [key]: { ...all[key], photos: [...all[key].photos, { tempId, preview, uploading: true }] },
      }));
      try {
        const blob = await shrinkPhoto(file);
        const { id } = await uploadInspectionPhoto(blob);
        updatePhoto(key, tempId, { id, uploading: false });
      } catch (e) {
        showToast?.(e.message || 'Photo upload failed', 'error');
        setAnswers((all) => ({
          ...all, [key]: { ...all[key], photos: all[key].photos.filter((p) => p.tempId !== tempId) },
        }));
      }
    }
  };

  const removePhoto = (key, photo) => {
    setAnswers((all) => ({
      ...all, [key]: { ...all[key], photos: all[key].photos.filter((p) => p.tempId !== photo.tempId) },
    }));
    if (photo.id) deleteInspectionPhoto(photo.id).catch(() => {});
  };

  const switchTemplate = (id) => {
    const next = templates.templates.find((t) => t.id === id);
    if (!next || next.id === template.id) return;
    if (touched && !window.confirm('Switching forms clears the answers and photos so far. Switch?')) return;
    Object.values(answers).flatMap((a) => a.photos).forEach((p) => p.id && deleteInspectionPhoto(p.id).catch(() => {}));
    setTemplate(next);
    setDetails({});
    setAnswers(blankAnswers(next));
    setTried(false);
  };

  const close = () => {
    if (touched && !window.confirm('Discard this inspection?')) return;
    Object.values(answers).flatMap((a) => a.photos).forEach((p) => p.id && deleteInspectionPhoto(p.id).catch(() => {}));
    onClose();
  };

  const submit = async () => {
    setTried(true);
    if (problems.count) {
      showToast?.(`${problems.count} question${problems.count === 1 ? '' : 's'} still need${problems.count === 1 ? 's' : ''} an answer`, 'error');
      document.querySelector('.insp-area.is-invalid, .form-row.is-invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setBusy(true);
    try {
      const saved = await submitInspection(submission({ item, template, details, answers, comments, markUnserviceable }));
      onSubmitted?.(saved);
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const detailField = (f) => {
    const value = details[f.key] ?? '';
    const set = (v) => setDetails((d) => ({ ...d, [f.key]: v }));
    const invalid = tried && problems.details[f.key];
    return (
      <label className={`form-row${invalid ? ' is-invalid' : ''}`} key={f.key}>
        <span className="form-label">{f.label}{f.required ? ' *' : ''}</span>
        {f.type === 'choice' ? (
          <select value={value} onChange={(e) => set(e.target.value)}>
            <option value="">Choose…</option>
            {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input
            type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
            inputMode={f.type === 'number' ? 'decimal' : undefined}
            value={value}
            placeholder={f.placeholder}
            onChange={(e) => set(e.target.value)}
          />
        )}
      </label>
    );
  };

  return (
    <Drawer
      title={template.title}
      subtitle={[item.name, item.serial_number].filter(Boolean).join(' · ')}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit inspection'}
          </button>
        </>
      }
    >
      <fieldset className="form-set" disabled={busy}>
        <Section title="Form">
          <label className="form-row">
            <span className="form-label">Inspection form</span>
            <select value={template.id} onChange={(e) => switchTemplate(e.target.value)}>
              {templates.templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </label>
          {template.details.map(detailField)}
        </Section>

        <Section title={`Checklist · ${template.areas.length} areas`}>
          {template.areas.map((a, i) => {
            const ans = answers[a.key];
            const invalid = tried && problems.areas[a.key];
            const ready = ans.photos.filter((p) => p.id).length;
            return (
              <div key={a.key} className={`insp-area${invalid ? ' is-invalid' : ''}${ans.defects === 'yes' ? ' has-defect' : ''}`}>
                <div className="insp-area-head">
                  <span className="insp-num">{i + 1}</span>
                  <span className="insp-label">{a.label}</span>
                </div>

                <div className="insp-row">
                  <span className="insp-q">Defects observed?</span>
                  <div className="insp-yn" role="radiogroup" aria-label={`Defects observed: ${a.label}`}>
                    {['no', 'yes'].map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={ans.defects === v}
                        className={`insp-yn-btn${ans.defects === v ? ` on-${v}` : ''}`}
                        onClick={() => setArea(a.key, { defects: v })}
                      >
                        {v === 'yes' ? 'Yes' : 'No'}
                      </button>
                    ))}
                  </div>
                </div>

                {ans.defects === 'yes' && (
                  <textarea
                    className="note-input insp-notes"
                    rows={3}
                    autoFocus
                    value={ans.notes}
                    onChange={(e) => setArea(a.key, { notes: e.target.value })}
                    placeholder="Describe the defect: what, where, how bad, and any action taken"
                  />
                )}

                <div className="insp-photos">
                  {ans.photos.map((p) => (
                    <div key={p.tempId} className={`insp-thumb${p.uploading ? ' is-uploading' : ''}`}>
                      <img src={p.preview} alt="" />
                      {p.uploading
                        ? <span className="insp-thumb-busy">Uploading…</span>
                        : (
                          <button type="button" className="insp-thumb-x" aria-label="Remove photo" onClick={() => removePhoto(a.key, p)}>
                            ✕
                          </button>
                        )}
                    </div>
                  ))}
                  <label className="insp-add">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) => { addPhotos(a.key, [...e.target.files]); e.target.value = ''; }}
                    />
                    + Photo
                  </label>
                  <span className="insp-count">
                    {a.photos ? `${ready} / ${a.photos} requested` : ready ? `${ready} added` : 'optional'}
                  </span>
                </div>

                {invalid && <div className="insp-error">{problems.areas[a.key]}</div>}
              </div>
            );
          })}
        </Section>

        <Section title="Comments">
          <textarea
            className="note-input"
            rows={3}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Anything else worth recording (optional)"
          />
        </Section>

        {defects > 0 && (
          <Section title="Result">
            <div className="banner banner-danger" style={{ marginBottom: 8 }}>
              {defects} area{defects === 1 ? '' : 's'} with defects.
            </div>
            <div className="opt-list">
              <label className="opt" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={markUnserviceable}
                  onChange={(e) => setMarkUnserviceable(e.target.checked)}
                />
                <span className="opt-name">Mark {item.name} unserviceable</span>
                <span className="opt-hint">until an admin releases it</span>
              </label>
            </div>
          </Section>
        )}
      </fieldset>
    </Drawer>
  );
}
