import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Timeline from './Timeline.jsx';
import PlanningBar from './PlanningBar.jsx';
import { Drawer, Section, KV, Toggle, SearchBox } from './ui.jsx';
import {
  STATES, EQUIPMENT_CATEGORIES, adjustBooking, updateEquipment, getEquipmentLocations, getStaleDays,
} from '../api.js';
import { buildBars, layoutLanes, groupByEntity, bucketBy, conflictDays, orderStatesFor } from '../lib/model.js';
import { makeMatcher } from '../lib/search.js';
import { diffDays, fmtShort, fmtLong, addDays, today as todayIso } from '../lib/dates.js';
import {
  bookedIndex, planWindow, availability, availText, resolveLocation, sortRows, summary, AVAIL_TONE, LAST_JOB_DAYS,
} from '../lib/equipmentPlan.js';

const PLAN_KEY = 'eq.plan';
function loadPlan() {
  try {
    const v = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
    if (v && ['7', '14', 'custom'].includes(v.preset)) return v;
  } catch { /* storage unavailable */ }
  return { preset: '14', freeOnly: false };
}

const CATEGORY_ORDER = EQUIPMENT_CATEGORIES;

// ── View 2: equipment availability and bookings ─────────────────────────
//
// Rows are equipment items; bars are the jobs they are booked to. The home
// base toggle switches the grouping between where an item lives (its state)
// and what kind of thing it is. Travel time is the pad either side of a
// booking — adjusting it here books or releases the actual days, which is
// what makes the item unavailable to another job while it is in transit.

