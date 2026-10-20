import React, { useState } from 'react';
import { Drawer, Section } from './ui.jsx';
import { STATES, EQUIPMENT_CATEGORIES, updateEquipment, createEquipment } from '../api.js';

// ── Equipment details ───────────────────────────────────────────────────
// The register entry for one item, editable by admins and read-only for
// everyone else. Shared by the Equipment view and the project page, so an
// item's details look and save the same wherever they are opened from.
//
// `item` is either an equipment record or { isNew: true } for a blank form.
// `onSaved(record, { isNew })` runs after a successful save; the caller
// closes the drawer and refreshes whatever it shows.

function formFor(item, myState) {
  if (item.isNew) {
    // Adding starts blank, with the user's own state and the most common
    // category filled in.
    return {
      name: '', equipment_category: 'Drones', location: STATES.includes(myState) ? myState : '',
      serial_number: '', description: '', dimensions: '', weight: '', contents: '', info_url: '', sds_url: '', airtag_name: '',
      serviceable: true, active: true,
    };
  }
  return {
    name: item.name || '',
    equipment_category: item.equipment_category || '',
    location: item.location || '',
    serial_number: item.serial_number || '',
    description: item.description || '',
    dimensions: item.dimensions || '',
    weight: item.weight || '',
    contents: item.contents || '',
    info_url: item.info_url || '',
    sds_url: item.sds_url || '',
    airtag_name: item.airtag_name || '',
    serviceable: item.serviceable !== 0,
    active: item.active !== 0,
  };
}

export default function EquipmentDetailsDrawer({ item, isAdmin, myState, onClose, onSaved, showToast }) {
  const [form, setForm] = useState(() => formFor(item, myState));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!form.name.trim()) {
      showToast?.('A name is required', 'error');
      return;
    }
    setBusy(true);
    try {
      const body = { ...form, name: form.name.trim() };
      const saved = item.isNew ? await createEquipment(body) : await updateEquipment(item.id, body);
      await onSaved?.(saved, { isNew: !!item.isNew });
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const field = (key, label, props = {}) => (
    <label className="form-row" key={key}>
      <span className="form-label">{label}</span>
      <input
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        {...props}
      />
    </label>
  );

  return (
    <Drawer
      title={item.isNew ? 'New equipment' : item.name}
      subtitle={item.isNew ? 'Add an item to the register'
        : item.active === 0 ? 'Inactive — hidden from the default list' : 'Equipment details'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{isAdmin ? 'Cancel' : 'Close'}</button>
          {isAdmin && (
            <button className="btn btn-primary" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : item.isNew ? 'Add' : 'Save'}
            </button>
          )}
        </>
      }
    >
      {!isAdmin && <div className="banner banner-warn">Only admins can change equipment.</div>}

      <fieldset className="form-set" disabled={!isAdmin || busy}>
        <Section title="Identity">
          {field('name', 'Name', { required: true })}
          <label className="form-row">
            <span className="form-label">Category</span>
            <select
              value={form.equipment_category}
              onChange={(e) => setForm((f) => ({ ...f, equipment_category: e.target.value }))}
            >
              <option value="">Uncategorised</option>
              {EQUIPMENT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="form-row">
            <span className="form-label">Home base</span>
            <select
              value={form.location}
              onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
            >
              <option value="">No home base</option>
              {STATES.map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
          </label>
          {field('serial_number', 'Serial')}
          {field('description', 'Description', { placeholder: 'e.g. Matrice 300 RTK, second airframe' })}
        </Section>

        <Section title="Physical">
          {field('dimensions', 'Dimensions', { placeholder: 'e.g. 60 × 40 × 30 cm' })}
          {field('weight', 'Weight', { placeholder: 'e.g. 12 kg' })}
          <label className="form-row">
            <span className="form-label">Box contents</span>
            <textarea
              className="note-input"
              rows={4}
              value={form.contents}
              onChange={(e) => setForm((f) => ({ ...f, contents: e.target.value }))}
              placeholder={'One item per line, e.g.\n1 x Controller\n1 x Tablet, charger, cables'}
            />
          </label>
          {field('airtag_name', 'AirTag name', { placeholder: 'as it appears in Find My' })}
        </Section>

        <Section title="Links">
          {field('info_url', 'Info / manual', { type: 'url', placeholder: 'https://…' })}
          {field('sds_url', 'Safety data sheet', { type: 'url', placeholder: 'https://…' })}
        </Section>

        <Section title="Status">
          <div className="opt-list">
            <label className="opt" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.serviceable}
                onChange={(e) => setForm((f) => ({ ...f, serviceable: e.target.checked }))}
              />
              <span className="opt-name">Serviceable</span>
              <span className="opt-hint">usable right now</span>
            </label>
            {!item.isNew && (
              <label className="opt" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                />
                <span className="opt-name">Active</span>
                <span className="opt-hint">in the register</span>
              </label>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 10, lineHeight: 1.5 }}>
            Unserviceable kit stays in the list — it is still yours, just not
            usable. Inactive kit leaves the default list entirely; find it
            again with the Inactive or All filter. Existing bookings are left
            alone either way.
          </div>
        </Section>
      </fieldset>
    </Drawer>
  );
}
