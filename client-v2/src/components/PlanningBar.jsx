import React from 'react';
import { fmtShort } from '../lib/dates.js';
import { geocodePlace } from '../api.js';

// "What is free, and where" — the window everything on the Equipment tab is
// judged against.
export default function PlanningBar({ plan, onPlan, win, counts, jobs }) {
  const set = (patch) => onPlan({ ...plan, ...patch });
  return (
    <div className="plan-bar">
      <strong className="plan-title">Plan</strong>
      <div className="chips" role="group" aria-label="Planning window">
        {[['7', '7 days'], ['14', '14 days'], ['custom', 'Custom']].map(([v, l]) => (
          <button key={v} type="button" className={`chip${plan.preset === v ? ' is-active' : ''}`}
            onClick={() => set({ preset: v, from: plan.from || win.from, to: plan.to || win.to })}>{l}</button>
        ))}
      </div>
      {plan.preset === 'custom' ? (
        <span className="plan-dates">
          <input type="date" value={plan.from || win.from} onChange={(e) => set({ from: e.target.value })} aria-label="From" />
          –
          <input type="date" value={plan.to || win.to} onChange={(e) => set({ to: e.target.value })} aria-label="To" />
        </span>
      ) : (
        <span className="plan-dates">{fmtShort(win.from)} – {fmtShort(win.to)}</span>
      )}
      <label className="plan-free">
        <input type="checkbox" checked={!!plan.freeOnly} onChange={(e) => set({ freeOnly: e.target.checked })} /> Free only
      </label>
      <NearBox near={plan.near} jobs={jobs} onNear={(near) => set({ near })} />
      <span className="plan-summary">
        <span className="tag tag-ok">{counts.free} free</span>
        <span className="tag tag-warn">{counts.partial} part free</span>
        <span className="tag tag-danger">{counts.booked} booked</span>
        {counts.unserviceable > 0 && <span className="tag tag-mute">{counts.unserviceable} U/S</span>}
      </span>
    </div>
  );
}

const RADII = [100, 250, 500, 1000];

function NearBox({ near, jobs, onNear }) {
  const [text, setText] = React.useState('');
  const [msg, setMsg] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const options = (jobs || []).filter((j) => Number.isFinite(j.site_lat))
    .map((j) => ({ key: `${j.code} ${j.site_address || j.name}`, lat: j.site_lat, lng: j.site_lng }));

  const choose = async () => {
    const q = text.trim();
    if (!q) return;
    const job = options.find((o) => o.key.toLowerCase() === q.toLowerCase());
    if (job) { onNear({ label: job.key, lat: job.lat, lng: job.lng, radius: near?.radius || 500 }); setText(''); setMsg(''); return; }
    setBusy(true);
    try {
      const r = await geocodePlace(q);
      if (r.found) { onNear({ label: r.label, lat: r.lat, lng: r.lng, radius: near?.radius || 500 }); setText(''); setMsg(''); }
      else setMsg(`Couldn't find "${q}" — try a nearby town or pick a job`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (near) {
    return (
      <span className="near">
        <span className="near-label">Near <strong>{near.label}</strong></span>
        {RADII.map((r) => (
          <button key={r} type="button" className={`chip${near.radius === r ? ' is-active' : ''}`}
            onClick={() => onNear({ ...near, radius: r })}>{r} km</button>
        ))}
        <button type="button" className="chip" onClick={() => onNear(null)} aria-label="Clear near">✕</button>
      </span>
    );
  }
  return (
    <span className="near">
      <input list="near-jobs" value={text} placeholder="Near a job or town…" aria-label="Near"
        onChange={(e) => {
          setText(e.target.value);
          const job = options.find((o) => o.key === e.target.value);
          if (job) { onNear({ label: job.key, lat: job.lat, lng: job.lng, radius: 500 }); setText(''); }
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') choose(); }} />
      <datalist id="near-jobs">{options.map((o) => <option key={o.key} value={o.key} />)}</datalist>
      <button type="button" className="chip" disabled={busy || !text.trim()} onClick={choose}>{busy ? '…' : 'Find'}</button>
      {msg && <span className="near-msg">{msg}</span>}
    </span>
  );
}
