import React, { useCallback, useEffect, useState } from 'react';
import { Drawer, Section } from './ui.jsx';
import {
  STATES, EQUIPMENT_CATEGORIES, updateEquipment, createEquipment,
  getInspectionTemplates, getInspections, deleteInspection, inspectionPdfUrl,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import InspectionForm from './InspectionForm.jsx';
import { templateFor } from '../lib/inspection.js';
import {
  UN_CODES, UN_CODE_HELP, parseUnCodes, formatUnCodes, isKnownUnCode,
} from '../lib/dangerousGoods.js';

// ── Equipment details ───────────────────────────────────────────────────
// The register entry for one item, editable by admins and read-only for
// everyone else. Shared by the Equipment view and the project page, so an
// item's details look and save the same wherever they are opened from.
//
// `item` is either an equipment record or { isNew: true } for a blank form.
// `onSaved(record, { isNew })` runs after a successful save; the caller
// closes the drawer and refreshes whatever it shows. `onInspected()` runs
// after an inspection is submitted, so the caller can pick up a change to
// the item's serviceability without closing the drawer.

function formFor(item, myState) {
  if (item.isNew) {
    // Adding starts blank, with the user's own state and the most common
    // category filled in.
    return {
      name: '', equipment_category: 'Drones', location: STATES.includes(myState) ? myState : '',
      serial_number: '', description: '', dimensions: '', weight: '', contents: '', info_url: '', sds_url: '', airtag_name: '',
      serviceable: true, active: true,
      dangerous_goods: false, un_codes: [], un_other: '',
    };
  }
  // Codes from the reference list are ticked; any others go in the free-text box.
  const { codes } = parseUnCodes(item.un_codes);
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
    dangerous_goods: !!item.dangerous_goods,
    un_codes: codes.filter(isKnownUnCode),
    un_other: codes.filter((c) => !isKnownUnCode(c)).join(', '),
  };
}

const TZ = 'Australia/Sydney';
const fmtWhen = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });

// Past reports for an item, newest first, each opening its PDF. Anyone
// signed in (bar the shared viewer) can start a new one.
function InspectionHistory({ reports, canInspect, isAdmin, onStart, onDelete }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? reports : reports.slice(0, 4);
  return (
    <Section title="Inspections">
      {reports.length === 0 && (
        <div className="insp-empty">No inspections recorded yet.</div>
      )}
      <div className="insp-list">
        {shown.map((r) => (
          <div key={r.id} className="insp-report">
            <a className="insp-report-main" href={inspectionPdfUrl(r.id)} target="_blank" rel="noopener noreferrer" title="Open the PDF report">
              <span className="insp-report-title">{r.title} <span className="insp-report-no">#{r.number}</span></span>
              <span className="insp-report-meta">{fmtWhen(r.inspected_at)} · {r.inspected_by_name || 'Unknown'}</span>
            </a>
            <span className={`tag ${r.defect_count ? 'tag-danger' : 'tag-ok'}`}>
              {r.defect_count ? `${r.defect_count} defect${r.defect_count === 1 ? '' : 's'}` : 'No defects'}
            </span>
            <a className="btn btn-sm" href={inspectionPdfUrl(r.id, { download: true })} title="Download the PDF">PDF</a>
            {isAdmin && (
              <button className="icon-btn" aria-label={`Delete report #${r.number}`} title="Delete report" onClick={() => onDelete(r)}>✕</button>
            )}
          </div>
        ))}
      </div>
      {reports.length > shown.length && (
        <button className="btn-link insp-more" onClick={() => setShowAll(true)}>Show all {reports.length} reports</button>
      )}
      {canInspect && (
        <button className="btn btn-primary insp-start" onClick={onStart}>New inspection</button>
      )}
    </Section>
  );
}

