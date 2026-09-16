#!/usr/bin/env node
/**
 * One-off backfill (2026-09-17): allocate a project lead — and therefore a
 * state — to every active, unassigned job, inferred from the people already
 * rostered on it.
 *
 * Grant's model: a job's state is where its project lead is from. For this
 * backfill the lead is inferred from the allocated crew:
 *   1. the person with the most rostered days on the job ("running the job")
 *   2. tie -> higher seniority role (manager > senior pilot > pilot > other)
 *   3. tie -> earliest first rostered day
 *   4. tie -> name
 *
 * Only touches jobs with lead_id AND state empty, so it is re-runnable.
 * Non-project codes (UNAVAILABLE, CLOSED, BREAK-DAY, TOIL-…) are skipped.
 *
 * Usage (from the server dir — better-sqlite3 lives in server/node_modules):
 *   cd ~/domains/taskz.id/nodejs/server
 *   DATABASE_PATH=~/data/ops-schedule.db node scripts/allocate-lead-state.js           # dry run
 *   DATABASE_PATH=~/data/ops-schedule.db node scripts/allocate-lead-state.js --apply   # write
 */
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const APPLY = process.argv.includes('--apply');
const dbPath = (process.env.DATABASE_PATH || path.join(os.homedir(), 'data', 'ops-schedule.db'))
  .replace(/^~($|\/)/, os.homedir() + '$1');

// Status markers / placeholders that are not project work — left unassigned
const SKIP_EXACT = new Set(['CLOSED', 'NO-TRAVEL']);
const SKIP_RE = /LEAVE|UNAVAIL|NOT-AVAIL|^TOIL|^BREAK-DAY|^N-A-/i;
function isSkippable(code) {
  return SKIP_EXACT.has(code.toUpperCase()) || SKIP_RE.test(code);
}

const db = new Database(dbPath, APPLY ? {} : { readonly: true });
db.pragma('busy_timeout = 5000');

const jobs = db.prepare(`
  SELECT j.id, j.code, j.name
  FROM jobs j
  WHERE j.active = 1 AND j.archived = 0
    AND (j.lead_id IS NULL OR j.lead_id = '')
    AND (j.state IS NULL OR j.state = '')
    AND j.code NOT LIKE 'NOTE-%'
    AND j.code NOT IN ('TOIL', 'LEAVE', 'NOT-AVAIL')
  ORDER BY j.code
`).all();

const crewStmt = db.prepare(`
  SELECT tm.id, tm.name, IFNULL(tm.role, '') AS role, IFNULL(tm.location, '') AS location,
         COUNT(DISTINCT se.date) AS days, MIN(se.date) AS first_day
  FROM schedule_entries se
  JOIN team_members tm ON tm.id = se.team_member_id
  WHERE se.job_id = ? AND tm.is_equipment = 0
  GROUP BY tm.id
`);

function seniority(role) {
  const r = String(role || '').toLowerCase().replace(/\u00a0/g, ' ').trim();
  if (!r) return 1;
  if (/manag|director/.test(r)) return 4;
  if (/senior pilot/.test(r)) return 3;
  if (/rpas operator|pilot|team us|repl/.test(r)) return 2;
  return 1;
}

const assignments = [];
const skipped = { pseudo: [], noCrew: [], noLocatedCrew: [] };

for (const job of jobs) {
  if (isSkippable(job.code)) { skipped.pseudo.push(job.code); continue; }
  const crew = crewStmt.all(job.id);
  if (!crew.length) { skipped.noCrew.push(job.code); continue; }
  const located = crew.filter(c => c.location.trim() !== '');
  if (!located.length) { skipped.noLocatedCrew.push(job.code); continue; }

  located.sort((a, b) =>
    b.days - a.days ||
    seniority(b.role) - seniority(a.role) ||
    a.first_day.localeCompare(b.first_day) ||
    a.name.localeCompare(b.name)
  );
  const lead = located[0];
  const states = [...new Set(located.map(c => c.location))];
  assignments.push({
    id: job.id, code: job.code,
    leadId: lead.id, leadName: lead.name, leadRole: lead.role,
    state: lead.location, days: lead.days,
    mixed: states.length > 1,
    crew: located.map(c => `${c.name} [${c.location}${c.days ? ' ' + c.days + 'd' : ''}]`).join(', '),
  });
}

// ── report ──
console.log(`DB: ${dbPath} (${APPLY ? 'APPLY' : 'DRY RUN'})`);
console.log(`Unassigned active jobs: ${jobs.length}`);
console.log(`Will assign: ${assignments.length}`);
console.log(`Skipped — pseudo codes: ${skipped.pseudo.length} [${skipped.pseudo.join(', ')}]`);
console.log(`Skipped — no roster at all: ${skipped.noCrew.length}`);
console.log(`Skipped — roster but no located crew: ${skipped.noLocatedCrew.length}`);
console.log('');

const byState = {};
for (const a of assignments) byState[a.state] = (byState[a.state] || 0) + 1;
console.log('By state:', Object.entries(byState).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${n}`).join('  '));
console.log('');

console.log('=== MIXED-STATE crews — picked lead in [brackets] (REVIEW THESE) ===');
for (const a of assignments.filter(x => x.mixed)) {
  console.log(`${a.code}  ->  ${a.leadName} [${a.state}]   crew: ${a.crew}`);
}
console.log('');
console.log('=== ALL assignments ===');
for (const a of assignments) {
  console.log(`${a.code.padEnd(48)} -> ${a.leadName} (${a.state})${a.mixed ? '  *mixed' : ''}`);
}

if (APPLY) {
  const upd = db.prepare(`
    UPDATE jobs SET lead_id = ?, state = ?, updated_at = datetime('now', '+10 hours')
    WHERE id = ? AND (lead_id IS NULL OR lead_id = '') AND (state IS NULL OR state = '')
  `);
  const tx = db.transaction(() => {
    let n = 0;
    for (const a of assignments) n += upd.run(a.leadId, a.state, a.id).changes;
    return n;
  });
  const n = tx();
  const left = db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE active = 1 AND archived = 0 AND (lead_id IS NULL OR lead_id = '')`).get().c;
  console.log(`\nAPPLIED: ${n} jobs updated — ${left} unassigned active jobs remain.`);
} else {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
}
