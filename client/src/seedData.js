import data from './seedData.json';

const KEYS = {
  teamMembers: 'ops_team_members',
  jobs: 'ops_jobs',
  schedule: 'ops_schedule_entries',
  notifications: 'ops_notifications',
};

export function needsSeed() {
  const members = localStorage.getItem(KEYS.teamMembers);
  const jobs = localStorage.getItem(KEYS.jobs);
  return !members || members === '[]' || !jobs || jobs === '[]';
}

export function seedFromSpreadsheet() {
  localStorage.setItem(KEYS.teamMembers, JSON.stringify(data.team_members));
  localStorage.setItem(KEYS.jobs, JSON.stringify(data.jobs));
  localStorage.setItem(KEYS.schedule, JSON.stringify(data.schedule));
  if (!localStorage.getItem(KEYS.notifications)) {
    localStorage.setItem(KEYS.notifications, JSON.stringify([]));
  }
}
