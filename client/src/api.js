// localStorage-backed API layer
// Same function signatures as the original fetch-based API

const KEYS = {
  teamMembers: 'ops_team_members',
  jobs: 'ops_jobs',
  schedule: 'ops_schedule_entries',
  notifications: 'ops_notifications',
};

function getStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

function setStore(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function uuid() {
  return crypto.randomUUID();
}

// ── Team Members ──

export function getTeamMembers() {
  return getStore(KEYS.teamMembers)
    .filter(m => m.active === 1)
    .sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
}

export function createTeamMember(data) {
  const members = getStore(KEYS.teamMembers);
  const member = {
    id: uuid(),
    name: data.name,
    role: data.role || '',
    location: data.location || '',
    timezone: data.timezone || 'Australia/Sydney',
    color: data.color || '#3B82F6',
    sort_order: data.sort_order || 0,
    active: 1,
    created_at: now(),
    updated_at: now(),
  };
  members.push(member);
  setStore(KEYS.teamMembers, members);
  return member;
}

export function updateTeamMember(id, data) {
  const members = getStore(KEYS.teamMembers);
  const idx = members.findIndex(m => m.id === id);
  if (idx === -1) throw new Error('Team member not found');

  const existing = members[idx];
  members[idx] = {
    ...existing,
    name: data.name || existing.name,
    role: data.role ?? existing.role,
    location: data.location ?? existing.location,
    timezone: data.timezone || existing.timezone,
    color: data.color || existing.color,
    sort_order: data.sort_order ?? existing.sort_order,
    updated_at: now(),
  };
  setStore(KEYS.teamMembers, members);
  return members[idx];
}

export function deleteTeamMember(id) {
  const members = getStore(KEYS.teamMembers);
  const idx = members.findIndex(m => m.id === id);
  if (idx === -1) throw new Error('Team member not found');
  members[idx].active = 0;
  members[idx].updated_at = now();
  setStore(KEYS.teamMembers, members);
  return { success: true };
}

// ── Jobs ──

export function getJobs() {
  return getStore(KEYS.jobs)
    .filter(j => j.active === 1)
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function createJob(data) {
  if (!data.code || !data.name) throw new Error('Code and name are required');
  const jobs = getStore(KEYS.jobs);
  if (jobs.find(j => j.code === data.code)) throw new Error('Job code already exists');

  const job = {
    id: uuid(),
    code: data.code,
    name: data.name,
    description: data.description || '',
    color: data.color || '#3B82F6',
    client: data.client || '',
    file_url: data.file_url || '',
    active: 1,
    created_at: now(),
    updated_at: now(),
  };
  jobs.push(job);
  setStore(KEYS.jobs, jobs);
  return job;
}

export function updateJob(id, data) {
  const jobs = getStore(KEYS.jobs);
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) throw new Error('Job not found');

  const existing = jobs[idx];
  if (data.code && data.code !== existing.code) {
    if (jobs.find(j => j.code === data.code && j.id !== id)) {
      throw new Error('Job code already exists');
    }
  }

  jobs[idx] = {
    ...existing,
    code: data.code || existing.code,
    name: data.name || existing.name,
    description: data.description ?? existing.description,
    color: data.color || existing.color,
    client: data.client ?? existing.client,
    file_url: data.file_url ?? existing.file_url,
    updated_at: now(),
  };
  setStore(KEYS.jobs, jobs);
  return jobs[idx];
}

export function deleteJob(id) {
  const jobs = getStore(KEYS.jobs);
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) throw new Error('Job not found');
  jobs[idx].active = 0;
  jobs[idx].updated_at = now();
  setStore(KEYS.jobs, jobs);
  return { success: true };
}

// ── Schedule ──

export function getSchedule(start, end) {
  const entries = getStore(KEYS.schedule);
  const members = getStore(KEYS.teamMembers);
  const jobs = getStore(KEYS.jobs);

  const memberMap = Object.fromEntries(members.map(m => [m.id, m]));
  const jobMap = Object.fromEntries(jobs.map(j => [j.id, j]));

  return entries
    .filter(e => e.date >= start && e.date <= end)
    .map(e => {
      const m = memberMap[e.team_member_id] || {};
      const j = jobMap[e.job_id] || {};
      return {
        id: e.id,
        team_member_id: e.team_member_id,
        job_id: e.job_id,
        date: e.date,
        notes: e.notes,
        member_name: m.name,
        member_color: m.color,
        timezone: m.timezone,
        job_code: j.code,
        job_name: j.name,
        job_color: j.color,
        job_file_url: j.file_url,
      };
    })
    .sort((a, b) => {
      const ma = memberMap[a.team_member_id] || {};
      const mb = memberMap[b.team_member_id] || {};
      return ((ma.sort_order || 0) - (mb.sort_order || 0)) || (ma.name || '').localeCompare(mb.name || '') || a.date.localeCompare(b.date);
    });
}

