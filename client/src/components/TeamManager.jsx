import React, { useState } from 'react';
import { createTeamMember, updateTeamMember, deleteTeamMember, createEquipment } from '../api.js';

const TIMEZONES = [
  { value: 'Australia/Sydney', label: 'AEST - Sydney/Melbourne/Brisbane' },
  { value: 'Australia/Adelaide', label: 'ACST - Adelaide' },
  { value: 'Australia/Perth', label: 'AWST - Perth' },
  { value: 'Australia/Darwin', label: 'ACST - Darwin' },
  { value: 'Australia/Hobart', label: 'AEST - Hobart' },
];

const LOCATIONS = [
  'NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT', 'Processing', 'Other'
];

const DEFAULT_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];

export default function TeamManager({ members, equipment: equipmentItems = [], onRefresh, showToast }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [modalType, setModalType] = useState('member'); // 'member' or 'equipment'
  const [form, setForm] = useState({
    name: '', role: '', location: '', timezone: 'Australia/Sydney', color: '#3B82F6', sort_order: 0
  });

  const openCreate = (type = 'member') => {
    setEditing(null);
    setModalType(type);
    setForm({
      name: '', role: type === 'equipment' ? 'Equipment' : '', location: '', timezone: 'Australia/Sydney',
      color: type === 'equipment' ? '#64748b' : DEFAULT_COLORS[members.length % DEFAULT_COLORS.length],
      sort_order: type === 'equipment' ? 100 + equipmentItems.length : members.length
    });
    setShowModal(true);
  };

  const openEdit = (member, type = 'member') => {
    setEditing(member);
    setModalType(type);
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
        showToast(`${modalType === 'equipment' ? 'Equipment' : 'Team member'} updated`, 'success');
      } else if (modalType === 'equipment') {
        await createEquipment(form);
        showToast('Equipment added', 'success');
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
                className="member-avatar clickable"
                style={{ background: member.color, cursor: 'pointer' }}
                onClick={() => openEdit(member)}
                title="Edit team member"
              >
                {member.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{member.name}</div>
                <div style={{ fontSize: 13, color: '#64748b' }}>
                  {member.role}{member.role && member.location ? ' · ' : ''}{member.location}
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

      {/* Equipment is now managed on the Equipment tab */}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing ? `Edit ${modalType === 'equipment' ? 'Equipment' : 'Team Member'}` : `Add ${modalType === 'equipment' ? 'Equipment' : 'Team Member'}`}</h2>
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
                  <label>State / Location</label>
                  <select
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                  >
                    <option value="">Select state...</option>
                    {LOCATIONS.map(loc => (
                      <option key={loc} value={loc}>{loc}</option>
                    ))}
                  </select>
                </div>
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

              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : modalType === 'equipment' ? 'Add Equipment' : 'Add Member'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
