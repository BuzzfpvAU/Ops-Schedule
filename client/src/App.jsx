import React, { useState, useEffect, useCallback } from 'react';
import ScheduleGrid from './components/ScheduleGrid.jsx';
import TeamManager from './components/TeamManager.jsx';
import JobManager from './components/JobManager.jsx';
import EquipmentManager from './components/EquipmentManager.jsx';
import Toast from './components/Toast.jsx';
import NotificationBell from './components/NotificationBell.jsx';
import { getTeamMembers, getEquipment, getJobs, getSchedule, downloadIcalMember, seedDatabase, getSeedStatus } from './api.js';
import { getWeekDates, formatDateRange } from './utils/dates.js';

export default function App() {
  const [activeTab, setActiveTab] = useState('schedule');
  const [teamMembers, setTeamMembers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [equipmentList, setEquipmentList] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [exportModal, setExportModal] = useState(null);

  const weekDates = getWeekDates(weekOffset);

  const showToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [members, jobList, equip] = await Promise.all([getTeamMembers(), getJobs(), getEquipment()]);
      setTeamMembers(members);
      setJobs(jobList);
      setEquipmentList(equip);

      // Set current user to first member if not set
      if (!currentUser && members.length > 0) {
        setCurrentUser(members[0]);
      }
    } catch (err) {
      showToast('Failed to load data: ' + err.message, 'error');
    }
  }, [currentUser, showToast]);

  const loadSchedule = useCallback(async () => {
    try {
      const dates = weekDates;
      const start = dates[0].dateStr;
      const end = dates[dates.length - 1].dateStr;
      const entries = await getSchedule(start, end);
      setSchedule(entries);
    } catch (err) {
      showToast('Failed to load schedule: ' + err.message, 'error');
    }
  }, [weekDates, showToast]);

  useEffect(() => {
    // Auto-seed on first load if database is empty
    (async () => {
      try {
        const status = await getSeedStatus();
        if (status.empty) {
          await seedDatabase();
          showToast('Sample data loaded', 'success');
        }
      } catch (err) {
        console.warn('Seed check failed:', err.message);
      }
      loadData();
    })();
  }, []);
  useEffect(() => { loadSchedule(); }, [weekOffset]);

  const refreshAll = () => {
    loadData();
    loadSchedule();
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Ops Schedule</h1>
        <div className="header-actions">
          {currentUser && (
            <select
              value={currentUser?.id || ''}
              onChange={(e) => {
                const member = teamMembers.find(m => m.id === e.target.value);
                setCurrentUser(member);
              }}
              style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #475569', background: '#334155', color: 'white', fontSize: 13 }}
            >
              {teamMembers.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )}
          {currentUser && (
            <button
              className="header-export-btn"
              title="Download my calendar"
              onClick={() => {
                const today = new Date();
                const monthLater = new Date(today);
                monthLater.setDate(today.getDate() + 30);
                setExportModal({
                  startDate: today.toISOString().slice(0, 10),
                  endDate: monthLater.toISOString().slice(0, 10),
                });
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M2 6.5h12" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M5 1.5v3M11 1.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <path d="M8 9v3M6.5 10.5l1.5 1.5 1.5-1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          {currentUser && <NotificationBell memberId={currentUser.id} />}
        </div>
      </header>

      <nav className="nav-tabs">
        {['schedule', 'jobs', 'team', 'equipment'].map(tab => (
          <button
            key={tab}
            className={`nav-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'schedule' ? 'Schedule' : tab === 'jobs' ? 'Jobs / Projects' : tab === 'equipment' ? 'Equipment' : 'Team'}
          </button>
        ))}
      </nav>

      <main className="main-content">
        {activeTab === 'schedule' && (
          <ScheduleGrid
            teamMembers={teamMembers}
            equipment={equipmentList}
            jobs={jobs}
            schedule={schedule}
            weekDates={weekDates}
            weekOffset={weekOffset}
            onWeekChange={setWeekOffset}
            onRefresh={refreshAll}
            showToast={showToast}
            dateRangeLabel={formatDateRange(weekDates)}
          />
        )}
        {activeTab === 'jobs' && (
          <JobManager jobs={jobs} onRefresh={loadData} showToast={showToast} />
        )}
        {activeTab === 'equipment' && (
          <EquipmentManager equipment={equipmentList} onRefresh={loadData} showToast={showToast} />
        )}
        {activeTab === 'team' && (
          <TeamManager members={teamMembers} equipment={equipmentList} onRefresh={loadData} showToast={showToast} />
        )}
      </main>

      <Toast toasts={toasts} />

      {/* Export calendar modal */}
      {exportModal && currentUser && (
        <div className="modal-overlay" onClick={() => setExportModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Download My Calendar</h2>
            <p className="modal-subtitle">
              Export schedule for {currentUser.name} as an iCal file
            </p>

            <div className="form-row">
              <div className="form-group">
                <label>From</label>
                <input
                  type="date"
                  value={exportModal.startDate}
                  onChange={(e) => setExportModal({ ...exportModal, startDate: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>To</label>
                <input
                  type="date"
                  value={exportModal.endDate}
                  onChange={(e) => setExportModal({ ...exportModal, endDate: e.target.value })}
                />
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => setExportModal(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    await downloadIcalMember(currentUser.id, exportModal.startDate, exportModal.endDate);
                    showToast('Calendar downloaded', 'success');
                    setExportModal(null);
                  } catch (err) {
                    showToast('Export failed: ' + err.message, 'error');
                  }
                }}
              >
                Download .ics
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