export default function EquipmentView({
  equipment, schedule, bookings, days, zoom, labelWidth, myState, scrollCmd, onReachEdge,
  isAdmin, activeFilter, onActiveFilter, showToast, onChanged, jobs = [], onEnsureRange,
}) {
  const [collapsed, setCollapsed] = useState({});
  const [byHomeBase, setByHomeBase] = useState(true);
  const [onlyBooked, setOnlyBooked] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null); // { item, bar }
  const [editing, setEditing] = useState(null); // the item whose details are open
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(loadPlan);
  const [locations, setLocations] = useState([]);
  const [staleDays, setStaleDays] = useState(3);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    try { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch { /* storage unavailable */ }
  }, [plan]);

  useEffect(() => {
    getEquipmentLocations().then(setLocations).catch(() => setLocations([]));
    getStaleDays().then((r) => setStaleDays(r.stale_days || 3)).catch(() => {});
  }, []);

  const win = useMemo(
    () => planWindow(plan.preset, todayIso(), { from: plan.from, to: plan.to }),
    [plan.preset, plan.from, plan.to]
  );
  // The last-job rule looks back before the window, so make sure that
  // history is loaded too.
  useEffect(() => {
    onEnsureRange?.(addDays(win.from, -LAST_JOB_DAYS), win.to);
  }, [win.from, win.to, onEnsureRange]);

  const booked = useMemo(() => bookedIndex(schedule), [schedule]);
  const jobsById = useMemo(() => new Map((jobs || []).map((j) => [j.id, j])), [jobs]);
  const pingById = useMemo(
    () => new Map((locations || []).filter((l) => l.seen_at).map((l) => [l.id, l])),
    [locations]
  );

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

  const grouped = useMemo(() => {
    const match = makeMatcher(search);

    const rows = equipment
      .filter((item) => {
        if (activeFilter === 'active') return item.active !== 0;
        if (activeFilter === 'inactive') return item.active === 0;
        return true;
      })
      .filter((item) => match(
        item.name, item.serial_number, item.role,
        item.equipment_category, item.location, item.airtag_name,
      ))
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
        const avail = availability(item, booked.get(item.id), win);
        const loc = resolveLocation(item, {
          ping: pingById.get(item.id), staleDays, booked: booked.get(item.id), jobsById, windowStart: win.from,
        });
        return {
          id: item.id, item, bars: laid.bars, lanes: laid.lanes, bookedDays, clash: clash.size > 0,
          avail, loc, minHeight: 72,
        };
      })
      .filter(Boolean);

    const counts = summary(rows);
    const shown = plan.freeOnly ? rows.filter((r) => r.avail.status === 'free') : rows;

    const keyOf = byHomeBase ? (r) => r.item.location : (r) => r.item.equipment_category;
    // Only the home-base grouping is state-based; the category grouping keeps
    // its own fixed order, which has nothing to do with where you are.
    const order = byHomeBase ? orderStatesFor(myState, STATES) : CATEGORY_ORDER;
    const fallback = byHomeBase ? 'No home base' : 'Uncategorised';

    const buckets = bucketBy(shown, keyOf, order, fallback).map((b) => ({
      key: b.key,
      label: b.key,
      rows: sortRows(b.rows),
    }));
    return { buckets, counts, visible: shown };
  }, [equipment, entriesByItem, assignmentFor, byHomeBase, onlyBooked, search, activeFilter, myState, dayIndex,
    windowStart, windowEnd, booked, win, pingById, staleDays, jobsById, plan.freeOnly]);
  const groups = grouped.buckets;

  // One selection shared by the row list and the map.
  const onSelect = useCallback((id) => {
    setSelectedId(id);
    document.querySelector(`[data-row-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

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

  const openEditor = (item) => {
    setEditing(item);
    setForm({
      name: item.name || '',
      equipment_category: item.equipment_category || '',
      location: item.location || '',
      serial_number: item.serial_number || '',
      dimensions: item.dimensions || '',
      weight: item.weight || '',
      contents: item.contents || '',
      info_url: item.info_url || '',
      sds_url: item.sds_url || '',
      airtag_name: item.airtag_name || '',
      serviceable: item.serviceable !== 0,
      active: item.active !== 0,
    });
  };

  const saveEditor = async () => {
    if (!form.name.trim()) {
      showToast?.('A name is required', 'error');
      return;
    }
    setBusy(true);
    try {
      await updateEquipment(editing.id, { ...form, name: form.name.trim() });
      setEditing(null);
      await onChanged?.();
      showToast?.('Equipment updated', 'success');
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // Deactivating from the list is the common case, so it does not require
  // opening the editor — but it does warn when the item still has bookings,
  // since those do not disappear with it.
  const setActive = async (item, next, bookedDays) => {
    if (!next && bookedDays > 0) {
      const ok = window.confirm(
        `${item.name} is booked on ${bookedDays} day${bookedDays === 1 ? '' : 's'} in this window.\n\n` +
        'Marking it inactive hides it from the list but leaves those bookings in place. Continue?'
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await updateEquipment(item.id, { active: next });
      await onChanged?.();
      showToast?.(next ? `${item.name} reactivated` : `${item.name} marked inactive`, 'success');
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

  const renderLabel = (row) => {
    const item = row.item;
    const inactive = item.active === 0;
    return (
      <div className={`eq-label${row.id === selectedId ? ' is-selected' : ''}`}>
        <span className="swatch" style={{ background: item.color || '#475569' }} />
        <button
          type="button"
          className={`rl rl-button${inactive ? ' is-inactive' : ''}`}
          onClick={() => openEditor(item)}
          title="Edit this item"
        >
          <span className="rl-top">
            <span className="rl-name">{item.name}</span>
            {inactive && <span className="tag tag-mute">inactive</span>}
            {row.clash && <span className="tag tag-danger" title="Booked to more than one job on the same day">Clash</span>}
            {item.serviceable === 0 && <span className="tag tag-warn" title="Marked unserviceable">U/S</span>}
          </span>
          <span className="rl-sub">
            {[byHomeBase ? item.equipment_category : item.location, item.serial_number]
              .filter(Boolean)
              .join(' · ') || item.role}
          </span>
        </button>
        <button type="button" className="rl-loc" onClick={() => onSelect(row.id)} title="Show on map">
          {row.loc.label}
        </button>
        <span className={`tag tag-${AVAIL_TONE[row.avail.status]} eq-chip`}>{availText(row.avail)}</span>
      </div>
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
      <PlanningBar plan={plan} onPlan={setPlan} win={win} counts={grouped.counts} />
      <div className="toolbar" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <div className="chips" role="group" aria-label="Filter by status">
          {[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']].map(([v, l]) => (
            <button
              key={v}
              type="button"
              className={`chip${activeFilter === v ? ' is-active' : ''}`}
              onClick={() => onActiveFilter?.(v)}
              title={v === 'all' ? 'Everything, including items marked inactive' : `${l} equipment only`}
            >
              {l}
            </button>
          ))}
        </div>

        <Toggle checked={byHomeBase} onChange={setByHomeBase}>Group by home base</Toggle>
        <Toggle checked={onlyBooked} onChange={setOnlyBooked}>Booked only</Toggle>
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search equipment…"
          found={totalRows}
          total={equipment.length}
        />
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
        highlight={win}
        emptyMessage={plan.freeOnly ? 'Nothing is free for the whole window.' : 'No equipment matches these filters.'}
      />

      {editing && form && (
        <Drawer
          title={editing.name}
          subtitle={editing.active === 0 ? 'Inactive — hidden from the default list' : 'Equipment details'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !isAdmin} onClick={saveEditor}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
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

            <Section title="Links">
              {field('info_url', 'Info / manual', { type: 'url', placeholder: 'https://…' })}
              {field('sds_url', 'Safety data sheet', { type: 'url', placeholder: 'https://…' })}
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
                <label className="opt" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                  />
                  <span className="opt-name">Active</span>
                  <span className="opt-hint">in the register</span>
                </label>
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
      )}

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

          <Section title="Item">
            <div className="entry-row">
              <span className="entry-name">{selected.item.name}</span>
              <button className="btn" disabled={busy} onClick={() => openEditor(selected.item)}>Edit</button>
              {isAdmin && (
                <button
                  className={selected.item.active === 0 ? 'btn' : 'btn btn-danger'}
                  disabled={busy}
                  onClick={() => setActive(selected.item, selected.item.active === 0, selected.bar ? 1 : 0)}
                >
                  {selected.item.active === 0 ? 'Reactivate' : 'Mark inactive'}
                </button>
              )}
            </div>
          </Section>

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
