import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from './context/AuthContext.jsx';
import LoginPage from './components/LoginPage.jsx';
import SetupPage from './components/SetupPage.jsx';
import ForgotPassword from './components/ForgotPassword.jsx';
import ResetPassword from './components/ResetPassword.jsx';
import ChangePassword from './components/ChangePassword.jsx';
import ScheduleGrid from './components/ScheduleGrid.jsx';
import TeamManager from './components/TeamManager.jsx';
import JobManager from './components/JobManager.jsx';
import EquipmentManager from './components/EquipmentManager.jsx';
import Toast from './components/Toast.jsx';
import NotificationBell from './components/NotificationBell.jsx';
import { getTeamMembers, getEquipment, getJobs, getSchedule, downloadIcalMember, seedDatabase, getSeedStatus } from './api.js';
import { getWeekDates, formatDateRange } from './utils/dates.js';

export default function App() {
  const { user, loading, needsSetup, logout } = useAuth();
  const [authView, setAuthView] = useState('login');

  const [activeTab, setActiveTab] = useState('schedule');
  const [teamMembers, setTeamMembers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [equipmentList, setEquipmentList] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [exportModal, setExportModal] = useState(null);

  const weekDates = getWeekDates(weekOffset);

  // Check for reset token in URL
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('token');

  const currentUser = teamMembers.find(m => m.id === user?.memberId);

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
    } catch (err) {
      showToast('Failed to load data: ' + err.message, 'error');
    }
  }, [showToast]);

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
    if (!user) return;
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
  }, [user]);
  useEffect(() => { if (user) loadSchedule(); }, [weekOffset, user]);

  const refreshAll = () => {
    loadData();
    loadSchedule();
  };

  // Auth gates - AFTER all hooks to satisfy Rules of Hooks
  if (loading) return <div className="loading-screen">Loading...</div>;
  if (resetToken) return <ResetPassword token={resetToken} onDone={() => { window.history.replaceState({}, '', '/'); setAuthView('login'); }} />;
  if (needsSetup) return <SetupPage />;
  if (!user) {
    if (authView === 'forgot') return <ForgotPassword onBack={() => setAuthView('login')} />;
    return <LoginPage onForgotPassword={() => setAuthView('forgot')} />;
  }
  if (user.mustChangePassword) return <ChangePassword forced onDone={() => window.location.reload()} />;

  return (
    <div className="app">
      <header className="header">
        <h1>Ops Schedule</h1>
        <div className="header-actions">
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
          <div className="user-info">
            <span className="user-name">{user.name}</span>
            <span className={`role-badge ${user.isAdmin ? 'admin' : 'user'}`}>
              {user.isAdmin ? 'Admin' : 'User'}
            </span>
            <button className="logout-btn" onClick={logout} title="Sign out">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M11 11l3-3-3-3M14 8H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
        </div>
      </header>

      <nav className="nav-tabs">
        <button className={`nav-tab ${activeTab === 'schedule' ? 'active' : ''}`} onClick={() => setActiveTab('schedule')}>Schedule</button>
        {user.isAdmin && (
          <>
            <button className={`nav-tab ${activeTab === 'jobs' ? 'active' : ''}`} onClick={() => setActiveTab('jobs')}>Jobs / Projects</button>
            <button className={`nav-tab ${activeTab === 'team' ? 'active' : ''}`} onClick={() => setActiveTab('team')}>Team</button>
            <button className={`nav-tab ${activeTab === 'equipment' ? 'active' : ''}`} onClick={() => setActiveTab('equipment')}>Equipment</button>
          </>
        )}
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
        {activeTab === 'jobs' && user.isAdmin && (
          <JobManager jobs={jobs} onRefresh={loadData} showToast={showToast} />
        )}
        {activeTab === 'equipment' && user.isAdmin && (
          <EquipmentManager equipment={equipmentList} onRefresh={loadData} showToast={showToast} />
        )}
        {activeTab === 'team' && user.isAdmin && (
          <TeamManager members={teamMembers} equipment={equipmentList} onRefresh={loadData} showToast={showToast} />
        )}
      </main>

      <Toast toasts={toasts} />

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
