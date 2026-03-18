import React, { useState, useRef, useEffect } from 'react';
import { assignSchedule, clearScheduleEntry, createNotification, downloadIcalMember, getGcalLink } from '../api.js';

export default function ScheduleGrid({
  teamMembers, jobs, schedule, weekDates, weekOffset,
  onWeekChange, onRefresh, showToast, dateRangeLabel
}) {
  const [dropdown, setDropdown] = useState(null); // { memberId, date, x, y }
  const dropdownRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdown(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Build a lookup map: "memberId-date" -> entry
  const scheduleMap = {};
  for (const entry of schedule) {
    scheduleMap[`${entry.team_member_id}-${entry.date}`] = entry;
  }

  const handleCellClick = (memberId, dateStr, e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setDropdown({
      memberId,
      date: dateStr,
      x: Math.min(rect.left, window.innerWidth - 220),
      y: rect.bottom + 4
    });
  };

  const handleAssign = async (memberId, date, job) => {
    try {
      const result = await assignSchedule({
        team_member_id: memberId,
        job_id: job.id,
        date
      });

      // Create notification for the team member
      const member = teamMembers.find(m => m.id === memberId);
      const notifType = result._notification?.type || 'assigned';
      const message = notifType === 'changed'
        ? `Your schedule for ${date} was changed to ${job.code} - ${job.name}`
        : `You have been assigned to ${job.code} - ${job.name} on ${date}`;

      await createNotification({
        team_member_id: memberId,
        type: notifType,
        message,
        date,
        job_code: job.code
      });

      setDropdown(null);
      onRefresh();
      showToast(`Assigned ${job.code} to ${member?.name} on ${date}`, 'success');
    } catch (err) {
      showToast('Failed to assign: ' + err.message, 'error');
    }
  };

  const handleClear = async (memberId, date) => {
    try {
      await clearScheduleEntry(memberId, date);

      const member = teamMembers.find(m => m.id === memberId);
      await createNotification({
        team_member_id: memberId,
        type: 'removed',
        message: `Your assignment for ${date} has been removed`,
        date
      });

      setDropdown(null);
      onRefresh();
      showToast(`Cleared assignment for ${member?.name} on ${date}`);
    } catch (err) {
      showToast('Failed to clear: ' + err.message, 'error');
    }
  };

  const handleExportIcal = async (memberId) => {
    try {
      const blob = await downloadIcalMember(memberId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'schedule.ics';
      a.click();
      URL.revokeObjectURL(url);
      showToast('iCal file downloaded', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  };

  const getInitials = (name) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  return (
    <div>
      <div className="schedule-controls">
        <div className="week-nav">
          <button className="btn btn-sm" onClick={() => onWeekChange(weekOffset - 2)}>‹‹</button>
          <button className="btn btn-sm" onClick={() => onWeekChange(weekOffset - 1)}>‹ Prev</button>
          <button className="btn btn-sm btn-primary" onClick={() => onWeekChange(0)}>Today</button>
          <button className="btn btn-sm" onClick={() => onWeekChange(weekOffset + 1)}>Next ›</button>
          <button className="btn btn-sm" onClick={() => onWeekChange(weekOffset + 2)}>››</button>
        </div>
        <span className="week-label">{dateRangeLabel}</span>
      </div>

      <div className="schedule-grid">
        <table className="schedule-table">
          <thead>
            <tr>
              <th>Team Member</th>
              {weekDates.map(d => (
                <th
                  key={d.dateStr}
                  className={`${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''}`}
                >
                  <span className="day-name">{d.dayName}</span>
                  <span className="day-date">{d.dayNum} {d.month}</span>
                </th>
              ))}
              <th style={{ width: 60 }}>Export</th>
            </tr>
          </thead>
          <tbody>
            {teamMembers.map(member => (
              <tr key={member.id}>
                <td>
                  <div className="member-name-cell">
                    <div className="member-avatar" style={{ background: member.color }}>
                      {getInitials(member.name)}
                    </div>
                    <div className="member-info">
                      <span className="name">{member.name}</span>
                      {member.location && <span className="location">{member.location}</span>}
                    </div>
                  </div>
                </td>
                {weekDates.map(d => {
                  const entry = scheduleMap[`${member.id}-${d.dateStr}`];
                  return (
                    <td
                      key={d.dateStr}
                      className={`${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''}`}
                    >
                      <div
                        className="schedule-cell"
                        onClick={(e) => handleCellClick(member.id, d.dateStr, e)}
                      >
                        {entry ? (
                          <span
                            className="job-chip"
                            style={{ background: entry.job_color }}
                            title={`${entry.job_code} - ${entry.job_name}${entry.job_file_url ? '\nFiles: ' + entry.job_file_url : ''}`}
                          >
                            {entry.job_code}
                            <button
                              className="remove-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleClear(member.id, d.dateStr);
                              }}
                            >
                              ×
                            </button>
                          </span>
                        ) : (
                          <span className="empty-cell">+</span>
                        )}
                      </div>
                    </td>
                  );
                })}
                <td>
                  <button
                    className="btn-icon"
                    title="Download iCal"
                    onClick={() => handleExportIcal(member.id)}
                  >
                    📅
                  </button>
                </td>
              </tr>
            ))}
            {teamMembers.length === 0 && (
              <tr>
                <td colSpan={weekDates.length + 2} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
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
          className="cell-dropdown"
          style={{ position: 'fixed', left: dropdown.x, top: dropdown.y }}
        >
          {jobs.map(job => (
            <button
              key={job.id}
              className="cell-dropdown-item"
              onClick={() => handleAssign(dropdown.memberId, dropdown.date, job)}
            >
              <span className="job-dot" style={{ background: job.color }}></span>
              <span>{job.code} - {job.name}</span>
            </button>
          ))}
          {scheduleMap[`${dropdown.memberId}-${dropdown.date}`] && (
            <button
              className="cell-dropdown-item"
              onClick={() => handleClear(dropdown.memberId, dropdown.date)}
            >
              <span className="clear-option">✕ Clear assignment</span>
            </button>
          )}
          {jobs.length === 0 && (
            <div style={{ padding: '12px', color: '#94a3b8', fontSize: 13 }}>
              No jobs created yet. Add jobs in the Jobs tab.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
