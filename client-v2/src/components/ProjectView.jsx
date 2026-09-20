import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Timeline from './Timeline.jsx';
import { Drawer, Section, KV, Avatar } from './ui.jsx';
import {
  JOB_STATUSES, STATUSES, getJobPlanner, addJobDayNote, deleteJobDayNote,
} from '../api.js';
import { buildBars, layoutLanes } from '../lib/model.js';
import { diffDays, fmtShort, fmtLong } from '../lib/dates.js';

// ── View 4: one project in detail ───────────────────────────────────────
//
// Crew and equipment on the same timeline, with the day-by-day log that the
// other views have no room for: dispatched, tracking number, arrived. Notes
// live against a (row, day) cell and are append-only, so the history of a
// movement survives instead of being overwritten by the next update.
//
// Bookings on OTHER jobs are drawn faintly on the same rows, because the
// question being asked here is usually "can this person or this kit actually
// be where I need it".

export default function ProjectView({
  jobId, onBack, days, zoom, labelWidth, scrollCmd, onReachEdge,
  currentUser, onEnsureRange, showToast,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [cell, setCell] = useState(null); // { row, date }
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const isViewer = !!currentUser?.isViewer;
  const windowStart = days[0];
  const windowEnd = days[days.length - 1];

  const load = useCallback(async () => {
    try {
      const d = await getJobPlanner(jobId, windowStart, windowEnd);
      setData(d);
      setError('');
      return d;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, [jobId, windowStart, windowEnd]);

  useEffect(() => { load(); }, [load]);

  // Bring the job's own dates into the loaded window, so opening a project
  // that sits outside the current view does not show an empty grid.
  useEffect(() => {
    const span = data?.span;
    if (span?.start && span?.end) onEnsureRange?.(span.start, span.end);
  }, [data?.span?.start, data?.span?.end, onEnsureRange]);

  const dayIndex = useMemo(() => {
    const m = new Map();
    days.forEach((d, i) => m.set(d, i));
    return m;
  }, [days]);

  const clip = (start, end) => {
    if (!start || !end || start > windowEnd || end < windowStart) return null;
    const from = start < windowStart ? windowStart : start;
    const to = end > windowEnd ? windowEnd : end;
    const startIdx = dayIndex.get(from);
    if (startIdx === undefined) return null;
    return { startIdx, span: diffDays(from, to) + 1 };
  };

  // Notes keyed by "entity|date" for the marker, and by entity for counting.
  const notesByCell = useMemo(() => {
    const m = new Map();
    for (const n of data?.day_notes || []) {
      const key = `${n.entity_id}|${n.date}`;
      const list = m.get(key);
      if (list) list.push(n);
      else m.set(key, [n]);
    }
    return m;
  }, [data]);

  const buildRow = (r, kind) => {
    const bars = [];

    // This job's own days.
    for (const run of buildBars(r.entries || [], (e) => e.status || 'tentative')) {
      const geo = clip(run.start, run.end);
      if (geo) bars.push({ ...geo, key: `own-${r.id}-${run.start}`, kind: 'own', run, row: r });
    }
    // Everything else they are committed to, drawn faintly.
    for (const run of buildBars(r.otherEntries || [], (e) => e.job_id)) {
      const geo = clip(run.start, run.end);
      if (geo) bars.push({ ...geo, key: `other-${r.id}-${run.start}`, kind: 'other', run, row: r });
    }

    const laid = layoutLanes(bars);
    return {
      id: r.id,
      entity: r,
      kind,
      bars: laid.bars,
      lanes: laid.lanes,
      noteCount: (data?.day_notes || []).filter((n) => n.entity_id === r.id).length,
    };
  };

  const groups = useMemo(() => {
    if (!data) return [];
    const out = [];
    const people = (data.people || []).map((r) => buildRow(r, 'person'));
    const equipment = (data.equipment || []).map((r) => buildRow(r, 'equipment'));
    // Kit assigned to the job but with no days booked yet — it still needs a
    // row, because that is exactly what you want to leave a note against.
    const unbooked = (data.unbooked || []).map((r) =>
      buildRow({ ...r, entries: [], otherEntries: [] }, 'unbooked'));

    if (people.length) out.push({ key: 'crew', label: `Crew`, rows: people });
    if (equipment.length) out.push({ key: 'equipment', label: 'Equipment', rows: equipment });
    if (unbooked.length) {
      out.push({
        key: 'unbooked',
        label: 'Kit not yet booked',
        rows: unbooked,
        meta: <span className="tag tag-warn" style={{ marginLeft: 6 }}>no dates</span>,
      });
    }
    return out;
  }, [data, dayIndex, windowStart, windowEnd]);

  const openCell = (row, date) => {
    setDraft('');
    setCell({ row, date });
  };

  const cellNotes = cell ? (notesByCell.get(`${cell.row.id}|${cell.date}`) || []) : [];

  const addNote = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await addJobDayNote(jobId, { entity_id: cell.row.id, date: cell.date, text: draft.trim() });
      setDraft('');
      await load();
      showToast?.('Note added', 'success');
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeNote = async (id) => {
    setBusy(true);
    try {
      await deleteJobDayNote(id);
      await load();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const renderLabel = (row) => {
    const e = row.entity;
    return (
      <>
        {row.kind === 'person'
          ? <Avatar name={e.name} color={e.color} />
          : <span className="swatch" style={{ background: e.color || '#475569' }} />}
        <span className="rl">
          <span className="rl-top">
            <span className="rl-name">{e.name}</span>
            {e.allocation_status === 'confirmed' && <span className="tag tag-ok">✓</span>}
            {row.noteCount > 0 && (
              <span className="tag tag-mute" title={`${row.noteCount} note${row.noteCount === 1 ? '' : 's'}`}>
                {row.noteCount}
              </span>
            )}
          </span>
          <span className="rl-sub">
            {[e.role || e.category, e.days ? `${e.days}d` : null].filter(Boolean).join(' · ')}
          </span>
        </span>
      </>
    );
  };

  const renderBar = (bar) => {
    if (bar.kind === 'other') {
      const o = bar.run.sample;
      return (
        <div
          className="bar is-ghost"
          style={{ color: o.job_color || '#8d9bb0', opacity: 0.75, pointerEvents: 'none' }}
          title={`Also booked: ${o.job_code} — ${o.job_name}\n${fmtLong(bar.run.start)} → ${fmtLong(bar.run.end)}`}
        >
          <span className="bar-text">{o.job_code}</span>
        </div>
      );
    }
    const status = bar.run.sample.status || 'tentative';
    const meta = STATUSES[status] || STATUSES.tentative;
    const colour = status === 'confirmed' || status === 'tentative'
      ? (data?.job?.color || '#3b82f6')
      : meta.color;
    return (
      // No click handler: the click falls through to the day cell underneath,
      // so clicking a bar opens the log for the day you actually clicked
      // rather than for the day the bar happens to start.
      <div
        className={`bar${status === 'tentative' ? ' is-tentative' : ''}`}
        style={{ background: colour, pointerEvents: 'none' }}
        title={`${meta.label}\n${fmtLong(bar.run.start)} → ${fmtLong(bar.run.end)}`}
      >
        <span className="bar-text">
          {meta.label} · {fmtShort(bar.run.start)}–{fmtShort(bar.run.end)}
        </span>
      </div>
    );
  };

  // Note markers sit under the bars so a day carrying a log entry is visible
  // without opening anything.
  const renderOverlay = (row) => {
    const marks = [];
    for (const [key, list] of notesByCell) {
      const [entityId, date] = key.split('|');
      if (entityId !== row.id) continue;
      const idx = dayIndex.get(date);
      if (idx === undefined) continue;
      marks.push(
        <span
          key={key}
          className="note-mark"
          style={{ left: idx * zoom.colW, width: zoom.colW }}
          title={list.map((n) => `${n.text} — ${n.author_name || 'unknown'}`).join('\n')}
          onClick={(e) => { e.stopPropagation(); openCell(row, date); }}
        />
      );
    }
    return marks;
  };

  const job = data?.job;
  const st = job ? (JOB_STATUSES[job.status] || JOB_STATUSES.planning) : null;

  return (
    <>
      <div className="toolbar" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <button className="btn" onClick={onBack} title="Back to all projects">‹ Projects</button>
        {job && (
          <>
            <span className="rl-code">{job.code}</span>
            <strong style={{ fontSize: 13 }}>{job.name}</strong>
            <span className="tag" style={{ background: 'var(--line-soft)', color: st.color }}>{st.label}</span>
            {job.state && <span className="rl-sub">{job.state}</span>}
            <span className="rl-sub">
              {job.roster_start
                ? `${fmtShort(job.roster_start)} – ${fmtShort(job.roster_end)}`
                : 'nobody booked'}
            </span>
          </>
        )}
        <div className="toolbar-spacer" />
        <span className="rl-sub">Click any day to log a note</span>
        {data && <span className="count-pill">{(data.day_notes || []).length} notes</span>}
      </div>

      {error && <div className="banner banner-danger" style={{ margin: 12 }}>{error}</div>}
      {!data && !error && <div className="loading-screen">Loading project…</div>}

      {data && (
        <Timeline
          days={days}
          colW={zoom.colW}
          dayLabels={zoom.dayLabels}
          labelWidth={labelWidth}
          scrollCmd={scrollCmd}
          onReachEdge={onReachEdge}
          focusDate={data.span?.start || data.job?.planned_start || null}
          groups={groups}
          collapsed={collapsed}
          onToggleGroup={(k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))}
          renderLabel={renderLabel}
          renderBar={renderBar}
          renderOverlay={renderOverlay}
          onCellClick={(row, date) => openCell(row, date)}
          emptyMessage="Nobody and nothing is booked on this project yet."
        />
      )}

      {cell && (
        <Drawer
          title={cell.row.entity.name}
          subtitle={`${job?.code} · ${fmtLong(cell.date)}`}
          onClose={() => setCell(null)}
        >
          <Section title={`Day log (${cellNotes.length})`}>
            {cellNotes.length === 0 && (
              <div style={{ color: 'var(--text-mute)', fontSize: 12 }}>
                Nothing logged for this day yet.
              </div>
            )}
            {cellNotes.map((n) => (
              <div className="log-entry" key={n.id}>
                <div className="log-text">{n.text}</div>
                <div className="log-meta">
                  <span>{n.author_name || 'unknown'} · {n.created_at}</span>
                  {!isViewer && (
                    <button className="btn btn-danger" disabled={busy} onClick={() => removeNote(n.id)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </Section>

          {!isViewer && (
            <Section title="Add to the log">
              <textarea
                className="note-input"
                placeholder="e.g. Dispatched to KTA, tracking 12345"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') addNote();
                }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={addNote}>
                  Add note
                </button>
                <span className="rl-sub">⌘/Ctrl + Enter</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 10, lineHeight: 1.5 }}>
                The log only ever appends, so a movement keeps its history —
                dispatched one day, arrived the next.
              </div>
            </Section>
          )}

          {isViewer && <div className="banner banner-warn">Viewers cannot add notes.</div>}
        </Drawer>
      )}
    </>
  );
}
