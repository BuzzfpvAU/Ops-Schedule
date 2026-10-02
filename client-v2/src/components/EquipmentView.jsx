import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import Timeline from './Timeline.jsx';
import PlanningBar from './PlanningBar.jsx';
// Leaflet is ~150 KB; load it only when the map is actually shown.
const EquipmentMapPanel = lazy(() => import('./EquipmentMapPanel.jsx'));
import { Drawer, Section, KV, Toggle, SearchBox } from './ui.jsx';
import {
  STATES, EQUIPMENT_CATEGORIES, adjustBooking, updateEquipment, createEquipment, getEquipmentLocations, getStaleDays,
  bookEquipmentOut, deleteScheduleEntry,
} from '../api.js';
import { buildBars, layoutLanes, groupByEntity, bucketBy, conflictDays, orderStatesFor, NON_WORK } from '../lib/model.js';
import { makeMatcher } from '../lib/search.js';
import { diffDays, fmtShort, fmtLong, addDays, today as todayIso } from '../lib/dates.js';
import {
  bookedIndex, outIndex, withOut, planWindow, availability, availText, resolveLocation, sortRows, summary, AVAIL_TONE, LAST_JOB_DAYS,
  jobRuns, movesFor, tagChecks, usagePct, isIdle, lastUsed, nearFilter, MOVE_LOOKAHEAD_DAYS, USAGE_DAYS,
} from '../lib/equipmentPlan.js';
import MovesStrip from './MovesStrip.jsx';

const PLAN_KEY = 'eq.plan';
function loadPlan() {
  try {
    const v = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
    if (v && ['7', '14', 'custom'].includes(v.preset)) return v;
  } catch { /* storage unavailable */ }
  return { preset: '14', freeOnly: false };
}

