import React, { useState, useMemo } from 'react';
import { createJob, updateJob, deleteJob, downloadIcalJob, getJobCalendarToken, calendarFeedUrl, archiveJob, unarchiveJob, archiveJobsBulk } from '../api.js';
import JobCard, { JobListRow, JOB_STATUSES, fmtDateShort, JOB_STATES } from './JobCard.jsx';
import JobPlanner from './JobPlanner.jsx';

const DEFAULT_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];

const EMPTY_FORM = {
  code: '', name: '', description: '', color: '#3B82F6', client: '', file_url: '',
  job_number: '', sharepoint_url: '', status: 'planning', site_address: '', site_contact: '',
  notes: '', rental_required: 0,
  state: '', crew_size: 1, planned_start: '', planned_end: '', lead_id: '',
};

export default function JobManager({ jobs, onRefresh, showToast, currentUser, teamMembers = [], equipment = [], onScheduleRefresh }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [subJob, setSubJob] = useState(null); // { job, token, url } | null
  const [form, setForm] = useState(EMPTY_FORM);
  const [applyTemplate, setApplyTemplate] = useState(true);
  const [viewJob, setViewJob] = useState(null);   // job id open in the card view
  const [plannerJob, setPlannerJob] = useState(null); // job id open in the project planner
  const [cardVersion, setCardVersion] = useState(0);
  const [search, setSearch] = useState('');
  const [cleanup, setCleanup] = useState(null); // Set of job ids ticked in the cleanup modal | null (closed)
  const [cleanupSaving, setCleanupSaving] = useState(false);
  // State groups can be collapsed — remembered per browser
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('jcCollapsedStates') || '[]')); }
    catch { return new Set(); }
  });
  const toggleGroup = (key) => setCollapsedGroups(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    try { localStorage.setItem('jcCollapsedStates', JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });

  // Filter out auto-created status jobs (notes, toil, leave, unavailable)
  const STATUS_CODES = ['TOIL', 'LEAVE', 'NOT-AVAIL'];
  const realJobs = jobs.filter(j => !j.code.startsWith('NOTE-') && !STATUS_CODES.includes(j.code));

  const todayAEST = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const isPastJob = (j) => !j.archived && j.roster_end && j.roster_end < todayAEST;
  // Past-flagged jobs — candidates for the cleanup sweep (most recent first)
  const pastJobs = realJobs.filter(isPastJob).sort((a, b) => (b.roster_end || '').localeCompare(a.roster_end || ''));

  // Archived jobs stay out of the list — but a search finds them (badged).
  const q = search.trim().toLowerCase();
  const filteredJobs = q
    ? realJobs
        .filter(j =>
          [j.code, j.job_number, j.name, j.client, j.site_address]
            .some(v => (v || '').toLowerCase().includes(q)))
        .sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0))
    : realJobs.filter(j => !j.archived);

  // ── State grouping — a job's state is where its project lead is from ──
  const NO_STATE = '__no_state__';
  const people = useMemo(() => (teamMembers || []).filter(m => !m.is_equipment), [teamMembers]);
  const leadMember = people.find(m => m.id === form.lead_id) || null;
  const stateFromLead = !!(leadMember && leadMember.location);

  const handleLeadChange = (leadId) => {
    const m = people.find(p => p.id === leadId);
    setForm(f => ({ ...f, lead_id: leadId, ...(m && m.location ? { state: m.location } : {}) }));
  };

  // Groups follow the JOB_STATES order, then any other state, then "No state" last
  const groupedJobs = useMemo(() => {
    const map = new Map();
    for (const j of filteredJobs) {
      const key = (j.state || '').trim() || NO_STATE;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(j);
    }
    const known = JOB_STATES.filter(s => map.has(s));
    const other = [...map.keys()].filter(k => k !== NO_STATE && !JOB_STATES.includes(k)).sort();
    const order = [...known, ...other, ...(map.has(NO_STATE) ? [NO_STATE] : [])];
    return order.map(k => ({ key: k, jobs: map.get(k) }));
  }, [filteredJobs]);

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
      state: job.state || '', crew_size: job.crew_size || 1,
      planned_start: job.planned_start || '', planned_end: job.planned_end || '',
      lead_id: job.lead_id || '',
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

  const handleArchive = async (job) => {
    if (!confirm(`Archive "${job.code} - ${job.name}"?\n\nIt will be hidden from the list — still findable via search.`)) return;
    try {
      await archiveJob(job.id);
      showToast('Job archived', 'success');
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleUnarchive = async (job) => {
    try {
      await unarchiveJob(job.id);
      showToast('Job restored to the list', 'success');
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ── Cleanup sweep: review past-flagged jobs, bulk-archive the ticked ones ──
  const openCleanup = () => setCleanup(new Set(pastJobs.map(j => j.id)));

  const toggleCleanup = (id) => setCleanup(sel => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleCleanupArchive = async () => {
    const ids = [...cleanup];
    if (!ids.length) return;
    setCleanupSaving(true);
    try {
      const { archived } = await archiveJobsBulk(ids);
      showToast(`Archived ${archived} job${archived === 1 ? '' : 's'}`, 'success');
      setCleanup(null);
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setCleanupSaving(false);
    }
  };

  return (
    <div>
      {/* Card view (click a job row). The add/edit modal below renders at the
          same level so Edit opens on top of the card, not behind it. */}
      {viewJob ? (
        <JobCard
          jobId={viewJob}
          onBack={() => { setViewJob(null); onRefresh(); }}
          onEdit={(job) => openEdit(job)}
          currentUser={currentUser}
          teamMembers={teamMembers}
          equipment={equipment}
          showToast={showToast}
          refreshKey={cardVersion}
          onScheduleRefresh={onScheduleRefresh}
          onOpenPlanner={(id) => setPlannerJob(id)}
        />
      ) : (
      <div className="card">
        <div className="card-header">
          <h3>Jobs / Projects</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {pastJobs.length > 0 && (
              <button
                className="btn"
                onClick={openCleanup}
                title="Review jobs whose last scheduled day has passed and archive them in one go"
              >🧹 Cleanup past ({pastJobs.length})</button>
            )}
            <button className="btn btn-primary" onClick={openCreate}>+ Add Job</button>
          </div>
        </div>

        <div className="jc-search-wrap">
          <input
            type="search"
            className="jc-search"
            placeholder="Search jobs — code, job number, name, client… (archived included)"
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
            {q ? `No jobs match “${search}”.` : 'All jobs are archived — use search to find them.'}
          </p>
        )}

        {groupedJobs.map(({ key, jobs: groupJobs }) => {
          // While searching, always show matches — collapse only applies to the normal list
          const isCollapsed = !q && collapsedGroups.has(key);
          return (
            <div key={key} className="jc-state-group">
              <div
                className={`jc-list-group jc-group-head${isCollapsed ? ' jc-group-collapsed' : ''}`}
                onClick={() => toggleGroup(key)}
                title={key === NO_STATE ? "No project lead assigned yet — a job's state comes from where its lead is based" : 'Click to collapse / expand'}
              >
                <span className="jc-group-caret">{isCollapsed ? '▸' : '▾'}</span>
                <span className="jc-group-label">{key === NO_STATE ? 'No state' : key}</span>
                <span className="jc-group-count">{groupJobs.length} job{groupJobs.length === 1 ? '' : 's'}</span>
              </div>
              {!isCollapsed && groupJobs.map(job => (
                <JobListRow
                  key={job.id}
                  job={job}
                  onClick={() => setViewJob(job.id)}
                  actions={
                    <>
                      <button className="btn-icon" title="Download iCal" onClick={() => handleExportIcal(job)}>📅</button>
                      <button className="btn-icon" title="Subscribe (calendar feed)" onClick={() => openSubscribe(job)}>🔗</button>
                      <button className="btn-icon" title="Project planner — crew, equipment + notes" onClick={() => setPlannerJob(job.id)}>📋</button>
                      {job.archived ? (
                        <button className="btn btn-sm" onClick={() => handleUnarchive(job)}>Unarchive</button>
                      ) : isPastJob(job) ? (
                        <button className="btn btn-sm" title="All scheduled days are in the past" onClick={() => handleArchive(job)}>📦 Archive</button>
                      ) : null}
                      <button className="btn btn-sm" onClick={() => openEdit(job)}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(job)}>Remove</button>
                    </>
                  }
                />
              ))}
            </div>
          );
        })}
      </div>
      )}

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
                  <label>Project Lead (runs the job)</label>
                  <select value={form.lead_id} onChange={(e) => handleLeadChange(e.target.value)}>
                    <option value="">— none —</option>
                    {people.map(m => (
                      <option key={m.id} value={m.id}>{m.name}{m.location ? ` (${m.location})` : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label title={stateFromLead ? "Set automatically — the state is where the project lead is from" : "Drives the schedule's Unallocated line"}>
                    State {stateFromLead ? '(auto — from project lead)' : '(drives the Unallocated line)'}
                  </label>
                  <select
                    value={form.state}
                    disabled={stateFromLead}
                    onChange={(e) => setForm({ ...form, state: e.target.value })}
                  >
                    <option value="">— none —</option>
                    {JOB_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    {form.state && !JOB_STATES.includes(form.state) && <option value={form.state}>{form.state}</option>}
                  </select>
                </div>
                <div className="form-group">
                  <label title="The job shows on the Unallocated line until this many people are rostered on it">Crew size</label>
                  <input
                    type="number"
                    min="1"
                    value={form.crew_size}
                    onChange={(e) => setForm({ ...form, crew_size: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label title="Shown as the bar on the schedule's Unallocated line until people are rostered">Planned start</label>
                  <input type="date" value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Planned end</label>
                  <input type="date" value={form.planned_end} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} />
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
      {cleanup !== null && (
        <div className="modal-overlay" onClick={() => !cleanupSaving && setCleanup(null)}>
          <div className="modal jc-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Cleanup — past jobs</h2>
            <p className="modal-subtitle">
              Every job whose last scheduled day has passed. Tick the ones to archive — they drop off the list but stay findable via search (Unarchive puts them back).
            </p>
            <div className="jc-cleanup-toolbar">
              <div>
                <button type="button" className="btn btn-sm" onClick={() => setCleanup(new Set(pastJobs.map(j => j.id)))}>Select all</button>
                <button type="button" className="btn btn-sm" onClick={() => setCleanup(new Set())}>Select none</button>
              </div>
              <span className="jc-cleanup-count">{cleanup.size} of {pastJobs.length} selected</span>
            </div>
            <div className="jc-cleanup-list">
              {pastJobs.length === 0 && <div className="jc-empty">No past jobs — all caught up.</div>}
              {pastJobs.map(j => (
                <label key={j.id} className={`jc-cleanup-row${cleanup.has(j.id) ? ' checked' : ''}`}>
                  <input type="checkbox" checked={cleanup.has(j.id)} onChange={() => toggleCleanup(j.id)} />
                  <span className="jc-cleanup-main">
                    <span className="jc-cleanup-title"><strong>{j.code}</strong>{j.job_number ? ` · ${j.job_number}` : ''} — {j.name}</span>
                    <span className="jc-cleanup-meta">
                      {[j.client, j.roster_start && j.roster_end
                        ? `${fmtDateShort(j.roster_start)} → ${fmtDateShort(j.roster_end)}`
                        : (j.roster_end ? `ends ${fmtDateShort(j.roster_end)}` : '')].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" disabled={cleanupSaving} onClick={() => setCleanup(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={cleanupSaving || cleanup.size === 0} onClick={handleCleanupArchive}>
                {cleanupSaving ? 'Archiving…' : `📦 Archive selected (${cleanup.size})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project planner modal (opened from the jobs list) */}
      {plannerJob && (
        <div className="modal-overlay jp-overlay" onClick={() => setPlannerJob(null)}>
          <div className="jp-modal" onClick={(e) => e.stopPropagation()}>
            <JobPlanner
              jobId={plannerJob}
              onBack={() => setPlannerJob(null)}
              onOpenCard={(id) => { setPlannerJob(null); setViewJob(id); }}
              currentUser={currentUser}
              onScheduleRefresh={onScheduleRefresh}
              showToast={showToast}
            />
          </div>
        </div>
      )}
    </div>
  );
}
