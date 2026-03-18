import React, { useState, useEffect, useCallback } from 'react';
import ScheduleGrid from './components/ScheduleGrid.jsx';
import TeamManager from './components/TeamManager.jsx';
import JobManager from './components/JobManager.jsx';
import Toast from './components/Toast.jsx';
import NotificationBell from './components/NotificationBell.jsx';
import { getTeamMembers, getJobs, getSchedule } from './api.js';
import { getWeekDates, formatDateRange } from './utils/dates.js';

export default function App() {
  const [activeTab, setActiveTab] = useState('schedule');
  const [teamMembers, setTeamMembers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);

  const weekDates = getWeekDates(weekOffset);

  const showToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [members, jobList] = await Promise.all([getTeamMembers(), getJobs()]);
      setTeamMembers(members);
      setJobs(jobList);

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

  useEffect(() => { loadData(); }, []);
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
          {currentUser && <NotificationBell memberId={currentUser.id} />}
        </div>
      </header>

      <nav className="nav-tabs">
        {['schedule', 'jobs', 'team'].map(tab => (
          <button
            key={tab}
            className={`nav-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'schedule' ? 'Schedule' : tab === 'jobs' ? 'Jobs / Projects' : 'Team'}
          </button>
        ))}
      </nav>

      <main className="main-content">
        {activeTab === 'schedule' && (
          <ScheduleGrid
            teamMembers={teamMembers}
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
        {activeTab === 'team' && (
          <TeamManager members={teamMembers} onRefresh={loadData} showToast={showToast} />
        )}
      </main>

      <Toast toasts={toasts} />
    </div>
  );
}
