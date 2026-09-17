import React, { useCallback, useEffect, useState } from 'react';
import {
  getJobCard, updateChecklistItem, addChecklistItem, deleteChecklistItem, applyChecklistTemplate,
  addJobFlight, updateJobFlight, deleteJobFlight,
  addJobAccommodation, updateJobAccommodation, deleteJobAccommodation,
  addJobRental, updateJobRental, deleteJobRental,
  assignJobEquipment, removeJobEquipment, updateJobEquipmentTransit, adjustEquipmentBooking,
  updateJob, downloadIcalJob, getJobCalendarToken, calendarFeedUrl, getEquipment,
  archiveJob, unarchiveJob,
} from '../api.js';

export const JOB_STATUSES = {
  planning: { label: 'Planning', color: '#eab308' },
  confirmed: { label: 'Confirmed', color: '#22c55e' },
  active: { label: 'Active', color: '#3b82f6' },
  complete: { label: 'Complete', color: '#94a3b8' },
  cancelled: { label: 'Cancelled', color: '#ef4444' },
};

// States/streams a job can be allocated to before (or instead of) rostering people
export const JOB_STATES = ['WA', 'VIC', 'QLD', 'NSW', 'NT', 'Processing'];

const CHECKLIST_CATEGORIES = [
  ['accommodation', 'Accommodation'],
  ['flights', 'Flights'],
  ['vehicles', 'Vehicles'],
  ['equipment', 'Equipment'],
  ['admin', 'Admin / Compliance'],
  ['other', 'Other'],
];

// ── Date helpers ───────────────────────────────────────────────

