import React, { useMemo, useState } from 'react';
import { Drawer, Section } from './ui.jsx';
import { putMemberCerts, createCertType } from '../api.js';
import { certStatus, CERT_LABEL, NO_EXPIRY } from '../lib/certs.js';
import { today as todayIso, fmtLong } from '../lib/dates.js';

// One person's training and certifications. Anyone can read it; admins edit.
// Ticking a certificate means "has held it" — the planner lists such people
// and warns when the expiry has passed, so an expired record is kept.

const TONE = { expired: 'danger', lapses: 'warn', soon: 'warn', nodate: 'mute', valid: 'ok', never: 'ok' };

export default function CertsDrawer({ member, types, held, isAdmin, onClose, onSaved, showToast }) {
  const mine = held.get(member.id) || new Map();
  const [state, setState] = useState(() => {
    const s = {};
    for (const [id, expiry] of mine) {
      s[id] = { on: true, never: expiry === NO_EXPIRY, expiry: expiry && expiry !== NO_EXPIRY ? expiry : '' };
    }
    return s;
  });
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const today = todayIso();

  // Retired types stay visible for people who still hold them.
  const shown = useMemo(
    () => types.filter((t) => t.active || state[t.id]?.on),
    [types, state],
  );

  const set = (id, patch) => setState((s) => ({ ...s, [id]: { on: false, never: false, expiry: '', ...s[id], ...patch } }));

  const save = async () => {
    setBusy(true);
    try {
      const certs = Object.entries(state)
        .filter(([, v]) => v.on)
        .map(([cert_type_id, v]) => (v.never
          ? { cert_type_id, no_expiry: true, expiry_date: null }
          : { cert_type_id, expiry_date: v.expiry || null }));
      await putMemberCerts(member.id, certs);
      await onSaved?.();
      showToast?.('Certificates saved', 'success');
      onClose();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const addType = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const t = await createCertType(newName.trim());
      setNewName('');
      await onSaved?.();
      set(t.id, { on: true });
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={member.name}
      subtitle="Training & certifications"
      onClose={onClose}
      footer={isAdmin ? (
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      ) : null}
    >
      <Section title="Certificates">
        {shown.length === 0 && <div className="rl-sub">No certificates are set up yet.</div>}
        {shown.map((t) => {
          const v = state[t.id] || { on: false, never: false, expiry: '' };
          const status = v.on ? certStatus(v.never ? NO_EXPIRY : (v.expiry || null), { today }) : null;
          return (
            <div className="cert-row" key={t.id}>
              <label className="cert-name">
                <input
                  type="checkbox"
                  checked={v.on}
                  disabled={!isAdmin}
                  onChange={(e) => set(t.id, { on: e.target.checked })}
                />
                {t.name}
                {!t.active && <span className="rl-sub"> (retired)</span>}
              </label>
              {v.on && (isAdmin ? (
                <>
                  <input
                    type="date"
                    className="np-date"
                    value={v.never ? '' : v.expiry}
                    disabled={v.never}
                    onChange={(e) => set(t.id, { expiry: e.target.value })}
                    aria-label={`${t.name} expiry`}
                  />
                  <label className="cert-never" title="This certificate does not expire">
                    <input
                      type="checkbox"
                      checked={v.never}
                      onChange={(e) => set(t.id, { never: e.target.checked })}
                    />
                    No expiry
                  </label>
                </>
              ) : (
                <span className="rl-sub">{v.never ? '' : v.expiry ? fmtLong(v.expiry) : ''}</span>
              ))}
              {status && <span className={`tag tag-${TONE[status]}`}>{CERT_LABEL[status]}</span>}
            </div>
          );
        })}
        {!isAdmin && (
          <div className="banner banner-warn" style={{ marginTop: 10 }}>Only admins can edit certificates.</div>
        )}
      </Section>

      {isAdmin && (
        <Section title="Add a certificate to the business list">
          <div className="np-link">
            <input
              className="np-select"
              value={newName}
              placeholder="e.g. Rope Access"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addType(); }}
            />
            <button className="btn" disabled={busy || !newName.trim()} onClick={addType}>Add</button>
          </div>
        </Section>
      )}
    </Drawer>
  );
}
