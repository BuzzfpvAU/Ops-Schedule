import React, { useEffect, useState } from 'react';
import { fmtShort } from '../lib/dates.js';

// The transport list for the window, plus kit that has not moved in a month.
export default function MovesStrip({ moves, checks, idle, names, onSelect }) {
  const [open, setOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem('eq.strip') || '{}'); } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem('eq.strip', JSON.stringify(open)); } catch { /* storage unavailable */ } }, [open]);
  const tight = moves.filter((m) => m.tight).length;
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  return (
    <div className="moves">
      <div className="moves-head">
        <button type="button" className={`chip${open.moves ? ' is-active' : ''}`} onClick={() => toggle('moves')}>
          🚚 Moves ({moves.length + checks.length}){tight ? <span className="moves-tight"> · {tight} tight</span> : null}
          {checks.length ? <span className="moves-tight"> · {checks.length} ⚠</span> : null}
        </button>
        <button type="button" className={`chip${open.idle ? ' is-active' : ''}`} onClick={() => toggle('idle')}>
          💤 Sitting idle ({idle.length})
        </button>
      </div>
      {open.moves && (
        <div className="moves-list">
          {checks.length + moves.length === 0 && <div className="rl-sub">Nothing needs moving in this window.</div>}
          {checks.map((c) => (
            <button type="button" key={`${c.itemId}-${c.kind}`} className="moves-row is-tight" onClick={() => onSelect(c.itemId)}>
              ⚠ <strong>{names.get(c.itemId)}</strong> {c.kind === 'not_at_site' ? 'not at site' : 'not returned'} — {c.text}
            </button>
          ))}
          {moves.map((m) => (
            <button type="button" key={`${m.itemId}-${m.dueBy}-${m.to.jobId}`} className={`moves-row${m.tight ? ' is-tight' : ''}`}
              onClick={() => onSelect(m.itemId)}>
              <strong>{names.get(m.itemId)}</strong> · {m.from.label} → {m.to.label}
              {m.leaveAfter ? ` · leave after ${fmtShort(m.leaveAfter)}` : ''} · due {fmtShort(m.dueBy)}
              {' · '}{m.km != null ? `~${m.km.toLocaleString()} km · ${m.gapDays} day${m.gapDays === 1 ? '' : 's'}${m.tight ? ` (needs ${m.needDays})` : ''}` : 'distance unknown'}
            </button>
          ))}
        </div>
      )}
      {open.idle && (
        <div className="moves-list">
          {idle.length === 0 && <div className="rl-sub">Everything has been used in the last 30 days or is booked in the next 30.</div>}
          {idle.map((r) => (
            <button type="button" key={r.id} className="moves-row" onClick={() => onSelect(r.id)}>
              <strong>{r.item.name}</strong> · {r.loc.label} · {r.lastUsed ? `last used ${fmtShort(r.lastUsed)}` : 'not used in 30 days'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