export function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return s;
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateShort(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return s;
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function fmtDateTime(s) {
  if (!s) return '';
  const [datePart, timePart] = s.split('T');
  const d = fmtDateShort(datePart);
  return timePart ? `${d} ${timePart}` : d;
}

function rosterDays(start, end) {
  if (!start || !end) return 0;
  const a = new Date(start + 'T00:00:00');
  const b = new Date(end + 'T00:00:00');
  return Math.round((b - a) / 86400000) + 1;
}

function personLabel(item, people) {
  if (item.person_id) {
    const m = people.find(p => p.id === item.person_id);
    if (m) return m.name;
  }
  return item.person_name || '';
}

function nameOf(people, id) {
  const m = (people || []).find(p => p.id === id);
  return m ? m.name : '';
}

// ── Small shared pieces ────────────────────────────────────────

function Section({ title, badge, action, children }) {
  return (
    <div className="jc-section">
      <div className="jc-section-head">
        <h4>{title}{badge != null && <span className="jc-badge">{badge}</span>}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

function PersonFields({ people, personId, personName, onChange }) {
  return (
    <div className="form-row">
      <div className="form-group">
        <label>Team member</label>
        <select value={personId || ''} onChange={(e) => onChange({ person_id: e.target.value, person_name: '' })}>
          <option value="">—</option>
          {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label>or name (non-member)</label>
        <input
          type="text"
          value={personName || ''}
          disabled={!!personId}
          placeholder="e.g. contractor"
          onChange={(e) => onChange({ person_name: e.target.value })}
        />
      </div>
    </div>
  );
}

// ── Checklist ──────────────────────────────────────────────────

function ChecklistSection({ job, items, people, isAdmin, canTick, reload, showToast }) {
  const [addCat, setAddCat] = useState(null);
  const [form, setForm] = useState({ label: '', due_date: '', assigned_to: '' });

  const toggle = async (item) => {
    try {
      await updateChecklistItem(item.id, { done: !item.done });
      reload();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const addItem = async (cat) => {
    if (!form.label.trim()) return;
    try {
      await addChecklistItem(job.id, { category: cat, label: form.label.trim(), due_date: form.due_date, assigned_to: form.assigned_to });
      setForm({ label: '', due_date: '', assigned_to: '' });
      setAddCat(null);
      reload();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const removeItem = async (item) => {
    if (!confirm(`Remove "${item.label}"?`)) return;
    try { await deleteChecklistItem(item.id); reload(); } catch (err) { showToast(err.message, 'error'); }
  };

  const applyTemplate = async () => {
    try {
      const r = await applyChecklistTemplate(job.id);
      showToast(r.added ? `${r.added} standard items added` : 'Standard checklist already applied', 'success');
      reload();
    } catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <Section
      title="Readiness checklist"
      badge={`${items.filter(i => i.done).length}/${items.length}`}
      action={isAdmin && (
        <button className="btn btn-sm" onClick={applyTemplate} title="Add the standard job-prep items">＋ Standard checklist</button>
      )}
    >
      {CHECKLIST_CATEGORIES.map(([key, label]) => {
        const group = items.filter(i => i.category === key);
        if (group.length === 0 && !isAdmin) return null;
        return (
          <div key={key} className="jc-check-group">
            <div className="jc-check-group-head">
              <span>{label}</span>
              {group.length > 0 && <span className="jc-check-count">{group.filter(i => i.done).length}/{group.length}</span>}
              {isAdmin && (
                <button className="jc-add-inline" onClick={() => { setAddCat(addCat === key ? null : key); setForm({ label: '', due_date: '', assigned_to: '' }); }}>
                  ＋ Add
                </button>
              )}
            </div>
            {group.map(item => (
              <div key={item.id} className={`jc-check-item ${item.done ? 'done' : ''}`}>
                <input
                  type="checkbox"
                  checked={!!item.done}
                  disabled={!canTick}
                  onChange={() => toggle(item)}
                />
                <div className="jc-check-body">
                  <span className="jc-check-label">{item.label}</span>
                  <span className="jc-check-meta">
                    {[
                      item.assigned_to ? `→ ${nameOf(people, item.assigned_to) || 'assigned'}` : '',
                      item.due_date ? `due ${fmtDateShort(item.due_date)}` : '',
                      item.done && item.done_by ? `✓ ${nameOf(people, item.done_by) || item.done_by_name || ''}` : '',
                    ].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {isAdmin && (
                  <button className="btn-icon jc-x" title="Remove" onClick={() => removeItem(item)}>✕</button>
                )}
              </div>
            ))}
            {isAdmin && addCat === key && (
              <div className="jc-inline-form">
                <input
                  type="text"
                  autoFocus
                  placeholder="Item…"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && addItem(key)}
                />
                <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} title="Due date" />
                <select value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} title="Assignee">
                  <option value="">Assignee…</option>
                  {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn btn-sm btn-primary" onClick={() => addItem(key)}>Add</button>
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

// ── Flights ────────────────────────────────────────────────────

function FlightForm({ initial, people, onSave, onCancel, saving }) {
  const [f, setF] = useState(initial);
  return (
    <div className="jc-inline-form jc-form-block">
      <PersonFields people={people} personId={f.person_id} personName={f.person_name}
        onChange={(v) => setF({ ...f, ...v })} />
      <div className="form-row">
        <div className="form-group">
          <label>Direction</label>
          <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
            <option value="out">Out</option>
            <option value="return">Return</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="form-group">
          <label>Airline</label>
          <input value={f.airline} placeholder="Qantas" onChange={(e) => setF({ ...f, airline: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Flight no.</label>
          <input value={f.flight_number} placeholder="QF1234" onChange={(e) => setF({ ...f, flight_number: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>From</label>
          <input value={f.depart_airport} placeholder="PER" onChange={(e) => setF({ ...f, depart_airport: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Departs</label>
          <input type="datetime-local" value={f.depart_at} onChange={(e) => setF({ ...f, depart_at: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>To</label>
          <input value={f.arrive_airport} placeholder="KTA" onChange={(e) => setF({ ...f, arrive_airport: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Arrives</label>
          <input type="datetime-local" value={f.arrive_at} onChange={(e) => setF({ ...f, arrive_at: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Booking ref</label>
          <input value={f.booking_ref} onChange={(e) => setF({ ...f, booking_ref: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Notes</label>
          <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </div>
      </div>
      <div className="jc-form-actions">
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => onSave(f)}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

const emptyFlight = { person_id: '', person_name: '', direction: 'out', airline: '', flight_number: '', depart_airport: '', depart_at: '', arrive_airport: '', arrive_at: '', booking_ref: '', notes: '' };

function FlightsSection({ job, items, people, isAdmin, reload, showToast }) {
  const [editing, setEditing] = useState(null); // null | {} (new) | item
  const [saving, setSaving] = useState(false);

  const save = async (f) => {
    setSaving(true);
    try {
      if (f.id) await updateJobFlight(f.id, f);
      else await addJobFlight(job.id, f);
      setEditing(null);
      reload();
    } catch (err) { showToast(err.message, 'error'); } finally { setSaving(false); }
  };
  const remove = async (f) => {
    if (!confirm('Remove this flight?')) return;
    try { await deleteJobFlight(f.id); reload(); } catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <Section
      title="✈️ Flights"
      badge={items.length || null}
      action={isAdmin && <button className="btn btn-sm" onClick={() => setEditing({ ...emptyFlight })}>＋ Add</button>}
    >
      {items.length === 0 && !editing && <div className="jc-empty">No flights yet{isAdmin ? ' — add the first one.' : '.'}</div>}
      {items.map(f => (
        <div key={f.id} className="jc-row">
          <div className="jc-row-main">
            <div className="jc-row-title">
              <span className={`jc-dir jc-dir-${f.direction}`}>{f.direction}</span>
              {personLabel(f, people) && <strong>{personLabel(f, people)}</strong>}
              <span>{[f.airline, f.flight_number].filter(Boolean).join(' ')}</span>
            </div>
            <div className="jc-row-meta">
              {[
                f.depart_airport || f.arrive_airport ? `${f.depart_airport || '?'} → ${f.arrive_airport || '?'}` : '',
                f.depart_at ? fmtDateTime(f.depart_at) : '',
                f.booking_ref ? `Ref ${f.booking_ref}` : '',
                f.notes || '',
              ].filter(Boolean).join(' · ')}
            </div>
          </div>
          {isAdmin && (
            <div className="jc-row-actions">
              <button className="btn-icon" title="Edit" onClick={() => setEditing(f)}>✎</button>
              <button className="btn-icon" title="Remove" onClick={() => remove(f)}>✕</button>
            </div>
          )}
        </div>
      ))}
      {isAdmin && editing && (
        <FlightForm initial={editing} people={people} saving={saving} onSave={save} onCancel={() => setEditing(null)} />
      )}
    </Section>
  );
}

// ── Accommodation ──────────────────────────────────────────────

const emptyAccom = { person_id: '', person_name: '', venue: '', address: '', check_in: '', check_out: '', booking_ref: '', notes: '' };

function AccommodationForm({ initial, people, onSave, onCancel, saving }) {
  const [f, setF] = useState(initial);
  return (
    <div className="jc-inline-form jc-form-block">
      <PersonFields people={people} personId={f.person_id} personName={f.person_name}
        onChange={(v) => setF({ ...f, ...v })} />
      <div className="form-row">
        <div className="form-group">
          <label>Venue</label>
          <input value={f.venue} placeholder="Hotel / camp" onChange={(e) => setF({ ...f, venue: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Address</label>
          <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Check-in</label>
          <input type="date" value={f.check_in} onChange={(e) => setF({ ...f, check_in: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Check-out</label>
          <input type="date" value={f.check_out} onChange={(e) => setF({ ...f, check_out: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Booking ref</label>
          <input value={f.booking_ref} onChange={(e) => setF({ ...f, booking_ref: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Notes</label>
          <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </div>
      </div>
      <div className="jc-form-actions">
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => onSave(f)}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function AccommodationSection({ job, items, people, isAdmin, reload, showToast }) {
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const save = async (f) => {
    setSaving(true);
    try {
      if (f.id) await updateJobAccommodation(f.id, f);
      else await addJobAccommodation(job.id, f);
      setEditing(null);
      reload();
    } catch (err) { showToast(err.message, 'error'); } finally { setSaving(false); }
  };
  const remove = async (a) => {
    if (!confirm('Remove this accommodation?')) return;
    try { await deleteJobAccommodation(a.id); reload(); } catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <Section
      title="🏨 Accommodation"
      badge={items.length || null}
      action={isAdmin && <button className="btn btn-sm" onClick={() => setEditing({ ...emptyAccom })}>＋ Add</button>}
    >
      {items.length === 0 && !editing && <div className="jc-empty">No accommodation yet{isAdmin ? ' — add the first stay.' : '.'}</div>}
      {items.map(a => (
        <div key={a.id} className="jc-row">
          <div className="jc-row-main">
            <div className="jc-row-title">
              {personLabel(a, people) && <strong>{personLabel(a, people)}</strong>}
              <span>{a.venue || 'Accommodation'}</span>
            </div>
            <div className="jc-row-meta">
              {[
                a.address || '',
                a.check_in || a.check_out ? `${fmtDateShort(a.check_in) || '?'} → ${fmtDateShort(a.check_out) || '?'}` : '',
                a.booking_ref ? `Ref ${a.booking_ref}` : '',
                a.notes || '',
              ].filter(Boolean).join(' · ')}
            </div>
          </div>
          {isAdmin && (
            <div className="jc-row-actions">
              <button className="btn-icon" title="Edit" onClick={() => setEditing(a)}>✎</button>
              <button className="btn-icon" title="Remove" onClick={() => remove(a)}>✕</button>
            </div>
          )}
        </div>
      ))}
      {isAdmin && editing && (
        <AccommodationForm initial={editing} people={people} saving={saving} onSave={save} onCancel={() => setEditing(null)} />
      )}
    </Section>
  );
}

// ── Vehicles (owned + rentals) ─────────────────────────────────

const emptyRental = { company: '', vehicle_desc: '', rego: '', pickup_location: '', pickup_at: '', return_at: '', booked_under: '', booking_ref: '', notes: '' };

function RentalForm({ initial, onSave, onCancel, saving }) {
  const [f, setF] = useState(initial);
  return (
    <div className="jc-inline-form jc-form-block">
      <div className="form-row">
        <div className="form-group">
          <label>Hire company</label>
          <input value={f.company} placeholder="e.g. Thrifty" onChange={(e) => setF({ ...f, company: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Vehicle</label>
          <input value={f.vehicle_desc} placeholder="e.g. Toyota Hilux 4x4" onChange={(e) => setF({ ...f, vehicle_desc: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Rego</label>
          <input value={f.rego} onChange={(e) => setF({ ...f, rego: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Pickup location</label>
          <input value={f.pickup_location} onChange={(e) => setF({ ...f, pickup_location: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Pickup</label>
          <input type="datetime-local" value={f.pickup_at} onChange={(e) => setF({ ...f, pickup_at: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Return</label>
          <input type="datetime-local" value={f.return_at} onChange={(e) => setF({ ...f, return_at: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Booked under</label>
          <input value={f.booked_under} onChange={(e) => setF({ ...f, booked_under: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Booking ref</label>
          <input value={f.booking_ref} onChange={(e) => setF({ ...f, booking_ref: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Notes</label>
          <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </div>
      </div>
      <div className="jc-form-actions">
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => onSave(f)}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function VehiclesSection({ job, rentals, vehicles, equipmentList, people, isAdmin, reload, showToast }) {
  const [editingRental, setEditingRental] = useState(null);
  const [saving, setSaving] = useState(false);
  const [addingVehicle, setAddingVehicle] = useState('');

  const toggleRentalRequired = async () => {
    try {
      await updateJob(job.id, { rental_required: job.rental_required ? 0 : 1 });
      reload();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const saveRental = async (f) => {
    setSaving(true);
    try {
      if (f.id) await updateJobRental(f.id, f);
      else await addJobRental(job.id, f);
      setEditingRental(null);
      reload();
    } catch (err) { showToast(err.message, 'error'); } finally { setSaving(false); }
  };
  const removeRental = async (r) => {
    if (!confirm('Remove this rental?')) return;
    try { await deleteJobRental(r.id); reload(); } catch (err) { showToast(err.message, 'error'); }
  };

  const addVehicle = async () => {
    if (!addingVehicle) return;
    try { await assignJobEquipment(job.id, { equipment_id: addingVehicle }); setAddingVehicle(''); reload(); }
    catch (err) { showToast(err.message, 'error'); }
  };
  const removeVehicle = async (v) => {
    if (!confirm(`Remove ${v.equipment_name} from this job?`)) return;
    try { await removeJobEquipment(v.id); reload(); } catch (err) { showToast(err.message, 'error'); }
  };

  const vehicleOptions = equipmentList.filter(e => e.equipment_category === 'Vehicles');
  const assignedIds = new Set(vehicles.map(v => v.equipment_id));

  return (
    <Section title="🚗 Vehicles" badge={vehicles.length + rentals.length || null}>
      <div className="jc-subhead">Owned (from equipment register)</div>
      {vehicles.length === 0 && <div className="jc-empty">No company vehicles assigned.</div>}
      {vehicles.map(v => (
        <div key={v.id} className="jc-row">
          <div className="jc-row-main">
            <div className="jc-row-title">
              <strong>{v.equipment_name}</strong>
              {v.assigned_to && <span>→ {nameOf(people, v.assigned_to) || 'assigned'}</span>}
            </div>
            {(v.serial_number || v.notes) && (
              <div className="jc-row-meta">{[v.serial_number, v.notes].filter(Boolean).join(' · ')}</div>
            )}
          </div>
          {isAdmin && <div className="jc-row-actions"><button className="btn-icon" title="Remove" onClick={() => removeVehicle(v)}>✕</button></div>}
        </div>
      ))}
      {isAdmin && (
        <div className="jc-inline-form">
          <select value={addingVehicle} onChange={(e) => setAddingVehicle(e.target.value)}>
            <option value="">Add company vehicle…</option>
            {vehicleOptions.filter(e => !assignedIds.has(e.id)).map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <button className="btn btn-sm" disabled={!addingVehicle} onClick={addVehicle}>Add</button>
        </div>
      )}

      <div className="jc-subhead jc-rental-head">
        <label className="jc-rental-toggle">
          <input type="checkbox" checked={!!job.rental_required} disabled={!isAdmin} onChange={toggleRentalRequired} />
          Rental required
        </label>
        {isAdmin && job.rental_required && (
          <button className="btn btn-sm" onClick={() => setEditingRental({ ...emptyRental })}>＋ Add rental</button>
        )}
      </div>

      {rentals.map(r => (
        <div key={r.id} className="jc-row">
          <div className="jc-row-main">
            <div className="jc-row-title">
              <strong>{r.vehicle_desc || 'Rental vehicle'}</strong>
              {r.company && <span>{r.company}</span>}
              {r.rego && <span className="jc-chip-sm">{r.rego}</span>}
            </div>
            <div className="jc-row-meta">
              {[
                r.pickup_location ? `Pickup ${r.pickup_location}` : '',
                r.pickup_at ? fmtDateTime(r.pickup_at) : '',
                r.return_at ? `return ${fmtDateTime(r.return_at)}` : '',
                r.booked_under ? `booked under ${r.booked_under}` : '',
                r.booking_ref ? `Ref ${r.booking_ref}` : '',
                r.notes || '',
              ].filter(Boolean).join(' · ')}
            </div>
          </div>
          {isAdmin && (
            <div className="jc-row-actions">
              <button className="btn-icon" title="Edit" onClick={() => setEditingRental(r)}>✎</button>
              <button className="btn-icon" title="Remove" onClick={() => removeRental(r)}>✕</button>
            </div>
          )}
        </div>
      ))}
      {job.rental_required && rentals.length === 0 && !editingRental && (
        <div className="jc-empty">Rental flagged — add the booking details here.</div>
      )}
      {isAdmin && editingRental && (
        <RentalForm initial={editingRental} saving={saving} onSave={saveRental} onCancel={() => setEditingRental(null)} />
      )}
    </Section>
  );
}

// ── Equipment kit ──────────────────────────────────────────────

// Minutes → "hand-carried" | "45m" | "2h" | "2h 15m"
function fmtTransit(mins) {
  if (!mins) return 'hand-carried';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function KitSection({ job, kit, equipmentList, people, isAdmin, reload, showToast }) {
  const [adding, setAdding] = useState('');
  const [editingTransit, setEditingTransit] = useState(null); // { id, name, before, after }
  const [savingTransit, setSavingTransit] = useState(false);

  const add = async () => {
    if (!adding) return;
    try { await assignJobEquipment(job.id, { equipment_id: adding }); setAdding(''); reload(); }
    catch (err) { showToast(err.message, 'error'); }
  };
  const remove = async (k) => {
    if (!confirm(`Remove ${k.equipment_name} from this job?`)) return;
    try { await removeJobEquipment(k.id); reload(); } catch (err) { showToast(err.message, 'error'); }
  };
  const adjustBooking = async (k, edge, delta) => {
    try { await adjustEquipmentBooking(k.id, edge, delta); reload(); }
    catch (err) { showToast(err.message, 'error'); }
  };
  const saveTransit = async () => {
    const before = Math.max(0, Math.floor(Number(editingTransit.before) || 0));
    const after = Math.max(0, Math.floor(Number(editingTransit.after) || 0));
    setSavingTransit(true);
    try {
      await updateJobEquipmentTransit(editingTransit.id, before, after);
      setEditingTransit(null);
      reload();
    } catch (err) { showToast(err.message, 'error'); }
    finally { setSavingTransit(false); }
  };

  const assignedIds = new Set(kit.map(k => k.equipment_id));
  const options = equipmentList.filter(e => e.equipment_category !== 'Vehicles' && !assignedIds.has(e.id));

  return (
    <Section
      title="🧰 Equipment kit"
      badge={kit.length || null}
      action={isAdmin && (
        <span className="jc-inline-form jc-inline-right">
          <select value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add equipment…</option>
            {options.map(e => <option key={e.id} value={e.id}>{e.name}{e.equipment_category ? ` (${e.equipment_category})` : ''}</option>)}
          </select>
          <button className="btn btn-sm" disabled={!adding} onClick={add}>Add</button>
        </span>
      )}
    >
      {kit.length === 0 && <div className="jc-empty">No equipment assigned to this job yet.</div>}
      {kit.map(k => (
        <div key={k.id}>
          <div className="jc-row">
            <div className="jc-row-main">
              <div className="jc-row-title">
                <strong>{k.equipment_name}</strong>
                {k.category && <span className="jc-chip-sm">{k.category}</span>}
                {!!k.transit_before && <span className="jc-chip-sm" title={`${k.transit_before} min before job start`}>↑ {fmtTransit(k.transit_before)} before</span>}
                {!!k.transit_after && <span className="jc-chip-sm" title={`${k.transit_after} min after job end`}>↓ {fmtTransit(k.transit_after)} after</span>}
                {k.assigned_to && <span>→ {nameOf(people, k.assigned_to) || 'assigned'}</span>}
              </div>
              {(k.serial_number || k.notes) && (
                <div className="jc-row-meta">{[k.serial_number && `SN ${k.serial_number}`, k.notes].filter(Boolean).join(' · ')}</div>
              )}
              {isAdmin && (
                k.booked_from ? (
                  <div className="jc-row-meta">
                    <button className="btn-icon" title="Drop first booked day" onClick={() => adjustBooking(k, 'start', -1)}>−</button>
                    <button className="btn-icon" title="Book one day earlier" onClick={() => adjustBooking(k, 'start', 1)}>+</button>
                    <span>📅 {fmtDateShort(k.booked_from)}{k.booked_to !== k.booked_from ? ` → ${fmtDateShort(k.booked_to)}` : ''} ({k.booked_days}d)</span>
                    <button className="btn-icon" title="Drop last booked day" onClick={() => adjustBooking(k, 'end', -1)}>−</button>
                    <button className="btn-icon" title="Book one day later" onClick={() => adjustBooking(k, 'end', 1)}>+</button>
                  </div>
                ) : (
                  <div className="jc-row-meta">
                    <span>Not booked</span>
                    <button className="btn-icon" title="Start equipment booking" onClick={() => adjustBooking(k, 'end', 1)}>+</button>
                  </div>
                )
              )}
            </div>
            {isAdmin && (
              <div className="jc-row-actions">
                <button className="btn-icon" title="Edit transit" onClick={() => setEditingTransit({ id: k.id, name: k.equipment_name, before: k.transit_before || 0, after: k.transit_after || 0 })}>✎</button>
                <button className="btn-icon" title="Remove" onClick={() => remove(k)}>✕</button>
              </div>
            )}
          </div>
          {isAdmin && editingTransit?.id === k.id && (
            <div className="jc-inline-form jc-form-block">
              <div className="form-group">
                <label>Equipment</label>
                <input value={editingTransit.name} readOnly disabled />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Transit before (minutes)</label>
                  <input type="number" min="0" step="1" value={editingTransit.before}
                    onChange={(e) => setEditingTransit({ ...editingTransit, before: e.target.value })} />
                  <small>0 = hand-carried</small>
                </div>
                <div className="form-group">
                  <label>Transit after (minutes)</label>
                  <input type="number" min="0" step="1" value={editingTransit.after}
                    onChange={(e) => setEditingTransit({ ...editingTransit, after: e.target.value })} />
                  <small>0 = hand-carried</small>
                </div>
              </div>
              <div className="jc-form-actions">
                <button className="btn btn-sm" onClick={() => setEditingTransit(null)}>Cancel</button>
                <button className="btn btn-sm btn-primary" disabled={savingTransit} onClick={saveTransit}>{savingTransit ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </Section>
  );
}

// ── Notes ──────────────────────────────────────────────────────

function NotesSection({ job, isAdmin, reload, showToast }) {
  const [notes, setNotes] = useState(job.notes || '');
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setNotes(job.notes || ''); setDirty(false); }, [job.notes, job.id]);

  const save = async () => {
    try {
      await updateJob(job.id, { notes });
      setDirty(false);
      showToast('Notes saved', 'success');
      reload();
    } catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <Section title="📝 Notes">
      {isAdmin ? (
        <>
          <textarea rows={4} value={notes} placeholder="Job notes — meet times, contacts, gotchas…"
            onChange={(e) => { setNotes(e.target.value); setDirty(true); }} />
          {dirty && <div className="jc-form-actions"><button className="btn btn-sm btn-primary" onClick={save}>Save notes</button></div>}
        </>
      ) : (
        <div className="jc-notes-read">{job.notes || 'No notes yet.'}</div>
      )}
    </Section>
  );
}

// ── List row (shared by JobManager and MyJobs) ────────────────

export function JobListRow({ job, onClick, actions }) {
  const total = job.checklist_total || 0;
  const done = job.checklist_done || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const status = JOB_STATUSES[job.status] || JOB_STATUSES.planning;
  const days = rosterDays(job.roster_start, job.roster_end);
  const todayAEST = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const isPast = !job.archived && job.roster_end && job.roster_end < todayAEST;

  return (
    <div className={`list-item jc-list-row ${onClick ? 'clickable' : ''} ${job.archived ? 'jc-list-archived' : ''}`} onClick={onClick}>
      <div className="list-item-info">
        <span className="job-color-dot" style={{ background: job.color }}></span>
        <div style={{ minWidth: 0 }}>
          <div className="jc-list-title">
            {job.code}
            {job.job_number && <span className="jc-ref">{job.job_number}</span>}
            <span className="jc-status" style={{ background: `${status.color}22`, color: status.color, borderColor: `${status.color}55` }}>{status.label}</span>
            {job.archived && <span className="jc-chip-sm jc-chip-archived">Archived</span>}
            {isPast && <span className="jc-chip-sm jc-chip-past" title="All scheduled days are in the past — ready to archive">Past</span>}
          </div>
          <div className="jc-list-name">{job.name}{job.client ? ` — ${job.client}` : ''}</div>
          <div className="jc-list-meta">
            {job.roster_start
              ? `${fmtDateShort(job.roster_start)} → ${fmtDateShort(job.roster_end)} · ${days} day${days === 1 ? '' : 's'}`
              : 'Not yet rostered'}
            {job.lead_name && <span> · 👤 {job.lead_name}</span>}
            {total > 0 && <span> · {done}/{total} ready</span>}
          </div>
          {total > 0 && (
            <div className="jc-mini-progress"><div style={{ width: `${pct}%`, background: pct === 100 ? 'var(--success)' : 'var(--accent)' }}></div></div>
          )}
        </div>
      </div>
      <div className="list-item-actions" onClick={(e) => e.stopPropagation()}>
        {actions}
        {onClick && <span className="jc-list-chevron">›</span>}
      </div>
    </div>
  );
}

// ── Main card ──────────────────────────────────────────────────

export default function JobCard({ jobId, onBack, teamMembers = [], equipment = [], currentUser, showToast, onEdit, refreshKey = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [equipList, setEquipList] = useState(equipment);

  const load = useCallback(async () => {
    try {
      const card = await getJobCard(jobId);
      setData(card);
    } catch (err) {
      showToast('Failed to load job card: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [jobId, showToast]);

  useEffect(() => { setLoading(true); load(); }, [load, refreshKey]);

  // Ensure we have the full equipment list (App only loads equipment for admins on some tabs)
  useEffect(() => {
    if (equipment.length > 0) { setEquipList(equipment); return; }
    getEquipment().then(setEquipList).catch(() => {});
  }, [equipment]);

  const copySubscribe = async () => {
    try {
      const { token } = await getJobCalendarToken(jobId);
      await navigator.clipboard.writeText(calendarFeedUrl('job', token));
      showToast('Subscription link copied', 'success');
    } catch (err) {
      showToast('Failed to get subscription link: ' + err.message, 'error');
    }
  };

  if (loading) return <div className="jc-loading">Loading job…</div>;
  if (!data) return (
    <div className="jc-loading">
      Job not found.
      <div style={{ marginTop: 12 }}><button className="btn" onClick={onBack}>← Back</button></div>
    </div>
  );

  const { job, crew, checklist, flights, accommodation, rentals, equipment: kit } = data;
  const isAdmin = !!currentUser?.isAdmin;
  const people = teamMembers.filter(m => !m.is_equipment);
  const canTick = isAdmin; // admins complete the checklists
  const vehicles = kit.filter(k => k.category === 'Vehicles');
  const otherKit = kit.filter(k => k.category !== 'Vehicles');
  const done = checklist.filter(i => i.done).length;
  const pct = checklist.length ? Math.round((done / checklist.length) * 100) : 0;
  const status = JOB_STATUSES[job.status] || JOB_STATUSES.planning;
  const days = rosterDays(job.roster_start, job.roster_end);
  const complianceFlags = crew.flatMap(c =>
    (c.compliance || []).filter(x => x.status !== 'valid').map(x => ({ ...x, memberName: c.name }))
  );

  const toggleArchive = async () => {
    try {
      if (job.archived) {
        await unarchiveJob(job.id);
        showToast('Job unarchived', 'success');
      } else {
        await archiveJob(job.id);
        showToast('Job archived', 'success');
      }
      load();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  return (
    <div className="job-card">
      <button className="btn btn-sm jc-back" onClick={onBack}>← Back</button>

      <div className="jc-header card">
        <div className="jc-header-top">
          <span className="job-color-dot" style={{ background: job.color }}></span>
          <h2>{job.code}</h2>
          {job.job_number && <span className="jc-ref">Job {job.job_number}</span>}
          <span className="jc-status" style={{ background: `${status.color}22`, color: status.color, borderColor: `${status.color}55` }}>{status.label}</span>
          {job.archived && <span className="jc-chip-sm jc-chip-archived" title={`Archived ${job.archived_at || ''}`}>Archived</span>}
          {job.state && <span className="jc-chip-sm" title={job.lead_name ? "State — where the project lead is from" : "State this job is allocated to"}>📍 {job.state}</span>}
          {job.lead_name && <span className="jc-chip-sm" title="Project Lead — the person running this job; the state comes from where they're based">👤 {job.lead_name}</span>}
          {!job.archived && job.state && (job.crew_count || 0) < (job.crew_size || 1) && (
            <span className="jc-chip-sm jc-chip-crew" title="Not fully crewed — this job shows on the Unallocated line in the schedule">
              👷 {job.crew_count || 0}/{job.crew_size || 1} crew
            </span>
          )}
          <div className="jc-header-actions">
            {isAdmin && onEdit && <button className="btn btn-sm" onClick={() => onEdit(job)}>✎ Edit</button>}
            {isAdmin && (
              <button
                className="btn btn-sm"
                onClick={toggleArchive}
                title={job.archived ? 'Restore to the active jobs list' : 'Hide from the active jobs list'}
              >
                {job.archived ? 'Unarchive' : '📦 Archive'}
              </button>
            )}
          </div>
        </div>
        <div className="jc-title">{job.name}</div>
        <div className="jc-subtitle">
          {job.client && <span>Client: {job.client}</span>}
          <span className="jc-dates">
            {job.roster_start
              ? `${fmtDate(job.roster_start)} → ${fmtDate(job.roster_end)} · ${days} day${days === 1 ? '' : 's'} on the gantt`
              : 'Not yet rostered on the gantt'}
          </span>
        </div>
        {(job.site_address || job.site_contact) && (
          <div className="jc-subtitle">
            {job.site_address && <span>📍 {job.site_address}</span>}
            {job.site_contact && <span>☎ {job.site_contact}</span>}
          </div>
        )}
        {(job.planned_start || job.planned_end) && (
          <div className="jc-subtitle">
            <span title="Planned dates — shown as the bar on the schedule's Unallocated line">🗓 Planned: {job.planned_start ? fmtDate(job.planned_start) : '?'} → {job.planned_end ? fmtDate(job.planned_end) : '?'}</span>
          </div>
        )}
        <div className="jc-links">
          {job.sharepoint_url && (
            <a className="btn btn-sm" href={job.sharepoint_url} target="_blank" rel="noopener noreferrer">📂 SharePoint</a>
          )}
          {job.file_url && (
            <a className="btn btn-sm" href={job.file_url} target="_blank" rel="noopener noreferrer">📁 Files</a>
          )}
          <button className="btn btn-sm" onClick={() => downloadIcalJob(job.id).catch(e => showToast(e.message, 'error'))}>📅 iCal</button>
          {isAdmin && <button className="btn btn-sm" onClick={copySubscribe}>🔗 Subscribe</button>}
        </div>

        <div className="jc-progress-wrap">
          <div className="jc-progress">
            <div className="jc-progress-bar" style={{ width: `${pct}%`, background: pct === 100 ? 'var(--success)' : 'var(--accent)' }}></div>
          </div>
          <span className="jc-progress-label">{checklist.length === 0 ? 'No checklist yet' : `${done}/${checklist.length} ready`}</span>
        </div>

        {crew.length > 0 && (
          <div className="jc-crew">
            <span className="jc-crew-label">Crew:</span>
            {crew.map(c => {
              const flagged = (c.compliance || []).filter(x => x.status !== 'valid');
              return (
                <span
                  key={c.id}
                  className={`jc-crew-chip ${flagged.length ? 'jc-crew-flagged' : ''}`}
                  style={{ borderColor: c.color || '#3B82F6' }}
                  title={flagged.map(x => `${x.type}${x.site ? ` (${x.site})` : ''} — ${x.status}${x.expires_at ? ` ${fmtDateShort(x.expires_at)}` : ''}`).join('\n')}
                >
                  {c.name} <em>{fmtDateShort(c.from_date)}–{fmtDateShort(c.to_date)}</em>
                  {flagged.length > 0 && <span className="jc-crew-warn">⚠</span>}
                </span>
              );
            })}
          </div>
        )}

        {complianceFlags.length > 0 && (
          <div className="jc-compliance-flags">
            {complianceFlags.map(x => (
              <div key={x.id} className={`jc-comp-flag jc-comp-${x.status}`}>
                <span className="jc-comp-icon">{x.status === 'expired' ? '✗' : '⚠'}</span>
                <span><strong>{x.memberName}</strong> — {x.type}{x.site ? ` (${x.site})` : ''}</span>
                <span className="jc-comp-date">
                  {x.expires_at ? `${x.status === 'expired' ? 'expired' : 'expires'} ${fmtDateShort(x.expires_at)}` : x.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <ChecklistSection job={job} items={checklist} people={people} isAdmin={isAdmin} canTick={canTick} reload={load} showToast={showToast} />
      <FlightsSection job={job} items={flights} people={people} isAdmin={isAdmin} reload={load} showToast={showToast} />
      <AccommodationSection job={job} items={accommodation} people={people} isAdmin={isAdmin} reload={load} showToast={showToast} />
      <VehiclesSection job={job} rentals={rentals} vehicles={vehicles} equipmentList={equipList} people={people} isAdmin={isAdmin} reload={load} showToast={showToast} />
      <KitSection job={job} kit={otherKit} equipmentList={equipList} people={people} isAdmin={isAdmin} reload={load} showToast={showToast} />
      <NotesSection job={job} isAdmin={isAdmin} reload={load} showToast={showToast} />
    </div>
  );
}
