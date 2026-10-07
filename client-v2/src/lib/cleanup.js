import { isQuickJob } from './model.js';

/**
 * Jobs whose last scheduled day has passed and which are still on the active
 * list — the candidates for a cleanup sweep, most recently finished first.
 */
export function pastJobs(jobs, today) {
  return (jobs || [])
    .filter((j) => !j.archived && !isQuickJob(j) && j.roster_end && j.roster_end < today)
    .sort((a, b) => (b.roster_end || '').localeCompare(a.roster_end || ''));
}
