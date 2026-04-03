import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { assignSchedule, bulkAssignSchedule, clearScheduleEntry, deleteScheduleEntry, createNotification, updateScheduleStatus, updateScheduleNotes, createJob, getJobs as fetchJobs, updateTeamMember, moveScheduleEntries, STATUSES } from '../api.js';

const USER_ALLOWED_STATUSES = ['note', 'toil', 'leave', 'unavailable'];

export default function ScheduleGrid({
  teamMembers, equipment, jobs, schedule, allDates,
  onLoadMore, onScrollToToday, onRefresh, onScheduleRefresh, showToast
}) {
  // Use allDates as weekDates for compatibility with existing rendering logic
  const weekDates = allDates;
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

  // Drag-and-drop constants (tunable)
  const DRAG_HOLD_MS = 300;
  const DRAG_MOVE_THRESHOLD = 5;

  // Drag-and-drop state
  const dragHoldTimer = useRef(null);
  const dragSourceRef = useRef(null); // { entryIds, memberId, startDate, spanLength }
  const [dragOverCell, setDragOverCell] = useState(null); // { memberId, dateStr }
  const [isDragActive, setIsDragActive] = useState(false);
  const autoScrollRef = useRef(null);

  // Resize state
  const resizeRef = useRef(null); // { memberId, jobId, status, notes, edge, origStartIdx, origEndIdx, currentStartIdx, currentEndIdx }
  const [resizePreview, setResizePreview] = useState(null); // { memberId, startIdx, endIdx }

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
      if (e.target.closest('button, select, input, .task-bar, .empty-cell, .assignment-dropdown, .resize-handle')) return;
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

  // Scroll the grid so today's column is at the left edge (after sticky member column)
  const scrollToTodayColumn = useCallback(() => {
    const el = gridRef.current;
    if (!el) return;
    const todayHeader = el.querySelector('.day-header.today');
    if (!todayHeader) return;
    const memberCol = el.querySelector('.member-col-header');
    const memberColWidth = memberCol ? memberCol.offsetWidth : 0;
    el.scrollLeft = Math.max(0, todayHeader.offsetLeft - memberColWidth);
  }, []);

  // Scroll to today's column on initial mount (same as pressing "Today" button)
  const hasScrolledToToday = useRef(false);
  useEffect(() => {
    if (hasScrolledToToday.current || !gridRef.current || weekDates.length === 0) return;
    const todayIdx = weekDates.findIndex(d => d.isToday);
    if (todayIdx < 0) return;
    // Wait for schedule data before scrolling so the grid is fully rendered
    if (!schedule || schedule.length === 0) return;
    hasScrolledToToday.current = true;
    // Use requestAnimationFrame + short delay to ensure DOM is painted
    requestAnimationFrame(() => {
      setTimeout(() => scrollToTodayColumn(), 50);
    });
  }, [weekDates, schedule, scrollToTodayColumn]);

  // Scroll to today when button is pressed
  const handleScrollToToday = useCallback(() => {
    onScrollToToday();
    // Scroll after a short delay to allow any date range change to render
    setTimeout(() => scrollToTodayColumn(), 100);
  }, [onScrollToToday, scrollToTodayColumn]);

  // Infinite scroll: load more dates when near edges
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;

    let ticking = false;
    const THRESHOLD = 300; // pixels from edge to trigger load

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (!el) return;
        const { scrollLeft, scrollWidth, clientWidth } = el;
        // Near right edge → load future dates
        if (scrollWidth - scrollLeft - clientWidth < THRESHOLD) {
          onLoadMore('future');
        }
        // Near left edge → load past dates
        if (scrollLeft < THRESHOLD) {
          // Save scroll position so we can restore it after new columns are prepended
          const prevScrollWidth = scrollWidth;
          onLoadMore('past').then(() => {
            requestAnimationFrame(() => {
              if (gridRef.current) {
                const newScrollWidth = gridRef.current.scrollWidth;
                gridRef.current.scrollLeft += (newScrollWidth - prevScrollWidth);
              }
            });
          });
        }
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onLoadMore]);

  // Build schedule lookup (array per cell to support collisions)
  const scheduleMap = {};
  for (const entry of schedule) {
    const key = `${entry.team_member_id}-${entry.date}`;
    if (!scheduleMap[key]) scheduleMap[key] = [];
    scheduleMap[key].push(entry);
  }
  // Keep a ref so resize mouseup can access the latest scheduleMap
  const scheduleMapRef = useRef(scheduleMap);
  scheduleMapRef.current = scheduleMap;

  // Build merged spans per member/equipment row
  const allEntities = useMemo(() => [...teamMembers, ...(equipment || [])], [teamMembers, equipment]);

  const memberSpans = useMemo(() => {
    const result = {};
    for (const member of allEntities) {
      const spans = [];
      let i = 0;
      while (i < weekDates.length) {
        const entries = scheduleMap[`${member.id}-${weekDates[i].dateStr}`];
        const entry = entries ? entries[0] : null;
        if (entry) {
          // Find how many consecutive days have the same job AND status
          let end = i + 1;
          while (end < weekDates.length) {
            const nextEntries = scheduleMap[`${member.id}-${weekDates[end].dateStr}`];
            const nextEntry = nextEntries ? nextEntries[0] : null;
            if (nextEntry && nextEntry.job_id === entry.job_id && (nextEntry.status || 'tentative') === (entry.status || 'tentative')) {
              end++;
            } else {
              break;
            }
          }
          // Check if ANY day in this span has multiple entries (collision)
          let hasCollision = false;
          const allSpanEntries = [];
          for (let ci = i; ci < end; ci++) {
            const dayEntries = scheduleMap[`${member.id}-${weekDates[ci].dateStr}`];
            if (dayEntries) {
              allSpanEntries.push(...dayEntries);
              if (dayEntries.length > 1) hasCollision = true;
            }
          }
          const seen = new Set();
          const uniqueEntries = allSpanEntries.filter(e => { if (seen.has(e.job_id)) return false; seen.add(e.job_id); return true; });
          spans.push({ startIdx: i, length: end - i, entry, entries: uniqueEntries, hasCollision });
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
        const entries = scheduleMap[`${memberId}-${date}`];
        if (entries && entries.length > 0) {
          await updateScheduleStatus(entries[0].id, newStatus);
        }
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
          linkedEntries.map(e => updateScheduleStatus(e.id, newStatus))
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

  // ── Drag-and-Drop Handlers ──────────────────────────────────────────

  // Press-and-hold to activate drag on task bars
  const handleTaskBarMouseDown = useCallback((e, span, memberId) => {
    if (!isAdmin) return;
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const taskBarEl = e.currentTarget;

    const entryIds = [];
    for (let i = 0; i < span.length; i++) {
      const dateStr = weekDates[span.startIdx + i].dateStr;
      const entries = scheduleMap[`${memberId}-${dateStr}`];
      if (entries && entries.length > 0) {
        entryIds.push(entries[0].id);
      }
    }
    const startDateStr = weekDates[span.startIdx].dateStr;

    const cleanup = () => {
      clearTimeout(dragHoldTimer.current);
      document.removeEventListener('mousemove', onMoveBeforeHold);
      document.removeEventListener('mouseup', onMouseUpBeforeHold);
    };

    const onMoveBeforeHold = (ev) => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (dx > DRAG_MOVE_THRESHOLD || dy > DRAG_MOVE_THRESHOLD) {
        cleanup();
      }
    };
    const onMouseUpBeforeHold = () => {
      cleanup();
    };

    document.addEventListener('mousemove', onMoveBeforeHold);
    document.addEventListener('mouseup', onMouseUpBeforeHold);

    dragHoldTimer.current = setTimeout(() => {
      cleanup();
      dragSourceRef.current = { entryIds, memberId, startDate: startDateStr, spanLength: span.length };
      setIsDragActive(true);
      taskBarEl.setAttribute('draggable', 'true');
      taskBarEl.classList.add('dragging');
    }, DRAG_HOLD_MS);
  }, [isAdmin, weekDates, scheduleMap]);

  const handleDragStart = useCallback((e) => {
    if (!dragSourceRef.current) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(dragSourceRef.current));
  }, []);

  const handleDragEnd = useCallback((e) => {
    e.currentTarget.setAttribute('draggable', 'false');
    e.currentTarget.classList.remove('dragging');
    setIsDragActive(false);
    setDragOverCell(null);
    dragSourceRef.current = null;
    clearInterval(autoScrollRef.current);
  }, []);

  const handleCellDragOver = useCallback((e, memberId, dateStr) => {
    if (!dragSourceRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverCell({ memberId, dateStr });
  }, []);

  const handleCellDragLeave = useCallback(() => {
    setDragOverCell(null);
  }, []);

  const handleCellDrop = useCallback(async (e, memberId, dateStr) => {
    e.preventDefault();
    setDragOverCell(null);
    setIsDragActive(false);

    const source = dragSourceRef.current;
    if (!source) return;
    dragSourceRef.current = null;
    clearInterval(autoScrollRef.current);

    const targetStartIdx = weekDates.findIndex(d => d.dateStr === dateStr);
    if (targetStartIdx < 0) return;
    const targetEndIdx = targetStartIdx + source.spanLength - 1;
    if (targetEndIdx >= weekDates.length) {
      showToast('Cannot move: target extends beyond loaded dates', 'error');
      return;
    }

    if (memberId === source.memberId && dateStr === source.startDate) return;

    try {
      await moveScheduleEntries(source.entryIds, memberId, dateStr);
      showToast('Assignment moved', 'success');
      onScheduleRefresh();
    } catch (err) {
      showToast('Failed to move: ' + err.message, 'error');
      onScheduleRefresh();
    }
  }, [weekDates, showToast, onScheduleRefresh]);

  // Auto-scroll grid edges during drag
  const handleGridDragOver = useCallback((e) => {
    if (!dragSourceRef.current || !gridRef.current) return;
    e.preventDefault();
    const el = gridRef.current;
    const rect = el.getBoundingClientRect();
    const edgeZone = 60;

    clearInterval(autoScrollRef.current);
    if (e.clientX < rect.left + edgeZone) {
      autoScrollRef.current = setInterval(() => { el.scrollLeft -= 8; }, 16);
    } else if (e.clientX > rect.right - edgeZone) {
      autoScrollRef.current = setInterval(() => { el.scrollLeft += 8; }, 16);
    }
  }, []);

  // Escape key cancels active drag or resize
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (isDragActive) {
          setIsDragActive(false);
          setDragOverCell(null);
          dragSourceRef.current = null;
          clearInterval(autoScrollRef.current);
          const dragging = document.querySelector('.task-bar.dragging');
          if (dragging) {
            dragging.setAttribute('draggable', 'false');
            dragging.classList.remove('dragging');
          }
        }
        if (resizeRef.current) {
          resizeRef.current = null;
          setResizePreview(null);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isDragActive]);

  useEffect(() => {
    return () => clearInterval(autoScrollRef.current);
  }, []);

  // ── Resize Handlers ───────────────────────────────────────────────

  // Get the date column index from a mouse X position
  const getDateIdxFromMouseX = useCallback((clientX) => {
    const el = gridRef.current;
    if (!el) return -1;
    const headers = el.querySelectorAll('.day-header');
    for (let i = 0; i < headers.length; i++) {
      const rect = headers[i].getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) return i;
    }
    // If past the last header, return last index
    if (headers.length > 0) {
      const lastRect = headers[headers.length - 1].getBoundingClientRect();
      if (clientX > lastRect.right) return headers.length - 1;
      const firstRect = headers[0].getBoundingClientRect();
      if (clientX < firstRect.left) return 0;
    }
    return -1;
  }, []);

  const handleResizeMouseDown = useCallback((e, span, memberId, edge) => {
    if (!isAdmin) return;
    e.stopPropagation();
    e.preventDefault();

    const entry = span.entry;
    const origStartIdx = span.startIdx;
    const origEndIdx = span.startIdx + span.length - 1;

    resizeRef.current = {
      memberId,
      jobId: entry.job_id,
      status: entry.status || 'tentative',
      notes: entry.notes || '',
      edge, // 'left' or 'right'
      origStartIdx,
      origEndIdx,
      currentStartIdx: origStartIdx,
      currentEndIdx: origEndIdx,
    };
    setResizePreview({ memberId, startIdx: origStartIdx, endIdx: origEndIdx });

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [isAdmin]);

  // Global mousemove and mouseup for resize
  useEffect(() => {
    const onMouseMove = (e) => {
      if (!resizeRef.current) return;
      const idx = getDateIdxFromMouseX(e.clientX);
      if (idx < 0) return;

      const r = resizeRef.current;
      let newStart = r.currentStartIdx;
      let newEnd = r.currentEndIdx;

      if (r.edge === 'right') {
        newEnd = Math.max(r.origStartIdx, idx); // can't shrink past start
      } else {
        newStart = Math.min(r.origEndIdx, idx); // can't shrink past end
      }

      if (newStart !== r.currentStartIdx || newEnd !== r.currentEndIdx) {
        r.currentStartIdx = newStart;
        r.currentEndIdx = newEnd;
        setResizePreview({ memberId: r.memberId, startIdx: newStart, endIdx: newEnd });
      }

      // Auto-scroll at edges
      const el = gridRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const edgeZone = 60;
        clearInterval(autoScrollRef.current);
        if (e.clientX < rect.left + edgeZone) {
          autoScrollRef.current = setInterval(() => { el.scrollLeft -= 8; }, 16);
        } else if (e.clientX > rect.right - edgeZone) {
          autoScrollRef.current = setInterval(() => { el.scrollLeft += 8; }, 16);
        }
      }
    };

    const onMouseUp = async () => {
      if (!resizeRef.current) return;
      const r = resizeRef.current;
      resizeRef.current = null;
      setResizePreview(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      clearInterval(autoScrollRef.current);

      // Determine what changed
      const origDates = new Set();
      for (let i = r.origStartIdx; i <= r.origEndIdx; i++) {
        if (weekDates[i]) origDates.add(weekDates[i].dateStr);
      }
      const newDates = new Set();
      for (let i = r.currentStartIdx; i <= r.currentEndIdx; i++) {
        if (weekDates[i]) newDates.add(weekDates[i].dateStr);
      }

      // Dates to add (extended)
      const toAdd = [...newDates].filter(d => !origDates.has(d));
      // Dates to remove (shrunk)
      const toRemove = [...origDates].filter(d => !newDates.has(d));

      if (toAdd.length === 0 && toRemove.length === 0) return; // no change

      try {
        // Add new entries
        if (toAdd.length > 0) {
          await bulkAssignSchedule({
            team_member_id: r.memberId,
            job_id: r.jobId,
            dates: toAdd,
            status: r.status,
            notes: r.notes,
          });
        }
        // Remove shrunk entries
        if (toRemove.length > 0) {
          await Promise.all(
            toRemove.map(date => {
              const entries = scheduleMapRef.current[`${r.memberId}-${date}`];
              if (entries) {
                // Delete entries matching this job
                const matching = entries.filter(e => e.job_id === r.jobId);
                return Promise.all(matching.map(e => deleteScheduleEntry(e.id)));
              }
            })
          );
        }
        showToast(`Job ${toAdd.length > 0 ? 'extended' : 'shortened'} by ${Math.abs(toAdd.length || toRemove.length)} day${(toAdd.length || toRemove.length) !== 1 ? 's' : ''}`, 'success');
        onScheduleRefresh();
      } catch (err) {
        showToast('Failed to resize: ' + err.message, 'error');
        onScheduleRefresh();
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [getDateIdxFromMouseX, weekDates, showToast, onScheduleRefresh]);

  // ── End Drag-and-Drop / Resize ────────────────────────────────────

  const STATUS_CODES = ['TOIL', 'LEAVE', 'NOT-AVAIL'];
  const isRealJob = (j) => !j.code.startsWith('NOTE-') && !STATUS_CODES.includes(j.code);
  const filteredJobs = jobs.filter(j =>
    isRealJob(j) &&
    (!searchTerm || j.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    j.name.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="schedule-wrapper">
      {/* Controls */}
      <div className="schedule-controls">
        <div className="week-nav">
          <button className="nav-btn nav-today" onClick={handleScrollToToday} title="Jump to today">Today</button>
        </div>
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
      <div className="schedule-grid" ref={gridRef} onDragOver={isDragActive ? handleGridDragOver : undefined}>
        <table className="schedule-table">
          <thead>
            <tr>
              <th className="member-col-header">Team Member</th>
              {weekDates.map(d => {
                const isMonday = d.date.getDay() === 1;
                return (
                  <th key={d.dateStr} className={`day-header ${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''} ${isMonday ? 'week-start' : ''}`}>
                    <span className="day-name">{d.dayName.toUpperCase()}</span>
                    <span className="day-num">{d.dayNum}</span>
                    <span className="day-month">{d.month.toUpperCase()}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const rows = [];

              // Find logged-in user's location for priority sorting
              const currentMember = filteredMembers.find(m => m.id === authUser?.memberId);
              const userLocation = currentMember?.location || null;

              // Build ordered, deduplicated list of locations from filtered members
              const orderedLocations = [];
              const seenLocations = new Set();
              // Put user's location first if they have one
              if (userLocation && !authUser?.isViewer) {
                seenLocations.add(userLocation);
                orderedLocations.push(userLocation);
              }
              for (const member of filteredMembers) {
                const loc = member.location || 'Unassigned';
                if (!seenLocations.has(loc)) {
                  seenLocations.add(loc);
                  orderedLocations.push(loc);
                }
              }

              // Group members by location, with logged-in user first in their group
              const membersByLocation = {};
              for (const member of filteredMembers) {
                const loc = member.location || 'Unassigned';
                if (!membersByLocation[loc]) membersByLocation[loc] = [];
                if (member.id === authUser?.memberId) {
                  membersByLocation[loc].unshift(member);
                } else {
                  membersByLocation[loc].push(member);
                }
              }

              orderedLocations.forEach((location, groupIndex) => {
                const shade = groupIndex % 2 === 0 ? 'group-even' : 'group-odd';
                const membersInGroup = membersByLocation[location] || [];
                const eqItems = equipmentByLocation[location];

                // State group header
                rows.push(
                  <tr key={`group-${location}`} className="state-group-header">
                    <td colSpan={weekDates.length + 1}>
                      <div className="sticky-header-content">
                        <span className="state-group-label">{location}</span>
                        <span className="state-group-count">{membersInGroup.length} {membersInGroup.length === 1 ? 'member' : 'members'}{eqItems && eqItems.length > 0 ? ` · ${eqItems.length} equipment` : ''}</span>
                      </div>
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
                <tr key={member.id} data-member-id={member.id} className={`member-row ${shade} ${rowShade}`}>
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
                    const isMonday = d.date.getDay() === 1;
                    if (span.entry) {
                      const isMulti = span.length > 1;
                      const statusKey = span.entry.status || 'tentative';
                      const statusInfo = STATUSES[statusKey] || STATUSES.tentative;
                      return (
                        <td
                          key={d.dateStr}
                          colSpan={span.length}
                          className={`task-cell filled ${d.isToday ? 'today' : ''} ${span.hasCollision ? 'collision' : ''} ${dragOverCell && dragOverCell.memberId === member.id && dragOverCell.dateStr === d.dateStr ? (scheduleMap[`${member.id}-${d.dateStr}`]?.length > 0 ? 'drag-over-collision' : 'drag-over') : ''}`}
                          onDragOver={isDragActive ? (e) => handleCellDragOver(e, member.id, d.dateStr) : undefined}
                          onDragLeave={isDragActive ? handleCellDragLeave : undefined}
                          onDrop={isDragActive ? (e) => handleCellDrop(e, member.id, d.dateStr) : undefined}
                        >
                          {span.hasCollision ? (
                            <div className="collision-stack" onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              const relativeX = e.clientX - rect.left;
                              const dayWidth = rect.width / span.length;
                              const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                              const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                              handleCellClick(member.id, clickedDate, e);
                            }}>
                              {span.entries.slice(0, 3).map((ent) => {
                                const si = STATUSES[ent.status || 'tentative'] || STATUSES.tentative;
                                return (
                                  <div key={ent.id} className="collision-bar" style={{ '--task-color': si.color, '--task-text': getTextColor(si.color) }}>
                                    <span className="task-label">{ent.job_code || ent.job_name}</span>
                                  </div>
                                );
                              })}
                              {span.entries.length > 3 && <div className="collision-more">+{span.entries.length - 3}</div>}
                            </div>
                          ) : (
                            <div
                              className={`task-bar ${isMulti ? 'multi-day' : 'single-day'} status-${statusKey}`}
                              style={{
                                '--task-color': statusInfo.color,
                                '--task-text': getTextColor(statusInfo.color),
                              }}
                              title={`${span.entry.job_name} [${statusInfo.label}]${span.entry.job_description ? '\n' + span.entry.job_description : ''}`}
                              onMouseDown={isAdmin ? (ev) => handleTaskBarMouseDown(ev, span, member.id) : undefined}
                              onDragStart={handleDragStart}
                              onDragEnd={handleDragEnd}
                              onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const relativeX = e.clientX - rect.left;
                                const dayWidth = rect.width / span.length;
                                const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                                const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                                handleCellClick(member.id, clickedDate, e);
                              }}
                            >
                              {isAdmin && <div className="resize-handle resize-handle-left" onMouseDown={(ev) => handleResizeMouseDown(ev, span, member.id, 'left')} />}
                              <span className="task-label">
                                {span.entry.job_name || span.entry.job_code}
                              </span>
                              {isMulti && (
                                <span className="task-days">{span.length}d</span>
                              )}
                              {isAdmin && <div className="resize-handle resize-handle-right" onMouseDown={(ev) => handleResizeMouseDown(ev, span, member.id, 'right')} />}
                            </div>
                          )}
                        </td>
                      );
                    } else {
                      return (
                        <td
                          key={d.dateStr}
                          className={`task-cell empty ${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''} ${dragOverCell && dragOverCell.memberId === member.id && dragOverCell.dateStr === d.dateStr ? 'drag-over' : ''}`}
                          onClick={(isAdmin || member.id === authUser?.memberId) ? (e) => handleCellClick(member.id, d.dateStr, e) : undefined}
                          style={(!isAdmin && member.id !== authUser?.memberId) ? { cursor: 'default' } : undefined}
                          onDragOver={isDragActive ? (e) => handleCellDragOver(e, member.id, d.dateStr) : undefined}
                          onDragLeave={isDragActive ? handleCellDragLeave : undefined}
                          onDrop={isDragActive ? (e) => handleCellDrop(e, member.id, d.dateStr) : undefined}
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
                        <div className="sticky-header-content">
                          <span className={`equipment-toggle ${isCollapsed ? '' : 'expanded'}`}>
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </span>
                          <svg className="equipment-icon" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v4M5 3h4M2 7h10v5H2z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          <span className="equipment-group-label">Equipment ({eqItems.length})</span>
                        </div>
                      </td>
                    </tr>
                  );
                  if (!isCollapsed) {
                    for (const item of eqItems) {
                      const spans = memberSpans[item.id] || [];
                      rows.push(
                        <tr key={item.id} data-member-id={item.id} className={`member-row equipment-row ${shade}`}>
                          <td className="member-cell">
                            <div className="member-name-cell">
                              <div className="member-avatar equipment-avatar" style={{ background: item.color, color: getTextColor(item.color) }}>
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v4M5 3h4M2 7h10v5H2z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              </div>
                              <div className="member-info">
                                <span className="name" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  {item.name}
                                  {item.serviceable === 0 && (
                                    <span title="Unserviceable" style={{ color: '#f59e0b', fontSize: 13 }}>&#9888;</span>
                                  )}
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
                            const isMonday = d.date.getDay() === 1;
                            if (span.entry) {
                              const isMulti = span.length > 1;
                              const statusKey = span.entry.status || 'tentative';
                              const statusInfo = STATUSES[statusKey] || STATUSES.tentative;
                              return (
                                <td key={d.dateStr} colSpan={span.length} className={`task-cell filled ${d.isToday ? 'today' : ''} ${span.hasCollision ? 'collision' : ''} ${dragOverCell && dragOverCell.memberId === item.id && dragOverCell.dateStr === d.dateStr ? 'drag-over-collision' : ''}`}
                                  onDragOver={isDragActive ? (e) => handleCellDragOver(e, item.id, d.dateStr) : undefined}
                                  onDragLeave={isDragActive ? handleCellDragLeave : undefined}
                                  onDrop={isDragActive ? (e) => handleCellDrop(e, item.id, d.dateStr) : undefined}>
                                  {span.hasCollision ? (
                                    <div className="collision-stack" onClick={(e) => {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      const relativeX = e.clientX - rect.left;
                                      const dayWidth = rect.width / span.length;
                                      const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                                      const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                                      handleCellClick(item.id, clickedDate, e);
                                    }}>
                                      {span.entries.slice(0, 3).map((ent) => {
                                        const si = STATUSES[ent.status || 'tentative'] || STATUSES.tentative;
                                        return (
                                          <div key={ent.id} className="collision-bar" style={{ '--task-color': si.color, '--task-text': getTextColor(si.color) }}>
                                            <span className="task-label">{ent.job_code || ent.job_name}</span>
                                          </div>
                                        );
                                      })}
                                      {span.entries.length > 3 && <div className="collision-more">+{span.entries.length - 3}</div>}
                                    </div>
                                  ) : (
                                    <div className={`task-bar ${isMulti ? 'multi-day' : 'single-day'} status-${statusKey}`} style={{ '--task-color': statusInfo.color, '--task-text': getTextColor(statusInfo.color) }} title={`${span.entry.job_name} [${statusInfo.label}]${span.entry.job_description ? '\n' + span.entry.job_description : ''}`}
                                      onMouseDown={isAdmin ? (ev) => handleTaskBarMouseDown(ev, span, item.id) : undefined}
                                      onDragStart={handleDragStart}
                                      onDragEnd={handleDragEnd}
                                      onClick={(e) => {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      const relativeX = e.clientX - rect.left;
                                      const dayWidth = rect.width / span.length;
                                      const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                                      const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                                      handleCellClick(item.id, clickedDate, e);
                                    }}>
                                      {isAdmin && <div className="resize-handle resize-handle-left" onMouseDown={(ev) => handleResizeMouseDown(ev, span, item.id, 'left')} />}
                                      <span className="task-label">{span.entry.job_name || span.entry.job_code}</span>
                                      {isMulti && <span className="task-days">{span.length}d</span>}
                                      {isAdmin && <div className="resize-handle resize-handle-right" onMouseDown={(ev) => handleResizeMouseDown(ev, span, item.id, 'right')} />}
                                    </div>
                                  )}
                                </td>
                              );
                            } else {
                              return (
                                <td key={d.dateStr} className={`task-cell empty ${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''} ${dragOverCell && dragOverCell.memberId === item.id && dragOverCell.dateStr === d.dateStr ? 'drag-over' : ''}`} onClick={isAdmin ? (e) => handleCellClick(item.id, d.dateStr, e) : undefined} style={!isAdmin ? { cursor: 'default' } : undefined}
                                  onDragOver={isDragActive ? (e) => handleCellDragOver(e, item.id, d.dateStr) : undefined}
                                  onDragLeave={isDragActive ? handleCellDragLeave : undefined}
                                  onDrop={isDragActive ? (e) => handleCellDrop(e, item.id, d.dateStr) : undefined}>
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

      {/* Resize preview overlay */}
      {resizePreview && (() => {
        const el = gridRef.current;
        if (!el) return null;
        const headers = el.querySelectorAll('.day-header');
        const startHeader = headers[resizePreview.startIdx];
        const endHeader = headers[resizePreview.endIdx];
        if (!startHeader || !endHeader) return null;
        const gridRect = el.getBoundingClientRect();
        const startRect = startHeader.getBoundingClientRect();
        const endRect = endHeader.getBoundingClientRect();
        // Find the member row to get vertical position
        const memberRow = el.querySelector(`tr[data-member-id="${resizePreview.memberId}"]`);
        const rowRect = memberRow ? memberRow.getBoundingClientRect() : null;
        if (!rowRect) return null;
        return (
          <div className="resize-preview-overlay" style={{
            position: 'fixed',
            left: startRect.left,
            top: rowRect.top,
            width: endRect.right - startRect.left,
            height: rowRect.height,
            pointerEvents: 'none',
            zIndex: 50,
          }} />
        );
      })()}

      {/* Job assignment dropdown */}
      {dropdown && (() => {
        const existingEntries = scheduleMap[`${dropdown.memberId}-${dropdown.date}`] || [];
        const existingEntry = existingEntries[0];
        const isPopulated = existingEntries.length > 0;

        return (
        <div
          ref={dropdownRef}
          className="assignment-dropdown"
          style={{ position: 'fixed', left: dropdown.x, top: dropdown.y }}
        >
          {isPopulated ? (
            /* ── Populated cell: show task info, notes, link, status, clear ── */
            existingEntries.length > 1 ? (
              /* ── Multiple entries (collision): show each as a card ── */
              <div className="dropdown-collision-list">
                <div className="dropdown-collision-header">
                  <span className="dropdown-collision-title">{existingEntries.length} assignments on {dropdown.date}</span>
                </div>
                {existingEntries.map((entry) => {
                  const entryStatus = STATUSES[entry.status || 'tentative'] || STATUSES.tentative;
                  return (
                    <div key={entry.id} className="dropdown-collision-card">
                      <div className="dropdown-task-info">
                        <div className="dropdown-task-header">
                          <span className="dropdown-dot" style={{ background: entry.job_color }}></span>
                          <div className="dropdown-task-details">
                            <span className="dropdown-task-name">{entry.job_name}</span>
                            <span className="dropdown-task-code">{entry.job_code}</span>
                          </div>
                          <span className="dropdown-collision-status" style={{ background: entryStatus.color, color: getTextColor(entryStatus.color) }}>
                            {entryStatus.label}
                          </span>
                        </div>
                      </div>
                      {isAdmin && (
                        <div className="dropdown-notes-section">
                          <textarea
                            className="dropdown-notes-input"
                            placeholder="Notes..."
                            defaultValue={entry.notes || ''}
                            onBlur={async (e) => {
                              const newNotes = e.target.value;
                              if (newNotes !== (entry.notes || '')) {
                                try {
                                  await updateScheduleNotes(entry.id, newNotes);
                                  onScheduleRefresh();
                                  showToast('Notes updated', 'success');
                                } catch (err) {
                                  showToast('Failed to update notes: ' + err.message, 'error');
                                }
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                e.target.blur();
                              }
                            }}
                          />
                        </div>
                      )}
                      {entry.job_file_url && (
                        <a href={entry.job_file_url} target="_blank" rel="noopener noreferrer" className="dropdown-link-btn" onClick={(e) => e.stopPropagation()}>
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                            <path d="M6.5 3.5H3a1 1 0 00-1 1V13a1 1 0 001 1h8.5a1 1 0 001-1V9.5M9.5 2h4.5v4.5M14 2L7.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          Info
                        </a>
                      )}
                      {isAdmin && (
                        <div className="dropdown-collision-actions">
                          <div className="status-picker compact">
                            <div className="status-buttons">
                              {Object.entries(STATUSES).map(([key, { label, color }]) => (
                                <button
                                  key={key}
                                  className={`status-btn ${(entry.status || 'tentative') === key ? 'active' : ''}`}
                                  style={{ '--status-color': color }}
                                  title={label}
                                  onClick={async () => {
                                    try {
                                      await updateScheduleStatus(entry.id, key);
                                      onScheduleRefresh();
                                      showToast(`Status changed to ${STATUSES[key].label}`, 'success');
                                    } catch (err) {
                                      showToast('Failed to update status: ' + err.message, 'error');
                                    }
                                  }}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <button className="dropdown-clear compact" onClick={async () => {
                            try {
                              await deleteScheduleEntry(entry.id);
                              onScheduleRefresh();
                              showToast(`Cleared ${entry.job_name} on ${dropdown.date}`, 'success');
                              // Close dropdown if this was the last collision (now only 1 entry left)
                              if (existingEntries.length <= 2) setDropdown(null);
                            } catch (err) {
                              showToast('Failed to clear: ' + err.message, 'error');
                            }
                          }}>
                            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                            Clear
                          </button>
                        </div>
                      )}
                      {!isAdmin && USER_ALLOWED_STATUSES.includes(entry.status) && (
                        <div className="dropdown-collision-actions">
                          <button className="dropdown-clear compact" onClick={async () => {
                            try {
                              await deleteScheduleEntry(entry.id);
                              onScheduleRefresh();
                              showToast(`Cleared ${entry.job_name} on ${dropdown.date}`, 'success');
                              if (existingEntries.length <= 2) setDropdown(null);
                            } catch (err) {
                              showToast('Failed to clear: ' + err.message, 'error');
                            }
                          }}>
                            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                            Clear
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {isAdmin && (
                  <button className="dropdown-clear-all" onClick={() => handleClear(dropdown.memberId, dropdown.date)}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    Clear all assignments
                  </button>
                )}
              </div>
            ) : (
              /* ── Single entry: original behavior ── */
              <>
                <div className="dropdown-task-info">
                  <div className="dropdown-task-header">
                    <span className="dropdown-dot" style={{ background: existingEntry.job_color }}></span>
                    <div className="dropdown-task-details">
                      <span className="dropdown-task-name">{existingEntry.job_name}</span>
                      <span className="dropdown-task-code">{existingEntry.job_code}</span>
                    </div>
                  </div>
                  {existingEntry.job_description && (
                    <p className="dropdown-task-desc">{existingEntry.job_description}</p>
                  )}
                </div>
                {isAdmin && (
                  <div className="dropdown-notes-section">
                    <label className="dropdown-notes-label">Notes</label>
                    <textarea
                      className="dropdown-notes-input"
                      placeholder="Add a note for this day..."
                      defaultValue={existingEntry.notes || ''}
                      onBlur={async (e) => {
                        const newNotes = e.target.value;
                        if (newNotes !== (existingEntry.notes || '')) {
                          try {
                            await updateScheduleNotes(existingEntry.id, newNotes);
                            onScheduleRefresh();
                            showToast('Notes updated', 'success');
                          } catch (err) {
                            showToast('Failed to update notes: ' + err.message, 'error');
                          }
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          e.target.blur();
                        }
                      }}
                    />
                  </div>
                )}
                {existingEntry.job_file_url && (
                  <a
                    href={existingEntry.job_file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="dropdown-link-btn"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M6.5 3.5H3a1 1 0 00-1 1V13a1 1 0 001 1h8.5a1 1 0 001-1V9.5M9.5 2h4.5v4.5M14 2L7.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    More information
                  </a>
                )}
                {isAdmin && (
                  <div className="dropdown-footer">
                    <div className="status-picker">
                      <span className="status-picker-label">Status</span>
                      <div className="status-buttons">
                        {Object.entries(STATUSES).map(([key, { label, color }]) => {
                          const currentStatus = existingEntry.status || 'tentative';
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
                    <button className="dropdown-clear" onClick={() => handleClear(dropdown.memberId, dropdown.date)}>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                      Clear assignment
                    </button>
                  </div>
                )}
                {!isAdmin && USER_ALLOWED_STATUSES.includes(existingEntry.status) && (
                  <div className="dropdown-footer">
                    <button className="dropdown-clear" onClick={() => handleClear(dropdown.memberId, dropdown.date)}>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                      Clear assignment
                    </button>
                  </div>
                )}
              </>
            )
          ) : (
            /* ── Empty cell: show quick actions, search, job list ── */
            <>
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
              {isAdmin && (
                <>
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
                  <div className="dropdown-days-row">
                    <label className="dropdown-days-label">Days</label>
                    <div className="dropdown-days-control">
                      <button type="button" className="days-btn" onClick={() => setAssignDays(Math.max(1, assignDays - 1))}>−</button>
                      <input type="number" className="days-input" min="1" max="90" value={assignDays} onChange={(e) => setAssignDays(Math.max(1, parseInt(e.target.value) || 1))} />
                      <button type="button" className="days-btn" onClick={() => setAssignDays(assignDays + 1)}>+</button>
                    </div>
                    {assignDays > 1 && <span className="dropdown-days-hint">→ {assignDays} days from {dropdown.date}</span>}
                  </div>
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
                </>
              )}
            </>
          )}
        </div>
        );
      })()}

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
                {jobs.filter(j => isRealJob(j)).map(j => (
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
                  <label>Tagz.au Link</label>
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
