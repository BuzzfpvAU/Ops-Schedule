import { diffDays } from './dates.js';

// ── Field view model ────────────────────────────────────────────────
// Pure helpers behind the phone layout: a person's days grouped into runs
// on a job, and where each piece of kit is now and next.

// One person's (or item's) schedule entries as runs: consecutive days on
// the same job with the same status. Runs ending before `fromIso` are left
// out; a run in progress is kept whole so "since Monday" still shows.
export function runsFor(entries, memberId, fromIso) {
  const mine = entries
    .filter((e) => e.team_member_id === memberId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const runs = [];
  for (const e of mine) {
    const last = runs[runs.length - 1];
    if (last && last.job_id === e.job_id && last.status === e.status && diffDays(last.end, e.date) === 1) {
      last.end = e.date;
      last.days += 1;
      if (e.notes) last.notes.push({ date: e.date, text: e.notes });
      continue;
    }
    runs.push({
      key: `${e.job_id}:${e.date}`,
      job_id: e.job_id,
      job_code: e.job_code,
      job_name: e.job_name,
      job_color: e.job_color,
      status: e.status,
      start: e.date,
      end: e.date,
      days: 1,
      notes: e.notes ? [{ date: e.date, text: e.notes }] : [],
    });
  }
  return runs.filter((r) => r.end >= fromIso);
}

// The badge on a run: "Now" while it is under way, then "Tomorrow" or
// "In 5 days".
export function runWhen(run, todayIso) {
  if (run.start <= todayIso) return 'Now';
  const n = diffDays(todayIso, run.start);
  return n === 1 ? 'Tomorrow' : `In ${n} days`;
}

// Where an item is booked today, and its next booking after that.
export function kitStatus(entries, itemId, todayIso) {
  const runs = runsFor(entries, itemId, todayIso);
  const now = runs.find((r) => r.start <= todayIso && r.end >= todayIso) || null;
  const next = runs.find((r) => r.start > todayIso) || null;
  return { now, next };
}

// Kit booked to any job the person is on from today forward — what a crew
// member is likely to pack, check or inspect.
export function kitOnMyJobs(entries, memberId, todayIso) {
  const myJobs = new Set(entries.filter((e) => e.team_member_id === memberId && e.date >= todayIso).map((e) => e.job_id));
  const ids = new Set();
  for (const e of entries) {
    if (e.date >= todayIso && e.team_member_id !== memberId && myJobs.has(e.job_id)) ids.add(e.team_member_id);
  }
  return ids;
}

// "5 min ago", "3 h ago", "2 d ago" for a last-seen timestamp.
export function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const t = new Date(iso.includes('T') || iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// A maps link that opens the phone's maps app (Apple Maps on iOS hands
// Google links on to it too).
export function mapsUrl({ lat, lng, address }) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return null;
}
