import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getJobPlanner, STATUSES,
  assignSchedule, bulkAssignSchedule, deleteScheduleEntry, moveScheduleEntries,
} from '../api.js';
import { JOB_STATUSES, fmtDateShort } from './JobCard.jsx';

// ── Project planner ────────────────────────────────────────────
// Full-size, job-scoped slice of the schedule: one row per person /
// equipment item with roster entries on the job (crew + equipment in
// one scrolling grid), day columns across the job's span, other
// bookings shown faintly so conflicts are obvious, and the same
// drag/resize editing as the main schedule (admins).

const MAX_DAYS = 400;
const PAD_BEFORE = 7;   // extra draggable days before the span
const PAD_AFTER = 14;   // extra draggable days after the span
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isoOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDaysISO(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

function statusOf(key) {
  return STATUSES[key] || STATUSES.tentative;
}

// Consecutive runs of this-job entries per row (for drag move / edge resize)
function runsOf(entries) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1));
  const runs = [];
  let cur = null;
  for (const e of sorted) {
    if (cur && addDaysISO(cur.lastDate, 1) === e.date) {
      cur.entries.push(e);
      cur.lastDate = e.date;
    } else {
      cur = { entries: [e], firstDate: e.date, lastDate: e.date };
      runs.push(cur);
    }
  }
  return runs;
}

