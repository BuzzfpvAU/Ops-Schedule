import React from 'react';
import { fmtShort } from '../lib/dates.js';

// "What is free, and where" — the window everything on the Equipment tab is
// judged against.
export default function PlanningBar({ plan, onPlan, win, counts }) {
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
      <span className="plan-summary">
        <span className="tag tag-ok">{counts.free} free</span>
        <span className="tag tag-warn">{counts.partial} part free</span>
        <span className="tag tag-danger">{counts.booked} booked</span>
        {counts.unserviceable > 0 && <span className="tag tag-mute">{counts.unserviceable} U/S</span>}
      </span>
    </div>
  );
}