export function assignSchedule(data) {
  const { team_member_id, job_id, date, notes } = data;
  if (!team_member_id || !job_id || !date) throw new Error('team_member_id, job_id, and date are required');

  const entries = getStore(KEYS.schedule);
  const existingIdx = entries.findIndex(e => e.team_member_id === team_member_id && e.date === date);
  const previousJobId = existingIdx >= 0 ? entries[existingIdx].job_id : null;

  let id;
  if (existingIdx >= 0) {
    id = entries[existingIdx].id;
    entries[existingIdx].job_id = job_id;
    entries[existingIdx].notes = notes || '';
    entries[existingIdx].updated_at = now();
  } else {
    id = uuid();
    entries.push({ id, team_member_id, job_id, date, notes: notes || '', created_at: now(), updated_at: now() });
  }
  setStore(KEYS.schedule, entries);

  const members = getStore(KEYS.teamMembers);
  const jobs = getStore(KEYS.jobs);
  const m = members.find(x => x.id === team_member_id) || {};
  const j = jobs.find(x => x.id === job_id) || {};

  const isNew = existingIdx < 0;
  const isChanged = !isNew && previousJobId !== job_id;

  return {
    id,
    team_member_id,
    job_id,
    date,
    notes: notes || '',
    member_name: m.name,
    job_code: j.code,
    job_name: j.name,
    job_color: j.color,
    _notification: {
      type: isNew ? 'assigned' : (isChanged ? 'changed' : 'updated'),
      team_member_id,
      date,
    },
  };
}

export function bulkAssignSchedule(data) {
  const { team_member_id, job_id, dates, notes } = data;
  if (!team_member_id || !job_id || !dates || !Array.isArray(dates)) {
    throw new Error('team_member_id, job_id, and dates array are required');
  }

  const entries = getStore(KEYS.schedule);
  for (const date of dates) {
    const existingIdx = entries.findIndex(e => e.team_member_id === team_member_id && e.date === date);
    if (existingIdx >= 0) {
      entries[existingIdx].job_id = job_id;
      entries[existingIdx].notes = notes || '';
      entries[existingIdx].updated_at = now();
    } else {
      entries.push({ id: uuid(), team_member_id, job_id, date, notes: notes || '', created_at: now(), updated_at: now() });
    }
  }
  setStore(KEYS.schedule, entries);

  return {
    success: true,
    count: dates.length,
    _notification: {
      type: 'bulk_assigned',
      team_member_id,
      dates,
    },
  };
}

export function deleteScheduleEntry(id) {
  const entries = getStore(KEYS.schedule);
  const existing = entries.find(e => e.id === id);
  if (!existing) throw new Error('Schedule entry not found');

  setStore(KEYS.schedule, entries.filter(e => e.id !== id));
  return {
    success: true,
    _notification: {
      type: 'removed',
      team_member_id: existing.team_member_id,
      date: existing.date,
    },
  };
}

export function clearScheduleEntry(memberId, date) {
  const entries = getStore(KEYS.schedule);
  const filtered = entries.filter(e => !(e.team_member_id === memberId && e.date === date));
  const deleted = entries.length - filtered.length;
  setStore(KEYS.schedule, filtered);
  return { success: true, deleted };
}

// ── Export ──

function buildIcsEvents(events) {
  let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OpsSchedule//EN\r\n';
  for (const evt of events) {
    const dateStr = evt.date.replace(/-/g, '');
    const nextDay = new Date(evt.date);
    nextDay.setDate(nextDay.getDate() + 1);
    const endStr = nextDay.toISOString().slice(0, 10).replace(/-/g, '');
    ics += 'BEGIN:VEVENT\r\n';
    ics += `DTSTART;VALUE=DATE:${dateStr}\r\n`;
    ics += `DTEND;VALUE=DATE:${endStr}\r\n`;
    ics += `SUMMARY:${evt.summary}\r\n`;
    if (evt.description) ics += `DESCRIPTION:${evt.description.replace(/\n/g, '\\n')}\r\n`;
    ics += `UID:${uuid()}@ops-schedule\r\n`;
    ics += 'END:VEVENT\r\n';
  }
  ics += 'END:VCALENDAR\r\n';
  return ics;
}