export default function JobPlanner({ jobId, onBack, onOpenCard, currentUser, onScheduleRefresh, showToast }) {
  const isAdmin = !!currentUser?.isAdmin;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState({ people: false, equipment: false });
  const [pop, setPop] = useState(null); // { rowId, date, x, y } day popover
  const [dragUI, setDragUI] = useState(null); // { rowId, startIdx, endIdx }
  const [resizeUI, setResizeUI] = useState(null); // { rowId, startIdx, endIdx }
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const dataRef = useRef(null);
  const daysRef = useRef([]);
  const toast = (msg, kind) => showToast?.(msg, kind || 'error');

  const load = useCallback(async () => {
    const d = await getJobPlanner(jobId);
    setData(d);
    return d;
  }, [jobId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    getJobPlanner(jobId)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message || 'Failed to load'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [jobId]);

  const days = useMemo(() => {
    if (!data) return [];
    let start = data.span?.start || null;
    let end = data.span?.end || null;
    if (!start) { start = data.job.planned_start || null; end = data.job.planned_end || start; }
    if (!start || !end) return [];
    const out = [];
    let cur = addDaysISO(start, -PAD_BEFORE);
    const stop = addDaysISO(end, PAD_AFTER);
    while (cur <= stop && out.length < MAX_DAYS) { out.push(cur); cur = addDaysISO(cur, 1); }
    return out;
  }, [data]);

  const spanDays = useMemo(() => {
    if (!data?.span) return days.length;
    return Math.round((parseISO(data.span.end) - parseISO(data.span.start)) / 86400000) + 1;
  }, [data, days]);

  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { daysRef.current = days; }, [days]);
  useEffect(() => () => { document.body.style.cursor = ''; document.body.style.userSelect = ''; }, []);

  const finishEdit = async () => {
    setBusy(false);
    try { await load(); } catch { /* keep old view */ }
    onScheduleRefresh?.();
  };

  // Global drag / resize handling for the grid
  useEffect(() => {
    const onMove = (e) => {
      const r = dragRef.current;
      if (r) {
        if (Math.abs(e.clientX - r.startX) > 4) r.moved = true;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const cell = el && el.closest ? el.closest('[data-jp-date]') : null;
        if (r.moved && cell && cell.dataset.jpRow === r.rowId) {
          const idx = Number(cell.dataset.jpIdx);
          const n = daysRef.current.length;
          const startIdx = Math.max(0, Math.min(n - r.spanLen, idx - r.grabIdx));
          r.lastStartIdx = startIdx;
          setDragUI({ rowId: r.rowId, startIdx, endIdx: startIdx + r.spanLen - 1 });
        }
        return;
      }
      const rz = resizeRef.current;
      if (rz) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const cell = el && el.closest ? el.closest('[data-jp-date]') : null;
        if (cell && cell.dataset.jpRow === rz.rowId) {
          const idx = Number(cell.dataset.jpIdx);
          if (rz.edge === 'right') rz.curEnd = Math.max(rz.origStart, idx);
          else rz.curStart = Math.min(rz.origEnd, idx);
          setResizeUI({ rowId: rz.rowId, startIdx: rz.curStart, endIdx: rz.curEnd });
        }
      }
    };

    const onUp = async () => {
      const r = dragRef.current;
      const rz = resizeRef.current;
      dragRef.current = null;
      resizeRef.current = null;
      setDragUI(null);
      setResizeUI(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      if (r) {
        if (r.moved && r.lastStartIdx != null && r.lastStartIdx !== r.startIdx) {
          setBusy(true);
          try {
            await moveScheduleEntries(r.entryIds, r.rowId, daysRef.current[r.lastStartIdx]);
            await finishEdit();
          } catch (err) { setBusy(false); toast('Move failed: ' + err.message, 'error'); }
        } else if (!r.moved) {
          // plain click on a day bar → day popover
          setPop({ rowId: r.rowId, date: r.clickDate, x: r.clickX, y: r.clickY });
        }
        return;
      }

      if (rz) {
        const daysArr = daysRef.current;
        const d = dataRef.current;
        const row = [...(d.people || []), ...(d.equipment || [])].find((x) => x.id === rz.rowId);
        if (!row) return;
        const origDates = [];
        for (let i = rz.origStart; i <= rz.origEnd; i++) if (daysArr[i]) origDates.push(daysArr[i]);
        const newDates = [];
        for (let i = rz.curStart; i <= rz.curEnd; i++) if (daysArr[i]) newDates.push(daysArr[i]);
        const toAdd = newDates.filter((x) => !origDates.includes(x));
        const toRemove = origDates.filter((x) => !newDates.includes(x));
        if (toAdd.length === 0 && toRemove.length === 0) return;
        setBusy(true);
        try {
          if (toAdd.length > 0) {
            await bulkAssignSchedule({
              team_member_id: rz.rowId, job_id: dataRef.current.job.id,
              dates: toAdd, status: rz.status, notes: rz.notes,
            });
          }
          if (toRemove.length > 0) {
            const ids = row.entries.filter((e) => toRemove.includes(e.date)).map((e) => e.id);
            await Promise.all(ids.map((id) => deleteScheduleEntry(id)));
          }
          await finishEdit();
        } catch (err) { setBusy(false); toast('Resize failed: ' + err.message, 'error'); }
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="jc-loading">Loading planner…</div>;
  if (error) {
    return (
      <div className="jc-loading">
        Couldn't load the planner — {error}
        <div style={{ marginTop: 12 }}><button className="btn" onClick={onBack}>← Back</button></div>
      </div>
    );
  }
  if (!data) return null;

  const { job, people, equipment, unbooked, notes } = data;
  const status = JOB_STATUSES[job.status] || JOB_STATUSES.planning;
  const crewSize = job.crew_size || 1;
  const spanLabel = data.span
    ? `${fmtDateShort(data.span.start)} → ${fmtDateShort(data.span.end)}`
    : (job.planned_start
      ? `Planned ${fmtDateShort(job.planned_start)} → ${fmtDateShort(job.planned_end || job.planned_start)}`
      : '');

  // Conflict count: member-days where this job and another job overlap
  let conflicts = 0;
  for (const r of [...people, ...equipment]) {
    const mine = new Set(r.entries.map((e) => e.date));
    for (const o of r.otherEntries) if (mine.has(o.date)) conflicts += 1;
  }

  const todayISO = isoOf(new Date());
  const nCols = days.length + 1;

  const startDrag = (e, row, run, i) => {
    if (!isAdmin || busy) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const startIdx = days.indexOf(run.firstDate);
    dragRef.current = {
      rowId: row.id, entryIds: run.entries.map((x) => x.id),
      spanLen: run.entries.length, grabIdx: i - startIdx, startIdx,
      lastStartIdx: null, startX: e.clientX, moved: false,
      clickDate: days[i], clickX: rect.left, clickY: rect.bottom,
    };
    setPop(null);
    document.body.style.userSelect = 'none';
  };

  const startResize = (e, row, run, edge) => {
    if (!isAdmin || busy) return;
    e.stopPropagation();
    e.preventDefault();
    const startIdx = days.indexOf(run.firstDate);
    const endIdx = days.indexOf(run.lastDate);
    resizeRef.current = {
      rowId: row.id, edge, origStart: startIdx, origEnd: endIdx,
      curStart: startIdx, curEnd: endIdx,
      status: run.entries[0].status, notes: run.entries[0].notes || '',
    };
    setResizeUI({ rowId: row.id, startIdx, endIdx });
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const quickAdd = async (row, d) => {
    if (!isAdmin || busy) return;
    setBusy(true);
    try {
      await assignSchedule({ team_member_id: row.id, job_id: job.id, date: d });
      await finishEdit();
    } catch (err) { setBusy(false); toast('Add failed: ' + err.message, 'error'); }
  };

  const removeDay = async () => {
    if (!pop || busy) return;
    const row = [...people, ...equipment].find((x) => x.id === pop.rowId);
    const ids = (row?.entries || []).filter((e) => e.date === pop.date).map((e) => e.id);
    setPop(null);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await Promise.all(ids.map((id) => deleteScheduleEntry(id)));
      await finishEdit();
    } catch (err) { setBusy(false); toast('Remove failed: ' + err.message, 'error'); }
  };

  const renderRow = (row) => {
    const byDate = new Map();
    for (const e of row.entries) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    const otherByDate = new Map();
    for (const o of row.otherEntries) {
      if (!otherByDate.has(o.date)) otherByDate.set(o.date, []);
      otherByDate.get(o.date).push(o);
    }
    const runs = runsOf(row.entries);
    const runEdge = new Map(); // date -> { run, isFirst, isLast }
    for (const run of runs) {
      for (const e of run.entries) {
        runEdge.set(e.date, { run, isFirst: e.date === run.firstDate, isLast: e.date === run.lastDate });
      }
    }
    return (
      <tr key={row.id}>
        <td className="jp-name-col">
          {!row.is_equipment && <span className="jp-color" style={{ background: row.color || '#3B82F6' }} />}
          <span className="jp-name">{row.name}</span>
          {row.is_equipment && row.category ? <span className="jc-chip-sm">{row.category}</span> : null}
          <em className="jp-range">{fmtDateShort(row.from_date)}–{fmtDateShort(row.to_date)} · {row.days}d</em>
        </td>
        {days.map((d, i) => {
          const mine = byDate.get(d) || [];
          const others = otherByDate.get(d) || [];
          const cls = ['jp-cell'];
          const dt = parseISO(d);
          const weekend = dt.getDay() === 0 || dt.getDay() === 6;
          if (weekend) cls.push('jp-wend');
          if (d === todayISO) cls.push('jp-today');
          const isPreview = dragUI && dragUI.rowId === row.id && i >= dragUI.startIdx && i <= dragUI.endIdx;
          const isResizePrev = resizeUI && resizeUI.rowId === row.id && i >= resizeUI.startIdx && i <= resizeUI.endIdx;
          if (isPreview || isResizePrev) cls.push('jp-preview');

          if (mine.length > 0) {
            const conflict = others.length > 0;
            if (conflict) cls.push('jp-conflict');
            if (mine.some((e) => e.notes)) cls.push('jp-has-note');
            const edge = runEdge.get(d);
            let title = `${d}\n${mine.map((e) => statusOf(e.status).label + (e.notes ? ` — "${e.notes}"` : '')).join('\n')}`;
            if (conflict) title += `\n⚠ Also booked: ${others.map((o) => `${o.job_code} ${o.job_name}`).join(', ')}`;
            return (
              <td
                key={d}
                className={cls.join(' ')}
                data-jp-date={d}
                data-jp-idx={i}
                data-jp-row={row.id}
                title={title}
                onMouseDown={isAdmin ? (e) => startDrag(e, row, edge.run, i) : undefined}
              >
                <span className="jp-bar" style={{ background: statusOf(mine[0].status).color }} />
                {mine.length > 1 && <span className="jp-multi">{mine.length}</span>}
                {isAdmin && edge.isFirst && (
                  <div className="jp-handle jp-handle-l" title="Drag to change start" onMouseDown={(e) => startResize(e, row, edge.run, 'left')} />
                )}
                {isAdmin && edge.isLast && (
                  <div className="jp-handle jp-handle-r" title="Drag to change end" onMouseDown={(e) => startResize(e, row, edge.run, 'right')} />
                )}
              </td>
            );
          }

          if (others.length > 0) {
            const o = others[0];
            return (
              <td
                key={d}
                className={cls.join(' ')}
                data-jp-date={d}
                data-jp-idx={i}
                data-jp-row={row.id}
                title={`${d}\nOther booking: ${others.map((x) => `${x.job_code} ${x.job_name} (${statusOf(x.status).label})`).join(', ')}`}
              >
                <span className="jp-ghost" style={{ background: o.job_color || '#94a3b8' }} />
                {others.length > 1 && <span className="jp-multi jp-multi-dim">{others.length}</span>}
              </td>
            );
          }

          if (isAdmin) cls.push('jp-addable');
          return (
            <td
              key={d}
              className={cls.join(' ')}
              data-jp-date={d}
              data-jp-idx={i}
              data-jp-row={row.id}
              title={isAdmin ? `${d} — click to add this job` : `${d}`}
              onClick={isAdmin ? () => quickAdd(row, d) : undefined}
            />
          );
        })}
      </tr>
    );
  };

  return (
    <div className="jp-wrap">
      <div className="jp-head">
        <button className="btn btn-sm" onClick={onBack}>← Back</button>
        <h2>{job.code}{job.job_number ? ` · ${job.job_number}` : ''} — {job.name}</h2>
        <span className="jp-chip jp-status" style={{ borderColor: status.color, color: status.color }}>{status.label}</span>
        {busy && <span className="jp-chip jp-busy">Saving…</span>}
      </div>

      <div className="jp-chips">
        {job.client && <span className="jp-chip">🏢 {job.client}</span>}
        {job.state && <span className="jp-chip">📍 {job.state}</span>}
        {job.lead_name && <span className="jp-chip">👤 {job.lead_name}</span>}
        {spanLabel && <span className="jp-chip">🗓 {spanLabel}{spanDays ? ` · ${spanDays}d` : ''}</span>}
        <span className="jp-chip">👷 {people.length}/{crewSize} crew</span>
        {conflicts > 0 && (
          <span className="jp-chip jp-chip-warn" title="Days where this job overlaps another booking for the same person or equipment — see the red-outlined cells">{conflicts} conflict{conflicts === 1 ? '' : 's'}</span>
        )}
      </div>

      <div className="jp-body">
        {days.length === 0 ? (
          <div className="jc-empty" style={{ padding: '24px 8px' }}>
            No days rostered yet — assign people or equipment to this job on the schedule and they'll appear here.
            {job.planned_start && (
              <> Planned window: <strong>{fmtDateShort(job.planned_start)} → {fmtDateShort(job.planned_end || job.planned_start)}</strong>.</>
            )}
          </div>
        ) : (
          <>
            <div className="jp-legend">
              {Object.entries(STATUSES).map(([k, s]) => (
                <span key={k} className="jp-leg-item"><i style={{ background: s.color }} />{s.label}</span>
              ))}
              <span className="jp-leg-item"><i className="jp-leg-ghost" />other jobs</span>
              <span className="jp-leg-item"><i className="jp-leg-conflict" />conflict</span>
              <span className="jp-leg-item"><i className="jp-leg-note" />day notes</span>
            </div>

            <div className="jp-table-wrap">
              <table className="jp-table">
                <thead>
                  <tr>
                    <th className="jp-name-col jp-corner">Job {job.code}</th>
                    {(() => {
                      const months = [];
                      for (const d of days) {
                        const lab = parseISO(d).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
                        const last = months[months.length - 1];
                        if (last && last.label === lab) last.span += 1;
                        else months.push({ label: lab, span: 1 });
                      }
                      return months.map((m) => (
                        <th key={m.label} className="jp-month" colSpan={m.span}>{m.label}</th>
                      ));
                    })()}
                  </tr>
                  <tr>
                    <th className="jp-name-col" />
                    {days.map((d) => {
                      const dt = parseISO(d);
                      const weekend = dt.getDay() === 0 || dt.getDay() === 6;
                      const cls = ['jp-dh'];
                      if (weekend) cls.push('jp-wend');
                      if (d === todayISO) cls.push('jp-today');
                      return (
                        <th key={d} className={cls.join(' ')} title={d}>
                          {dt.getDate()}<em>{DOW[dt.getDay()][0]}</em>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  <tr className="jp-sec-row">
                    <td colSpan={nCols} onClick={() => setCollapsed((c) => ({ ...c, people: !c.people }))}>
                      <span className="jp-sec-caret">{collapsed.people ? '▸' : '▾'}</span>
                      👷 Crew <span className="jp-count-pill">{people.length}</span>
                    </td>
                  </tr>
                  {!collapsed.people && people.map(renderRow)}
                  {!collapsed.people && (
                    <tr className="jp-footer-row">
                      <td className="jp-name-col">Crew per day</td>
                      {days.map((d) => {
                        const n = people.filter((p) => p.entries.some((e) => e.date === d)).length;
                        return <td key={d} className="jp-count">{n || ''}</td>;
                      })}
                    </tr>
                  )}

                  <tr className="jp-sec-row">
                    <td colSpan={nCols} onClick={() => setCollapsed((c) => ({ ...c, equipment: !c.equipment }))}>
                      <span className="jp-sec-caret">{collapsed.equipment ? '▸' : '▾'}</span>
                      🧰 Equipment <span className="jp-count-pill">{equipment.length}</span>
                    </td>
                  </tr>
                  {!collapsed.equipment && equipment.map(renderRow)}
                </tbody>
              </table>
            </div>

            {unbooked.length > 0 && (
              <div className="jp-unbooked">
                <strong>Assigned, no days booked yet:</strong>{' '}
                {unbooked.map((u, i) => (
                  <span key={u.id}>{i > 0 ? ', ' : ''}{u.name}{u.category ? ` (${u.category})` : ''}</span>
                ))}
              </div>
            )}

            <div className="jp-section" style={{ marginTop: 16 }}>
              <h4>📝 Notes</h4>
              {job.notes && job.notes.trim() ? (
                <div className="jp-job-notes">{job.notes}</div>
              ) : (
                <div className="jc-empty">No job notes yet — add them on the job card.</div>
              )}
              {notes.length > 0 && (
                <div className="jp-day-notes">
                  <div className="jp-day-notes-head">Day notes ({notes.length})</div>
                  {notes.map((n, i) => (
                    <div key={`${n.date}-${n.member_name}-${i}`} className="jp-day-note">
                      <span className="jp-dn-date">{fmtDateShort(n.date)}</span>
                      <span className="jp-dn-who">{n.member_name}{n.is_equipment ? ' · gear' : ''}</span>
                      <span className="jp-dn-text">{n.notes}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="jp-foot">
        {onOpenCard && <button className="btn btn-sm" onClick={() => onOpenCard(job.id)}>Open full job card →</button>}
      </div>

      {pop && (
        <>
          <div className="jp-pop-backdrop" onClick={() => setPop(null)} />
          <div className="jp-pop" style={{ left: Math.max(8, Math.min(pop.x, window.innerWidth - 260)), top: pop.y }}>
            <div className="jp-pop-date">{fmtDateShort(pop.date)}</div>
            {(() => {
              const row = [...people, ...equipment].find((x) => x.id === pop.rowId);
              const mine = (row?.entries || []).filter((e) => e.date === pop.date);
              return (
                <>
                  <div className="jp-pop-row"><strong>{row?.name}</strong> · {job.code}</div>
                  <div className="jp-pop-row">{mine.map((e) => statusOf(e.status).label).join(', ')}</div>
                  {mine.some((e) => e.notes) && <div className="jp-pop-notes">{mine.map((e) => e.notes).filter(Boolean).join('\n')}</div>}
                  {isAdmin && (
                    <button className="btn btn-sm" onClick={removeDay}>🗑 Remove from this job</button>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
