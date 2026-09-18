import React, { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { STATUSES } from '../api.js';
import DayActionSheet from './DayActionSheet.jsx';
import JobCard from './JobCard.jsx';
import JobPlanner from './JobPlanner.jsx';
import {
  groupEntriesByDate, annotateSpans, withMonthHeaders,
  canEditSchedule, defaultMemberId, isUserEntry,
} from '../utils/individualSchedule.js';

const STATUS_CODES = ['TOIL', 'LEAVE', 'NOT-AVAIL'];

// How close to either end of the list before the next fortnight loads
const EDGE_MARGIN = 400;

// A note or leave-type entry rather than real work. Its job name already says
// what it is, so the code and the status label would only repeat it.
const isStatusJob = (entry) =>
  isUserEntry(entry) || entry.job_code?.startsWith('NOTE-') || STATUS_CODES.includes(entry.job_code);

const initials = (name) =>
  name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

// One person's schedule as a vertical, scrolling list of days. Replaces the
// horizontal grid on phone-sized viewports.
export default function IndividualSchedule({
  teamMembers, schedule, allDates, onLoadMore, onScrollToToday, onScheduleRefresh, showToast,
}) {
  const { user } = useAuth();
  const [memberId, setMemberId] = useState(null);
  const [sheetDate, setSheetDate] = useState(null);
  const [jobCardId, setJobCardId] = useState(null);
  const [plannerJobId, setPlannerJobId] = useState(null);

  const topSentinel = useRef(null);
  const bottomSentinel = useRef(null);
  const todayRow = useRef(null);
  const pendingHeight = useRef(null);
  const busy = useRef(false);
  const ready = useRef(false);
  const scrollToTodayNext = useRef(true);

  // Settle on a member once the team has loaded, and keep a valid one selected
  useEffect(() => {
    if (teamMembers.length === 0) return;
    setMemberId(prev => (prev && teamMembers.some(m => m.id === prev)) ? prev : defaultMemberId(user, teamMembers));
  }, [teamMembers, user]);

  const member = teamMembers.find(m => m.id === memberId);
  const editable = canEditSchedule(user, memberId);

  const dates = useMemo(() => withMonthHeaders(allDates), [allDates]);
  const byDate = useMemo(() => {
    const grouped = groupEntriesByDate(schedule, memberId);
    return annotateSpans(grouped, allDates);
  }, [schedule, memberId, allDates]);

  // Put today on screen, both on first paint and after the Today button.
  // Waits for a member, since the day rows do not exist until there is one.
  useLayoutEffect(() => {
    if (!memberId || dates.length === 0) return;

    if (scrollToTodayNext.current) {
      scrollToTodayNext.current = false;
      // Today is not always in range; the arming below has to happen regardless
      todayRow.current?.scrollIntoView({ block: 'center' });
    }

    // Only watch the edges once the list has settled where we put it
    const timer = setTimeout(() => { ready.current = true; }, 300);
    return () => clearTimeout(timer);
  }, [dates, memberId]);

  // Growing the range at the top pushes content down; put it back
  useLayoutEffect(() => {
    if (pendingHeight.current == null) return;
    const delta = document.documentElement.scrollHeight - pendingHeight.current;
    pendingHeight.current = null;
    if (delta > 0) window.scrollBy(0, delta);
  }, [dates]);

  const loadMore = useCallback(async (direction) => {
    if (busy.current || !ready.current) return;
    busy.current = true;
    pendingHeight.current = direction === 'past' ? document.documentElement.scrollHeight : null;
    try {
      await onLoadMore(direction);
    } finally {
      busy.current = false;
    }
  }, [onLoadMore]);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        loadMore(entry.target === topSentinel.current ? 'past' : 'future');
      }
    }, { rootMargin: EDGE_MARGIN + 'px 0px' });

    if (topSentinel.current) observer.observe(topSentinel.current);
    if (bottomSentinel.current) observer.observe(bottomSentinel.current);
    return () => observer.disconnect();
  }, [loadMore]);

  // Backstop for the observer, which browsers throttle in backgrounded tabs
  useEffect(() => {
    const onScroll = () => {
      const { scrollHeight } = document.documentElement;
      if (window.scrollY <= EDGE_MARGIN) loadMore('past');
      else if (window.scrollY + window.innerHeight >= scrollHeight - EDGE_MARGIN) loadMore('future');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [loadMore]);

  const handleToday = () => {
    scrollToTodayNext.current = true;
    ready.current = false;
    onScrollToToday();
  };

  if (!member) {
    return <div className="ind-empty">No team members yet.</div>;
  }

  return (
    <div className="ind-view">
      <div className="ind-header">
        <div className="ind-avatar" style={{ background: member.color }}>{initials(member.name)}</div>
        <div className="ind-person">
          <select
            className="ind-person-select"
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            aria-label="Whose schedule to show"
          >
            {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <div className="ind-person-meta">
            {[member.role, member.location].filter(Boolean).join(' · ') || 'Team member'}
          </div>
        </div>
        <button className="ind-today-btn" onClick={handleToday}>Today</button>
      </div>

      <div className="ind-days">
        <div ref={topSentinel} className="ind-sentinel" />

        {dates.map(d => {
          const entries = byDate[d.dateStr] || [];
          const canTap = editable;
          return (
            <React.Fragment key={d.dateStr}>
              {d.monthHeader && <div className="ind-month">{d.monthHeader}</div>}
              <div
                ref={d.isToday ? todayRow : null}
                className={`ind-day ${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''} ${canTap ? 'tappable' : ''}`}
                onClick={canTap ? () => setSheetDate(d) : undefined}
              >
                <div className="ind-rail">
                  <span className="ind-dayname">{d.dayName.toUpperCase()}</span>
                  <span className="ind-daynum">{d.dayNum}</span>
                </div>
                <div className="ind-entries">
                  {entries.length === 0 ? (
                    <div className="ind-free">
                      <span>Free</span>
                      {canTap && (
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                      )}
                    </div>
                  ) : entries.map(entry => {
                    const status = STATUSES[entry.status];
                    const accent = isStatusJob(entry) ? (status?.color || entry.job_color) : entry.job_color;
                    const meta = [
                      !isStatusJob(entry) && status?.label,
                      entry.spanLength > 1 && `day ${entry.spanIndex} of ${entry.spanLength}`,
                      entry.notes,
                    ].filter(Boolean).join(' · ');
                    return (
                      <div key={entry.id} className="ind-entry" style={{ borderLeftColor: accent }}>
                        <div className="ind-entry-title">
                          {isStatusJob(entry)
                            ? entry.job_name
                            : <>{entry.job_code} <span className="ind-entry-name">{entry.job_name}</span></>}
                        </div>
                        {meta && <div className="ind-entry-meta">{meta}</div>}
                        {!isStatusJob(entry) && entry.job_id && (
                          <button
                            type="button"
                            className="ind-entry-open"
                            title="Open job card"
                            onClick={(e) => { e.stopPropagation(); setJobCardId(entry.job_id); }}
                          >›</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </React.Fragment>
          );
        })}

        <div ref={bottomSentinel} className="ind-sentinel" />
      </div>

      {sheetDate && (
        <DayActionSheet
          date={sheetDate}
          entries={byDate[sheetDate.dateStr] || []}
          member={member}
          user={user}
          onClose={() => setSheetDate(null)}
          onChanged={onScheduleRefresh}
          showToast={showToast}
        />
      )}

      {jobCardId && (
        <div className="modal-overlay jobcard-overlay" onClick={() => setJobCardId(null)}>
          <div className="jobcard-modal" onClick={(e) => e.stopPropagation()}>
            <JobCard
              jobId={jobCardId}
              onBack={() => setJobCardId(null)}
              currentUser={user}
              teamMembers={teamMembers}
              showToast={showToast}
              onScheduleRefresh={onScheduleRefresh}
              onOpenPlanner={(id) => { setJobCardId(null); setPlannerJobId(id); }}
            />
          </div>
        </div>
      )}

      {/* Project planner modal (opened from the job card) */}
      {plannerJobId && (
        <div className="modal-overlay jp-overlay" onClick={() => setPlannerJobId(null)}>
          <div className="jp-modal" onClick={(e) => e.stopPropagation()}>
            <JobPlanner
              jobId={plannerJobId}
              onBack={() => setPlannerJobId(null)}
              onOpenCard={(id) => { setPlannerJobId(null); setJobCardId(id); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
