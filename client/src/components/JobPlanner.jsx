import React, { useEffect, useMemo, useState } from 'react';
import { getJobPlanner, STATUSES } from '../api.js';
import { JOB_STATUSES, fmtDateShort } from './JobCard.jsx';

// ── Project planner ────────────────────────────────────────────
// A job-scoped slice of the schedule: one row per person / equipment
// item with roster entries on the job, day columns across the job's
// span, plus the job notes and per-day notes.

const MAX_DAYS = 400;
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

// One row's day cells — a coloured bar per rostered day (tooltip carries
// status + notes), a white dot when the day has notes, count badge for
// multiple entries on the same day.
function DayCells({ entries, days }) {
  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of entries) {
      if (!m.has(e.date)) m.set(e.date, []);
      m.get(e.date).push(e);
    }
    return m;
  }, [entries]);
  const todayISO = useMemo(() => isoOf(new Date()), []);

  return days.map((d) => {
    const dt = parseISO(d);
    const weekend = dt.getDay() === 0 || dt.getDay() === 6;
    const cls = ['jp-cell'];
    if (weekend) cls.push('jp-wend');
    if (d === todayISO) cls.push('jp-today');
    const es = byDate.get(d);
    if (!es || es.length === 0) return <td key={d} className={cls.join(' ')} />;
    const es_ = es;
    const hasNotes = es_.some((e) => e.notes);
    if (hasNotes) cls.push('jp-has-note');
    const tip = `${d}\n` + es_.map((e) => `${statusOf(e.status).label}${e.notes ? ` — "${e.notes}"` : ''}`).join('\n');
    return (
      <td key={d} className={cls.join(' ')} title={tip}>
        <span className="jp-bar" style={{ background: statusOf(es_[0].status).color }} />
        {es_.length > 1 && <span className="jp-multi">{es_.length}</span>}
      </td>
    );
  });
}

// Shared days-table: sticky name column, month header row, day header row
function DaysTable({ label, rows, days, renderName, footer }) {
  const months = useMemo(() => {
    const out = [];
    for (const d of days) {
      const lab = parseISO(d).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
      const last = out[out.length - 1];
      if (last && last.label === lab) last.span += 1;
      else out.push({ label: lab, span: 1 });
    }
    return out;
  }, [days]);
  const todayISO = useMemo(() => isoOf(new Date()), []);

  return (
    <div className="jp-table-wrap">
      <table className="jp-table">
        <thead>
          <tr>
            <th className="jp-name-col jp-corner">{label}</th>
            {months.map((m) => (
              <th key={m.label} className="jp-month" colSpan={m.span}>{m.label}</th>
            ))}
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
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="jp-name-col">{renderName(r)}</td>
              <DayCells entries={r.entries} days={days} />
            </tr>
          ))}
          {footer}
        </tbody>
      </table>
    </div>
  );
}

export default function JobPlanner({ jobId, onBack, onOpenCard }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
    let start = null;
    let end = null;
    const see = (d) => {
      if (!d) return;
      if (!start || d < start) start = d;
      if (!end || d > end) end = d;
    };
    for (const r of [...data.people, ...data.equipment]) { see(r.from_date); see(r.to_date); }
    if (!start) { see(data.job.planned_start); see(data.job.planned_end); }
    if (!start) return [];
    const out = [];
    let cur = start;
    while (cur <= end && out.length < MAX_DAYS) { out.push(cur); cur = addDaysISO(cur, 1); }
    return out;
  }, [data]);

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
  const spanLabel = job.roster_start
    ? `${fmtDateShort(job.roster_start)} → ${fmtDateShort(job.roster_end)}`
    : (job.planned_start
      ? `Planned ${fmtDateShort(job.planned_start)} → ${fmtDateShort(job.planned_end || job.planned_start)}`
      : '');

  return (
    <div className="jp-wrap">
      <div className="jp-head">
        <button className="btn btn-sm" onClick={onBack}>← Back</button>
        <h2>{job.code}{job.job_number ? ` · ${job.job_number}` : ''} — {job.name}</h2>
        <span className="jp-chip jp-status" style={{ borderColor: status.color, color: status.color }}>{status.label}</span>
      </div>

      <div className="jp-chips">
        {job.client && <span className="jp-chip">🏢 {job.client}</span>}
        {job.state && <span className="jp-chip">📍 {job.state}</span>}
        {job.lead_name && <span className="jp-chip">👤 {job.lead_name}</span>}
        {spanLabel && <span className="jp-chip">🗓 {spanLabel}{days.length ? ` · ${days.length}d` : ''}</span>}
        <span className="jp-chip">👷 {people.length}/{crewSize} crew</span>
      </div>

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
            <span className="jp-leg-item"><i className="jp-leg-note" />has day notes</span>
          </div>

          <div className="jp-section">
            <h4>👷 People <span className="jp-count-pill">{people.length}</span></h4>
            {people.length === 0 ? (
              <div className="jc-empty">No crew rostered yet.</div>
            ) : (
              <DaysTable
                label="Crew"
                rows={people}
                days={days}
                renderName={(p) => (
                  <>
                    <span className="jp-color" style={{ background: p.color || '#3B82F6' }} />
                    <span className="jp-name">{p.name}</span>
                    <em className="jp-range">{fmtDateShort(p.from_date)}–{fmtDateShort(p.to_date)} · {p.days}d</em>
                  </>
                )}
                footer={(
                  <tr className="jp-footer-row">
                    <td className="jp-name-col">Crew per day</td>
                    {days.map((d) => {
                      const n = people.filter((p) => p.entries.some((e) => e.date === d)).length;
                      return <td key={d} className="jp-count">{n || ''}</td>;
                    })}
                  </tr>
                )}
              />
            )}
          </div>

          <div className="jp-section">
            <h4>🧰 Equipment <span className="jp-count-pill">{equipment.length}</span></h4>
            {equipment.length === 0 && unbooked.length === 0 && (
              <div className="jc-empty">No equipment assigned to this job yet.</div>
            )}
            {equipment.length > 0 && (
              <DaysTable
                label="Kit"
                rows={equipment}
                days={days}
                renderName={(r) => (
                  <>
                    <span className="jp-name">{r.name}</span>
                    {r.category && <span className="jc-chip-sm">{r.category}</span>}
                    <em className="jp-range">{fmtDateShort(r.from_date)}–{fmtDateShort(r.to_date)} · {r.days}d</em>
                  </>
                )}
              />
            )}
            {unbooked.length > 0 && (
              <div className="jp-unbooked">
                <strong>Assigned, no days booked yet:</strong>{' '}
                {unbooked.map((u, i) => (
                  <span key={u.id}>{i > 0 ? ', ' : ''}{u.name}{u.category ? ` (${u.category})` : ''}</span>
                ))}
              </div>
            )}
          </div>

          <div className="jp-section">
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

      {onOpenCard && (
        <div className="jp-foot">
          <button className="btn btn-sm" onClick={() => onOpenCard(job.id)}>Open full job card →</button>
        </div>
      )}
    </div>
  );
}
