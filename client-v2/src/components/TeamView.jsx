import React, { useMemo, useState } from 'react';
import Timeline from './Timeline.jsx';
import { Drawer, Section, KV, Avatar } from './ui.jsx';
import { STATES, STATUSES, quickEntry, deleteScheduleEntry } from '../api.js';
import { buildBars, layoutLanes, groupByEntity, bucketBy, isWork, isQuickJob, NON_WORK } from '../lib/model.js';
import { diffDays, fmtShort, fmtLong, today as todayIso } from '../lib/dates.js';

// ── View 3: who is working where ────────────────────────────────────────
//
// People grouped by their base state, with job allocations and the non-job
// entries — leave, TOIL, notes, unavailable — on the same line, because the
// question "can this person take that job" depends on both.
//
// The Unallocated group carries jobs that are planned but not yet crewed, so
// the work waiting for people sits in the same timeline as the people.

const UNALLOCATED = '__unallocated__';

// Entries a non-admin may add to their own row.
const QUICK_STATUSES = ['note', 'toil', 'leave', 'unavailable'];

export default function TeamView({
  members, jobs, schedule, days, zoom, labelWidth, currentUser, showToast, onChanged,
}) {
  const [collapsed, setCollapsed] = useState({});
  const [search, setSearch] = useState('');
  const [dayPanel, setDayPanel] = useState(null); // { member, date, entries }
  const [busy, setBusy] = useState(false);
  const [noteText, setNoteText] = useState('');

  const isAdmin = !!currentUser?.isAdmin;
  const isViewer = !!currentUser?.isViewer;
  const today = todayIso();

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

  const entriesByMember = useMemo(() => groupByEntity(schedule), [schedule]);

  // Jobs that are planned but short of crew — the work with nobody on it.
  const unallocatedRows = useMemo(() => {
    const out = [];
    for (const job of jobs) {
      if (job.archived || !job.active || isQuickJob(job)) continue;
      if (['complete', 'cancelled'].includes(job.status)) continue;
      if ((job.crew_count || 0) >= (job.crew_size || 1)) continue;

      const start = job.planned_start || job.roster_start;
      const end = job.planned_end || job.roster_end || start;
      const geo = clip(start, end);
      if (!geo) continue;

      out.push({
        id: `un-${job.id}`,
        unallocated: true,
        job,
        lanes: 1,
        bars: [{ ...geo, key: `un-${job.id}`, job, unallocated: true, lane: 0, start, end }],
      });
    }
    return out.sort((a, z) =>
      (a.job.planned_start || '9999').localeCompare(z.job.planned_start || '9999'));
  }, [jobs, dayIndex, windowStart, windowEnd]);

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();

    const rows = members
      .filter((m) => !term || m.name?.toLowerCase().includes(term) || m.role?.toLowerCase().includes(term))
      .map((member) => {
        const entries = entriesByMember.get(member.id) || [];
        const runs = buildBars(entries, (e) => `${e.job_id}|${e.status || 'tentative'}`);

        const bars = [];
        for (const run of runs) {
          const geo = clip(run.start, run.end);
          if (!geo) continue;
          bars.push({
            ...geo,
            key: `${member.id}-${run.sample.job_id}-${run.start}-${run.sample.status}`,
            run,
            member,
            start: run.start,
            end: run.end,
          });
        }
        const laid = layoutLanes(bars);
        const workDays = entries.filter(isWork).length;
        return { id: member.id, member, bars: laid.bars, lanes: laid.lanes, workDays };
      });

    const buckets = bucketBy(rows, (r) => r.member.location, STATES, 'No state').map((b) => ({
      key: b.key,
      label: b.key,
      rows: b.rows.sort((a, z) => (a.member.name || '').localeCompare(z.member.name || '')),
    }));

    if (unallocatedRows.length) {
      buckets.unshift({
        key: UNALLOCATED,
        label: 'Unallocated work',
        rows: unallocatedRows,
        meta: <span className="tag tag-warn" style={{ marginLeft: 6 }}>needs crew</span>,
      });
    }
    return buckets;
  }, [members, entriesByMember, unallocatedRows, search]);

  const canEdit = (memberId) => !isViewer && (isAdmin || memberId === currentUser?.memberId);

  const openDay = (row, date) => {
    if (row.unallocated) return;
    const entries = (entriesByMember.get(row.member.id) || []).filter((e) => e.date === date);
    setNoteText('');
    setDayPanel({ member: row.member, date, entries });
  };

  const addQuick = async (status) => {
    if (status === 'note' && !noteText.trim()) {
      showToast?.('Type the note first', 'error');
      return;
    }
    setBusy(true);
    try {
      await quickEntry({
        date: dayPanel.date,
        status,
        text: status === 'note' ? noteText.trim() : undefined,
        team_member_id: dayPanel.member.id,
      });
      showToast?.(`${STATUSES[status].label} added`, 'success');
      setDayPanel(null);
      await onChanged?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeEntry = async (entry) => {
    setBusy(true);
    try {
      await deleteScheduleEntry(entry.id);
      showToast?.('Entry removed', 'success');
      setDayPanel(null);
      await onChanged?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const renderLabel = (row) => {
    if (row.unallocated) {
      const job = row.job;
      return (
        <>
          <span className="swatch" style={{ background: job.color || '#eab308' }} />
          <span className="rl">
            <span className="rl-top">
              <span className="rl-code">{job.code}</span>
              <span className="rl-name">{job.name}</span>
            </span>
            <span className="rl-sub">
              {job.state ? `${job.state} · ` : ''}
              {job.crew_count || 0} of {job.crew_size || 1} crew
              {job.lead_name ? ` · lead ${job.lead_name}` : ''}
            </span>
          </span>
          <span className="tag tag-warn">
            +{(job.crew_size || 1) - (job.crew_count || 0)}
          </span>
        </>
      );
    }
    const m = row.member;
    return (
      <>
        <Avatar name={m.name} color={m.color} />
        <span className="rl">
          <span className="rl-top">
            <span className="rl-name">{m.name}</span>
            {m.id === currentUser?.memberId && <span className="tag tag-mute">you</span>}
          </span>
          <span className="rl-sub">{m.role || m.location}</span>
        </span>
        <span className="rl-sub" style={{ flex: 'none' }}>{row.workDays ? `${row.workDays}d` : ''}</span>
      </>
    );
  };

  const renderBar = (bar, row) => {
    if (bar.unallocated) {
      return (
        <div
          className="bar is-ghost"
          style={{ color: bar.job.color || '#eab308' }}
          title={`${bar.job.code} — ${bar.job.name}\nPlanned ${fmtLong(bar.start)} → ${fmtLong(bar.end)}\nNeeds ${(bar.job.crew_size || 1) - (bar.job.crew_count || 0)} more crew`}
        >
          <span className="bar-text">Needs crew</span>
        </div>
      );
    }

    const e = bar.run.sample;
    const status = e.status || 'tentative';
    const nonWork = NON_WORK.has(status);
    const meta = STATUSES[status] || STATUSES.tentative;
    const background = nonWork ? meta.color : (e.job_color || '#3b82f6');
    const label = nonWork
      ? (status === 'note' ? (e.notes || e.job_name || 'Note') : meta.label)
      : `${e.job_code}${bar.span > 6 ? ` · ${e.job_name}` : ''}`;

    return (
      <div
        className={`bar${status === 'tentative' ? ' is-tentative' : ''}`}
        style={{ background }}
        title={`${nonWork ? meta.label : `${e.job_code} ${e.job_name}`}\n${fmtLong(bar.start)} → ${fmtLong(bar.end)}${e.notes ? `\n${e.notes}` : ''}`}
        onClick={(ev) => { ev.stopPropagation(); openDay(row, bar.start); }}
      >
        <span className="bar-text">{label}</span>
      </div>
    );
  };

  const peopleCount = groups.reduce((n, g) => n + (g.key === UNALLOCATED ? 0 : g.rows.length), 0);

  return (
    <>
      <div className="toolbar" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <label className="field">
          <input
            type="search"
            placeholder="Filter people…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="toolbar-spacer" />
        <div className="legend">
          {['confirmed', 'tentative', 'leave', 'toil', 'unavailable'].map((k) => (
            <span className="legend-item" key={k}>
              <span className="legend-key" style={{ background: STATUSES[k].color }} />
              {STATUSES[k].label}
            </span>
          ))}
        </div>
        {unallocatedRows.length > 0 && (
          <span className="count-pill is-warn">{unallocatedRows.length} unallocated</span>
        )}
        <span className="count-pill">{peopleCount} people</span>
      </div>

      <Timeline
        days={days}
        colW={zoom.colW}
        dayLabels={zoom.dayLabels}
        labelWidth={labelWidth}
        groups={groups}
        collapsed={collapsed}
        onToggleGroup={(k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))}
        renderLabel={renderLabel}
        renderBar={renderBar}
        onCellClick={(row, date) => openDay(row, date)}
        emptyMessage="No people match this filter."
      />

      {dayPanel && (
        <Drawer
          title={dayPanel.member.name}
          subtitle={fmtLong(dayPanel.date)}
          onClose={() => setDayPanel(null)}
        >
          <Section title={`On this day (${dayPanel.entries.length})`}>
            {dayPanel.entries.length === 0 && (
              <div style={{ color: 'var(--text-mute)', fontSize: 12 }}>Nothing booked.</div>
            )}
            {dayPanel.entries.map((e) => {
              const meta = STATUSES[e.status || 'tentative'] || STATUSES.tentative;
              const nonWork = NON_WORK.has(e.status);
              return (
                <div className="entry-row" key={e.id}>
                  <span className="opt-dot" style={{ background: nonWork ? meta.color : (e.job_color || '#3b82f6') }} />
                  <span className="entry-name">
                    {nonWork ? meta.label : `${e.job_code} — ${e.job_name}`}
                    {e.notes ? ` · ${e.notes}` : ''}
                  </span>
                  {canEdit(dayPanel.member.id) && (isAdmin || nonWork) && (
                    <button
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => removeEntry(e)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </Section>

          {canEdit(dayPanel.member.id) && (
            <Section title="Add">
              <textarea
                className="note-input"
                placeholder="Note text (only needed for a note)…"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                style={{ marginBottom: 10 }}
              />
              <div className="opt-list">
                {QUICK_STATUSES.map((s) => (
                  <button key={s} className="opt" disabled={busy} onClick={() => addQuick(s)}>
                    <span className="opt-dot" style={{ background: STATUSES[s].color }} />
                    <span className="opt-name">{STATUSES[s].label}</span>
                    <span className="opt-hint">{s === 'note' ? 'needs text' : 'one day'}</span>
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 10, lineHeight: 1.5 }}>
                Job allocations are made from the job card. This panel covers the
                non-job entries — leave, TOIL, notes and unavailability.
              </div>
            </Section>
          )}

          {isViewer && <div className="banner banner-warn">Viewers cannot change the schedule.</div>}
        </Drawer>
      )}
    </>
  );
}
