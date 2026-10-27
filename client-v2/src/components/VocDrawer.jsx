import React, { useCallback, useEffect, useState } from 'react';
import { Drawer, Section } from './ui.jsx';
import VocForm from './VocForm.jsx';
import { getVocs, getVocCategories, getVocEquipment, changeVocDate, deleteVoc, vocPdfUrl } from '../api.js';
import { vocStatus } from '../lib/voc.js';
import { fmtLong, today as todayIso } from '../lib/dates.js';

// ── One person's Validation of Competency certificates ──────────────
// Admins record new VOCs, move a VOC's date (e.g. to back-date one done
// earlier) and delete them; anyone can open their own certificates.

const STATUS = {
  current: ['tag-ok', 'Current'],
  soon: ['tag-warn', 'Expiring soon'],
  expired: ['tag-danger', 'Expired'],
  nyc: ['tag-mute', 'Not yet competent'],
};

// The certificate list on its own, so the phone layout can show it too.
export function VocList({ vocs, isAdmin, onChangeDate, onDelete }) {
  const today = todayIso();
  const [editing, setEditing] = useState(null); // { id, value }
  if (!vocs.length) return <div className="insp-empty">No VOCs recorded yet.</div>;
  return (
    <div className="insp-list">
      {vocs.map((v) => {
        const [tone, label] = STATUS[vocStatus(v, today)];
        const competent = v.results.filter((r) => r.outcome === 'competent');
        return (
          <div key={v.id} className="insp-report voc-report">
            <div className="voc-report-top">
              <a className="insp-report-main" href={vocPdfUrl(v.id)} target="_blank" rel="noopener noreferrer" title="Open the certificate">
                <span className="insp-report-title">
                  {v.results.map((r) => r.title).join(', ')} <span className="insp-report-no">{v.cert_number}</span>
                </span>
                <span className="insp-report-meta">
                  {fmtLong(v.assessed_on)}
                  {competent.length ? ` · valid until ${fmtLong(v.expires_on)}` : ''}
                  {` · ${v.assessor_name}`}
                </span>
              </a>
              <span className={`tag ${tone}`}>{label}</span>
              <a className="btn btn-sm" href={vocPdfUrl(v.id, { download: true })} title="Download the certificate">PDF</a>
              {isAdmin && (
                <button className="icon-btn" aria-label={`Delete ${v.cert_number}`} title="Delete VOC" onClick={() => onDelete(v)}>✕</button>
              )}
            </div>
            <div className="voc-report-cats">
              {v.results.map((r) => (
                <span key={r.key} className={r.outcome === 'competent' ? '' : 'is-nyc'}>
                  <b>{r.title}{r.outcome === 'competent' ? '' : ' (NYC)'}:</b> {r.equipment.join(', ')}
                </span>
              ))}
            </div>
            {isAdmin && (editing?.id === v.id ? (
              <div className="voc-date-edit">
                <input
                  type="date"
                  className="np-date"
                  value={editing.value}
                  max={today}
                  aria-label="Date of assessment"
                  onChange={(e) => setEditing({ id: v.id, value: e.target.value })}
                />
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!editing.value || editing.value === v.assessed_on}
                  onClick={async () => { if (await onChangeDate(v, editing.value)) setEditing(null); }}
                >
                  Save date
                </button>
                <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            ) : (
              <button className="btn-link voc-date-btn" onClick={() => setEditing({ id: v.id, value: v.assessed_on })}>
                Change date
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default function VocDrawer({ member, isAdmin, currentUser, onClose, onChanged, showToast }) {
  const [vocs, setVocs] = useState([]);
  const [categories, setCategories] = useState(null);
  const [equipment, setEquipment] = useState({});
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    getVocs(member.id).then(setVocs).catch((e) => showToast?.(e.message, 'error'));
  }, [member.id, showToast]);
  const loadEquipment = useCallback(() => getVocEquipment().then(setEquipment).catch(() => {}), []);

  useEffect(() => {
    load();
    if (isAdmin) {
      getVocCategories().then(setCategories).catch(() => setCategories(null));
      loadEquipment();
    }
  }, [load, loadEquipment, isAdmin]);

  const changeDate = async (v, value) => {
    try {
      await changeVocDate(v.id, value);
      showToast?.(`${v.cert_number} moved to ${fmtLong(value)}`, 'success');
      load();
      await onChanged?.();
      return true;
    } catch (e) {
      showToast?.(e.message, 'error');
      return false;
    }
  };

  const remove = async (v) => {
    if (!window.confirm(`Delete ${v.cert_number} and its certificate? This cannot be undone.`)) return;
    try {
      await deleteVoc(v.id);
      load();
      await onChanged?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    }
  };

  if (creating && categories) {
    return (
      <VocForm
        member={member}
        categories={categories}
        equipment={equipment}
        currentUser={currentUser}
        showToast={showToast}
        onEquipmentChanged={loadEquipment}
        onClose={() => setCreating(false)}
        onSubmitted={async (saved) => {
          setCreating(false);
          showToast?.(`${saved.cert_number} issued`, 'success');
          load();
          loadEquipment();
          await onChanged?.();
        }}
      />
    );
  }

  return (
    <Drawer title={member.name} subtitle="Validation of Competency" onClose={onClose}>
      <Section title="Certificates">
        <VocList vocs={vocs} isAdmin={isAdmin} onChangeDate={changeDate} onDelete={remove} />
        {isAdmin && (
          <button className="btn btn-primary insp-start" disabled={!categories} onClick={() => setCreating(true)}>
            New VOC
          </button>
        )}
      </Section>
      <div className="voc-hint">
        Each category found competent is valid for one year from the date of assessment and shows in
        Certificates as “VOC – …”, so jobs can require it.
      </div>
    </Drawer>
  );
}
