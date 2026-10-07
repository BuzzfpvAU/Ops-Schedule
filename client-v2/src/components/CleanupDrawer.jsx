import React, { useState } from 'react';
import { Drawer } from './ui.jsx';
import { archiveJobsBulk } from '../api.js';
import { fmtShort } from '../lib/dates.js';

// Cleanup sweep: every job whose last scheduled day has passed, all ticked to
// start with. Archiving drops them off the active lists; nothing is deleted.
export default function CleanupDrawer({ jobs, onClose, onDone, showToast }) {
  const [ticked, setTicked] = useState(() => new Set(jobs.map((j) => j.id)));
  const [busy, setBusy] = useState(false);

  const toggle = (id) => setTicked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const archive = async () => {
    setBusy(true);
    try {
      const { archived } = await archiveJobsBulk([...ticked]);
      showToast?.(`Archived ${archived} project${archived === 1 ? '' : 's'}`, 'success');
      await onDone?.();
      onClose();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="Clean up past projects"
      subtitle="Every project whose last scheduled day has passed"
      onClose={onClose}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || ticked.size === 0} onClick={archive}>
            {busy ? 'Archiving…' : `Archive selected (${ticked.size})`}
          </button>
        </>
      }
    >
      <div className="rl-sub" style={{ lineHeight: 1.5, marginBottom: 10 }}>
        Tick the ones to archive. They drop off the project list but are not
        deleted, and can be restored from the classic interface.
      </div>
      <div className="np-actions" style={{ marginTop: 0, marginBottom: 6 }}>
        <button className="btn" onClick={() => setTicked(new Set(jobs.map((j) => j.id)))}>Select all</button>
        <button className="btn" onClick={() => setTicked(new Set())}>Select none</button>
        <span className="rl-sub">{ticked.size} of {jobs.length} selected</span>
      </div>
      {jobs.length === 0 && <div className="rl-sub">No past projects — all caught up.</div>}
      {jobs.map((j) => (
        <label key={j.id} className="cert-row" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={ticked.has(j.id)} onChange={() => toggle(j.id)} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              <strong>{j.code}</strong>{j.job_number ? ` · ${j.job_number}` : ''} — {j.name}
            </div>
            <div className="rl-sub">
              {[
                j.client,
                j.roster_start ? `${fmtShort(j.roster_start)} → ${fmtShort(j.roster_end)}` : `ended ${fmtShort(j.roster_end)}`,
              ].filter(Boolean).join(' · ')}
            </div>
          </span>
        </label>
      ))}
    </Drawer>
  );
}
