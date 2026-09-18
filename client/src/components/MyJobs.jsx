import React, { useCallback, useEffect, useState } from 'react';
import { getMyJobs } from '../api.js';
import JobCard, { JobListRow } from './JobCard.jsx';
import JobPlanner from './JobPlanner.jsx';

// Member-facing job list: the jobs this user is rostered on, open card for details.
export default function MyJobs({ currentUser, teamMembers = [], equipment = [], showToast }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openJob, setOpenJob] = useState(null);
  const [plannerJob, setPlannerJob] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try {
      setJobs(await getMyJobs());
    } catch (err) {
      showToast('Failed to load your jobs: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  if (openJob) {
    return (
      <div>
        <JobCard
          jobId={openJob}
          onBack={() => { setOpenJob(null); load(); }}
          currentUser={currentUser}
          teamMembers={teamMembers}
          equipment={equipment}
          showToast={showToast}
          onOpenPlanner={(id) => setPlannerJob(id)}
        />
        {plannerJob && (
          <div className="modal-overlay jp-overlay" onClick={() => setPlannerJob(null)}>
            <div className="jp-modal" onClick={(e) => e.stopPropagation()}>
              <JobPlanner
                jobId={plannerJob}
                onBack={() => setPlannerJob(null)}
                onOpenCard={(id) => { setPlannerJob(null); setOpenJob(id); }}
                currentUser={currentUser}
                showToast={showToast}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Today in the app's home timezone (same +10h convention as the server)
  const todayAEST = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const q = search.trim().toLowerCase();
  const visible = q
    ? jobs.filter(j => [j.code, j.job_number, j.name, j.client].some(v => (v || '').toLowerCase().includes(q)))
    : jobs;
  const upcoming = visible.filter(j => j.roster_end && j.roster_end >= todayAEST);
  const past = visible.filter(j => !j.roster_end || j.roster_end < todayAEST);

  return (
    <div className="card">
      <div className="card-header">
        <h3>My Jobs</h3>
      </div>

      {jobs.length > 0 && (
        <div className="jc-search-wrap">
          <input
            type="search"
            className="jc-search"
            placeholder="Search my jobs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search my jobs"
          />
          {q && <span className="jc-search-count">{visible.length} of {jobs.length}</span>}
        </div>
      )}

      {loading && <div className="jc-loading">Loading…</div>}

      {!loading && jobs.length === 0 && (
        <p style={{ color: '#94a3b8', textAlign: 'center', padding: 32, fontSize: 14 }}>
          No jobs assigned to you yet. Jobs appear here once you're on the schedule.
        </p>
      )}

      {!loading && jobs.length > 0 && visible.length === 0 && (
        <p style={{ color: '#94a3b8', textAlign: 'center', padding: 32, fontSize: 14 }}>
          No jobs match “{search}”.
        </p>
      )}

      {!loading && upcoming.length > 0 && (
        <>
          <div className="jc-list-group">Upcoming</div>
          {upcoming.map(job => (
            <JobListRow key={job.id} job={job} onClick={() => setOpenJob(job.id)} />
          ))}
        </>
      )}

      {!loading && past.length > 0 && (
        <>
          <div className="jc-list-group">Previous</div>
          {past.map(job => (
            <JobListRow key={job.id} job={job} onClick={() => setOpenJob(job.id)} />
          ))}
        </>
      )}
    </div>
  );
}
