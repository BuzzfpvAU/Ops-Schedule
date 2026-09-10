// Pure logic for the mobile individual schedule view.
// Kept free of React and the DOM so it can be tested directly.

// Statuses a non-admin is allowed to set on their own days
export const USER_ALLOWED_STATUSES = ['note', 'toil', 'leave', 'unavailable'];

// Group a member's entries by date string: { '2026-09-10': [entry, ...] }
export function groupEntriesByDate(schedule, memberId) {
  const byDate = {};
  if (!memberId) return byDate;

  for (const entry of schedule) {
    if (entry.team_member_id !== memberId) continue;
    (byDate[entry.date] ||= []).push(entry);
  }
  return byDate;
}

// An entry the viewing user added themselves, and may therefore remove
export function isUserEntry(entry) {
  return USER_ALLOWED_STATUSES.includes(entry.status);
}

// Whether the viewing user may add entries to the schedule on screen
export function canEditSchedule(user, viewedMemberId) {
  if (!user || user.isViewer) return false;
  if (user.isAdmin) return true;
  return Boolean(viewedMemberId) && viewedMemberId === user.memberId;
}

// Whether the viewing user may remove a specific entry
export function canDeleteEntry(user, entry) {
  if (!user || user.isViewer) return false;
  if (user.isAdmin) return true;
  return entry.team_member_id === user.memberId && isUserEntry(entry);
}

// Which member the view opens on: yourself, else the first person on the team
export function defaultMemberId(user, teamMembers) {
  const own = teamMembers.find(m => m.id === user?.memberId);
  if (own) return own.id;
  return teamMembers[0]?.id || null;
}

// 'SEPTEMBER 2026' — used for the sticky headers between months
export function monthLabel(date) {
  return date
    .toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
    .toUpperCase();
}

// Tag each date with the month header it should render, if any
export function withMonthHeaders(dates) {
  let previous = null;
  return dates.map(d => {
    const label = monthLabel(d.date);
    const header = label === previous ? null : label;
    previous = label;
    return { ...d, monthHeader: header };
  });
}

// Mark each entry with its position in a run of consecutive days on the same job,
// so a three-day job can read "day 2 of 3" instead of repeating itself.
export function annotateSpans(byDate, dates) {
  const positionOf = new Map(dates.map((d, i) => [d.dateStr, i]));

  // Where each job appears, as positions in the visible date range
  const positionsByJob = new Map();
  for (const [dateStr, entries] of Object.entries(byDate)) {
    const pos = positionOf.get(dateStr);
    if (pos === undefined) continue;
    for (const entry of entries) {
      if (!positionsByJob.has(entry.job_id)) positionsByJob.set(entry.job_id, []);
      positionsByJob.get(entry.job_id).push(pos);
    }
  }

  // Consecutive positions form one run: { [jobId]: { [pos]: { index, length } } }
  const runsByJob = new Map();
  for (const [jobId, positions] of positionsByJob) {
    const sorted = [...new Set(positions)].sort((a, b) => a - b);
    const spans = new Map();
    let runStart = 0;
    for (let i = 0; i <= sorted.length; i++) {
      const breaks = i === sorted.length || sorted[i] !== sorted[i - 1] + 1;
      if (i > 0 && breaks) {
        const length = i - runStart;
        for (let k = runStart; k < i; k++) {
          spans.set(sorted[k], { index: k - runStart + 1, length });
        }
        runStart = i;
      }
    }
    runsByJob.set(jobId, spans);
  }

  const annotated = {};
  for (const [dateStr, entries] of Object.entries(byDate)) {
    const pos = positionOf.get(dateStr);
    annotated[dateStr] = entries.map(entry => {
      const span = runsByJob.get(entry.job_id)?.get(pos);
      return { ...entry, spanIndex: span?.index ?? 1, spanLength: span?.length ?? 1 };
    });
  }
  return annotated;
}
