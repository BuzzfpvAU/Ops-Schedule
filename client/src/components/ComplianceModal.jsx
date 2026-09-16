import React, { useCallback, useEffect, useState } from 'react';
import { getMemberCompliance, addMemberCompliance, updateMemberCompliance, deleteMemberCompliance } from '../api.js';

export const COMPLIANCE_TYPES = ['Site Induction', 'White Card', 'RePL (CASA)', 'AROC', 'Medical', 'HRWL', 'First Aid', 'SWMS', 'Police Check', 'Other'];
const EMPTY = { type: '', reference: '', site: '', issued_at: '', expires_at: '', file_url: '', notes: '' };

function fmtShort(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return s;
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function complianceStatusOf(expires) {
  if (!expires) return { label: 'Valid', color: '#22c55e' };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  if (expires < today) return { label: 'Expired', color: '#ef4444' };
  const warn = new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  if (expires <= warn) return { label: 'Expiring', color: '#eab308' };
  return { label: 'Valid', color: '#22c55e' };
}

export default function ComplianceModal({ member, onClose, showToast }) {
  const [rows, setRows] = useState(null);
  const [editing, setEditing] = useState(null); // null | {} (new) | row
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await getMemberCompliance(member.id));
    } catch (err) {
      showToast(err.message, 'error');
      setRows([]);
    }
  }, [member.id, showToast]);

  useEffect(() => { load(); }, [load]);

  const save = async (f) => {
    if (!f.type) { showToast('Type is required', 'error'); return; }
    setSaving(true);
    try {
      if (f.id) await updateMemberCompliance(f.id, f);
      else await addMemberCompliance(member.id, f);
      setEditing(null);
      await load();
      showToast('Compliance saved', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r) => {
    if (!confirm(`Delete "${r.type}" record?`)) return;
    try {
      await deleteMemberCompliance(r.id);
      await load();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const Form = ({ initial }) => {
    const [f, setF] = useState(initial);
    return (
      <div className="jc-form-block" style={{ marginTop: 10 }}>
        <div className="form-row">
          <div className="form-group">
            <label>Type *</label>
            <input list="compliance-types" value={f.type} placeholder="e.g. White Card" onChange={(e) => setF({ ...f, type: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Reference / Number</label>
            <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Site (for inductions)</label>
            <input value={f.site} placeholder="e.g. Woodside KGP" onChange={(e) => setF({ ...f, site: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Issued</label>
            <input type="date" value={f.issued_at} onChange={(e) => setF({ ...f, issued_at: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Expires</label>
            <input type="date" value={f.expires_at} onChange={(e) => setF({ ...f, expires_at: e.target.value })} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>File URL</label>
            <input value={f.file_url} onChange={(e) => setF({ ...f, file_url: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Notes</label>
            <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </div>
        </div>
        <div className="jc-form-actions">
          <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => save(f)}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal jc-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Compliance — {member.name}</h2>
        <p className="modal-subtitle">
          Site inductions, cards and licences, tracked per person. Expiry is checked against each job's start date on the job card.
        </p>
        <datalist id="compliance-types">
          {COMPLIANCE_TYPES.map(t => <option key={t} value={t} />)}
        </datalist>

        {rows === null && <div className="jc-loading">Loading…</div>}
        {rows && rows.length === 0 && !editing && <div className="jc-empty">No compliance records yet.</div>}

        {rows && rows.map(r => {
          const st = complianceStatusOf(r.expires_at);
          return (
            <div key={r.id} className="comp-row">
              <div className="comp-row-main">
                <div className="comp-row-title">
                  <strong>{r.type}</strong>
                  <span className="comp-status" style={{ color: st.color, borderColor: `${st.color}66`, background: `${st.color}1a` }}>{st.label}</span>
                  {r.site && <span className="jc-chip-sm">{r.site}</span>}
                </div>
                <div className="comp-row-meta">
                  {[r.reference && `Ref ${r.reference}`, r.issued_at && `issued ${fmtShort(r.issued_at)}`, r.expires_at && `expires ${fmtShort(r.expires_at)}`, r.notes].filter(Boolean).join(' · ')}
                  {r.file_url && <span> · <a href={r.file_url} target="_blank" rel="noopener noreferrer">📎 file</a></span>}
                </div>
              </div>
              <div className="jc-row-actions">
                <button className="btn-icon" title="Edit" onClick={() => setEditing(r)}>✎</button>
                <button className="btn-icon" title="Delete" onClick={() => remove(r)}>✕</button>
              </div>
            </div>
          );
        })}

        {rows && !editing && (
          <div className="jc-form-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
            <button className="btn btn-sm btn-primary" onClick={() => setEditing({ ...EMPTY })}>＋ Add record</button>
          </div>
        )}
        {rows && editing && <Form key={editing.id || 'new'} initial={editing} />}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
