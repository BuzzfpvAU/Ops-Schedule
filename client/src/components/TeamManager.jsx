import React, { useState } from 'react';
import { createTeamMember, updateTeamMember, deleteTeamMember } from '../api.js';

const TIMEZONES = [
  { value: 'Australia/Sydney', label: 'AEST - Sydney/Melbourne/Brisbane' },
  { value: 'Australia/Adelaide', label: 'ACST - Adelaide' },
  { value: 'Australia/Perth', label: 'AWST - Perth' },
  { value: 'Australia/Darwin', label: 'ACST - Darwin' },
  { value: 'Australia/Hobart', label: 'AEST - Hobart' },
];

const DEFAULT_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];

export default function TeamManager({ members, onRefresh, showToast }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    name: '', role: '', location: '', timezone: 'Australia/Sydney', color: '#3B82F6', sort_order: 0
  });

  const openCreate = () => {
    setEditing(null);
    setForm({
      name: '', role: '', location: '', timezone: 'Australia/Sydney',
      color: DEFAULT_COLORS[members.length % DEFAULT_COLORS.length], sort_order: members.length
    });
    setShowModal(true);
  };

  const openEdit = (member) => {
    setEditing(member);
    setForm({
      name: member.name, role: member.role, location: member.location,
      timezone: member.timezone, color: member.color, sort_order: member.sort_order
    });
    setShowModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await updateTeamMember(editing.id, form);
        showToast('Team member updated', 'success');
      } else {
        await createTeamMember(form);
        showToast('Team member added', 'success');
      }
      setShowModal(false);
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleDelete = async (member) => {
    if (!confirm(`Remove "${member.name}" from the team?`)) return;
    try {
      await deleteTeamMember(member.id);
      showToast('Team member removed', 'success');
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3>Team Members</h3>
          <button className="btn btn-primary" onClick={openCreate}>+ Add Member</button>
        </div>

        {members.length === 0 && (
          <p style={{ color: '#94a3b8', textAlign: 'center', padding: 32, fontSize: 14 }}>
            No team members yet. Click "Add Member" to get started.
          </p>
        )}

        {members.map(member => (
          <div key={member.id} className="list-item">
            <div className="list-item-info">
              <div
                className="member-avatar"
                style={{ background: member.color }}
              >
                {member.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{member.name}</div>
                <div style={{ fontSize: 13, color: '#64748b' }}>
                  {member.role}{member.role && member.location ? ' · ' : ''}{member.location}
                </div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>
                  {TIMEZONES.find(t => t.value === member.timezone)?.label || member.timezone}
                </div>
              </div>
            </div>
            <div className="list-item-actions">
              <button className="btn btn-sm" onClick={() => openEdit(member)}>Edit</button>
              <button className="btn btn-sm btn-danger" onClick={() => handleDelete(member)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing ? 'Edit Team Member' : 'Add Team Member'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Alex Smith"
                  required
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Role</label>
                  <input
                    type="text"
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                    placeholder="e.g. Project Manager"
                  />
                </div>
                <div className="form-group">
                  <label>Location</label>
                  <input
                    type="text"
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    placeholder="e.g. Melbourne"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Timezone</label>
                  <select
                    value={form.timezone}
                    onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                  >
                    {TIMEZONES.map(tz => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
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

              <div className="form-group">
                <label>Sort Order</label>
                <input
                  type="number"
                  value={form.sort_order}
                  onChange={(e) => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })}
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Add Member'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