export default function EquipmentDetailsDrawer({ item, isAdmin, myState, onClose, onSaved, onInspected, showToast }) {
  const [form, setForm] = useState(() => formFor(item, myState));
  const [busy, setBusy] = useState(false);
  const { user } = useAuth() || {};
  const [templates, setTemplates] = useState(null);
  const [reports, setReports] = useState([]);
  const [inspecting, setInspecting] = useState(false);

  const loadReports = useCallback(() => {
    if (item.isNew) return;
    getInspections(item.id).then(setReports).catch(() => setReports([]));
  }, [item.id, item.isNew]);

  useEffect(() => {
    if (item.isNew) return;
    loadReports();
    getInspectionTemplates().then(setTemplates).catch(() => setTemplates(null));
  }, [item.isNew, loadReports]);

  const removeReport = async (r) => {
    if (!window.confirm(`Delete report #${r.number} and its photos? This cannot be undone.`)) return;
    try {
      await deleteInspection(r.id);
      loadReports();
    } catch (e) {
      showToast?.(e.message, 'error');
    }
  };

  if (inspecting && templates) {
    return (
      <InspectionForm
        item={item}
        templates={templates}
        initialTemplate={templateFor(templates, form.equipment_category || item.equipment_category)}
        showToast={showToast}
        onClose={() => setInspecting(false)}
        onSubmitted={(saved) => {
          setInspecting(false);
          loadReports();
          // Keep the open details in step, so a later Save does not put
          // the item back into service.
          if (saved.marked_unserviceable) setForm((f) => ({ ...f, serviceable: false }));
          showToast?.(
            saved.defect_count
              ? `Report #${saved.number} saved · ${saved.defect_count} defect${saved.defect_count === 1 ? '' : 's'}`
              : `Report #${saved.number} saved · no defects`,
            saved.defect_count ? 'error' : 'success',
          );
          onInspected?.(saved);
        }}
      />
    );
  }

  const save = async () => {
    if (!form.name.trim()) {
      showToast?.('A name is required', 'error');
      return;
    }
    const other = parseUnCodes(form.un_other);
    if (form.dangerous_goods && other.invalid.length) {
      showToast?.(`Not a UN number: ${other.invalid.join(', ')}`, 'error');
      return;
    }
    setBusy(true);
    try {
      const { un_other, ...rest } = form;
      const codes = form.dangerous_goods
        ? [...UN_CODES.map((c) => c.code).filter((c) => form.un_codes.includes(c)), ...other.codes]
        : [];
      const body = { ...rest, name: form.name.trim(), un_codes: formatUnCodes([...new Set(codes)]) };
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

  // A link field whose label opens the address, once it holds one. Only
  // http(s) addresses become links, so a stray "javascript:" never runs.
  const linkField = (key, label, placeholder) => {
    const url = form[key].trim();
    const href = /^https?:\/\/\S+$/i.test(url) ? url : null;
    return (
      <label className="form-row" key={key}>
        <span className="form-label">
          {href ? (
            <a className="form-label-link" href={href} target="_blank" rel="noopener noreferrer" title={`Open ${href}`}>
              {label} ↗
            </a>
          ) : label}
        </span>
        <input
          type="url"
          value={form[key]}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          placeholder={placeholder}
        />
      </label>
    );
  };

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
      {!item.isNew && (
        <InspectionHistory
          reports={reports}
          canInspect={!!templates && !!user && !user.isViewer}
          isAdmin={isAdmin}
          onStart={() => setInspecting(true)}
          onDelete={removeReport}
        />
      )}

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

        <Section
          title={(
            <>
              Dangerous goods{' '}
              <span className="dg-help" title={UN_CODE_HELP} aria-label="UN code reference">ⓘ</span>
            </>
          )}
        >
          <div className="opt-list">
            <label className="opt" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.dangerous_goods}
                onChange={(e) => setForm((f) => ({ ...f, dangerous_goods: e.target.checked }))}
              />
              <span className="opt-name">Contains dangerous goods</span>
              <span className="opt-hint">tick the UN numbers that apply</span>
            </label>
          </div>
          {form.dangerous_goods && (
            <>
              <div className="opt-list un-list">
                {UN_CODES.map((c) => (
                  <label
                    key={c.code}
                    className="opt"
                    style={{ cursor: 'pointer' }}
                    title={`${c.code} — ${c.label} (Class ${c.cls})${c.hint ? `\n${c.hint}` : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={form.un_codes.includes(c.code)}
                      onChange={(e) => setForm((f) => ({
                        ...f,
                        un_codes: e.target.checked
                          ? [...f.un_codes, c.code]
                          : f.un_codes.filter((x) => x !== c.code),
                      }))}
                    />
                    <span className="un-code">{c.code}</span>
                    <span className="opt-name">{c.label}</span>
                    <span className="opt-hint">Class {c.cls}</span>
                  </label>
                ))}
              </div>
              {field('un_other', 'Other UN numbers', { placeholder: 'e.g. UN1170, UN2794' })}
            </>
          )}
        </Section>

        <Section title="Links">
          {linkField('info_url', 'Info / manual', 'https://…')}
          {linkField('sds_url', 'Safety data sheet', 'https://…')}
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
