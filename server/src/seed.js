import { initDb } from './db.js';
import { v4 as uuidv4 } from 'uuid';

const db = initDb();

// Check if data already exists
const existingMembers = db.prepare('SELECT COUNT(*) as count FROM team_members').get();
if (existingMembers.count > 0) {
  console.log('Database already has data — skipping seed.');
  process.exit(0);
}

console.log('Seeding database...');

// Team members
const members = [
  { id: uuidv4(), name: 'Alex Turner', role: 'Lead Operator', location: 'Sydney', timezone: 'Australia/Sydney', color: '#3B82F6', sort_order: 1 },
  { id: uuidv4(), name: 'Sam Patel', role: 'Field Technician', location: 'Melbourne', timezone: 'Australia/Melbourne', color: '#10B981', sort_order: 2 },
  { id: uuidv4(), name: 'Jordan Lee', role: 'Drone Pilot', location: 'Brisbane', timezone: 'Australia/Brisbane', color: '#F59E0B', sort_order: 3 },
  { id: uuidv4(), name: 'Casey Morgan', role: 'Surveyor', location: 'Perth', timezone: 'Australia/Perth', color: '#EF4444', sort_order: 4 },
];

const insertMember = db.prepare(
  'INSERT INTO team_members (id, name, role, location, timezone, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
for (const m of members) {
  insertMember.run(m.id, m.name, m.role, m.location, m.timezone, m.color, m.sort_order);
}
console.log(`  Inserted ${members.length} team members`);

// Jobs
const jobs = [
  { id: uuidv4(), code: 'SITE-001', name: 'Northside Solar Farm', description: 'Solar panel installation survey', color: '#3B82F6', client: 'SunPower Co' },
  { id: uuidv4(), code: 'SITE-002', name: 'Harbor Bridge Inspection', description: 'Quarterly bridge structural inspection', color: '#10B981', client: 'City Council' },
  { id: uuidv4(), code: 'SITE-003', name: 'Greenfield Mapping', description: 'Topographic mapping for new development', color: '#F59E0B', client: 'Greenfield Dev' },
  { id: uuidv4(), code: 'MAINT-01', name: 'Equipment Maintenance', description: 'Weekly equipment check and calibration', color: '#8B5CF6', client: '' },
  { id: uuidv4(), code: 'TRAIN-01', name: 'Safety Training', description: 'Mandatory safety refresher course', color: '#EF4444', client: '' },
];

const insertJob = db.prepare(
  'INSERT INTO jobs (id, code, name, description, color, client) VALUES (?, ?, ?, ?, ?, ?)'
);
for (const j of jobs) {
  insertJob.run(j.id, j.code, j.name, j.description, j.color, j.client);
}
console.log(`  Inserted ${jobs.length} jobs`);

// Schedule entries for the current week (Mon–Fri)
function getWeekDates() {
  const today = new Date();
  const day = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
  const dates = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

const weekDates = getWeekDates();
const scheduleEntries = [
  { member: 0, job: 0, day: 0 },
  { member: 0, job: 0, day: 1 },
  { member: 0, job: 2, day: 2 },
  { member: 0, job: 3, day: 4 },
  { member: 1, job: 1, day: 0 },
  { member: 1, job: 1, day: 1 },
  { member: 1, job: 0, day: 3 },
  { member: 2, job: 2, day: 0 },
  { member: 2, job: 2, day: 1 },
  { member: 2, job: 2, day: 2 },
  { member: 2, job: 4, day: 3 },
  { member: 3, job: 1, day: 2 },
  { member: 3, job: 1, day: 3 },
  { member: 3, job: 3, day: 4 },
];

const insertSchedule = db.prepare(
  'INSERT INTO schedule_entries (id, team_member_id, job_id, date) VALUES (?, ?, ?, ?)'
);
for (const e of scheduleEntries) {
  insertSchedule.run(uuidv4(), members[e.member].id, jobs[e.job].id, weekDates[e.day]);
}
console.log(`  Inserted ${scheduleEntries.length} schedule entries for week of ${weekDates[0]}`);

console.log('Seed complete!');
process.exit(0);
