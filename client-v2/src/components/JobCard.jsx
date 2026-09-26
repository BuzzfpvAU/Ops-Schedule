import React, { useEffect, useMemo, useState } from 'react';
import { Section } from './ui.jsx';
import EquipmentPicker, { PadInput } from './EquipmentPicker.jsx';
import {
  JOB_STATUSES, STATES, EQUIPMENT_CATEGORIES,
  updateJob, getJobReadiness, setJobStatus,
  addChecklistItem, updateChecklistItem, deleteChecklistItem, applyChecklistTemplate,
  removeJobEquipment, setJobEquipmentPads, confirmJobKit, getKits, applyKitToJob,
  bulkAssignSchedule, clearMemberDay,
} from '../api.js';
import { rangeOf, fmtShort } from '../lib/dates.js';

// ── Job card ────────────────────────────────────────────────────────────
//
// The editable half of a project: its details, the readiness gates that decide
// whether it can advance, the checklist, and who and what is on it.
//
// Assigning books the job's planned window in one go and leaves trimming to the
// timeline, which is the tool that is actually good at dates. A job with no
// planned window cannot be booked against, so the card says so rather than
// silently assigning nothing.

const CHECKLIST_CATEGORIES = [
  ['accommodation', 'Accommodation'],
  ['flights', 'Flights'],
  ['vehicles', 'Vehicles'],
  ['equipment', 'Equipment'],
  ['admin', 'Admin / Compliance'],
  ['other', 'Other'],
];

const STATUS_FLOW = ['planning', 'confirmed', 'active', 'complete'];

const GATE_TONE = { pass: 'ok', warn: 'warn', fail: 'danger' };

function Field({ label, children }) {
  return (
    <label className="form-row">
      <span className="form-label">{label}</span>
      {children}
    </label>
  );
}

