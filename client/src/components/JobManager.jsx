import React, { useState } from 'react';
import { createJob, updateJob, deleteJob, downloadIcalJob } from '../api.js';

const DEFAULT_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];

export default function JobManager({ jobs, onRefresh, showToast }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ code: '', name: '', description: '', color: '#3B82F6', client: '', file_url: '' });

  const openCreate = () => {
    setEditing(null);
    setForm({ code: '', name: '', description: '', color: DEFAULT_COLORS[jobs.length % DEFAULT_COLORS.length], client: '', file_url: '' });
    setShowModal(true);
  };

  const openEdit = (job) => {
    setEditing(job);
    setForm({ code: job.code, name: job.name, description: job.description, color: job.color, client: job.client, file_url: job.file_url });
    setShowModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await updateJob(editing.id, form);
        showToast('Job updated', 'success');
      } else {
        await createJob(form);
        showToast('Job created', 'success');
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
      downloadIcalJob(job.id);
      showToast('iCal file downloaded', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  };

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3>Jobs / Projects</h3>
          <button className="btn btn-primary" onClick={openCreate}>+ Add Job</button>
        </div>

        {jobs.length === 0 && (
          <p style={{ color: '#94a3b8', textAlign: 'center', padding: 32, fontSize: 14 }}>
            No jobs yet. Click "Add Job" to create your first job code.
          </p>
        )}

        {jobs.map(job => (
          <div key={job.id} className="list-item">
            <div className="list-item-info">
              <span className="job-color-dot" style={{ background: job.color }}></span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{job.code}</div>
                <div style={{ fontSize: 13, color: '#64748b' }}>{job.name}</div>
                {job.client && <div style={{ fontSize: 12, color: '#94a3b8' }}>Client: {job.client}</div>}
                {job.file_url && (
                  <a href={job.file_url} target="_blank" rel="noopener noreferrer" className="file-link">
                    📁 Linked files
                  </a>
                )}
              </div>
            </div>
            <div className="list-item-actions">
              <button className="btn-icon" title="Download iCal" onClick={() => handleExportIcal(job)}>📅</button>
              <button className="btn btn-sm" onClick={() => openEdit(job)}>Edit</button>
              <button className="btn btn-sm btn-danger" onClick={() => handleDelete(job)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing ? 'Edit Job' : 'Add Job'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Job Code *</label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    placeholder="e.g. MELB-001"
                    required
                  />
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

              <div className="form-group">
                <label>Job Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Melbourne Office Fitout"
                  required
                />
              </div>

              <div className="form-group">
                <label>Client</label>
                <input
                  type="text"
                  value={form.client}
                  onChange={(e) => setForm({ ...form, client: e.target.value })}
                  placeholder="e.g. ABC Construction"
                />
              </div>

              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  placeholder="Brief description of the job..."
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

              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Create Job'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