function stored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
const clampMap = (w) => Math.max(280, Math.min(900, Math.round(w)));

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
  const [outForm, setOutForm] = useState(null); // book-out drawer: { equipment_id, from, to, text }
  const [outSel, setOutSel] = useState(null); // an existing book-out: { item, run }
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(loadPlan);
  const [locations, setLocations] = useState([]);
  const [staleDays, setStaleDays] = useState(3);
  const [selectedId, setSelectedId] = useState(null);
  const [mapOpen, setMapOpen] = useState(() => stored('eq.mapOpen', true));
  const [mapWidth, setMapWidth] = useState(() => clampMap(stored('eq.mapWidth', window.innerWidth * 0.38)));
  const [pane, setPane] = useState('timeline'); // phone only: which half is showing
  useEffect(() => { store('eq.mapOpen', mapOpen); }, [mapOpen]);
  useEffect(() => { store('eq.mapWidth', mapWidth); }, [mapWidth]);

  const startDrag = (e) => {
    e.preventDefault();
    const move = (ev) => setMapWidth(clampMap(window.innerWidth - ev.clientX));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

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
    const back = addDays(win.from, -LAST_JOB_DAYS);
    const usageStart = addDays(todayIso(), -USAGE_DAYS);
    onEnsureRange?.(back < usageStart ? back : usageStart, addDays(win.to, MOVE_LOOKAHEAD_DAYS));
  }, [win.from, win.to, onEnsureRange]);

  const booked = useMemo(() => bookedIndex(schedule), [schedule]);
  const outDays = useMemo(() => outIndex(schedule), [schedule]);
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
        const avail = availability(item, withOut(booked.get(item.id), outDays.get(item.id)), win);
        const loc = resolveLocation(item, {
          ping: pingById.get(item.id), staleDays, booked: booked.get(item.id), jobsById, windowStart: win.from,
        });
        const itemBooked = booked.get(item.id);
        const jr = jobRuns(itemBooked);
        const today = todayIso();
        return {
          id: item.id, item, bars: laid.bars, lanes: laid.lanes, bookedDays, clash: clash.size > 0,
          avail, loc, minHeight: 72,
          moves: movesFor(item, { runs: jr, jobsById, win, today }),
          checks: tagChecks(item, { ping: pingById.get(item.id), staleDays, runs: jr, jobsById, today }),
          usage: usagePct(itemBooked, today),
          idle: isIdle(item, itemBooked, today),
          lastUsed: lastUsed(itemBooked, today),
        };
      })
      .filter(Boolean);

    const counts = summary(rows);
    const freeRows = plan.freeOnly ? rows.filter((r) => r.avail.status === 'free') : rows;
    const near = plan.near;
    const shown = near ? nearFilter(freeRows, near, near.radius) : freeRows;
    const strip = {
      moves: rows.flatMap((r) => r.moves).sort((a, b) => a.dueBy.localeCompare(b.dueBy)),
      checks: rows.flatMap((r) => r.checks),
      idle: rows.filter((r) => r.idle),
      names: new Map(rows.map((r) => [r.id, r.item.name])),
    };

    const keyOf = byHomeBase ? (r) => r.item.location : (r) => r.item.equipment_category;
    // Only the home-base grouping is state-based; the category grouping keeps
    // its own fixed order, which has nothing to do with where you are.
    const order = byHomeBase ? orderStatesFor(myState, STATES) : CATEGORY_ORDER;
    const fallback = byHomeBase ? 'No home base' : 'Uncategorised';

    const buckets = bucketBy(shown, keyOf, order, fallback).map((b) => ({
      key: b.key,
      label: b.key,
      // With Near on, rows arrive nearest-first; keep that order.
      rows: near ? b.rows : sortRows(b.rows),
      meta: b.rows.length ? (
        <span className="rl-sub" style={{ marginLeft: 6 }} title="Average share of the last 30 days booked">
          {Math.round(b.rows.reduce((n, r) => n + r.usage, 0) / b.rows.length)}% used
        </span>
      ) : null,
    }));
    return { buckets, counts, visible: shown, strip };
  }, [equipment, entriesByItem, outDays, assignmentFor, byHomeBase, onlyBooked, search, activeFilter, myState, dayIndex,
    windowStart, windowEnd, booked, win, pingById, staleDays, jobsById, plan.freeOnly, plan.near]);
  const groups = grouped.buckets;

  // What the map shows: exactly the rows the timeline is showing.
  const mapData = useMemo(() => {
    const points = [];
    const notOnMap = [];
    for (const r of grouped.visible) {
      if (r.loc.lat != null && r.loc.lng != null) {
        points.push({
          id: r.id, name: r.item.name, lat: r.loc.lat, lng: r.loc.lng, approx: r.loc.approx,
          tone: AVAIL_TONE[r.avail.status], source: r.loc.source,
        });
      } else {
        notOnMap.push({ id: r.id, name: r.item.name, label: r.loc.label.replace('📍 ', '') });
      }
    }
    const siteIds = new Set();
    for (const r of grouped.visible) {
      for (const [d, en] of booked.get(r.id) || []) if (d >= win.from && d <= win.to) siteIds.add(en.job_id);
    }
    const sites = [...siteIds].map((id) => jobsById.get(id))
      .filter((j) => j && Number.isFinite(j.site_lat) && Number.isFinite(j.site_lng))
      .map((j) => ({ code: j.code, lat: j.site_lat, lng: j.site_lng }));
    return { points, notOnMap, sites };
  }, [grouped.visible, booked, win.from, win.to, jobsById]);

  // The selected item's next move, drawn as an arrow on the map.
  const route = useMemo(() => {
    const m = grouped.strip.moves.find((x) => x.itemId === selectedId && x.from.lat != null && x.to.lat != null);
    if (!m) return null;
    return {
      from: m.from, to: m.to,
      label: `${m.leaveAfter ? `leave ${fmtShort(m.leaveAfter)} → ` : ''}due ${fmtShort(m.dueBy)}`,
    };
  }, [grouped, selectedId]);

  // One selection shared by the row list and the map.
  const onSelect = useCallback((id) => {
    setSelectedId(id);
    setPane((p) => (p === 'map' ? 'timeline' : p));
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

  // Adding uses the same drawer, blank, with the user's own state and the
  // most common category filled in.
  const openNew = () => {
    setEditing({ isNew: true });
    setForm({
      name: '', equipment_category: 'Drones', location: STATES.includes(myState) ? myState : '',
      serial_number: '', dimensions: '', weight: '', contents: '', info_url: '', sds_url: '', airtag_name: '',
      serviceable: true, active: true,
    });
  };

  const saveEditor = async () => {
    if (!form.name.trim()) {
      showToast?.('A name is required', 'error');
      return;
    }
    setBusy(true);
    try {
      if (editing.isNew) {
        const created = await createEquipment({ ...form, name: form.name.trim() });
        setEditing(null);
        await onChanged?.();
        // Show it straight away: selected on both panes, scrolled into view
        // once the refreshed list has rendered.
        setSelectedId(created.id);
        setTimeout(() => onSelect(created.id), 150);
        showToast?.(`${created.name} added`, 'success');
        return;
      }
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
          {row.loc.label}{row.distKm != null ? ` · ${row.distKm} km` : ''}
        </button>
        <span className="eq-chips">
          <span className={`tag tag-${AVAIL_TONE[row.avail.status]} eq-chip`}>{availText(row.avail)}</span>
          {row.moves.length > 0 && (
            <span className={`tag ${row.moves.some((m) => m.tight) ? 'tag-danger' : 'tag-warn'} eq-chip`}
              title={row.moves.map((m) => `${m.from.label} → ${m.to.label}, due ${fmtShort(m.dueBy)}`).join('\n')}>🚚</span>
          )}
          {row.checks.length > 0 && (
            <span className="tag tag-danger eq-chip" title={row.checks.map((c) => c.text).join('\n')}>⚠</span>
          )}
          <span className="rl-sub eq-usage">Used {row.usage}%</span>
        </span>
      </div>
    );
  };

  const openBookOut = (item, date) => {
    const from = date || todayIso();
    setOutForm({ equipment_id: item?.id || '', from, to: from, text: '' });
  };

  const submitBookOut = async () => {
    setBusy(true);
    try {
      const r = await bookEquipmentOut(outForm);
      setOutForm(null);
      await onChanged?.();
      showToast?.(`Booked out for ${r.days} day${r.days === 1 ? '' : 's'}`, 'success');
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeBookOut = async () => {
    setBusy(true);
    try {
      await Promise.all(outSel.run.entries.map((e) => deleteScheduleEntry(e.id)));
      setOutSel(null);
      await onChanged?.();
      showToast?.('Booking removed', 'success');
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const renderBar = (bar) => {
    const job = bar.run.sample;
    // Booked out for servicing or non-project work: the note is the label.
    if (NON_WORK.has(job.status)) {
      return (
        <div
          className={`bar${bar.conflict ? ' is-conflict' : ''}`}
          style={{ background: job.job_color || '#3b82f6' }}
          title={`Out of use: ${job.job_name}\n${fmtLong(bar.start)} → ${fmtLong(bar.end)}${bar.conflict ? '\n⚠ Overlaps another booking' : ''}`}
          onClick={(e) => { e.stopPropagation(); setOutSel({ item: bar.item, run: bar.run }); }}
        >
          <span className="bar-text">{job.job_name}</span>
        </div>
      );
    }
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
      <PlanningBar plan={plan} onPlan={setPlan} win={win} counts={grouped.counts} jobs={jobs} />
      <MovesStrip moves={grouped.strip.moves} checks={grouped.strip.checks} idle={grouped.strip.idle}
        names={grouped.strip.names} onSelect={onSelect} />
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
        {isAdmin && (
          <button type="button" className="btn" onClick={() => openBookOut(null)}
            title="Book kit out for servicing or non-project work">Book out</button>
        )}
        {isAdmin && (
          <button type="button" className="btn btn-primary" onClick={openNew}>+ Add equipment</button>
        )}
        <button type="button" className={`chip${mapOpen ? ' is-active' : ''}`} onClick={() => setMapOpen((v) => !v)}
          title={mapOpen ? 'Hide the map' : 'Show the map'}>🗺 Map</button>
        <span className="chips eq-pane-toggle" role="group" aria-label="Show">
          <button type="button" className={`chip${pane === 'timeline' ? ' is-active' : ''}`} onClick={() => setPane('timeline')}>Timeline</button>
          <button type="button" className={`chip${pane === 'map' ? ' is-active' : ''}`}
            onClick={() => { setMapOpen(true); setPane('map'); }}>Map</button>
        </span>
      </div>

      <div className={`eq-split${mapOpen ? '' : ' is-collapsed'}`} style={{ '--mapw': `${mapWidth}px` }} data-pane={pane}>
      <div className="eq-left">
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
        onCellClick={isAdmin ? (row, date) => openBookOut(row.item, date) : undefined}
        emptyMessage={plan.freeOnly ? 'Nothing is free for the whole window.' : 'No equipment matches these filters.'}
      />
      </div>
      {mapOpen && <div className="eq-divider" onPointerDown={startDrag} role="separator" aria-label="Resize map" />}
      {mapOpen && (
        <div className="eq-right">
          <Suspense fallback={<div className="eqm-broken">Loading map…</div>}>
            <EquipmentMapPanel
              points={mapData.points} sites={mapData.sites} notOnMap={mapData.notOnMap}
              selectedId={selectedId} onSelect={onSelect}
              route={route} near={plan.near || null}
            />
          </Suspense>
        </div>
      )}
      </div>

      {editing && form && (
        <Drawer
          title={editing.isNew ? 'New equipment' : editing.name}
          subtitle={editing.isNew ? 'Add an item to the register'
            : editing.active === 0 ? 'Inactive — hidden from the default list' : 'Equipment details'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !isAdmin} onClick={saveEditor}>
                {busy ? 'Saving…' : editing.isNew ? 'Add' : 'Save'}
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
                {!editing.isNew && (
                  <label className="opt" style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={form.active}
                      onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                    />
                    <span className="opt-name">Active</span>
                    <span className="opt-hint">in the register</span>
                  </label>
                )}
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

      {outForm && (
        <Drawer
          title="Book out"
          subtitle="Servicing or non-project work"
          onClose={() => setOutForm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setOutForm(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={busy || !outForm.equipment_id || !outForm.text.trim() || !outForm.from || !outForm.to || outForm.to < outForm.from}
                onClick={submitBookOut}
              >
                {busy ? 'Booking…' : 'Book out'}
              </button>
            </>
          }
        >
          <label className="form-row">
            <span className="form-label">Equipment</span>
            <select
              className="np-select"
              value={outForm.equipment_id}
              onChange={(e) => setOutForm((f) => ({ ...f, equipment_id: e.target.value }))}
            >
              <option value="">Choose an item…</option>
              {[...equipment].sort((a, b) => a.name.localeCompare(b.name)).map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </label>
          <label className="form-row">
            <span className="form-label">From</span>
            <input type="date" className="np-date" value={outForm.from}
              onChange={(e) => setOutForm((f) => ({ ...f, from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to }))} />
          </label>
          <label className="form-row">
            <span className="form-label">To (inclusive)</span>
            <input type="date" className="np-date" value={outForm.to} min={outForm.from}
              onChange={(e) => setOutForm((f) => ({ ...f, to: e.target.value }))} />
          </label>
          <label className="form-row">
            <span className="form-label">Note</span>
            <textarea
              className="note-input"
              rows={3}
              value={outForm.text}
              onChange={(e) => setOutForm((f) => ({ ...f, text: e.target.value }))}
              placeholder="e.g. Annual service at depot"
            />
          </label>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            The item shows as unavailable on these days, so it will not appear free in
            the planner and allocating it to a job flags a clash.
          </div>
        </Drawer>
      )}

      {outSel && (
        <Drawer
          title={outSel.item.name}
          subtitle="Booked out"
          onClose={() => setOutSel(null)}
          footer={isAdmin ? (
            <button className="btn btn-danger" disabled={busy} onClick={removeBookOut}>Remove booking</button>
          ) : null}
        >
          <Section title="Booking">
            <KV label="Note">{outSel.run.sample.job_name}</KV>
            <KV label="Out">{`${fmtLong(outSel.run.start)} → ${fmtLong(outSel.run.end)}`}</KV>
            <KV label="Days">{outSel.run.entries.length}</KV>
          </Section>
          {!isAdmin && <div className="banner banner-warn">Only admins can change bookings.</div>}
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
