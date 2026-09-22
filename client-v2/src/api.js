// V2 API client — same server, same endpoints, same httpOnly cookie session
// as the v1 UI. Nothing here is V2-specific except `getEquipmentBookings`.

const API = '/api';

export const STATUSES = {
  confirmed:   { label: 'Confirmed',     color: '#22c55e' },
  tentative:   { label: 'Tentative',     color: '#eab308' },
  note:        { label: 'Note',          color: '#3b82f6' },
  toil:        { label: 'TOIL',          color: '#a855f7' },
  leave:       { label: 'Leave',         color: '#10b981' },
  unavailable: { label: 'Not available', color: '#ef4444' },
};

export const JOB_STATUSES = {
  planning:  { label: 'Planning',  color: '#94a3b8' },
  confirmed: { label: 'Confirmed', color: '#38bdf8' },
  active:    { label: 'Active',    color: '#22c55e' },
  complete:  { label: 'Complete',  color: '#64748b' },
  cancelled: { label: 'Cancelled', color: '#ef4444' },
};

export const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT', 'Processing', 'Other'];

export const EQUIPMENT_CATEGORIES = [
  'Drones', 'Payloads', 'Batteries', 'Survey Equip', 'Accessories', 'Spare Parts', 'Vehicles',
];

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const e = new Error(err.error || `API error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// ── Auth ──
export const authMe = () => api('/auth/me');
export const authLogin = (email, password) =>
  api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
export const authLogout = () => api('/auth/logout', { method: 'POST' });

// ── Reference data ──
export const getTeamMembers = () => api('/team-members');
export const getEquipment = (includeInactive = false) =>
  api(`/team-members/equipment${includeInactive ? '?include_inactive=1' : ''}`);

export const updateEquipment = (id, data) =>
  api(`/team-members/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const getJobs = () => api('/jobs');
export const getJobCard = (id) => api(`/jobs/${id}`);

// ── Schedule ──
export const getSchedule = (start, end) =>
  api(`/schedule?start=${start}&end=${end}`);

export const assignSchedule = (data) =>
  api('/schedule', { method: 'PUT', body: JSON.stringify(data) });

export const bulkAssignSchedule = (data) =>
  api('/schedule/bulk', { method: 'PUT', body: JSON.stringify(data) });

export const quickEntry = (data) =>
  api('/schedule/quick', { method: 'POST', body: JSON.stringify(data) });

export const deleteScheduleEntry = (id) =>
  api(`/schedule/${id}`, { method: 'DELETE' });

export const updateScheduleStatus = (entryId, status) =>
  api('/schedule/status', { method: 'PUT', body: JSON.stringify({ entry_id: entryId, status }) });

// ── Single project ──
export const getJobPlanner = (id, from, to) => {
  const q = from && to ? `?from=${from}&to=${to}` : '';
  return api(`/jobs/${id}/planner${q}`);
};

export const addJobDayNote = (jobId, data) =>
  api(`/jobs/${jobId}/day-notes`, { method: 'POST', body: JSON.stringify(data) });

export const deleteJobDayNote = (noteId) =>
  api(`/jobs/day-notes/${noteId}`, { method: 'DELETE' });

// ── Equipment allocation ──
// The booking index is the one endpoint V2 adds: it maps an equipment item's
// booked days back to the job_equipment assignment that owns them, which is
// what the travel-pad controls need.
export const getEquipmentBookings = (start, end) =>
  api(`/equipment/bookings?start=${start}&end=${end}`);

export const adjustBooking = (assignmentId, edge, delta) =>
  api(`/jobs/equipment/${assignmentId}/booking`, {
    method: 'POST',
    body: JSON.stringify({ edge, delta }),
  });