function downloadBlob(content, filename, type = 'text/calendar') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadIcalMember(memberId) {
  const members = getStore(KEYS.teamMembers);
  const member = members.find(m => m.id === memberId);
  if (!member) throw new Error('Team member not found');

  const entries = getStore(KEYS.schedule).filter(e => e.team_member_id === memberId).sort((a, b) => a.date.localeCompare(b.date));
  const jobs = getStore(KEYS.jobs);
  const jobMap = Object.fromEntries(jobs.map(j => [j.id, j]));

  const events = entries.map(e => {
    const j = jobMap[e.job_id] || {};
    let desc = `Job: ${j.code} - ${j.name}`;
    if (j.description) desc += `\n${j.description}`;
    if (j.file_url) desc += `\nFiles: ${j.file_url}`;
    if (e.notes) desc += `\nNotes: ${e.notes}`;
    return { date: e.date, summary: `${j.code} - ${j.name}`, description: desc };
  });

  const ics = buildIcsEvents(events);
  downloadBlob(ics, `schedule-${member.name.replace(/\s+/g, '-')}.ics`);
}

export function downloadIcalJob(jobId) {
  const jobs = getStore(KEYS.jobs);
  const job = jobs.find(j => j.id === jobId);
  if (!job) throw new Error('Job not found');

  const entries = getStore(KEYS.schedule).filter(e => e.job_id === jobId).sort((a, b) => a.date.localeCompare(b.date));
  const members = getStore(KEYS.teamMembers);
  const memberMap = Object.fromEntries(members.map(m => [m.id, m]));

  // Group by date
  const byDate = {};
  for (const e of entries) {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push((memberMap[e.team_member_id] || {}).name || 'Unknown');
  }

  const events = Object.entries(byDate).map(([date, memberNames]) => ({
    date,
    summary: `${job.code} - ${job.name}`,
    description: `Team: ${memberNames.join(', ')}\n${job.description || ''}${job.file_url ? '\nFiles: ' + job.file_url : ''}`,
  }));

  const ics = buildIcsEvents(events);
  downloadBlob(ics, `schedule-${job.code}.ics`);
}

export function getGcalLink(title, date, description) {
  const dateStr = date.replace(/-/g, '');
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);
  const endStr = nextDay.toISOString().slice(0, 10).replace(/-/g, '');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${dateStr}/${endStr}`,
    details: description || '',
  });

  return { url: `https://calendar.google.com/calendar/render?${params.toString()}` };
}

// ── Notifications ──

export function getNotifications(memberId) {
  return getStore(KEYS.notifications)
    .filter(n => n.team_member_id === memberId)
    .sort((a, b) => (a.read - b.read) || new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
}

export function getUnreadCount(memberId) {
  const count = getStore(KEYS.notifications)
    .filter(n => n.team_member_id === memberId && n.read === 0)
    .length;
  return { count };
}

export function createNotification(data) {
  if (!data.team_member_id || !data.message) throw new Error('team_member_id and message required');
  const notifications = getStore(KEYS.notifications);
  const notification = {
    id: uuid(),
    team_member_id: data.team_member_id,
    type: data.type || 'info',
    message: data.message,
    date: data.date || null,
    job_code: data.job_code || null,
    read: 0,
    created_at: now(),
  };
  notifications.push(notification);
  setStore(KEYS.notifications, notifications);
  return notification;
}

export function markNotificationRead(id) {
  const notifications = getStore(KEYS.notifications);
  const n = notifications.find(x => x.id === id);
  if (n) n.read = 1;
  setStore(KEYS.notifications, notifications);
  return { success: true };
}

export function markAllRead(memberId) {
  const notifications = getStore(KEYS.notifications);
  for (const n of notifications) {
    if (n.team_member_id === memberId) n.read = 1;
  }
  setStore(KEYS.notifications, notifications);
  return { success: true };
}
