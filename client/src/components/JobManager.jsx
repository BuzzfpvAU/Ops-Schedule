import React, { useState } from 'react';
import { createJob, updateJob, deleteJob, downloadIcalJob, getJobCalendarToken, calendarFeedUrl } from '../api.js';
import JobCard, { JobListRow, JOB_STATUSES } from './JobCard.jsx';

const DEFAULT_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];

const EMPTY_FORM = {
  code: '', name: '', description: '', color: '#3B82F6', client: '', file_url: '',
  job_number: '', sharepoint_url: '', status: 'planning', site_address: '', site_contact: '',
  notes: '', rental_required: 0,
};

export default function JobManager({ jobs, onRefresh, showToast, currentUser, teamMembers = [], equipment = [] }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [subJob, setSubJob] = useState(null); // { job, token, url } | null
  const [form, setForm] = useState(EMPTY_FORM);
  const [applyTemplate, setApplyTemplate] = useState(true);
  const [viewJob, setViewJob] = useState(null);   // job id open in the card view
  const [cardVersion, setCardVersion] = useState(0);
  const [search, setSearch] = useState('');

  // Filter out auto-created status jobs (notes, toil, leave, unavailable)
  const STATUS_CODES = ['TOIL', 'LEAVE', 'NOT-AVAIL'];
  const realJobs = jobs.filter(j => !j.code.startsWith('NOTE-') && !STATUS_CODES.includes(j.code));

  const q = search.trim().toLowerCase();
  const filteredJobs = q
    ? realJobs.filter(j =>
        [j.code, j.job_number, j.name, j.client, j.site_address]
          .some(v => (v || '').toLowerCase().includes(q)))
    : realJobs;

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, color: DEFAULT_COLORS[realJobs.length % DEFAULT_COLORS.length] });
    setApplyTemplate(true);
    setShowModal(true);
  };

  const openEdit = (job) => {
    setEditing(job);
    setForm({
      ...EMPTY_FORM,
      code: job.code, name: job.name, description: job.description || '', color: job.color,
      client: job.client || '', file_url: job.file_url || '', job_number: job.job_number || '',
      sharepoint_url: job.sharepoint_url || '', status: job.status || 'planning',
      site_address: job.site_address || '', site_contact: job.site_contact || '',
      notes: job.notes || '', rental_required: job.rental_required ? 1 : 0,
    });
    setShowModal(true);
  };

  const suggestSharepoint = () => {
    // Folder convention seen in the AUAV SharePoint: J<number>_<CLIENT>-<Name-With-Dashes>
    const parts = [];
    if (form.job_number) parts.push(form.job_number.toUpperCase());
    if (form.client) parts.push(form.client.trim().toUpperCase().replace(/\s+/g, '-'));
    if (form.name) parts.push(form.name.trim().replace(/\s+/g, '-'));
    if (!form.job_number && !form.name) {
      showToast('Add a job number and name first', 'error');
      return;
    }
    const folder = parts.join('_').replace(/^_/, '').replace(/_+$/, '');
    const url = `https://cwltdgroup.sharepoint.com/sites/auav-projects/Shared%20Documents/${encodeURIComponent(folder)}`;
    setForm(f => ({ ...f, sharepoint_url: url }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await updateJob(editing.id, form);
        showToast('Job updated', 'success');
        if (viewJob === editing.id) setCardVersion(v => v + 1);
      } else {
        await createJob({ ...form, applyTemplate });
        showToast(applyTemplate ? 'Job created with standard checklist' : 'Job created', 'success');
      }
      setShowModal(false);
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleDelete = async (job) => {
    if (!confirm(`Remove job "${job.code} - ${job.name}"?`)) return;
    try {
      await deleteJob(job.id);
      showToast('Job removed', 'success');
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleExportIcal = async (job) => {
    try {
      await downloadIcalJob(job.id);
      showToast('iCal file downloaded', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  };

  const openSubscribe = async (job) => {
    try {
      const { token } = await getJobCalendarToken(job.id);
      setSubJob({ job, url: calendarFeedUrl('job', token) });
    } catch (err) {
      showToast('Failed to get subscription link: ' + err.message, 'error');
    }
  };

  const copySubUrl = async () => {
    if (!subJob) return;
    try {
      await navigator.clipboard.writeText(subJob.url);
      showToast(`Subscription link copied for ${subJob.job.code}`, 'success');
      setSubJob(null);
    } catch {
      showToast('Copy failed — select the link manually', 'error');
    }
  };

  // Card view (click a job row)
  if (viewJob) {
    return (
      <JobCard
        jobId={viewJob}
        onBack={() => { setViewJob(null); onRefresh(); }}
        onEdit={(job) => openEdit(job)}
        currentUser={currentUser}
        teamMembers={teamMembers}
        equipment={equipment}
        showToast={showToast}
        refreshKey={cardVersion}
      />
    );
  }

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3>Jobs / Projects</h3>
          <button className="btn btn-primary" onClick={openCreate}>+ Add Job</button>
        </div>

        <div className="jc-search-wrap">
          <input
            type="search"
            className="jc-search"
            placeholder="Search jobs — code, job number, name, client…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search jobs"
          />
          {q && <span className="jc-search-count">{filteredJobs.length} of {realJobs.length}</span>}
        </div>

        {realJobs.length === 0 && (
          <p style={{ color: '#94a3b8', textAlign: 'center', padding: 32, fontSize: 14 }}>
            No jobs yet. Click "Add Job" to create your first job code.
          </p>
        )}

        {realJobs.length > 0 && filteredJobs.length === 0 && (
          <p style={{ color: '#94a3b8', textAlign: 'center', padding: 32, fontSize: 14 }}>
            No jobs match “{search}”.
          </p>
        )}

        {filteredJobs.map(job => (
          <JobListRow
            key={job.id}
            job={job}
            onClick={() => setViewJob(job.id)}
            actions={
              <>
                <button className="btn-icon" title="Download iCal" onClick={() => handleExportIcal(job)}>📅</button>
                <button className="btn-icon" title="Subscribe (calendar feed)" onClick={() => openSubscribe(job)}>🔗</button>
                <button className="btn btn-sm" onClick={() => openEdit(job)}>Edit</button>
                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(job)}>Remove</button>
              </>
            }
          />
        ))}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal jc-modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing ? 'Edit Job' : 'Add Job'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Job Code *</label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    placeholder="e.g. J2293"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Job Number (external ref)</label>
                  <input
                    type="text"
                    value={form.job_number}
                    onChange={(e) => setForm({ ...form, job_number: e.target.value })}
                    placeholder="e.g. J2293"
                  />
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    {Object.entries(JOB_STATUSES).map(([key, s]) => (
                      <option key={key} value={key}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Color</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={form.color}
                      onChange={(e) => setForm({ ...form, color: e.target.value })}
                    />
                    <input
                      type="text"
                      value={form.color}
                      onChange={(e) => setForm({ ...form, color: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Job Name *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Woodside KGP"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Client</label>
                  <input
                    type="text"
                    value={form.client}
                    onChange={(e) => setForm({ ...form, client: e.target.value })}
                    placeholder="e.g. Vertech"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Site Address</label>
                  <input
                    type="text"
                    value={form.site_address}
                    onChange={(e) => setForm({ ...form, site_address: e.target.value })}
                    placeholder="e.g. Karratha Gas Plant, WA"
                  />
                </div>
                <div className="form-group">
                  <label>Site Contact (name / phone)</label>
                  <input
                    type="text"
                    value={form.site_contact}
                    onChange={(e) => setForm({ ...form, site_contact: e.target.value })}
                    placeholder="e.g. John Smith 0400 000 000"
                  />
                </div>
              </div>

              <div className="form-group">
                <label>
                  SharePoint Directory
                  <button type="button" className="jc-linklike" onClick={suggestSharepoint}>auto-build from details</button>
                </label>
                <input
                  type="url"
                  value={form.sharepoint_url}
                  onChange={(e) => setForm({ ...form, sharepoint_url: e.target.value })}
                  placeholder="https://cwltdgroup.sharepoint.com/sites/auav-projects/…"
                />
              </div>

              <div className="form-group">
                <label>File Link (URL)</label>
                <input
                  type="url"
                  value={form.file_url}
                  onChange={(e) => setForm({ ...form, file_url: e.target.value })}
                  placeholder="e.g. https://drive.google.com/..."
                />
              </div>

              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  placeholder="Brief description of the job..."
                />
              </div>

              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  placeholder="Job notes — meet times, contacts, gotchas…"
                />
              </div>

              <div className="form-row jc-form-checks">
                <label className="jc-checkline">
                  <input
                    type="checkbox"
                    checked={!!form.rental_required}
                    onChange={(e) => setForm({ ...form, rental_required: e.target.checked ? 1 : 0 })}
                  />
                  Rental vehicle required
                </label>
                {!editing && (
                  <label className="jc-checkline">
                    <input
                      type="checkbox"
                      checked={applyTemplate}
                      onChange={(e) => setApplyTemplate(e.target.checked)}
                    />
                    Apply standard readiness checklist
                  </label>
                )}
              </div>

              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Create Job'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {subJob && (
        <div className="modal-overlay" onClick={() => setSubJob(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Subscribe — {subJob.job.code}</h2>
            <p className="modal-subtitle">
              Everyone assigned to this job, updated automatically (past 60 days → next 13 months). Add the link in Apple Calendar (File → New Calendar Subscription), Google Calendar (Add by URL) or Outlook.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                readOnly
                value={subJob.url}
                onFocus={(e) => e.target.select()}
              />
              <button type="button" className="btn btn-primary" onClick={copySubUrl}>Copy</button>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setSubJob(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
