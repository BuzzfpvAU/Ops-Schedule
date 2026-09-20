import React, { useMemo, useState } from 'react';
import Timeline from './Timeline.jsx';
import { Drawer, Section, KV, Toggle } from './ui.jsx';
import { STATES, adjustBooking } from '../api.js';
import { buildBars, layoutLanes, groupByEntity, bucketBy, conflictDays, orderStatesFor } from '../lib/model.js';
import { diffDays, fmtShort, fmtLong, addDays } from '../lib/dates.js';

const CATEGORY_ORDER = ['Drones', 'Payloads', 'Batteries', 'Survey Equip', 'Accessories', 'Spare Parts', 'Vehicles'];

// ── View 2: equipment availability and bookings ─────────────────────────
//
// Rows are equipment items; bars are the jobs they are booked to. The home
// base toggle switches the grouping between where an item lives (its state)
// and what kind of thing it is. Travel time is the pad either side of a
// booking — adjusting it here books or releases the actual days, which is
// what makes the item unavailable to another job while it is in transit.

export default function EquipmentView({
  equipment, schedule, bookings, days, zoom, labelWidth, myState, scrollCmd, onReachEdge, isAdmin, showToast, onChanged,
}) {
  const [collapsed, setCollapsed] = useState({});
  const [byHomeBase, setByHomeBase] = useState(true);
  const [onlyBooked, setOnlyBooked] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null); // { item, bar }
  const [busy, setBusy] = useState(false);

  const dayIndex = useMemo(() => {
    const m = new Map();
    days.forEach((d, i) => m.set(d, i));
    return m;
  }, [days]);

  const windowStart = days[0];
  const windowEnd = days[days.length - 1];

  const clip = (start, end) => {
    if (!start || !end || start > windowEnd || end < windowStart) return null;
    const from = start < windowStart ? windowStart : start;
    const to = end > windowEnd ? windowEnd : end;
    const startIdx = dayIndex.get(from);
    if (startIdx === undefined) return null;
    return { startIdx, span: diffDays(from, to) + 1 };
  };

  // Assignment metadata keyed by equipment+job, so a bar knows which
  // job_equipment row to adjust when travel time changes.
  const assignmentFor = useMemo(() => {
    const m = new Map();
    for (const b of bookings || []) m.set(`${b.equipment_id}|${b.job_id}`, b);
    return m;
  }, [bookings]);

  const entriesByItem = useMemo(() => groupByEntity(schedule), [schedule]);

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();

    const rows = equipment
      .filter((item) => {
        if (!term) return true;
        return (
          item.name?.toLowerCase().includes(term) ||
          item.serial_number?.toLowerCase().includes(term) ||
          item.role?.toLowerCase().includes(term)
        );
      })
      .map((item) => {
        const entries = entriesByItem.get(item.id) || [];
        // Split on job only — an item's booking is one continuous commitment
        // even if the job's own status changes partway through.
        const runs = buildBars(entries, (e) => e.job_id);
        const clash = conflictDays(runs);

        const bars = [];
        for (const run of runs) {
          const geo = clip(run.start, run.end);
          if (!geo) continue;
          const sample = run.sample;
          const assignment = assignmentFor.get(`${item.id}|${sample.job_id}`);
          const hasClash = run.entries.some((e) => clash.has(e.date));
          bars.push({
            ...geo,
            key: `${item.id}-${sample.job_id}-${run.start}`,
            run,
            item,
            assignment,
            conflict: hasClash,
            start: run.start,
            end: run.end,
          });
        }
        if (onlyBooked && !bars.length) return null;

        const laid = layoutLanes(bars);
        const bookedDays = runs.reduce((n, r) => n + r.entries.length, 0);
        return { id: item.id, item, bars: laid.bars, lanes: laid.lanes, bookedDays, clash: clash.size > 0 };
      })
      .filter(Boolean);

    const keyOf = byHomeBase ? (r) => r.item.location : (r) => r.item.equipment_category;
    // Only the home-base grouping is state-based; the category grouping keeps
    // its own fixed order, which has nothing to do with where you are.
    const order = byHomeBase ? orderStatesFor(myState, STATES) : CATEGORY_ORDER;
    const fallback = byHomeBase ? 'No home base' : 'Uncategorised';

    return bucketBy(rows, keyOf, order, fallback).map((b) => ({
      key: b.key,
      label: b.key,
      rows: b.rows.sort((a, z) => (a.item.name || '').localeCompare(z.item.name || '')),
    }));
  }, [equipment, entriesByItem, assignmentFor, byHomeBase, onlyBooked, search, myState, dayIndex, windowStart, windowEnd]);

  const adjust = async (edge, delta) => {
    const assignment = selected?.bar?.assignment;
    if (!assignment) {
      showToast?.('This booking has no equipment assignment on the job to adjust.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await adjustBooking(assignment.id, edge, delta);
      if (res.conflicts?.length) {
        showToast?.(
          `Travel time updated — now clashes with ${res.conflicts.map((c) => c.code).join(', ')}`,
          'error'
        );
      } else {
        showToast?.('Travel time updated', 'success');
      }
      setSelected(null);
      await onChanged?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const renderLabel = (row) => {
    const item = row.item;
    return (
      <>
        <span className="swatch" style={{ background: item.color || '#475569' }} />
        <span className="rl">
          <span className="rl-top">
            <span className="rl-name">{item.name}</span>
            {row.clash && <span className="tag tag-danger" title="Booked to more than one job on the same day">Clash</span>}
            {item.serviceable === 0 && <span className="tag tag-warn" title="Marked unserviceable">U/S</span>}
          </span>
          <span className="rl-sub">
            {[byHomeBase ? item.equipment_category : item.location, item.serial_number]
              .filter(Boolean)
              .join(' · ') || item.role}
          </span>
        </span>
        <span className="rl-sub" style={{ flex: 'none' }}>
          {row.bookedDays ? `${row.bookedDays}d` : 'free'}
        </span>
      </>
    );
  };

  const renderBar = (bar) => {
    const job = bar.run.sample;
    // Always the full text, truncated by CSS. Gating on day count was wrong:
    // the same span is 204px at day zoom and 72px at month zoom, so it hid
    // names that fit and showed names that did not.
    const label = `${job.job_code} · ${job.job_name}`;
    return (
      <div
        className={`bar${bar.conflict ? ' is-conflict' : ''}${bar.assignment?.status === 'confirmed' ? '' : ' is-tentative'}`}
        style={{ background: job.job_color || '#3b82f6' }}
        title={`${job.job_code} ${job.job_name}\n${fmtLong(bar.start)} → ${fmtLong(bar.end)}${
          bar.assignment ? `\nTravel pad: ${bar.assignment.pad_before}d before, ${bar.assignment.pad_after}d after` : ''
        }${bar.conflict ? '\n⚠ Overlaps another job' : ''}`}
        onClick={(e) => { e.stopPropagation(); setSelected({ item: bar.item, bar }); }}
      >
        <span className="bar-text">{label}</span>
      </div>
    );
  };

  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <>
      <div className="toolbar" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <Toggle checked={byHomeBase} onChange={setByHomeBase}>Group by home base</Toggle>
        <Toggle checked={onlyBooked} onChange={setOnlyBooked}>Booked only</Toggle>
        <label className="field">
          <input
            type="search"
            placeholder="Filter equipment…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="toolbar-spacer" />
        <div className="legend">
          <span className="legend-item">
            <span className="legend-key" style={{ background: '#3b82f6' }} /> Confirmed
          </span>
          <span className="legend-item">
            <span
              className="legend-key"
              style={{
                background: '#3b82f6',
                backgroundImage: 'repeating-linear-gradient(135deg, rgba(255,255,255,.3) 0 3px, transparent 3px 6px)',
              }}
            /> Tentative
          </span>
          <span className="legend-item">
            <span className="legend-key" style={{ background: 'transparent', outline: '1.5px solid var(--danger)' }} /> Clash
          </span>
        </div>
        <span className="count-pill">{totalRows} items</span>
      </div>

      <Timeline
        days={days}
        colW={zoom.colW}
        dayLabels={zoom.dayLabels}
        labelWidth={labelWidth}
        scrollCmd={scrollCmd}
        onReachEdge={onReachEdge}
        groups={groups}
        collapsed={collapsed}
        onToggleGroup={(k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))}
        renderLabel={renderLabel}
        renderBar={renderBar}
        emptyMessage="No equipment matches these filters."
      />

      {selected && (
        <Drawer
          title={selected.item.name}
          subtitle={`${selected.bar.run.sample.job_code} — ${selected.bar.run.sample.job_name}`}
          onClose={() => setSelected(null)}
        >
          {selected.bar.conflict && (
            <div className="banner banner-danger">
              This item is booked to more than one job on overlapping days. Trim one
              booking or swap in a different item.
            </div>
          )}

          <Section title="Booking">
            <KV label="Job">{`${selected.bar.run.sample.job_code} — ${selected.bar.run.sample.job_name}`}</KV>
            <KV label="Booked">{`${fmtLong(selected.bar.start)} → ${fmtLong(selected.bar.end)}`}</KV>
            <KV label="Days">{diffDays(selected.bar.start, selected.bar.end) + 1}</KV>
            <KV label="Allocation">{selected.bar.assignment?.status || 'tentative'}</KV>
            <KV label="Home base">{selected.item.location || '—'}</KV>
            <KV label="Serial">{selected.item.serial_number}</KV>
          </Section>

          <Section title="Travel time">
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.5 }}>
              Extending a booking reserves the extra days so nothing else can take
              this item while it is in transit. Trimming releases them.
            </div>

            {!isAdmin && (
              <div className="banner banner-warn">Only admins can change bookings.</div>
            )}

            <div className="stepper" style={{ marginBottom: 8 }}>
              <span className="stepper-label">
                Before — currently from {fmtShort(selected.bar.start)}
              </span>
              <button
                className="step-btn"
                disabled={!isAdmin || busy}
                onClick={() => adjust('start', -1)}
                title="Release the first day"
              >−</button>
              <button
                className="step-btn"
                disabled={!isAdmin || busy}
                onClick={() => adjust('start', 1)}
                title={`Reserve ${fmtShort(addDays(selected.bar.start, -1))} as travel`}
              >+</button>
            </div>

            <div className="stepper">
              <span className="stepper-label">
                After — currently to {fmtShort(selected.bar.end)}
              </span>
              <button
                className="step-btn"
                disabled={!isAdmin || busy}
                onClick={() => adjust('end', -1)}
                title="Release the last day"
              >−</button>
              <button
                className="step-btn"
                disabled={!isAdmin || busy}
                onClick={() => adjust('end', 1)}
                title={`Reserve ${fmtShort(addDays(selected.bar.end, 1))} as travel`}
              >+</button>
            </div>
          </Section>
        </Drawer>
      )}
    </>
  );
}
