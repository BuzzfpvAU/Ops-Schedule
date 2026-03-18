const API_BASE = '/ops/api';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Request failed');
  }
  // Handle iCal downloads
  if (res.headers.get('content-type')?.includes('text/calendar')) {
    return res.blob();
  }
  return res.json();
}

// Team Members
export const getTeamMembers = () => request('/team-members');
export const createTeamMember = (data) => request('/team-members', { method: 'POST', body: JSON.stringify(data) });
export const updateTeamMember = (id, data) => request(`/team-members/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteTeamMember = (id) => request(`/team-members/${id}`, { method: 'DELETE' });

// Jobs
export const getJobs = () => request('/jobs');
export const createJob = (data) => request('/jobs', { method: 'POST', body: JSON.stringify(data) });
export const updateJob = (id, data) => request(`/jobs/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteJob = (id) => request(`/jobs/${id}`, { method: 'DELETE' });

// Schedule
export const getSchedule = (start, end) => request(`/schedule?start=${start}&end=${end}`);
export const assignSchedule = (data) => request('/schedule', { method: 'PUT', body: JSON.stringify(data) });
export const bulkAssignSchedule = (data) => request('/schedule/bulk', { method: 'PUT', body: JSON.stringify(data) });
export const deleteScheduleEntry = (id) => request(`/schedule/${id}`, { method: 'DELETE' });
export const clearScheduleEntry = (memberId, date) => request(`/schedule/member/${memberId}/date/${date}`, { method: 'DELETE' });

// Export
export const downloadIcalMember = (memberId) => request(`/export/ical/member/${memberId}`);
export const downloadIcalJob = (jobId) => request(`/export/ical/job/${jobId}`);
export const getGcalLink = (title, date, description) =>
  request(`/export/gcal-link?title=${encodeURIComponent(title)}&date=${date}&description=${encodeURIComponent(description || '')}`);

// Notifications
export const getNotifications = (memberId) => request(`/notifications/member/${memberId}`);
export const getUnreadCount = (memberId) => request(`/notifications/member/${memberId}/unread`);
export const createNotification = (data) => request('/notifications', { method: 'POST', body: JSON.stringify(data) });
export const markNotificationRead = (id) => request(`/notifications/${id}/read`, { method: 'PUT' });
export const markAllRead = (memberId) => request(`/notifications/member/${memberId}/read-all`, { method: 'PUT' });
