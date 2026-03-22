// Server-backed API layer
// All data is stored in SQLite on the server, shared across all users/devices

const API = '/api';

export const STATUSES = {
  confirmed: { label: 'Confirmed', color: '#22c55e' },
  tentative: { label: 'Tentative', color: '#eab308' },
  note: { label: 'Note', color: '#3b82f6' },
  toil: { label: 'TOIL', color: '#a855f7' },
  leave: { label: 'Leave', color: '#10b981' },
  unavailable: { label: 'Not Available', color: '#ef4444' },
};

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error ${res.status}`);
  }
  return res.json();
}

// ── Team Members ──

export async function getTeamMembers() {
  return api('/team-members');
}

export async function getEquipment() {
  return api('/team-members/equipment');
}

export async function createEquipment(data) {
  return createTeamMember({ ...data, is_equipment: 1 });
}

export async function createTeamMember(data) {
  return api('/team-members', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateTeamMember(id, data) {
  return api(`/team-members/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteTeamMember(id) {
  return api(`/team-members/${id}`, { method: 'DELETE' });
}

// ── Jobs ──

export async function getJobs() {
  return api('/jobs');
}

export async function createJob(data) {
  return api('/jobs', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateJob(id, data) {
  return api(`/jobs/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteJob(id) {
  return api(`/jobs/${id}`, { method: 'DELETE' });
}

// ── Schedule ──

export async function getSchedule(start, end) {
  return api(`/schedule?start=${start}&end=${end}`);
}

export async function assignSchedule(data) {
  return api('/schedule', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function bulkAssignSchedule(data) {
  return api('/schedule/bulk', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function updateScheduleStatus(memberId, date, status) {
  return api('/schedule/status', {
    method: 'PUT',
    body: JSON.stringify({ team_member_id: memberId, date, status }),
  });
}

export async function updateScheduleNotes(memberId, date, notes) {
  return api('/schedule/notes', {
    method: 'PUT',
    body: JSON.stringify({ team_member_id: memberId, date, notes }),
  });
}

export async function deleteScheduleEntry(id) {
  return api(`/schedule/${id}`, { method: 'DELETE' });
}

export async function clearScheduleEntry(memberId, date) {
  return api(`/schedule/member/${memberId}/date/${date}`, { method: 'DELETE' });
}

// ── Export (client-side iCal generation from server data) ──

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
    ics += `UID:${crypto.randomUUID()}@ops-schedule\r\n`;
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

export async function downloadIcalMember(memberId, startDate, endDate) {
  // Fetch member info
  const members = await getTeamMembers();
  const equipment = await getEquipment();
  const allMembers = [...members, ...equipment];
  const member = allMembers.find(m => m.id === memberId);
  if (!member) throw new Error('Team member not found');

  // Fetch their schedule from server
  const memberSchedule = await api(`/schedule/member/${memberId}?${startDate ? `start=${startDate}&end=${endDate}` : ''}`);

  const events = memberSchedule.map(e => {
    let desc = `Job: ${e.job_code} - ${e.job_name}`;
    if (e.job_file_url) desc += `\nFiles: ${e.job_file_url}`;
    if (e.notes) desc += `\nNotes: ${e.notes}`;
    return { date: e.date, summary: `${e.job_code} - ${e.job_name}`, description: desc };
  });

  const ics = buildIcsEvents(events);
  downloadBlob(ics, `schedule-${member.name.replace(/\s+/g, '-')}.ics`);
}

export async function downloadIcalJob(jobId) {
  const jobs = await getJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) throw new Error('Job not found');

  // Get all schedule entries and filter by job
  const allSchedule = await getSchedule('2020-01-01', '2030-12-31');
  const entries = allSchedule.filter(e => e.job_id === jobId);

  const byDate = {};
  for (const e of entries) {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e.member_name || 'Unknown');
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

export async function getNotifications(memberId) {
  return api(`/notifications/member/${memberId}`);
}

export async function getUnreadCount(memberId) {
  return api(`/notifications/member/${memberId}/unread`);
}

export async function createNotification(data) {
  return api('/notifications', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function markNotificationRead(id) {
  return api(`/notifications/${id}/read`, { method: 'PUT' });
}

export async function markAllRead(memberId) {
  return api(`/notifications/member/${memberId}/read-all`, { method: 'PUT' });
}

// ── Seed ──

export async function seedDatabase() {
  return api('/seed', { method: 'POST' });
}

export async function getSeedStatus() {
  return api('/seed/status');
}

// ── Auth ──

export async function authLogin(email, password) {
  return api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export async function authLogout() {
  return api('/auth/logout', { method: 'POST' });
}

export async function authMe() {
  return api('/auth/me');
}

export async function authStatus() {
  return api('/auth/status');
}

export async function authInit() {
  return api('/auth/init');
}

export async function authSetup(email, password, name) {
  return api('/auth/setup', { method: 'POST', body: JSON.stringify({ email, password, name }) });
}

export async function authChangePassword(currentPassword, newPassword) {
  return api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
}

export async function authForgotPassword(email) {
  return api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
}

export async function authResetPassword(token, newPassword) {
  return api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) });
}

export async function authAdminResetPassword(memberId, tempPassword) {
  return api('/auth/admin-reset-password', { method: 'POST', body: JSON.stringify({ memberId, tempPassword }) });
}

export async function shareViewerAccess(recipientEmail) {
  return api('/auth/share-viewer-access', { method: 'POST', body: JSON.stringify({ recipientEmail }) });
}

// Passkey
export async function passkeyRegisterOptions() {
  return api('/auth/passkey/register-options', { method: 'POST' });
}

export async function passkeyRegisterVerify(body) {
  return api('/auth/passkey/register-verify', { method: 'POST', body: JSON.stringify(body) });
}

export async function passkeyLoginOptions(email) {
  return api('/auth/passkey/login-options', { method: 'POST', body: JSON.stringify({ email }) });
}

export async function passkeyLoginVerify(body) {
  return api('/auth/passkey/login-verify', { method: 'POST', body: JSON.stringify(body) });
}

// Admin: set email/password for a team member
export async function setMemberCredentials(memberId, email, password) {
  return api(`/team-members/${memberId}`, {
    method: 'PUT',
    body: JSON.stringify({ email, password_hash: '__SET_PASSWORD__', _password: password }),
  });
}
