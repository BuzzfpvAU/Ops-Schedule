import React, { useMemo, useState } from 'react';
import Timeline from './Timeline.jsx';
import { JOB_STATUSES, STATES } from '../api.js';
import { buildBars, groupByJob, bucketBy, isQuickJob, orderStatesFor } from '../lib/model.js';
import { diffDays, fmtShort, fmtLong } from '../lib/dates.js';

// ── View 1: jobs on a timeline, grouped by the state managing them ──────
//
// Two bars can appear per job. The planned window (planned_start/end on the
// job) draws as a dashed outline; the actual roster — the days somebody is
// really booked — draws solid on top. Where they disagree, the gap is the
// point of the view.

export default function ProjectsView({ jobs, schedule, days, zoom, labelWidth, myState, scrollCmd, onReachEdge, onOpenProject, showToast }) {
  const [collapsed, setCollapsed] = useState({});
  const [statusFilter, setStatusFilter] = useState('open');

  const dayIndex = useMemo(() => {
    const m = new Map();
    days.forEach((d, i) => m.set(d, i));
    return m;
  }, [days]);

  const windowStart = days[0];
  const windowEnd = days[days.length - 1];

  // Clip a date span to the rendered window, returning null when it falls
  // entirely outside. Bars that start before the window still need to render
  // — clipped at the left edge — or long projects vanish.
  const clip = (start, end) => {
    if (!start || !end || start > windowEnd || end < windowStart) return null;
    const from = start < windowStart ? windowStart : start;
    const to = end > windowEnd ? windowEnd : end;
    const startIdx = dayIndex.get(from);
    if (startIdx === undefined) return null;
    return { startIdx, span: diffDays(from, to) + 1, clippedLeft: start < windowStart, clippedRight: end > windowEnd };
  };

  const entriesByJob = useMemo(() => groupByJob(schedule), [schedule]);

  const groups = useMemo(() => {
    const visible = jobs.filter((j) => {
      if (j.archived || isQuickJob(j)) return false;
      if (statusFilter === 'open') return !['complete', 'cancelled'].includes(j.status);
      if (statusFilter === 'all') return true;
      return j.status === statusFilter;
    });

    const rows = visible.map((job) => {
      const bars = [];

      // Planned window — the intent.
      const planned = clip(job.planned_start, job.planned_end || job.planned_start);
      if (planned) {
        bars.push({ ...planned, key: `plan-${job.id}`, kind: 'planned', job, lane: 0 });
      }

      // Rostered days — what is actually booked. Merged per contiguous run so
      // a job that pauses over a weekend shows two bars, not one.
      const entries = entriesByJob.get(job.id) || [];
      const runs = buildBars(entries, (e) => e.job_id);
      for (const run of runs) {
        const geo = clip(run.start, run.end);
        if (!geo) continue;
        bars.push({
          ...geo,
          key: `roster-${job.id}-${run.start}`,
          kind: 'roster',
          job,
          run,
          lane: planned ? 1 : 0,
        });
      }

      if (!bars.length) return null;
      return {
        id: job.id,
        job,
        bars,
        lanes: planned && runs.length ? 2 : 1,
      };
    }).filter(Boolean);

    // A job's managing state — explicit on the job, else inherited from the
    // lead's base location, which is what the server already does.
    return bucketBy(rows, (r) => r.job.state, orderStatesFor(myState, STATES), 'No state').map((b) => ({
      key: b.key,
      label: b.key,
      rows: b.rows.sort((a, z) => {
        const as = a.job.planned_start || a.job.roster_start || '9999';
        const zs = z.job.planned_start || z.job.roster_start || '9999';
        return as.localeCompare(zs) || (a.job.code || '').localeCompare(z.job.code || '');
      }),
    }));
  }, [jobs, entriesByJob, statusFilter, myState, dayIndex, windowStart, windowEnd]);

  // Drill into the single-project view; the old summary drawer is superseded
  // by it, since that view shows the same crew and kit plus the day log.
  const openCard = (job) => onOpenProject?.(job.id);

  const renderLabel = (row) => {
    const job = row.job;
    const st = JOB_STATUSES[job.status] || JOB_STATUSES.planning;
    const understaffed = (job.crew_count || 0) < (job.crew_size || 1);
    return (
      <>
        <span className="swatch" style={{ background: job.color || '#475569' }} />
        <button
          type="button"
          className="rl"
          style={{ border: 0, background: 'none', padding: 0 }}
          onClick={() => openCard(job)}
        >
          <span className="rl-top">
            <span className="rl-code">{job.code}</span>
            <span className="rl-name">{job.name}</span>
          </span>
          <span className="rl-sub">
            {job.description || job.client || st.label}
            {job.lead_name ? ` · ${job.lead_name}` : ''}
          </span>
        </button>
        {understaffed && (
          <span className="tag tag-warn" title={`${job.crew_count || 0} of ${job.crew_size || 1} crew rostered`}>
            {job.crew_count || 0}/{job.crew_size || 1}
          </span>
        )}
      </>
    );
  };

  const renderBar = (bar) => {
    const job = bar.job;
    if (bar.kind === 'planned') {
      return (
        <div
          className="bar is-ghost"
          style={{ color: job.color || '#8d9bb0' }}
          title={`Planned: ${fmtLong(job.planned_start)} → ${fmtLong(job.planned_end || job.planned_start)}`}
          onClick={(e) => { e.stopPropagation(); openCard(job); }}
        >
          <span className="bar-text">Planned</span>
        </div>
      );
    }
    const crew = new Set(bar.run.entries.map((e) => e.team_member_id)).size;
    const label = `${job.code} · ${fmtShort(bar.run.start)}–${fmtShort(bar.run.end)}`;
    return (
      <div
        className="bar"
        style={{ background: job.color || '#3b82f6' }}
        title={`${job.code} ${job.name}\n${fmtLong(bar.run.start)} → ${fmtLong(bar.run.end)}\n${crew} rostered`}
        onClick={(e) => { e.stopPropagation(); openCard(job); }}
      >
        <span className="bar-text">{label}</span>
      </div>
    );
  };

  return (
    <>
      <div className="toolbar" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <div className="tgroup">
          {[
            ['open', 'Open'],
            ['planning', 'Planning'],
            ['confirmed', 'Confirmed'],
            ['active', 'Active'],
            ['all', 'All'],
          ].map(([v, l]) => (
            <button key={v} className={statusFilter === v ? 'is-active' : ''} onClick={() => setStatusFilter(v)}>
              {l}
            </button>
          ))}
        </div>
        <div className="toolbar-spacer" />
        <div className="legend">
          <span className="legend-item">
            <span className="legend-key" style={{ background: '#3b82f6' }} /> Rostered
          </span>
          <span className="legend-item">
            <span className="legend-key" style={{ background: 'transparent', border: '1px dashed var(--text-mute)' }} /> Planned
          </span>
        </div>
        <span className="count-pill">{groups.reduce((n, g) => n + g.rows.length, 0)} jobs</span>
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
        emptyMessage="No jobs fall inside this date window."
      />

    </>
  );
}
