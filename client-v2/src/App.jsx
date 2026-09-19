import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth.jsx';
import Login from './components/Login.jsx';
import ProjectsView from './components/ProjectsView.jsx';
import EquipmentView from './components/EquipmentView.jsx';
import TeamView from './components/TeamView.jsx';
import { ButtonGroup, Toasts } from './components/ui.jsx';
import useLabelWidth from './lib/useLabelWidth.js';
import {
  getTeamMembers, getEquipment, getJobs, getSchedule, getEquipmentBookings,
} from './api.js';
import {
  ZOOMS, ZOOM_ORDER, windowFor, rangeOf, addDays, today as todayIso, fmtRange,
} from './lib/dates.js';

const VIEWS = [
  { key: 'projects', label: 'Projects', icon: 'M3 5h13M3 10h9M3 15h6' },
  { key: 'equipment', label: 'Equipment', icon: 'M3 6h6v8H3zM11 9h6v5h-6z' },
  { key: 'team', label: 'Team', icon: 'M7 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM2 16c0-2.8 2.2-5 5-5s5 2.2 5 5M14 16c0-2.2-1-4-2.5-5' },
];

export default function App() {
  const { user, loading, logout } = useAuth();
  const labelWidth = useLabelWidth();

  const [view, setView] = useState('projects');
  const [zoomKey, setZoomKey] = useState('day');
  const [anchor, setAnchor] = useState(() => todayIso());

  const [members, setMembers] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);

  const zoom = ZOOMS[zoomKey];
  const win = useMemo(() => windowFor(zoomKey, anchor), [zoomKey, anchor]);
  const days = useMemo(() => rangeOf(win.start, win.end), [win.start, win.end]);

  const showToast = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  // Reference data — changes rarely, loaded once per session and after edits.
  const loadReference = useCallback(async () => {
    const [m, e, j] = await Promise.all([getTeamMembers(), getEquipment(), getJobs()]);
    setMembers(m);
    setEquipment(e);
    setJobs(j);
  }, []);

  // Window data — refetched whenever the visible date range moves.
  const loadWindow = useCallback(async (start, end) => {
    const [s, b] = await Promise.all([
      getSchedule(start, end),
      getEquipmentBookings(start, end).catch(() => []),
    ]);
    setSchedule(s);
    setBookings(b);
  }, []);

  useEffect(() => {
    if (!user) return;
    setBusy(true);
    loadReference()
      .catch((e) => showToast(e.message, 'error'))
      .finally(() => setBusy(false));
  }, [user, loadReference, showToast]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    setBusy(true);
    loadWindow(win.start, win.end)
      .catch((e) => { if (alive) showToast(e.message, 'error'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [user, win.start, win.end, loadWindow, showToast]);

  // After a write, both the window and the roll-ups on jobs can change.
  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadReference(), loadWindow(win.start, win.end)]);
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, [loadReference, loadWindow, win.start, win.end, showToast]);

  // Paging moves the anchor by a third of the window, which keeps enough
  // context on screen to follow a long project across a page turn.
  const page = (dir) => {
    const stride = Math.max(7, Math.round((ZOOMS[zoomKey].before + ZOOMS[zoomKey].after) / 3));
    setAnchor((a) => addDays(a, dir * stride));
  };

  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!user) return <Login />;

  const common = { days, zoom, labelWidth, showToast, onChanged: refresh };

  return (
    <div className="app">
      <header className="appbar">
        <div className="brand">
          Ops Schedule <span className="v2">V2</span>
        </div>
        <div className="appbar-spacer" />
        {busy && <span className="rl-sub">Loading…</span>}
        <div className="appbar-user">
          <span className="user-name">{user.isViewer ? 'Viewer' : user.name}</span>
          <span className={`role-chip${user.isAdmin ? ' admin' : ''}`}>
            {user.isAdmin ? 'Admin' : user.isViewer ? 'Viewer' : 'User'}
          </span>
        </div>
        <a className="icon-btn" href="/" title="Back to the classic UI" style={{ textDecoration: 'none' }}>↩</a>
        <button className="icon-btn" onClick={logout} title="Sign out">⏻</button>
      </header>

      <nav className="tabs">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            className={`tab${view === v.key ? ' is-active' : ''}`}
            onClick={() => setView(v.key)}
          >
            <svg width="16" height="16" viewBox="0 0 19 19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d={v.icon} />
            </svg>
            <span className="tab-text">{v.label}</span>
          </button>
        ))}
      </nav>

      <div className="toolbar">
        <div className="tgroup">
          <button onClick={() => page(-1)} title="Earlier">‹</button>
          <button onClick={() => setAnchor(todayIso())} title="Jump back to today">Today</button>
          <button onClick={() => page(1)} title="Later">›</button>
        </div>

        <span className="rl-sub">{fmtRange(win.start, win.end)}</span>

        <div className="toolbar-spacer" />

        <ButtonGroup
          value={zoomKey}
          onChange={setZoomKey}
          options={ZOOM_ORDER.map((k) => ({
            value: k,
            label: ZOOMS[k].label,
            title: `${ZOOMS[k].label} scale — ${ZOOMS[k].colW}px per day`,
          }))}
        />
      </div>

      {view === 'projects' && (
        <ProjectsView jobs={jobs} schedule={schedule} {...common} />
      )}
      {view === 'equipment' && (
        <EquipmentView
          equipment={equipment}
          schedule={schedule}
          bookings={bookings}
          isAdmin={!!user.isAdmin}
          {...common}
        />
      )}
      {view === 'team' && (
        <TeamView
          members={members}
          jobs={jobs}
          schedule={schedule}
          currentUser={user}
          {...common}
        />
      )}

      <Toasts toasts={toasts} />
    </div>
  );
}
