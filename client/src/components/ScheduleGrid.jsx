import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { assignSchedule, bulkAssignSchedule, clearScheduleEntry, createNotification, updateScheduleStatus, createJob, getJobs as fetchJobs, updateTeamMember, STATUSES } from '../api.js';

const USER_ALLOWED_STATUSES = ['note', 'toil', 'leave', 'unavailable'];

export default function ScheduleGrid({
  teamMembers, equipment, jobs, schedule, weekDates, weekOffset,
  onWeekChange, onRefresh, onScheduleRefresh, showToast, dateRangeLabel
}) {
  const [dropdown, setDropdown] = useState(null);
  const [multiDayModal, setMultiDayModal] = useState(null);
  const [noteModal, setNoteModal] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [assignDays, setAssignDays] = useState(1);
  const [editMember, setEditMember] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', role: '', location: '', color: '' });
  const [collapsedEquipment, setCollapsedEquipment] = useState({});
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [filterMember, setFilterMember] = useState('all');
  const [locationDropdownOpen, setLocationDropdownOpen] = useState(false);
  const locationDropdownRef = useRef(null);
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);
  const gridRef = useRef(null);
  const dragState = useRef({ isDragging: false, startX: 0, scrollLeft: 0 });

  // Get unique locations for filtering
  const locations = useMemo(() => {
    const locs = [...new Set(teamMembers.map(m => m.location).filter(Boolean))];
    return locs.sort();
  }, [teamMembers]);

  const { user: authUser } = useAuth();
  const isAdmin = authUser?.isAdmin;

  // Toggle a location in the multi-select
  const toggleLocation = (loc) => {
    setSelectedLocations(prev =>
      prev.includes(loc) ? prev.filter(l => l !== loc) : [...prev, loc]
    );
    setFilterMember('all');
  };

  const selectAllLocations = () => { setSelectedLocations([]); setFilterMember('all'); };
  const filterLocation = selectedLocations.length === 0 ? 'all' : selectedLocations;

  // Filtered team members
  const filteredMembers = useMemo(() => {
    let members = teamMembers;
    if (selectedLocations.length > 0) {
      members = members.filter(m => selectedLocations.includes(m.location));
    }
    if (filterMember !== 'all') {
      members = members.filter(m => m.id === filterMember);
    }
    return members;
  }, [teamMembers, selectedLocations, filterMember]);

  // Filtered equipment
  const filteredEquipment = useMemo(() => {
    let items = equipment || [];
    if (selectedLocations.length > 0) {
      items = items.filter(m => selectedLocations.includes(m.location));
    }
    return items;
  }, [equipment, selectedLocations]);

  // Equipment grouped by location
  const equipmentByLocation = useMemo(() => {
    const map = {};
    for (const item of filteredEquipment) {
      const loc = item.location || 'Unassigned';
      if (!map[loc]) map[loc] = [];
      map[loc].push(item);
    }
    return map;
  }, [filteredEquipment]);

  const toggleEquipment = (location) => {
    setCollapsedEquipment(prev => ({ ...prev, [location]: !prev[location] }));
  };

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdown(null);
        setSearchTerm('');
      }
      if (locationDropdownRef.current && !locationDropdownRef.current.contains(e.target)) {
        setLocationDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (dropdown && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [dropdown]);

  // Drag-to-scroll on the grid
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;

    const onMouseDown = (e) => {
      // Don't intercept clicks on interactive elements
      if (e.target.closest('button, select, input, .task-bar, .empty-cell, .assignment-dropdown')) return;
      dragState.current = { isDragging: true, startX: e.pageX, startY: e.pageY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
      el.style.cursor = 'grabbing';
      el.style.userSelect = 'none';
    };

    const onMouseMove = (e) => {
      if (!dragState.current.isDragging) return;
      const dx = e.pageX - dragState.current.startX;
      const dy = e.pageY - dragState.current.startY;
      el.scrollLeft = dragState.current.scrollLeft - dx;
      el.scrollTop = dragState.current.scrollTop - dy;
    };

    const onMouseUp = () => {
      if (!dragState.current.isDragging) return;
      dragState.current.isDragging = false;
      el.style.cursor = '';
      el.style.userSelect = '';
    };

    el.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Build schedule lookup
  const scheduleMap = {};
  for (const entry of schedule) {
    scheduleMap[`${entry.team_member_id}-${entry.date}`] = entry;
  }

  // Build merged spans per member/equipment row
  const allEntities = useMemo(() => [...teamMembers, ...(equipment || [])], [teamMembers, equipment]);

  const memberSpans = useMemo(() => {
    const result = {};
    for (const member of allEntities) {
      const spans = [];
      let i = 0;
      while (i < weekDates.length) {
        const entry = scheduleMap[`${member.id}-${weekDates[i].dateStr}`];
        if (entry) {
          // Find how many consecutive days have the same job AND status
          let end = i + 1;
          while (end < weekDates.length) {
            const nextEntry = scheduleMap[`${member.id}-${weekDates[end].dateStr}`];
            if (nextEntry && nextEntry.job_id === entry.job_id && (nextEntry.status || 'tentative') === (entry.status || 'tentative')) {
              end++;
            } else {
              break;
            }
          }
          spans.push({ startIdx: i, length: end - i, entry });
          i = end;
        } else {
          spans.push({ startIdx: i, length: 1, entry: null });
          i++;
        }
      }
      result[member.id] = spans;
    }
    return result;
  }, [allEntities, schedule, weekDates]);

  const handleCellClick = (memberId, dateStr, e) => {
    // Non-admin can only click their own row
    if (!isAdmin && memberId !== authUser?.memberId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dropdownHeight = 420;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // If not enough space below, position above the cell
    const y = spaceBelow < dropdownHeight && spaceAbove > spaceBelow
      ? Math.max(8, rect.top - dropdownHeight)
      : Math.min(rect.bottom + 4, window.innerHeight - dropdownHeight);
    setDropdown({
      memberId,
      date: dateStr,
      x: Math.min(rect.left, window.innerWidth - 320),
      y
    });
    setSearchTerm('');
    setAssignDays(1);
  };

  const handleAssign = async (memberId, date, job) => {
    try {
      const member = teamMembers.find(m => m.id === memberId) || equipment.find(e => e.id === memberId);
      if (assignDays > 1) {
        const dates = [];
        const current = new Date(date);
        for (let i = 0; i < assignDays; i++) {
          dates.push(current.toISOString().slice(0, 10));
          current.setDate(current.getDate() + 1);
        }
        await bulkAssignSchedule({ team_member_id: memberId, job_id: job.id, dates, status: 'tentative' });
        // Fire notification in background (don't await)
        createNotification({ team_member_id: memberId, type: 'bulk_assigned', message: `Assigned to ${job.code} - ${job.name} for ${assignDays} days from ${date}`, date, job_code: job.code }).catch(() => {});
        showToast(`Assigned ${job.code} to ${member?.name} for ${assignDays} days`, 'success');
      } else {
        const result = await assignSchedule({ team_member_id: memberId, job_id: job.id, date });
        const notifType = result._notification?.type || 'assigned';
        const message = notifType === 'changed'
          ? `Schedule for ${date} changed to ${job.code} - ${job.name}`
          : `Assigned to ${job.code} - ${job.name} on ${date}`;
        // Fire notification in background (don't await)
        createNotification({ team_member_id: memberId, type: notifType, message, date, job_code: job.code }).catch(() => {});
        showToast(`Assigned ${job.code} to ${member?.name} on ${date}`, 'success');
      }
      setDropdown(null);
      setSearchTerm('');
      setAssignDays(1);
      onScheduleRefresh();
    } catch (err) {
      showToast('Failed to assign: ' + err.message, 'error');
    }
  };

  const handleMultiDayAssign = async () => {
    if (!multiDayModal) return;
    const { memberId, jobId, startDate, endDate } = multiDayModal;
    const job = jobs.find(j => j.id === jobId);
    const member = teamMembers.find(m => m.id === memberId);
    if (!job || !member) return;

    // Generate date range
    const dates = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      dates.push(current.toISOString().slice(0, 10));
      current.setDate(current.getDate() + 1);
    }

    if (dates.length === 0) {
      showToast('End date must be on or after start date', 'error');
      return;
    }

    try {
      await bulkAssignSchedule({ team_member_id: memberId, job_id: jobId, dates, status: multiDayModal.status || 'tentative' });
      createNotification({
        team_member_id: memberId,
        type: 'bulk_assigned',
        message: `Assigned to ${job.code} - ${job.name} for ${dates.length} days (${startDate} to ${endDate})`,
        date: startDate,
        job_code: job.code
      }).catch(() => {});
      setMultiDayModal(null);
      onScheduleRefresh();
      showToast(`Assigned ${job.code} to ${member.name} for ${dates.length} days`, 'success');
    } catch (err) {
      showToast('Failed to assign: ' + err.message, 'error');
    }
  };

  const handleClear = async (memberId, date) => {
    try {
      await clearScheduleEntry(memberId, date);
      const member = teamMembers.find(m => m.id === memberId);
      createNotification({
        team_member_id: memberId, type: 'removed',
        message: `Assignment for ${date} removed`, date
      }).catch(() => {});
      setDropdown(null);
      onScheduleRefresh();
      showToast(`Cleared ${member?.name} on ${date}`);
    } catch (err) {
      showToast('Failed to clear: ' + err.message, 'error');
    }
  };

  const handleStatusChange = async (memberId, date, newStatus) => {
    try {
      const clickedEntry = schedule.find(e => e.team_member_id === memberId && e.date === date);
      if (!clickedEntry) {
        await updateScheduleStatus(memberId, date, newStatus);
      } else {
        // Find only the consecutive span containing the clicked date
        const sameJobEntries = schedule
          .filter(e => e.team_member_id === memberId && e.job_id === clickedEntry.job_id)
          .sort((a, b) => a.date.localeCompare(b.date));

        // Walk backward and forward from clicked date to find consecutive run
        const clickedMs = new Date(date).getTime();
        const oneDay = 86400000;
        const spanDates = new Set([date]);

        // Walk backward
        let cursor = clickedMs - oneDay;
        while (true) {
          const d = new Date(cursor).toISOString().slice(0, 10);
          if (sameJobEntries.find(e => e.date === d)) {
            spanDates.add(d);
            cursor -= oneDay;
          } else break;
        }
        // Walk forward
        cursor = clickedMs + oneDay;
        while (true) {
          const d = new Date(cursor).toISOString().slice(0, 10);
          if (sameJobEntries.find(e => e.date === d)) {
            spanDates.add(d);
            cursor += oneDay;
          } else break;
        }

        const linkedEntries = sameJobEntries.filter(e => spanDates.has(e.date));
        await Promise.all(
          linkedEntries.map(e => updateScheduleStatus(memberId, e.date, newStatus))
        );
      }
      setDropdown(null);
      onScheduleRefresh();
      showToast(`Status changed to ${STATUSES[newStatus].label}`, 'success');
    } catch (err) {
      showToast('Failed to update status: ' + err.message, 'error');
    }
  };

  // Find or create a special-purpose job (TOIL, Not Available, etc.)
  const findOrCreateJob = async (name, code) => {
    let job = jobs.find(j => j.code === code);
    if (!job) {
      job = await createJob({ code, name, color: '#64748b' });
      onRefresh();
    }
    return job;
  };

  const handleQuickAssign = async (memberId, date, statusKey) => {
    const statusMap = {
      toil: { name: 'TOIL', code: 'TOIL' },
      leave: { name: 'Leave', code: 'LEAVE' },
      unavailable: { name: 'Not Available', code: 'NOT-AVAIL' },
    };
    const info = statusMap[statusKey];
    if (!info) return;

    const job = await findOrCreateJob(info.name, info.code);
    try {
      await assignSchedule({ team_member_id: memberId, job_id: job.id, date, status: statusKey });
      const member = teamMembers.find(m => m.id === memberId);
      createNotification({ team_member_id: memberId, type: 'assigned', message: `Marked as ${STATUSES[statusKey].label} on ${date}`, date, job_code: job.code }).catch(() => {});
      setDropdown(null);
      onScheduleRefresh();
      showToast(`${member?.name} marked as ${STATUSES[statusKey].label} on ${date}`, 'success');
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    }
  };

  const handleNoteAssign = async () => {
    if (!noteModal) return;
    const { memberId, date, text } = noteModal;
    if (!text.trim()) { showToast('Enter a note', 'error'); return; }

    // Find or create a job for this note text
    const code = 'NOTE-' + text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    let job = jobs.find(j => j.name === text.trim());
    if (!job) {
      try {
        job = await createJob({ code, name: text.trim(), color: '#3b82f6' });
      } catch {
        // Code collision, try with timestamp suffix
        job = await createJob({ code: code + '-' + Date.now().toString(36).slice(-3), name: text.trim(), color: '#3b82f6' });
      }
    }

    try {
      await assignSchedule({ team_member_id: memberId, job_id: job.id, date, status: 'note' });
      const member = teamMembers.find(m => m.id === memberId);
      createNotification({ team_member_id: memberId, type: 'assigned', message: `Note added for ${date}: ${text.trim()}`, date, job_code: job.code }).catch(() => {});
      setNoteModal(null);
      onScheduleRefresh();
      showToast(`Note added for ${member?.name} on ${date}`, 'success');
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    }
  };

  const getInitials = (name) =>
    name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  const LOCATIONS = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT', 'Processing', 'Other'];

  const openEditMember = (member) => {
    setEditMember(member);
    setEditForm({ name: member.name, role: member.role || '', location: member.location || '', color: member.color || '#3B82F6', info_url: member.info_url || '' });
  };

  const handleEditMemberSubmit = async (e) => {
    e.preventDefault();
    try {
      await updateTeamMember(editMember.id, editForm);
      showToast(`${editMember.is_equipment ? 'Equipment' : 'Team member'} updated`, 'success');
      setEditMember(null);
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Contrast text color for a background
  const getTextColor = (bg) => {
    if (!bg) return '#fff';
    const hex = bg.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#1a1a2e' : '#ffffff';
  };

  const filteredJobs = jobs.filter(j =>
    !j.code.startsWith('NOTE-') &&
    (!searchTerm || j.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    j.name.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="schedule-wrapper">
      {/* Controls */}
      <div className="schedule-controls">
        <div className="week-nav">
          <button className="nav-btn" onClick={() => onWeekChange(weekOffset - 2)} title="Back 2 weeks">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3L3 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M13 3L8 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button className="nav-btn" onClick={() => onWeekChange(weekOffset - 1)} title="Previous week">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button className="nav-btn nav-today" onClick={() => onWeekChange(0)}>Today</button>
          <button className="nav-btn" onClick={() => onWeekChange(weekOffset + 1)} title="Next week">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button className="nav-btn" onClick={() => onWeekChange(weekOffset + 2)} title="Forward 2 weeks">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M8 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
        <h2 className="date-range-label">{dateRangeLabel}</h2>
        <div className="schedule-filters">
          <div className="filter-group" ref={locationDropdownRef}>
            <label>States</label>
            <button
              className="filter-multiselect-btn"
              onClick={() => setLocationDropdownOpen(!locationDropdownOpen)}
            >
              <span className="filter-multiselect-text">
                {selectedLocations.length === 0
                  ? 'All States'
                  : selectedLocations.length === 1
                    ? selectedLocations[0]
                    : `${selectedLocations.length} selected`}
              </span>
              <svg className={`filter-chevron ${locationDropdownOpen ? 'open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {locationDropdownOpen && (
              <div className="filter-checkbox-dropdown">
                <div className="filter-checkbox-item" onClick={(e) => { e.stopPropagation(); selectAllLocations(); }}>
                  <input
                    type="checkbox"
                    checked={selectedLocations.length === 0}
                    readOnly
                  />
                  <span>All States</span>
                </div>
                <div className="filter-checkbox-divider" />
                {locations.map(loc => (
                  <div key={loc} className="filter-checkbox-item" onClick={(e) => { e.stopPropagation(); toggleLocation(loc); }}>
                    <input
                      type="checkbox"
                      checked={selectedLocations.includes(loc)}
                      readOnly
                    />
                    <span>{loc}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="filter-group">
            <label>Person</label>
            <select
              value={filterMember}
              onChange={(e) => setFilterMember(e.target.value)}
            >
              <option value="all">All Members</option>
              {(selectedLocations.length > 0
                ? teamMembers.filter(m => selectedLocations.includes(m.location))
                : teamMembers
              ).map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          {(selectedLocations.length > 0 || filterMember !== 'all') && (
            <button
              className="filter-clear-btn"
              onClick={() => { setSelectedLocations([]); setFilterMember('all'); }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="schedule-grid" ref={gridRef}>
        <table className="schedule-table">
          <thead>
            <tr>
              <th className="member-col-header">Team Member</th>
              {weekDates.map(d => (
                <th key={d.dateStr} className={`day-header ${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''}`}>
                  <span className="day-name">{d.dayName.toUpperCase()}</span>
                  <span className="day-num">{d.dayNum}</span>
                  <span className="day-month">{d.month.toUpperCase()}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const rows = [];

              // Build ordered, deduplicated list of locations from filtered members
              const orderedLocations = [];
              const seenLocations = new Set();
              for (const member of filteredMembers) {
                const loc = member.location || 'Unassigned';
                if (!seenLocations.has(loc)) {
                  seenLocations.add(loc);
                  orderedLocations.push(loc);
                }
              }

              // Group members by location
              const membersByLocation = {};
              for (const member of filteredMembers) {
                const loc = member.location || 'Unassigned';
                if (!membersByLocation[loc]) membersByLocation[loc] = [];
                membersByLocation[loc].push(member);
              }

              orderedLocations.forEach((location, groupIndex) => {
                const shade = groupIndex % 2 === 0 ? 'group-even' : 'group-odd';
                const membersInGroup = membersByLocation[location] || [];
                const eqItems = equipmentByLocation[location];

                // State group header
                rows.push(
                  <tr key={`group-${location}`} className="state-group-header">
                    <td colSpan={weekDates.length + 1}>
                      <span className="state-group-label">{location}</span>
                    </td>
                  </tr>
                );

                // Team members
                for (let mi = 0; mi < membersInGroup.length; mi++) {
                  const member = membersInGroup[mi];
                  const shade = groupIndex % 2 === 0 ? 'group-even' : 'group-odd';
                  const rowShade = mi % 2 === 0 ? 'row-even' : 'row-odd';
                const spans = memberSpans[member.id] || [];

                rows.push(
                <tr key={member.id} className={`member-row ${shade} ${rowShade}`}>
                  <td className="member-cell">
                    <div className="member-name-cell">
                      <div className="member-avatar" style={{ background: member.color, color: getTextColor(member.color) }}>
                        {getInitials(member.name)}
                      </div>
                      <div className="member-info">
                        <span className="name">{member.name}</span>
                        <span className="location">{member.location}</span>
                      </div>
                    </div>
                  </td>
                  {spans.map((span) => {
                    const d = weekDates[span.startIdx];
                    if (span.entry) {
                      const isMulti = span.length > 1;
                      const statusKey = span.entry.status || 'tentative';
                      const statusInfo = STATUSES[statusKey] || STATUSES.tentative;
                      return (
                        <td
                          key={d.dateStr}
                          colSpan={span.length}
                          className={`task-cell filled ${d.isToday ? 'today' : ''}`}
                        >
                          <div
                            className={`task-bar ${isMulti ? 'multi-day' : 'single-day'} status-${statusKey}`}
                            style={{
                              '--task-color': statusInfo.color,
                              '--task-text': getTextColor(statusInfo.color),
                            }}
                            title={`${span.entry.job_name} [${statusInfo.label}]${span.entry.job_file_url ? '\nFiles: ' + span.entry.job_file_url : ''}`}
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              const relativeX = e.clientX - rect.left;
                              const dayWidth = rect.width / span.length;
                              const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                              const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                              handleCellClick(member.id, clickedDate, e);
                            }}
                          >
                            <span className="task-label">
                              {span.entry.job_name || span.entry.job_code}
                            </span>
                            {isMulti && (
                              <span className="task-days">{span.length}d</span>
                            )}
                          </div>
                        </td>
                      );
                    } else {
                      return (
                        <td
                          key={d.dateStr}
                          className={`task-cell empty ${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''}`}
                          onClick={(isAdmin || member.id === authUser?.memberId) ? (e) => handleCellClick(member.id, d.dateStr, e) : undefined}
                          style={(!isAdmin && member.id !== authUser?.memberId) ? { cursor: 'default' } : undefined}
                        >
                          {(isAdmin || member.id === authUser?.memberId) && (
                            <div className="empty-cell">
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                              </svg>
                            </div>
                          )}
                        </td>
                      );
                    }
                  })}
                </tr>
                );
                }

                // Equipment for this location
                if (eqItems && eqItems.length > 0) {
                  const isCollapsed = !(collapsedEquipment[location] === true);
                  rows.push(
                    <tr key={`equip-header-${location}`} className="equipment-group-header" onClick={() => toggleEquipment(location)}>
                      <td colSpan={weekDates.length + 1}>
                        <span className={`equipment-toggle ${isCollapsed ? '' : 'expanded'}`}>
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </span>
                        <svg className="equipment-icon" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v4M5 3h4M2 7h10v5H2z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        <span className="equipment-group-label">Equipment ({eqItems.length})</span>
                      </td>
                    </tr>
                  );
                  if (!isCollapsed) {
                    for (const item of eqItems) {
                      const spans = memberSpans[item.id] || [];
                      rows.push(
                        <tr key={item.id} className={`member-row equipment-row ${shade}`}>
                          <td className="member-cell">
                            <div className="member-name-cell">
                              <div className="member-avatar equipment-avatar" style={{ background: item.color, color: getTextColor(item.color) }}>
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v4M5 3h4M2 7h10v5H2z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              </div>
                              <div className="member-info">
                                <span className="name" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  {item.name}
                                  {item.info_url && (
                                    <a
                                      href={item.info_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      title="Equipment info"
                                      style={{ color: 'var(--accent)', display: 'inline-flex', lineHeight: 1 }}
                                    >
                                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                                        <path d="M6.5 3.5H3a1 1 0 00-1 1V13a1 1 0 001 1h8.5a1 1 0 001-1V9.5M9.5 2h4.5v4.5M14 2L7.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                      </svg>
                                    </a>
                                  )}
                                </span>
                                <span className="location">{item.location}</span>
                              </div>
                            </div>
                          </td>
                          {spans.map((span) => {
                            const d = weekDates[span.startIdx];
                            if (span.entry) {
                              const isMulti = span.length > 1;
                              const statusKey = span.entry.status || 'tentative';
                              const statusInfo = STATUSES[statusKey] || STATUSES.tentative;
                              return (
                                <td key={d.dateStr} colSpan={span.length} className={`task-cell filled ${d.isToday ? 'today' : ''}`}>
                                  <div className={`task-bar ${isMulti ? 'multi-day' : 'single-day'} status-${statusKey}`} style={{ '--task-color': statusInfo.color, '--task-text': getTextColor(statusInfo.color) }} title={`${span.entry.job_name} [${statusInfo.label}]`} onClick={(e) => {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  const relativeX = e.clientX - rect.left;
                                  const dayWidth = rect.width / span.length;
                                  const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                                  const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                                  handleCellClick(item.id, clickedDate, e);
                                }}>
                                    <span className="task-label">{span.entry.job_name || span.entry.job_code}</span>
                                    {isMulti && <span className="task-days">{span.length}d</span>}
                                  </div>
                                </td>
                              );
                            } else {
                              return (
                                <td key={d.dateStr} className={`task-cell empty ${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''}`} onClick={isAdmin ? (e) => handleCellClick(item.id, d.dateStr, e) : undefined} style={!isAdmin ? { cursor: 'default' } : undefined}>
                                  {isAdmin && (
                                    <div className="empty-cell">
                                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                    </div>
                                  )}
                                </td>
                              );
                            }
                          })}
                        </tr>
                      );
                    }
                  }
                }
              });

              return rows;
            })()}
            {filteredMembers.length === 0 && (
              <tr>
                <td colSpan={weekDates.length + 1} className="empty-state">
                  No team members yet. Go to the Team tab to add some.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Job assignment dropdown */}
      {dropdown && (
        <div
          ref={dropdownRef}
          className="assignment-dropdown"
          style={{ position: 'fixed', left: dropdown.x, top: dropdown.y }}
        >
          {isAdmin && (
            <div className="dropdown-header">
              <input
                ref={searchInputRef}
                type="text"
                className="dropdown-search"
                placeholder="Search jobs..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          )}
          {!scheduleMap[`${dropdown.memberId}-${dropdown.date}`] && (
            <div className="dropdown-quick-actions">
              <button
                className="quick-action-btn"
                style={{ '--qa-color': STATUSES.note.color }}
                onClick={() => {
                  setNoteModal({ memberId: dropdown.memberId, date: dropdown.date, text: '' });
                  setDropdown(null);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3h8M3 7h5M3 11h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                Add Note
              </button>
              <button
                className="quick-action-btn"
                style={{ '--qa-color': STATUSES.toil.color }}
                onClick={() => handleQuickAssign(dropdown.memberId, dropdown.date, 'toil')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/><path d="M7 4v3.5l2.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                TOIL
              </button>
              <button
                className="quick-action-btn"
                style={{ '--qa-color': STATUSES.leave.color }}
                onClick={() => handleQuickAssign(dropdown.memberId, dropdown.date, 'leave')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1C4.5 1 2.5 3 2.5 5.5c0 1.5.7 2.8 1.8 3.7L7 13l2.7-3.8c1.1-.9 1.8-2.2 1.8-3.7C11.5 3 9.5 1 7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Leave
              </button>
              <button
                className="quick-action-btn"
                style={{ '--qa-color': STATUSES.unavailable.color }}
                onClick={() => handleQuickAssign(dropdown.memberId, dropdown.date, 'unavailable')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/><path d="M4.5 4.5l5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                Not Available
              </button>
            </div>
          )}
          {isAdmin && (
            <div className="dropdown-actions-row">
              <button
                className="dropdown-multi-day-btn"
                onClick={() => {
                  setMultiDayModal({
                    memberId: dropdown.memberId,
                    startDate: dropdown.date,
                    endDate: dropdown.date,
                    jobId: '',
                    status: 'tentative',
                  });
                  setDropdown(null);
                  setSearchTerm('');
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="1" y="2.5" width="12" height="9.5" rx="1.5" stroke="currentColor" strokeWidth="1"/>
                  <path d="M1 5.5h12" stroke="currentColor" strokeWidth="1"/>
                  <path d="M4 1v3M10 1v3" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                  <path d="M4 8h6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                </svg>
                Multi-day assignment
              </button>
            </div>
          )}
          {isAdmin && (
            <div className="dropdown-days-row">
              <label className="dropdown-days-label">Days</label>
              <div className="dropdown-days-control">
                <button type="button" className="days-btn" onClick={() => setAssignDays(Math.max(1, assignDays - 1))}>−</button>
                <input type="number" className="days-input" min="1" max="90" value={assignDays} onChange={(e) => setAssignDays(Math.max(1, parseInt(e.target.value) || 1))} />
                <button type="button" className="days-btn" onClick={() => setAssignDays(assignDays + 1)}>+</button>
              </div>
              {assignDays > 1 && <span className="dropdown-days-hint">→ {assignDays} days from {dropdown.date}</span>}
            </div>
          )}
          {isAdmin && (
            <div className="dropdown-list">
              {filteredJobs.map(job => (
                <button
                  key={job.id}
                  className="dropdown-item"
                  onClick={() => handleAssign(dropdown.memberId, dropdown.date, job)}
                >
                  <span className="dropdown-dot" style={{ background: job.color }}></span>
                  <span className="dropdown-job-name">{job.name}</span>
                  <span className="dropdown-job-code">{job.code}</span>
                </button>
              ))}
              {filteredJobs.length === 0 && (
                <div className="dropdown-empty">
                  {jobs.length === 0 ? 'No jobs created yet' : 'No matching jobs'}
                </div>
              )}
            </div>
          )}
          {scheduleMap[`${dropdown.memberId}-${dropdown.date}`] && (
            <div className="dropdown-footer">
              {isAdmin && (
                <div className="status-picker">
                  <span className="status-picker-label">Status</span>
                  <div className="status-buttons">
                    {Object.entries(STATUSES).map(([key, { label, color }]) => {
                      const currentStatus = scheduleMap[`${dropdown.memberId}-${dropdown.date}`]?.status || 'tentative';
                      return (
                        <button
                          key={key}
                          className={`status-btn ${currentStatus === key ? 'active' : ''}`}
                          style={{ '--status-color': color }}
                          title={label}
                          onClick={() => handleStatusChange(dropdown.memberId, dropdown.date, key)}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {(isAdmin || USER_ALLOWED_STATUSES.includes(scheduleMap[`${dropdown.memberId}-${dropdown.date}`]?.status)) && (
                <button className="dropdown-clear" onClick={() => handleClear(dropdown.memberId, dropdown.date)}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  Clear assignment
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Multi-day assignment modal */}
      {multiDayModal && (
        <div className="modal-overlay" onClick={() => setMultiDayModal(null)}>
          <div className="modal multi-day-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Multi-Day Assignment</h2>
            <p className="modal-subtitle">
              Assign {teamMembers.find(m => m.id === multiDayModal.memberId)?.name} to a job across multiple days
            </p>

            <div className="form-group">
              <label>Job</label>
              <select
                value={multiDayModal.jobId}
                onChange={(e) => setMultiDayModal({ ...multiDayModal, jobId: e.target.value })}
              >
                <option value="">Select a job...</option>
                {jobs.filter(j => !j.code.startsWith('NOTE-')).map(j => (
                  <option key={j.id} value={j.id}>{j.name} ({j.code})</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>Status</label>
              <div className="status-buttons modal-status-buttons">
                {Object.entries(STATUSES).map(([key, { label, color }]) => (
                  <button
                    key={key}
                    className={`status-btn ${multiDayModal.status === key ? 'active' : ''}`}
                    style={{ '--status-color': color }}
                    onClick={() => setMultiDayModal({ ...multiDayModal, status: key })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Start Date</label>
                <input
                  type="date"
                  value={multiDayModal.startDate}
                  onChange={(e) => setMultiDayModal({ ...multiDayModal, startDate: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>End Date</label>
                <input
                  type="date"
                  value={multiDayModal.endDate}
                  onChange={(e) => setMultiDayModal({ ...multiDayModal, endDate: e.target.value })}
                />
              </div>
            </div>

            {multiDayModal.startDate && multiDayModal.endDate && (
              <div className="day-count-preview">
                {(() => {
                  const s = new Date(multiDayModal.startDate);
                  const e = new Date(multiDayModal.endDate);
                  const diff = Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
                  return diff > 0 ? `${diff} day${diff > 1 ? 's' : ''}` : 'Invalid range';
                })()}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={() => setMultiDayModal(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!multiDayModal.jobId || !multiDayModal.startDate || !multiDayModal.endDate}
                onClick={handleMultiDayAssign}
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Note modal */}
      {noteModal && (
        <div className="modal-overlay" onClick={() => setNoteModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Note</h2>
            <p className="modal-subtitle">
              Add a note for {teamMembers.find(m => m.id === noteModal.memberId)?.name} on {noteModal.date}
            </p>
            <div className="form-group">
              <label>Note</label>
              <input
                type="text"
                autoFocus
                placeholder="Enter note text..."
                value={noteModal.text}
                onChange={(e) => setNoteModal({ ...noteModal, text: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') handleNoteAssign(); }}
              />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setNoteModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleNoteAssign} disabled={!noteModal.text.trim()}>
                Add Note
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit member/equipment modal */}
      {editMember && (
        <div className="modal-overlay" onClick={() => setEditMember(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Edit {editMember.is_equipment ? 'Equipment' : 'Team Member'}</h2>
            <form onSubmit={handleEditMemberSubmit}>
              <div className="form-group">
                <label>Name *</label>
                <input type="text" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>{editMember.is_equipment ? 'Type / Description' : 'Role'}</label>
                  <input type="text" value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>State / Location</label>
                  <select value={editForm.location} onChange={(e) => setEditForm({ ...editForm, location: e.target.value })}>
                    <option value="">Select state...</option>
                    {LOCATIONS.map(loc => <option key={loc} value={loc}>{loc}</option>)}
                  </select>
                </div>
              </div>
              {editMember.is_equipment === 1 && (
                <div className="form-group">
                  <label>Info / Documentation Link</label>
                  <input type="url" value={editForm.info_url || ''} onChange={(e) => setEditForm({ ...editForm, info_url: e.target.value })} placeholder="https://..." />
                </div>
              )}
              <div className="form-group">
                <label>Color</label>
                <div className="color-input-wrapper">
                  <input type="color" value={editForm.color} onChange={(e) => setEditForm({ ...editForm, color: e.target.value })} />
                  <input type="text" value={editForm.color} onChange={(e) => setEditForm({ ...editForm, color: e.target.value })} />
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setEditMember(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
