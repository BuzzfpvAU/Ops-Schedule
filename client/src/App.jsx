import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import PasskeyManager from './components/PasskeyManager.jsx';
import { getTeamMembers, getEquipment, getJobs, getSchedule, downloadIcalMember, seedDatabase, getSeedStatus } from './api.js';
import { generateDateRange, getInitialDateRange, extendDateRange } from './utils/dates.js';

// Parse reset token once, outside component
const initialResetToken = new URLSearchParams(window.location.search).get('token');

export default function App() {
  const { user, loading, needsSetup, logout } = useAuth();
  const [authView, setAuthView] = useState('login');

  const [activeTab, setActiveTab] = useState('schedule');
  const [teamMembers, setTeamMembers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [equipmentList, setEquipmentList] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [exportModal, setExportModal] = useState(null);
  const [showPasskeys, setShowPasskeys] = useState(false);
  const [resetToken, setResetToken] = useState(initialResetToken);

  // Date range state for infinite scroll
  const initialRange = useMemo(() => getInitialDateRange(), []);
  const [dateRange, setDateRange] = useState(initialRange);
  const loadingRef = useRef(false);

  // Generate date objects from the current range
  const allDates = useMemo(
    () => generateDateRange(dateRange.startDate, dateRange.endDate),
    [dateRange.startDate, dateRange.endDate]
  );

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

  // Load schedule for a date range, optionally merging with existing data
  const loadScheduleRange = useCallback(async (start, end, merge = false) => {
    try {
      const entries = await getSchedule(start, end);
      if (merge) {
        setSchedule(prev => {
          // Remove entries in the fetched range, then add new ones
          const startD = new Date(start);
          const endD = new Date(end);
          const filtered = prev.filter(e => {
            const d = new Date(e.date);
            return d < startD || d > endD;
          });
          return [...filtered, ...entries];
        });
      } else {
        setSchedule(entries);
      }
    } catch (err) {
      showToast('Failed to load schedule: ' + err.message, 'error');
    }
  }, [showToast]);

  // Load more dates when scrolling to edges
  const loadMore = useCallback(async (direction) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const ext = extendDateRange(dateRange.startDate, dateRange.endDate, direction, 14);
      // Fetch schedule for the new dates only, then merge
      await loadScheduleRange(ext.startDate, ext.endDate, true);
      setDateRange({ startDate: ext.rangeStart, endDate: ext.rangeEnd });
    } finally {
      loadingRef.current = false;
    }
  }, [dateRange, loadScheduleRange]);

  // Load everything in parallel on login
  useEffect(() => {
    if (!user) return;
    (async () => {
      const [seedResult] = await Promise.allSettled([
        getSeedStatus().then(async (status) => {
          if (status.empty) {
            await seedDatabase();
            showToast('Sample data loaded', 'success');
          }
        }),
        loadData(),
        loadScheduleRange(dateRange.startDate, dateRange.endDate),
      ]);
    })();
  }, [user]);

  // Refresh just the current schedule range
  const refreshSchedule = useCallback(() => {
    loadScheduleRange(dateRange.startDate, dateRange.endDate);
  }, [loadScheduleRange, dateRange]);

  const refreshAll = useCallback(() => {
    loadData();
    loadScheduleRange(dateRange.startDate, dateRange.endDate);
  }, [loadData, loadScheduleRange, dateRange]);

  // Reset to today's range
  const scrollToToday = useCallback(() => {
    const newRange = getInitialDateRange();
    setDateRange(newRange);
    loadScheduleRange(newRange.startDate, newRange.endDate);
  }, [loadScheduleRange]);

  // Auth gates - AFTER all hooks to satisfy Rules of Hooks
  if (loading) return <div className="loading-screen">Loading...</div>;
  if (resetToken) return <ResetPassword token={resetToken} onDone={() => { window.history.replaceState({}, '', '/'); setResetToken(null); setAuthView('login'); }} />;
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
            <button className="passkey-btn" onClick={() => setShowPasskeys(true)} title="Manage passkeys">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            </button>
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
            allDates={allDates}
            onLoadMore={loadMore}
            onScrollToToday={scrollToToday}
            onRefresh={refreshAll}
            onScheduleRefresh={refreshSchedule}
            showToast={showToast}
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

      {showPasskeys && (
        <PasskeyManager onClose={() => setShowPasskeys(false)} showToast={showToast} />
      )}

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
