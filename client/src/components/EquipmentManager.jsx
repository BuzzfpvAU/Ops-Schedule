import React, { useState } from 'react';
import { createEquipment, updateTeamMember, deleteTeamMember } from '../api.js';

const LOCATIONS = [
  'NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT', 'Processing', 'Other'
];

const DEFAULT_COLORS = ['#64748b', '#475569', '#6366f1', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed'];

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
  '#ec4899', '#64748b', '#475569', '#1e293b',
];

export default function EquipmentManager({ equipment: equipmentItems = [], onRefresh, showToast }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [collapsedStates, setCollapsedStates] = useState({});
  const [form, setForm] = useState({
    name: '', role: 'Equipment', location: '', timezone: 'Australia/Sydney', color: '#64748b', sort_order: 100, info_url: ''
  });

  // Group equipment by location
  const grouped = {};
  for (const item of equipmentItems) {
    const loc = item.location || 'Unassigned';
    if (!grouped[loc]) grouped[loc] = [];
    grouped[loc].push(item);
  }

  // Sort locations to match LOCATIONS order
  const sortedLocations = Object.keys(grouped).sort((a, b) => {
    const idxA = LOCATIONS.indexOf(a);
    const idxB = LOCATIONS.indexOf(b);
    if (idxA === -1 && idxB === -1) return a.localeCompare(b);
    if (idxA === -1) return 1;
    if (idxB === -1) return -1;
    return idxA - idxB;
  });

  const toggleState = (loc) => {
    setCollapsedStates(prev => ({ ...prev, [loc]: !prev[loc] }));
  };

  const openCreate = () => {
    setEditing(null);
    setForm({
      name: '', role: 'Equipment', location: '', timezone: 'Australia/Sydney',
      color: DEFAULT_COLORS[equipmentItems.length % DEFAULT_COLORS.length],
      sort_order: 100 + equipmentItems.length, info_url: ''
    });
    setShowModal(true);
  };

  const openEdit = (item) => {
    setEditing(item);
    setForm({
      name: item.name, role: item.role || 'Equipment', location: item.location,
      timezone: item.timezone, color: item.color, sort_order: item.sort_order, info_url: item.info_url || ''
    });
    setShowModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await updateTeamMember(editing.id, form);
        showToast('Equipment updated', 'success');
      } else {
        await createEquipment(form);
        showToast('Equipment added', 'success');
      }
      setShowModal(false);
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleDelete = async (item) => {
    if (!confirm(`Remove "${item.name}"?`)) return;
    try {
      await deleteTeamMember(item.id);
      showToast('Equipment removed', 'success');
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3>Equipment</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="equipment-count-badge">{equipmentItems.length} items</span>
            <button className="btn btn-primary" onClick={openCreate}>+ Add Equipment</button>
          </div>
        </div>

        {equipmentItems.length === 0 && (
          <p style={{ color: 'var(--text-dim)', textAlign: 'center', padding: 32, fontSize: 14 }}>
            No equipment yet. Click "Add Equipment" to get started.
          </p>
        )}

        {sortedLocations.map((location, idx) => {
          const items = grouped[location];
          const isCollapsed = collapsedStates[location];
          return (
            <div key={location} className="equipment-state-group">
              <div className="equipment-state-header" onClick={() => toggleState(location)}>
                <div className="equipment-state-left">
                  <span className={`equipment-state-chevron ${isCollapsed ? '' : 'expanded'}`}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none">
                      <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                  <span className="equipment-state-name">{location}</span>
                  <span className="equipment-state-count">{items.length}</span>
                </div>
              </div>
              {!isCollapsed && (
                <div className="equipment-state-items">
                  {items.map(item => (
                    <div key={item.id} className="list-item equipment-list-item">
                      <div className="list-item-info">
                        <div className="member-avatar equipment-avatar clickable" style={{ background: item.color, cursor: 'pointer' }} onClick={() => openEdit(item)} title="Edit equipment">
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M7 1v4M5 3h4M2 7h10v5H2z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                            {item.name}
                            {item.info_url && (
                              <a
                                href={item.info_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title="Equipment info & documentation"
                                style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center' }}
                              >
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                  <path d="M6.5 3.5H3a1 1 0 00-1 1V13a1 1 0 001 1h8.5a1 1 0 001-1V9.5M9.5 2h4.5v4.5M14 2L7.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              </a>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{item.role || 'Equipment'}</div>
                        </div>
                      </div>
                      <div className="list-item-actions">
                        <button className="btn btn-sm" onClick={() => openEdit(item)}>Edit</button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDelete(item)}>Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing ? 'Edit Equipment' : 'Add Equipment'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. DJI M300 RTK"
                  required
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Type / Description</label>
                  <input
                    type="text"
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                    placeholder="e.g. Drone, Camera, Vehicle"
                  />
                </div>
                <div className="form-group">
                  <label>State / Location</label>
                  <select
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    required
                  >
                    <option value="">Select state...</option>
                    {LOCATIONS.map(loc => (
                      <option key={loc} value={loc}>{loc}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Info / Documentation Link</label>
                <input
                  type="url"
                  value={form.info_url}
                  onChange={(e) => setForm({ ...form, info_url: e.target.value })}
                  placeholder="https://docs.google.com/... or any URL with equipment info"
                />
                <span style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                  Link to serial numbers, SDS, specs, or other equipment documentation
                </span>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Color</label>
                  <div className="color-swatch-grid">
                    {PRESET_COLORS.map(c => (
                      <button
                        key={c}
                        type="button"
                        className={`color-swatch${form.color === c ? ' selected' : ''}`}
                        style={{ background: c }}
                        onClick={() => setForm({ ...form, color: c })}
                        title={c}
                      />
                    ))}
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
              </div>

              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Add Equipment'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
