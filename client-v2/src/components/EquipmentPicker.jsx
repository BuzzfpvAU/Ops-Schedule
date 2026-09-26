import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SearchBox } from './ui.jsx';
import { getEquipmentBookings, assignJobEquipment } from '../api.js';
import { addDays, diffDays, rangeOf, isWeekend, fmtShort } from '../lib/dates.js';
import { makeMatcher } from '../lib/search.js';

// ── Add equipment: search + a mini equipment timeline ───────────────────
//
// Finding kit by name alone hides the question that matters — is it free?
// Each candidate gets a strip of its bookings on other jobs around this
// job's dates, with the job window and the transit pads shaded across every
// row, so a clash is visible before anything is booked. Clashes are allowed
// (the rest of the app reports them rather than refusing), just flagged.

const CONTEXT_DAYS = 10; // shown either side of the booking
const MIN_SPAN = 28;

export default function EquipmentPicker({ jobId, window: win, equipment, assignedIds, onClose, onAdded, showToast }) {
  const [search, setSearch] = useState('');
  const [padB, setPadB] = useState(1);
  const [padA, setPadA] = useState(1);
  const [picked, setPicked] = useState(() => new Set());
  const [bookings, setBookings] = useState(null);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !search) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, search]);

  useEffect(() => { searchRef.current?.querySelector('input')?.focus(); }, []);

  // Days drawn: the booking plus context, stretched to a readable minimum.
  const days = useMemo(() => {
    if (!win) return [];
    let from = addDays(win.from, -CONTEXT_DAYS);
    let to = addDays(win.to, CONTEXT_DAYS);
    const short = MIN_SPAN - (diffDays(from, to) + 1);
    if (short > 0) {
      from = addDays(from, -Math.floor(short / 2));
      to = addDays(to, Math.ceil(short / 2));
    }
    return rangeOf(from, to);
  }, [win?.from, win?.to]);

  const first = days[0];
  const last = days[days.length - 1];

  useEffect(() => {
    if (!first || !last) { setBookings([]); return; }
    let alive = true;
    getEquipmentBookings(first, last)
      .then((b) => { if (alive) setBookings(b); })
      .catch((e) => { if (alive) { setBookings([]); showToast?.(e.message, 'error'); } });
    return () => { alive = false; };
  }, [first, last, showToast]);

  const need = win ? { from: addDays(win.from, -padB), to: addDays(win.to, padA) } : null;

  const byItem = useMemo(() => {
    const m = new Map();
    for (const b of bookings || []) {
      if (b.job_id === jobId) continue;
      const list = m.get(b.equipment_id);
      if (list) list.push(b); else m.set(b.equipment_id, [b]);
    }
    return m;
  }, [bookings, jobId]);

  const rows = useMemo(() => {
    const match = makeMatcher(search);
    return (equipment || [])
      .filter((e) => e.active !== 0 && !assignedIds.has(e.id))
      .filter((e) => match(e.name, e.equipment_category, e.serial_number, e.location))
      .map((e) => {
        const other = byItem.get(e.id) || [];
        const clashes = need
          ? other.filter((b) => b.booked_from <= need.to && b.booked_to >= need.from)
          : [];
        return { item: e, other, clashes };
      })
      .sort((a, z) =>
        (a.item.equipment_category || '').localeCompare(z.item.equipment_category || '') ||
        a.item.name.localeCompare(z.item.name));
  }, [equipment, assignedIds, search, byItem, need?.from, need?.to]);

  const total = (equipment || []).filter((e) => e.active !== 0 && !assignedIds.has(e.id)).length;

  // Percent geometry keeps the strip fitting the dialog at any width.
  const pct = (iso) => (diffDays(first, iso) / days.length) * 100;
  const span = (from, to) => {
    const a = from < first ? first : from;
    const b = to > last ? last : to;
    if (a > b) return null;
    return { left: `${pct(a)}%`, width: `${((diffDays(a, b) + 1) / days.length) * 100}%` };
  };

  const toggle = (id) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const add = async () => {
    setBusy(true);
    const clashing = [];
    let added = 0;
    try {
      for (const id of picked) {
        const r = await assignJobEquipment(jobId, { equipment_id: id, pad_before: padB, pad_after: padA });
        added += 1;
        if (r?.conflicts?.length) {
          const name = equipment.find((e) => e.id === id)?.name || 'Item';
          clashing.push(`${name} (${r.conflicts.map((c) => c.code).join(', ')})`);
        }
      }
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      await onAdded?.();
      setBusy(false);
    }
    if (clashing.length) showToast?.(`Added ${added} — clashing: ${clashing.join(', ')}`, 'error');
    else if (added) showToast?.(`Added ${added} item${added === 1 ? '' : 's'}`, 'success');
    if (added === picked.size) onClose();
  };

  const band = need && span(need.from, need.to);
  const core = win && span(win.from, win.to);
  const monthTicks = days.filter((d, i) => i === 0 || d.endsWith('-01'));

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="picker" role="dialog" aria-label="Add equipment">
        <header className="picker-head">
          <div className="drawer-title">Add equipment</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="picker-controls">
          <div ref={searchRef} style={{ flex: 1, minWidth: 180 }}>
            <SearchBox value={search} onChange={setSearch} placeholder="Search equipment…" found={rows.length} total={total} />
          </div>
          <div className="picker-pads" title="Transit buffer booked either side of the job">
            <span className="rl-sub">Transit</span>
            <PadInput label="before" value={padB} onChange={setPadB} />
            <PadInput label="after" value={padA} onChange={setPadA} />
          </div>
        </div>

        {!win && (
          <div className="banner banner-warn" style={{ margin: '0 16px 10px' }}>
            This job has no planned dates or crew yet, so added kit will not be booked.
            Set planned dates on the card to book it.
          </div>
        )}

        <div className="picker-grid">
          {win && (
            <div className="picker-row picker-axis">
              <div className="picker-name" />
              <div className="picker-strip">
                {days.map((d, i) => isWeekend(d) && (
                  <span key={d} className="picker-weekend" style={{ left: `${(i / days.length) * 100}%`, width: `${100 / days.length}%` }} />
                ))}
                {band && <span className="picker-band is-pad" style={band} />}
                {core && <span className="picker-band is-job" style={core} />}
                {monthTicks.map((d) => (
                  <span key={d} className="picker-tick" style={{ left: `${pct(d)}%` }}>{fmtShort(d)}</span>
                ))}
                {need && (
                  <span className="picker-need" style={{ left: `${pct(need.from < first ? first : need.from)}%` }}>
                    {fmtShort(need.from)} – {fmtShort(need.to)}
                  </span>
                )}
              </div>
            </div>
          )}

          {bookings === null && <div className="rl-sub" style={{ padding: 16 }}>Loading bookings…</div>}
          {bookings !== null && rows.length === 0 && (
            <div className="rl-sub" style={{ padding: 16 }}>{search ? 'Nothing matches.' : 'All equipment is already on this job.'}</div>
          )}

          {bookings !== null && rows.map(({ item, other, clashes }) => {
            const on = picked.has(item.id);
            return (
              <label key={item.id} className={`picker-row${on ? ' is-picked' : ''}`}>
                <div className="picker-name">
                  <input type="checkbox" checked={on} onChange={() => toggle(item.id)} />
                  <span className="rl" style={{ minWidth: 0 }}>
                    <span className="rl-name">{item.name}</span>
                    <span className="rl-sub">
                      {[item.equipment_category, item.location].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </span>
                  {item.serviceable === 0 && <span className="tag tag-warn" title="Marked unserviceable">U/S</span>}
                  {clashes.length > 0
                    ? <span className="tag tag-danger" title={clashes.map((c) => `${c.job_code} ${fmtShort(c.booked_from)}–${fmtShort(c.booked_to)}`).join('\n')}>clash</span>
                    : win && <span className="tag tag-ok">free</span>}
                </div>
                <div className="picker-strip">
                  {band && <span className="picker-band is-pad" style={band} />}
                  {core && <span className="picker-band is-job" style={core} />}
                  {on && band && <span className="picker-bar is-new" style={band} />}
                  {other.map((b) => {
                    const g = span(b.booked_from, b.booked_to);
                    if (!g) return null;
                    const clash = clashes.includes(b);
                    return (
                      <span
                        key={b.id}
                        className={`picker-bar${clash ? ' is-clash' : ''}`}
                        style={{ ...g, background: b.job_color || '#64748b' }}
                        title={`${b.job_code} — ${b.job_name}\n${fmtShort(b.booked_from)} – ${fmtShort(b.booked_to)}`}
                      >
                        {b.job_code}
                      </span>
                    );
                  })}
                </div>
              </label>
            );
          })}
        </div>

        <footer className="picker-foot">
          <span className="rl-sub">
            {picked.size
              ? `${picked.size} selected${need ? ` · books ${fmtShort(need.from)} – ${fmtShort(need.to)}` : ''}`
              : 'Tick the items to add'}
          </span>
          <div className="toolbar-spacer" />
          <span className="picker-legend">
            <span className="picker-key is-job" /> job
            <span className="picker-key is-pad" /> transit
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!picked.size || busy} onClick={add}>
            {busy ? 'Adding…' : picked.size ? `Add ${picked.size} item${picked.size === 1 ? '' : 's'}` : 'Add'}
          </button>
        </footer>
      </div>
    </>
  );
}

// Whole days, 0–30, with − / + so a buffer can be nudged without typing.
export function PadInput({ label, value, onChange, disabled }) {
  const set = (v) => onChange(Math.min(30, Math.max(0, v)));
  return (
    <span className="pad-input" title={`Transit days ${label} the job`}>
      <button type="button" className="pad-step" disabled={disabled || value <= 0} onClick={() => set(value - 1)} aria-label={`One less day ${label}`}>−</button>
      <span className="pad-val">{value}d</span>
      <button type="button" className="pad-step" disabled={disabled || value >= 30} onClick={() => set(value + 1)} aria-label={`One more day ${label}`}>+</button>
      <span className="pad-label">{label}</span>
    </span>
  );
}
