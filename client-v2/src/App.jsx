import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  ZOOMS, ZOOM_ORDER, rangeOf, addDays, today as todayIso, fmtRange,
  initialWindow, extendWindow, clampColW, zoomIn, zoomOut, labelModeFor,
  MIN_COL_W, MAX_COL_W,
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
  // Density and date range are independent: zooming changes how wide a day is
  // and nothing else, and the window grows as you scroll rather than being
  // whatever the zoom level implied.
  const [colW, setColW] = useState(ZOOMS.day.colW);
  const [win, setWin] = useState(() => initialWindow(todayIso()));
  // A counter, because pressing Today or a paging arrow may not change any
  // other state and still has to move the timeline.
  const [scrollCmd, setScrollCmd] = useState({ nonce: 0, type: null, dir: 0 });

  const [members, setMembers] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);

  // The signed-in user's home state. Derived once here so all three views
  // lead with the same region rather than each working it out separately.
  const myState = useMemo(() => {
    const me = members.find((m) => m.id === user?.memberId);
    return me?.location || null;
  }, [members, user]);

  const zoom = useMemo(
    () => ({ colW, dayLabels: labelModeFor(colW) }),
    [colW]
  );
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

  // What has already been fetched. The window only ever grows, so a scroll to
  // the edge needs the new slice, not the whole range again.
  const loadedRef = useRef(null);

  const loadWindowFull = useCallback(async (start, end) => {
    const [s, b] = await Promise.all([
      getSchedule(start, end),
      getEquipmentBookings(start, end).catch(() => []),
    ]);
    setSchedule(s);
    setBookings(b);
    loadedRef.current = { start, end };
  }, []);

  useEffect(() => {
    if (!user) return;
    setBusy(true);
    loadReference()
      .catch((e) => showToast(e.message, 'error'))
      .finally(() => setBusy(false));
  }, [user, loadReference, showToast]);

  // Fetch whatever part of the window is not loaded yet, and merge. On the
  // first pass that is the whole window; after a scroll it is only the slice
  // that just appeared.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const prev = loadedRef.current;

    const gaps = [];
    if (!prev) {
      gaps.push([win.start, win.end]);
    } else {
      if (win.start < prev.start) gaps.push([win.start, addDays(prev.start, -1)]);
      if (win.end > prev.end) gaps.push([addDays(prev.end, 1), win.end]);
    }
    if (!gaps.length) return undefined;

    loadedRef.current = {
      start: prev && prev.start < win.start ? prev.start : win.start,
      end: prev && prev.end > win.end ? prev.end : win.end,
    };

    setBusy(true);
    (async () => {
      try {
        const chunks = await Promise.all(gaps.map(([a, b]) => getSchedule(a, b)));
        if (!alive) return;
        const added = chunks.flat();
        // Bookings cover the whole window and the list is small, so it is
        // simpler to replace than to reconcile ids across merges.
        const b = await getEquipmentBookings(win.start, win.end).catch(() => []);
        if (!alive) return;
        setSchedule((cur) => [...cur, ...added]);
        setBookings(b);
      } catch (e) {
        if (alive) showToast(e.message, 'error');
      } finally {
        if (alive) setBusy(false);
      }
    })();

    return () => { alive = false; };
  }, [user, win.start, win.end, showToast]);

  // After a write both the window data and the roll-ups on jobs can change,
  // so this replaces rather than merges.
  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadReference(), loadWindowFull(win.start, win.end)]);
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, [loadReference, loadWindowFull, win.start, win.end, showToast]);

  // Reaching either edge grows the window; the timeline keeps its position.
  const extendingRef = useRef(false);
  const onReachEdge = useCallback((dir) => {
    if (extendingRef.current) return;
    extendingRef.current = true;
    setWin((w) => extendWindow(w, dir, todayIso()));
    // Released on the next frame so one scroll gesture cannot queue a dozen
    // extensions before the first has rendered.
    setTimeout(() => { extendingRef.current = false; }, 250);
  }, []);

  const scroll = (type, dir = 0) =>
    setScrollCmd((c) => ({ nonce: c.nonce + 1, type, dir }));

  const setZoom = (next) => setColW(clampColW(next));

  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!user) return <Login />;

  const common = { days, zoom, labelWidth, myState, scrollCmd, onReachEdge, showToast, onChanged: refresh };

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
          <button onClick={() => scroll('page', -1)} title="Scroll back">‹</button>
          <button onClick={() => scroll('today')} title="Scroll so today is the first column">Today</button>
          <button onClick={() => scroll('page', 1)} title="Scroll forward">›</button>
        </div>

        <span className="rl-sub">{fmtRange(win.start, win.end)}</span>

        <div className="toolbar-spacer" />

        <div className="tgroup">
          <button
            onClick={() => setZoom(zoomOut(colW))}
            disabled={colW <= MIN_COL_W}
            title="Show more time"
            aria-label="Zoom out"
          >
            −
          </button>
          {ZOOM_ORDER.map((k) => (
            <button
              key={k}
              className={colW === ZOOMS[k].colW ? 'is-active' : ''}
              onClick={() => setZoom(ZOOMS[k].colW)}
              title={`${ZOOMS[k].label} — ${ZOOMS[k].colW}px per day`}
            >
              {ZOOMS[k].label}
            </button>
          ))}
          <button
            onClick={() => setZoom(zoomIn(colW))}
            disabled={colW >= MAX_COL_W}
            title="Show more detail"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
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
