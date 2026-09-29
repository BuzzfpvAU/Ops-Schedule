import React, { useEffect, useMemo, useRef, useState } from 'react';
import { STATES, createJob } from '../api.js';

// ── New project ─────────────────────────────────────────────────────────
//
// Just enough to put a project on the timeline. Crew, kit and everything
// else go on the job card, which opens as soon as the project is created.

const COLOURS = ['#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#64748b'];

export default function NewProjectDialog({ jobs, myState, onClose, onCreated, showToast }) {
  const [form, setForm] = useState({
    code: '', name: '', job_number: '', client: '',
    state: STATES.includes(myState) ? myState : '',
    planned_start: '', planned_end: '', crew_size: 1,
    color: COLOURS[(jobs?.length || 0) % COLOURS.length],
  });
  const [busy, setBusy] = useState(false);
  const first = useRef(null);

  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const codeTaken = useMemo(() => {
    const c = form.code.trim().toLowerCase();
    return !!c && (jobs || []).some((j) => (j.code || '').toLowerCase() === c);
  }, [form.code, jobs]);

  const datesBad = form.planned_start && form.planned_end && form.planned_end < form.planned_start;
  const ready = form.code.trim() && form.name.trim() && !codeTaken && !datesBad;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const job = await createJob({
        ...form,
        code: form.code.trim(),
        name: form.name.trim(),
        // A start with no end is a one-day project until the card says otherwise.
        planned_end: form.planned_end || form.planned_start,
      });
      onCreated(job);
    } catch (err) {
      showToast?.(err.message, 'error');
      setBusy(false);
    }
  };

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <form className="picker np" role="dialog" aria-label="New project" onSubmit={submit}>
        <header className="picker-head">
          <div className="drawer-title">New project</div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="np-body">
          <label className="np-field">
            <span>Code *</span>
            <input ref={first} value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="e.g. KAL-0143" />
            {codeTaken && <em className="np-err">Already used by another project</em>}
          </label>
          <label className="np-field">
            <span>Job number</span>
            <input value={form.job_number} onChange={(e) => set('job_number', e.target.value)} placeholder="e.g. TE-12001" />
          </label>
          <label className="np-field np-wide">
            <span>Name *</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Kalgoorlie Phase 2" />
          </label>
          <label className="np-field">
            <span>Client</span>
            <input value={form.client} onChange={(e) => set('client', e.target.value)} />
          </label>
          <label className="np-field">
            <span>State</span>
            <select value={form.state} onChange={(e) => set('state', e.target.value)}>
              <option value="">No state</option>
              {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="np-field">
            <span>Planned start</span>
            <input type="date" value={form.planned_start} onChange={(e) => set('planned_start', e.target.value)} />
          </label>
          <label className="np-field">
            <span>Planned end</span>
            <input type="date" value={form.planned_end} min={form.planned_start || undefined}
              onChange={(e) => set('planned_end', e.target.value)} />
            {datesBad && <em className="np-err">Ends before it starts</em>}
          </label>
          <label className="np-field">
            <span>Crew needed</span>
            <input type="number" min="1" value={form.crew_size}
              onChange={(e) => set('crew_size', Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <div className="np-field">
            <span>Colour</span>
            <div className="np-colours">
              {COLOURS.map((c) => (
                <button
                  key={c} type="button"
                  className={`np-swatch${form.color === c ? ' is-on' : ''}`}
                  style={{ background: c }}
                  onClick={() => set('color', c)}
                  aria-label={`Colour ${c}`}
                  aria-pressed={form.color === c}
                />
              ))}
            </div>
          </div>
        </div>

        <footer className="picker-foot">
          <span className="rl-sub">Crew and equipment are added on the job card next.</span>
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </footer>
      </form>
    </>
  );
}
