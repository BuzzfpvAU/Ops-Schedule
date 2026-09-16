import React, { useCallback, useEffect, useState } from 'react';
import { getMyJobs } from '../api.js';
import JobCard, { JobListRow } from './JobCard.jsx';

// Member-facing job list: the jobs this user is rostered on, open card for details.
export default function MyJobs({ currentUser, teamMembers = [], equipment = [], showToast }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openJob, setOpenJob] = useState(null);

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
      <JobCard
        jobId={openJob}
        onBack={() => { setOpenJob(null); load(); }}
        currentUser={currentUser}
        teamMembers={teamMembers}
        equipment={equipment}
        showToast={showToast}
      />
    );
  }

  // Today in the app's home timezone (same +10h convention as the server)
  const todayAEST = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const upcoming = jobs.filter(j => j.roster_end && j.roster_end >= todayAEST);
  const past = jobs.filter(j => !j.roster_end || j.roster_end < todayAEST);

  return (
    <div className="card">
      <div className="card-header">
        <h3>My Jobs</h3>
      </div>

      {loading && <div className="jc-loading">Loading…</div>}

      {!loading && jobs.length === 0 && (
        <p style={{ color: '#94a3b8', textAlign: 'center', padding: 32, fontSize: 14 }}>
          No jobs assigned to you yet. Jobs appear here once you're on the schedule.
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