export default function JobCard({ jobId, card, readiness, members, equipment, isAdmin, onChanged, showToast }) {
  const job = card?.job;
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState({});
  const [crewPick, setCrewPick] = useState('');
  const [kitPick, setKitPick] = useState('');
  const [kits, setKits] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Ticks show immediately and are reconciled when the reload lands. Without
  // this the box is purely controlled, so it snaps back for the second or two
  // the round trip takes and a quick second click silently undoes the first.
  const [pendingDone, setPendingDone] = useState({});

  useEffect(() => {
    if (!job) return;
    setForm({
      code: job.code || '',
      name: job.name || '',
      client: job.client || '',
      description: job.description || '',
      job_number: job.job_number || '',
      state: job.state || '',
      crew_size: job.crew_size || 1,
      planned_start: job.planned_start || '',
      planned_end: job.planned_end || '',
      lead_id: job.lead_id || '',
      site_address: job.site_address || '',
      site_contact: job.site_contact || '',
      sharepoint_url: job.sharepoint_url || '',
      notes: job.notes || '',
    });
    setDirty(false);
  }, [job?.id, job?.updated_at]);

  useEffect(() => { getKits().then(setKits).catch(() => setKits([])); }, []);

  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setDirty(true); };

  const plannedDays = useMemo(() => {
    if (!form?.planned_start || !form?.planned_end) return [];
    if (form.planned_end < form.planned_start) return [];
    return rangeOf(form.planned_start, form.planned_end);
  }, [form?.planned_start, form?.planned_end]);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await updateJob(jobId, form);
      setDirty(false);
      await onChanged?.();
      // New dates move the crew and kit bookings too; say so, and name
      // anyone who now overlaps another job, since the move goes ahead anyway.
      const moved = saved?.rebooked;
      if (moved?.clashes?.length) {
        const list = moved.clashes.map((c) => `${c.name} (${c.job_code})`).join(', ');
        showToast?.(`Bookings moved — now clashing: ${list}`, 'error');
      } else if (moved) {
        showToast?.(`Job saved — ${moved.members} booking${moved.members === 1 ? '' : 's'} moved to the new dates`, 'success');
      } else {
        showToast?.('Job saved', 'success');
      }
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // A refused transition comes back as a 409 listing the gates that failed, so
  // the message says what is blocking rather than just that it failed.
  const moveTo = async (status) => {
    setBusy(true);
    try {
      await setJobStatus(jobId, status);
      await onChanged?.();
      showToast?.(`Now ${status}`, 'success');
    } catch (e) {
      const reason = window.prompt(
        `Cannot move to ${status}:\n\n${e.message}\n\nEnter a reason to override, or cancel.`
      );
      if (!reason) { setBusy(false); return; }
      try {
        await setJobStatus(jobId, status, reason);
        await onChanged?.();
        showToast?.(`Now ${status} (overridden)`, 'success');
      } catch (e2) {
        showToast?.(e2.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      await onChanged?.();
      if (okMsg) showToast?.(okMsg, 'success');
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleItem = async (item, next) => {
    setPendingDone((p) => ({ ...p, [item.id]: next }));
    try {
      await updateChecklistItem(item.id, { done: next });
      await onChanged?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      // Drop the optimistic value either way: on success the reloaded item
      // already carries it, and on failure the real state should win.
      setPendingDone((p) => {
        const next = { ...p };
        delete next[item.id];
        return next;
      });
    }
  };

  const assignCrew = () => {
    if (!crewPick) return;
    if (!plannedDays.length) {
      showToast?.('Set a planned start and end before assigning crew', 'error');
      return;
    }
    const member = members.find((m) => m.id === crewPick);
    act(
      () => bulkAssignSchedule({ team_member_id: crewPick, job_id: jobId, dates: plannedDays, status: 'tentative' }),
      `${member?.name || 'Crew'} booked for ${plannedDays.length} days`
    ).then(() => setCrewPick(''));
  };

  const removeCrew = async (person) => {
    if (!window.confirm(`Remove ${person.name} from this job? Their ${person.days} booked day${person.days === 1 ? '' : 's'} will be cleared.`)) return;
    setBusy(true);
    try {
      // No bulk delete exists, so clear the member's days across the booking.
      for (const date of rangeOf(person.from_date, person.to_date)) {
        await clearMemberDay(person.id, date).catch(() => {});
      }
      await onChanged?.();
      showToast?.(`${person.name} removed`, 'success');
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const assignedIds = useMemo(
    () => new Set((card?.equipment || []).map((e) => e.equipment_id)),
    [card]
  );

  // What kit gets booked around: the saved planned dates, else the crew's
  // span — the same rule the server uses.
  const kitWindow = useMemo(() => {
    if (job?.planned_start && job?.planned_end && job.planned_end >= job.planned_start) {
      return { from: job.planned_start, to: job.planned_end };
    }
    const spans = (card?.crew || []).filter((c) => c.from_date);
    if (!spans.length) return null;
    return {
      from: spans.reduce((m, c) => (c.from_date < m ? c.from_date : m), spans[0].from_date),
      to: spans.reduce((m, c) => (c.to_date > m ? c.to_date : m), spans[0].to_date),
    };
  }, [job?.planned_start, job?.planned_end, card]);

  const changePads = (k, pads) => act(async () => {
    const r = await setJobEquipmentPads(k.id, pads);
    if (r?.conflicts?.length) {
      showToast?.(`${k.equipment_name} now clashes with ${r.conflicts.map((c) => c.code).join(', ')}`, 'error');
    }
  });

  if (!job || !form) return <div className="loading-screen">Loading job…</div>;

  const gates = readiness?.gates ? Object.values(readiness.gates) : [];
  const crew = card.crew || [];
  const kit = card.equipment || [];
  const checklist = card.checklist || [];
  const people = (members || []).filter((m) => !crew.some((c) => c.id === m.id));

  return (
    <div className="jobcard">
      {/* ── Workflow ── */}
      <Section title="Workflow">
        <div className="wf">
          {STATUS_FLOW.map((s) => {
            const here = job.status === s;
            const passed = STATUS_FLOW.indexOf(job.status) > STATUS_FLOW.indexOf(s);
            return (
              <button
                key={s}
                className={`wf-step${here ? ' is-here' : ''}${passed ? ' is-past' : ''}`}
                disabled={!isAdmin || busy || here}
                onClick={() => moveTo(s)}
                title={here ? 'Current status' : `Move to ${s}`}
              >
                {passed ? '✓ ' : ''}{JOB_STATUSES[s]?.label || s}
              </button>
            );
          })}
          {job.status !== 'cancelled' && isAdmin && (
            <button className="wf-step wf-cancel" disabled={busy} onClick={() => moveTo('cancelled')}>
              Cancel job
            </button>
          )}
        </div>

        {readiness && (
          <div className="gates">
            {gates.map((g) => (
              <details key={g.key} className={`gate is-${GATE_TONE[g.status] || 'mute'}`} open={g.status === 'fail'}>
                <summary>
                  <span className={`tag tag-${GATE_TONE[g.status] || 'mute'}`}>
                    {g.status === 'pass' ? '✓' : g.status === 'warn' ? '!' : '✗'}
                  </span>
                  <span className="gate-title">{g.title}</span>
                  {g.advisory && <span className="rl-sub">advisory</span>}
                </summary>
                <ul className="gate-checks">
                  {g.checks.map((c, i) => (
                    <li key={i} className={c.ok ? 'is-ok' : 'is-bad'}>
                      <strong>{c.label}</strong>
                      {c.note ? ` — ${c.note}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
      </Section>

      {/* ── Details ── */}
      <Section title="Details">
        <fieldset className="form-set" disabled={!isAdmin || busy}>
          <Field label="Code"><input value={form.code} onChange={(e) => set('code', e.target.value)} /></Field>
          <Field label="Name"><input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Client"><input value={form.client} onChange={(e) => set('client', e.target.value)} /></Field>
          <Field label="Job number"><input value={form.job_number} onChange={(e) => set('job_number', e.target.value)} /></Field>
          <Field label="Description">
            <input value={form.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <Field label="Lead">
            <select value={form.lead_id} onChange={(e) => set('lead_id', e.target.value)}>
              <option value="">No lead</option>
              {(members || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="State">
            <select
              value={form.state}
              onChange={(e) => set('state', e.target.value)}
              disabled={!isAdmin || busy || !!form.lead_id}
              title={form.lead_id ? 'Follows the lead’s base location' : undefined}
            >
              <option value="">No state</option>
              {STATES.map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
          </Field>
          <Field label="Crew needed">
            <input
              type="number" min="1"
              value={form.crew_size}
              onChange={(e) => set('crew_size', Number(e.target.value) || 1)}
            />
          </Field>
          <Field label="Planned start">
            <input type="date" value={form.planned_start} onChange={(e) => set('planned_start', e.target.value)} />
          </Field>
          <Field label="Planned end">
            <input type="date" value={form.planned_end} onChange={(e) => set('planned_end', e.target.value)} />
          </Field>
          <Field label="Site address"><input value={form.site_address} onChange={(e) => set('site_address', e.target.value)} /></Field>
          <Field label="Site contact"><input value={form.site_contact} onChange={(e) => set('site_contact', e.target.value)} /></Field>
          <Field label="SharePoint"><input type="url" value={form.sharepoint_url} onChange={(e) => set('sharepoint_url', e.target.value)} /></Field>
          <Field label="Notes">
            <textarea className="note-input" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
        </fieldset>

        {form.lead_id && (
          <div className="rl-sub" style={{ marginTop: 4 }}>
            State follows the lead’s base location, so it is set for you.
          </div>
        )}

        {isAdmin && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            {dirty && <span className="rl-sub">Unsaved changes</span>}
          </div>
        )}
      </Section>

      {/* ── Crew ── */}
      <Section title={`Crew (${crew.length} of ${job.crew_size || 1})`}>
        {crew.length === 0 && <div className="rl-sub">Nobody booked yet.</div>}
        {crew.map((c) => (
          <div className="entry-row" key={c.id}>
            <span className="opt-dot" style={{ background: c.color || '#475569' }} />
            <span className="entry-name">{c.name}</span>
            <span className="rl-sub">{fmtShort(c.from_date)}–{fmtShort(c.to_date)} · {c.days}d</span>
            {(c.compliance || []).some((x) => x.status === 'expired') && (
              <span className="tag tag-danger" title="Has an expired credential">compliance</span>
            )}
            {isAdmin && (
              <button className="btn btn-danger" disabled={busy} onClick={() => removeCrew(c)}>Remove</button>
            )}
          </div>
        ))}

        {isAdmin && (
          <div className="assign-row">
            <select value={crewPick} onChange={(e) => setCrewPick(e.target.value)}>
              <option value="">Add someone…</option>
              {people.map((m) => (
                <option key={m.id} value={m.id}>{m.name}{m.location ? ` · ${m.location}` : ''}</option>
              ))}
            </select>
            <button className="btn btn-primary" disabled={!crewPick || busy} onClick={assignCrew}>Assign</button>
            <span className="rl-sub">
              {plannedDays.length
                ? `books ${plannedDays.length} day${plannedDays.length === 1 ? '' : 's'} (${fmtShort(form.planned_start)}–${fmtShort(form.planned_end)})`
                : 'set a planned window first'}
            </span>
          </div>
        )}
      </Section>

      {/* ── Equipment ── */}
      <Section title={`Equipment (${kit.length})`}>
        {kit.length === 0 && <div className="rl-sub">No kit assigned.</div>}
        {kit.map((k) => (
          <div className="entry-row" key={k.id}>
            <span className="entry-name">{k.equipment_name}</span>
            <span className="rl-sub">{k.category}</span>
            <span className="rl-sub">
              {k.booked_from ? `${fmtShort(k.booked_from)}–${fmtShort(k.booked_to)}` : 'not booked'}
            </span>
            {isAdmin ? (
              <span className="kit-pads" title="Transit buffer either side of the job">
                <PadInput label="before" value={k.pad_before || 0} disabled={busy}
                  onChange={(v) => changePads(k, { pad_before: v })} />
                <PadInput label="after" value={k.pad_after || 0} disabled={busy}
                  onChange={(v) => changePads(k, { pad_after: v })} />
              </span>
            ) : (
              <span className="rl-sub">transit {k.pad_before || 0}d / {k.pad_after || 0}d</span>
            )}
            {(k.conflicts || []).length > 0 && (
              <span className="tag tag-danger" title={k.conflicts.map((c) => c.code).join(', ')}>clash</span>
            )}
            <span className={`tag ${k.status === 'confirmed' ? 'tag-ok' : 'tag-mute'}`}>{k.status || 'tentative'}</span>
            {isAdmin && (
              <button className="btn btn-danger" disabled={busy}
                onClick={() => act(() => removeJobEquipment(k.id), `${k.equipment_name} removed`)}>
                Remove
              </button>
            )}
          </div>
        ))}

        {isAdmin && (
          <>
            <div className="assign-row">
              <select value={kitPick} onChange={(e) => setKitPick(e.target.value)}>
                <option value="">Apply a kit…</option>
                {kits.map((k) => <option key={k.id} value={k.id}>{k.name} ({k.item_count})</option>)}
              </select>
              <button
                className="btn"
                disabled={!kitPick || busy}
                onClick={() => act(() => applyKitToJob(jobId, kitPick), 'Kit applied').then(() => setKitPick(''))}
              >
                Apply kit
              </button>
              <button
                className="btn"
                disabled={busy || kit.length === 0}
                onClick={() => act(() => confirmJobKit(jobId), 'Kit confirmed')}
              >
                Confirm all
              </button>
            </div>

            <button className="btn btn-primary kit-add" disabled={busy} onClick={() => setPickerOpen(true)}>
              + Add equipment…
            </button>
            {pickerOpen && (
              <EquipmentPicker
                jobId={jobId}
                window={kitWindow}
                equipment={equipment}
                assignedIds={assignedIds}
                onClose={() => setPickerOpen(false)}
                onAdded={onChanged}
                showToast={showToast}
              />
            )}
          </>
        )}
      </Section>

      {/* ── Checklist ── */}
      <Section title={`Checklist (${checklist.filter((i) => i.done).length}/${checklist.length})`}>
        {checklist.length === 0 && isAdmin && (
          <button className="btn" disabled={busy}
            onClick={() => act(() => applyChecklistTemplate(jobId), 'Standard checklist added')}>
            Add the standard checklist
          </button>
        )}

        {CHECKLIST_CATEGORIES.map(([key, label]) => {
          const items = checklist.filter((i) => i.category === key);
          if (!items.length && !isAdmin) return null;
          return (
            <div className="cl-group" key={key}>
              <div className="cl-head">{label}</div>
              {items.map((i) => {
                const done = pendingDone[i.id] ?? !!i.done;
                return (
                <div className={`cl-item${done ? ' is-done' : ''}`} key={i.id}>
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={!isAdmin}
                    onChange={(e) => toggleItem(i, e.target.checked)}
                  />
                  <span className="cl-label">{i.label}</span>
                  {i.required === 1 && <span className="tag tag-warn" title="Blocks a status change">required</span>}
                  {i.stage && <span className="rl-sub">{i.stage}</span>}
                  {isAdmin && (
                    <button className="cl-del" disabled={busy}
                      onClick={() => act(() => deleteChecklistItem(i.id))} title="Delete">✕</button>
                  )}
                </div>
                );
              })}
              {isAdmin && (
                <input
                  className="cl-add"
                  placeholder={`Add to ${label.toLowerCase()}…`}
                  value={newItem[key] || ''}
                  onChange={(e) => setNewItem((n) => ({ ...n, [key]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || !e.target.value.trim()) return;
                    const text = e.target.value.trim();
                    setNewItem((n) => ({ ...n, [key]: '' }));
                    act(() => addChecklistItem(jobId, { label: text, category: key }));
                  }}
                />
              )}
            </div>
          );
        })}
      </Section>
    </div>
  );
}
