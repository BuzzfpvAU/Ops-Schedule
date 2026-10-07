import React, { useMemo, useState } from 'react';
import Timeline, { rowHeight } from './Timeline.jsx';
import { SearchBox } from './ui.jsx';
import NewProjectDialog from './NewProjectDialog.jsx';
import CleanupDrawer from './CleanupDrawer.jsx';
import { pastJobs } from '../lib/cleanup.js';
import { JOB_STATUSES, STATES, shiftJob } from '../api.js';
import useBarDrag from '../lib/useBarDrag.js';
import { buildBars, groupByJob, bucketBy, isQuickJob, orderStatesFor, splitAroundSpan } from '../lib/model.js';
import { makeMatcher } from '../lib/search.js';
import { diffDays, fmtLong, today as todayIso } from '../lib/dates.js';

// ── View 1: jobs on a timeline, grouped by the state managing them ──────
//
// Two bars can appear per job. The planned window (planned_start/end on the
// job) draws as a dashed outline; the actual roster — the days somebody is
// really booked — draws solid on top. Where they disagree, the gap is the
// point of the view.

const KIT_H = 10;

export default function ProjectsView({ jobs, schedule, equipment = [], days, zoom, labelWidth, myState, scrollCmd, onReachEdge, onOpenProject, onChanged, currentUser, showToast }) {
  const isAdmin = !!currentUser?.isAdmin;
  const [creating, setCreating] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const past = useMemo(() => pastJobs(jobs, todayIso()), [jobs]);
  const [collapsed, setCollapsed] = useState({});
  const [statusFilter, setStatusFilter] = useState('open');
  const [search, setSearch] = useState('');
  // Projects ticked for a side-by-side look. Ticking only marks them; the
  // list narrows when "Show only selected" is pressed, so several can be
  // picked without the rest vanishing after the first tick.
  const [picked, setPicked] = useState(() => new Set());
  const [focus, setFocus] = useState(false);

  const togglePick = (id) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    if (next.size === 0) setFocus(false);
    return next;
  });
  const clearPicks = () => { setPicked(new Set()); setFocus(false); };

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
  const kitIds = useMemo(() => new Set((equipment || []).map((e) => e.id)), [equipment]);

  const groups = useMemo(() => {
    const match = makeMatcher(search);
    const visible = jobs.filter((j) => {
      if (j.archived || isQuickJob(j)) return false;
      // Focused on a selection: exactly those projects, whatever the search
      // and status filters say, so a ticked project can never be filtered away.
      if (focus) return picked.has(j.id);
      if (!match(j.code, j.name, j.description, j.client, j.lead_name, j.state, j.job_number)) return false;
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

      // Rostered days — the people actually booked. Merged per contiguous run
      // so a job that pauses over a weekend shows two bars, not one. Kit is
      // drawn separately, as a thin line under the bar.
      const entries = entriesByJob.get(job.id) || [];
      const crewEntries = entries.filter((e) => !kitIds.has(e.team_member_id));
      const kitEntries = entries.filter((e) => kitIds.has(e.team_member_id));
      const runs = buildBars(crewEntries, (e) => e.job_id);
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

      // Kit days, split around the crew's span so the parts that run beyond
      // it (travel pads, early dispatch, late return) read differently.
      const crewSpan = crewEntries.length
        ? {
            start: crewEntries.reduce((m, e) => (e.date < m ? e.date : m), crewEntries[0].date),
            end: crewEntries.reduce((m, e) => (e.date > m ? e.date : m), crewEntries[0].date),
          }
        : null;
      const kit = [];
      for (const run of buildBars(kitEntries, (e) => e.job_id)) {
        const names = [...new Set(run.entries.map((e) => e.member_name).filter(Boolean))];
        for (const part of splitAroundSpan(run.start, run.end, crewSpan)) {
          const geo = clip(part.start, part.end);
          if (geo) kit.push({ ...geo, beyond: part.beyond, names, start: part.start, end: part.end });
        }
      }

      if (!bars.length && !kit.length) return null;
      const lanes = planned && runs.length ? 2 : 1;
      return {
        id: job.id,
        job,
        bars,
        lanes,
        kit,
        kitCount: new Set(kitEntries.map((e) => e.team_member_id)).size,
        // Room for the kit line under the bars.
        minHeight: kit.length ? rowHeight(lanes) + KIT_H : 0,
      };
    }).filter(Boolean);

    // A job's managing state — explicit on the job, else inherited from the
    // lead's base location, which is what the server already does.
    const byStart = (a, z) => {
      const as = a.job.planned_start || a.job.roster_start || '9999';
      const zs = z.job.planned_start || z.job.roster_start || '9999';
      return as.localeCompare(zs) || (a.job.code || '').localeCompare(z.job.code || '');
    };
    // The selection is listed together as one group rather than split by state.
    if (focus) return [{ key: 'selected', label: 'Selected projects', rows: rows.sort(byStart) }];

    return bucketBy(rows, (r) => r.job.state, orderStatesFor(myState, STATES), 'No state').map((b) => ({
      key: b.key,
      label: b.key,
      rows: b.rows.sort(byStart),
    }));
  }, [jobs, entriesByJob, kitIds, statusFilter, search, myState, dayIndex, windowStart, windowEnd, focus, picked]);

  // Drill into the single-project view; the old summary drawer is superseded
  // by it, since that view shows the same crew and kit plus the day log.
  const openCard = (job) => onOpenProject?.(job.id);

  const renderLabel = (row) => {
    const job = row.job;
    const st = JOB_STATUSES[job.status] || JOB_STATUSES.planning;
    const understaffed = (job.crew_count || 0) < (job.crew_size || 1);
    return (
      <>
        <input
          type="checkbox"
          className="proj-pick"
          checked={picked.has(job.id)}
          onChange={() => togglePick(job.id)}
          aria-label={`Select ${job.name}`}
          title="Tick several projects, then Show only selected"
        />
        <span className="swatch" style={{ background: job.color || '#475569' }} />
        <button
          type="button"
          className="rl rl-project"
          onClick={() => openCard(job)}
          title={[
            `${job.code} — ${job.name}`,
            job.client,
            job.description,
            job.lead_name ? `Lead: ${job.lead_name}` : null,
            st.label,
          ].filter(Boolean).join('\n')}
        >
          <span className="rl-name">{job.name}</span>
          <span className="rl-sub">
            <span className="rl-sub-code">{job.code}</span>
            {job.client ? ` · ${job.client}` : ''}
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

  // Dragging any of a project's bars moves the whole project: every bar of
  // that job previews together, keyed by the job.
  const { bind, dragStyle } = useBarDrag({ colW: zoom.colW, enabled: isAdmin });

  const moveProject = async (job, days) => {
    try {
      const r = await shiftJob(job.id, days);
      await onChanged?.();
      const when = `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days > 0 ? 'later' : 'earlier'}`;
      if (r?.clashes?.length) {
        const list = r.clashes.map((c) => `${c.name} (${c.job_code})`).join(', ');
        showToast?.(`${job.code} moved ${when} — now clashing: ${list}`, 'error');
      } else {
        showToast?.(`${job.code} moved ${when}`, 'success');
      }
    } catch (e) {
      showToast?.(e.message, 'error');
    }
  };

  const barProps = (job) => bind(job.id, Infinity, {
    onCommit: (days) => moveProject(job, days),
    onClick: () => openCard(job),
  });

  const renderBar = (bar, row) => {
    const job = bar.job;
    const drag = dragStyle(job.id);
    const grab = isAdmin ? ' is-draggable' : '';
    if (bar.kind === 'planned') {
      return (
        <div
          className={`bar is-ghost${grab}`}
          style={{ color: job.color || '#8d9bb0', ...drag }}
          title={`Planned: ${fmtLong(job.planned_start)} → ${fmtLong(job.planned_end || job.planned_start)}${isAdmin ? '\nDrag to move the project' : ''}`}
          {...barProps(job)}
        >
          <span className="bar-text">Planned</span>
        </div>
      );
    }
    const crew = new Set(bar.run.entries.map((e) => e.team_member_id)).size;
    const kitN = row?.kitCount || 0;
    return (
      <div
        className={`bar${grab}`}
        style={{ background: job.color || '#3b82f6', ...drag }}
        title={`${job.code} ${job.name}\n${fmtLong(bar.run.start)} → ${fmtLong(bar.run.end)}\n${crew} crew${kitN ? `, ${kitN} kit` : ''}${isAdmin ? '\nDrag to move the project' : ''}`}
        {...barProps(job)}
      >
        <span className="bar-text">{job.name}</span>
      </div>
    );
  };

  // Kit as a thin line under the bar. Amber where it runs outside the crew's
  // dates; clicking opens the project like the bar does.
  const renderOverlay = (row) => (row.kit || []).map((k, i) => (
    <span
      key={`kit-${row.id}-${k.start}-${i}`}
      className={`kit-line${k.beyond ? ' is-beyond' : ''}`}
      style={{ left: k.startIdx * zoom.colW, width: Math.max(k.span * zoom.colW - 1, 3) }}
      title={`Kit: ${k.names.join(', ') || 'equipment'}\n${fmtLong(k.start)} → ${fmtLong(k.end)}${k.beyond ? '\nOutside the crew’s dates' : ''}`}
      onClick={(e) => { e.stopPropagation(); openCard(row.job); }}
    />
  ));

  const shownCount = groups.reduce((n, g) => n + g.rows.length, 0);
  const totalCount = jobs.filter((j) => !j.archived && !isQuickJob(j)).length;

  return (
    <>
      <div className="toolbar" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search projects…"
          found={shownCount}
          total={totalCount}
        />
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
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New project</button>
        )}
        {isAdmin && (
          <button
            className="btn"
            onClick={() => setCleaning(true)}
            title="Archive projects whose last scheduled day has passed"
          >
            Clean up{past.length ? ` (${past.length})` : ''}
          </button>
        )}
        {picked.size > 0 && !focus && (
          <>
            <button className="btn btn-primary" onClick={() => setFocus(true)}>
              Show only selected ({picked.size})
            </button>
            <button className="btn" onClick={clearPicks}>Clear</button>
          </>
        )}
        {focus && (
          <button className="btn" onClick={clearPicks} title="Back to every project">
            Showing {shownCount} of {picked.size} selected — Show all
          </button>
        )}
        <div className="toolbar-spacer" />
        <div className="legend">
          <span className="legend-item">
            <span className="legend-key" style={{ background: '#3b82f6' }} /> Rostered
          </span>
          <span className="legend-item">
            <span className="legend-key" style={{ background: 'transparent', border: '1px dashed var(--text-mute)' }} /> Planned
          </span>
          <span className="legend-item">
            <span className="legend-key" style={{ background: 'var(--text-mute)', height: 4 }} /> Kit
          </span>
          <span className="legend-item">
            <span className="legend-key" style={{ background: 'var(--warn)', height: 4 }} /> Kit beyond crew dates
          </span>
        </div>
        <span className="count-pill">{shownCount} jobs</span>
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
        renderOverlay={renderOverlay}
        emptyMessage={focus ? 'None of the selected projects fall inside this date window — scroll the timeline or press Show all.' : 'No jobs fall inside this date window.'}
      />

      {cleaning && (
        <CleanupDrawer
          jobs={past}
          onClose={() => setCleaning(false)}
          onDone={() => onChanged?.()}
          showToast={showToast}
        />
      )}

      {creating && (
        <NewProjectDialog
          jobs={jobs}
          myState={myState}
          onClose={() => setCreating(false)}
          onCreated={async (job) => {
            setCreating(false);
            await onChanged?.();
            showToast?.(`${job.code} created`, 'success');
            onOpenProject?.(job.id);
          }}
          showToast={showToast}
        />
      )}

    </>
  );
}
