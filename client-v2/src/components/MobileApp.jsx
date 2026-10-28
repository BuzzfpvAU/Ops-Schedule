import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth.jsx';
import Login from './Login.jsx';
import EquipmentDetailsDrawer from './EquipmentDetailsDrawer.jsx';
import VocDrawer, { VocList, canRecordVocs } from './VocDrawer.jsx';
import { Drawer, Section, KV, DgIcon, Toasts } from './ui.jsx';
import {
  STATUSES, JOB_STATUSES, EQUIPMENT_CATEGORIES,
  getTeamMembers, getEquipment, getSchedule, getEquipmentLocations, getJobCard, getVocs,
} from '../api.js';
import { addDays, fmtShort, fmtLong, today as todayIso } from '../lib/dates.js';
import { makeMatcher } from '../lib/search.js';
import { runsFor, runWhen, kitStatus, kitOnMyJobs, ago, mapsUrl } from '../lib/fieldView.js';

// ── Phone layout ────────────────────────────────────────────────────
// What crew need in the field, one thumb's reach away: their own schedule
// (with the job's site, travel, crew and kit), and the equipment list with
// details, location and inspections. Planning stays on the full layout,
// which is one tap away under Me.

const BACK_DAYS = 30;     // keeps a job already under way whole
const FORWARD_DAYS = 90;

const TABS = [
  { key: 'schedule', label: 'My schedule', icon: 'M4 5h12v11H4zM4 8h12M8 3v4M12 3v4' },
  { key: 'kit', label: 'Equipment', icon: 'M3 6h6v8H3zM11 9h6v5h-6z' },
  { key: 'me', label: 'Me', icon: 'M10 9a3 3 0 100-6 3 3 0 000 6zM4 17c0-3.3 2.7-6 6-6s6 2.7 6 6' },
];

const dateSpan = (a, b) => (a === b ? fmtLong(a) : `${fmtShort(a)} – ${fmtShort(b)}`);
// "Tue 21 Oct 06:10" from a stored "2026-10-21T06:10" (local time, as typed).
const when = (s) => {
  if (!s) return '';
  const [d, t] = String(s).split(/[T ]/);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(d) ? fmtLong(d).replace(/ \d{4}$/, '') : d;
  return t ? `${day} ${t.slice(0, 5)}` : day;
};

// A site contact with a phone number in it gets a tap-to-call link.
function Contact({ text }) {
  const phone = String(text || '').match(/\+?\d[\d\s()-]{6,}\d/);
  if (!phone) return text || null;
  const [before, after] = text.split(phone[0]);
  return <>{before}<a href={`tel:${phone[0].replace(/[^\d+]/g, '')}`}>{phone[0]}</a>{after}</>;
}

export default function MobileApp({ layout }) {
  const { user, loading, logout } = useAuth();
  const [tab, setTab] = useState('schedule');
  const [members, setMembers] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [locations, setLocations] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [openJob, setOpenJob] = useState(null);
  const [openItem, setOpenItem] = useState(null);
  const today = todayIso();

  const showToast = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [m, e, s, l] = await Promise.all([
        getTeamMembers(), getEquipment(), getSchedule(addDays(today, -BACK_DAYS), addDays(today, FORWARD_DAYS)),
        getEquipmentLocations().catch(() => []),
      ]);
      setMembers(m);
      setEquipment(e);
      setSchedule(s);
      setLocations(l);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [today, showToast]);

  useEffect(() => { if (user) load(); }, [user, load]);

  const me = members.find((m) => m.id === user?.memberId);

  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!user) return <Login />;

  return (
    <div className="m-app">
      <header className="m-head">
        <span className="m-brand">Ops Schedule</span>
        {busy && <span className="rl-sub">Loading…</span>}
        <div className="appbar-spacer" />
        <button className="icon-btn" onClick={load} aria-label="Refresh" title="Refresh">↻</button>
      </header>

      <main className="m-body">
        {tab === 'schedule' && (
          <ScheduleTab
            user={user}
            schedule={schedule}
            today={today}
            onOpenJob={setOpenJob}
          />
        )}
        {tab === 'kit' && (
          <KitTab
            user={user}
            equipment={equipment}
            schedule={schedule}
            locations={locations}
            today={today}
            onOpenItem={setOpenItem}
          />
        )}
        {tab === 'me' && (
          <MeTab user={user} me={me} members={members} layout={layout} onLogout={logout} showToast={showToast} />
        )}
      </main>

      <nav className="m-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`m-tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d={t.icon} />
            </svg>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {openJob && (
        <JobSheet
          jobId={openJob}
          user={user}
          equipment={equipment}
          onClose={() => setOpenJob(null)}
          onOpenItem={setOpenItem}
        />
      )}

      {openItem && (
        <EquipmentDetailsDrawer
          key={openItem.id}
          item={openItem}
          isAdmin={!!user.isAdmin}
          myState={me?.location || null}
          onClose={() => setOpenItem(null)}
          onSaved={async () => { setOpenItem(null); await load(); showToast('Equipment updated', 'success'); }}
          onInspected={load}
          showToast={showToast}
        />
      )}

      <Toasts toasts={toasts} />
    </div>
  );
}

// ── My schedule ──

function ScheduleTab({ user, schedule, today, onOpenJob }) {
  const runs = useMemo(() => runsFor(schedule, user.memberId, today), [schedule, user.memberId, today]);

  if (user.isViewer) {
    return <div className="m-empty">The viewer account has no schedule of its own. Use Equipment, or the full layout under Me.</div>;
  }

  return (
    <>
      <div className="m-title">
        <h1>My schedule</h1>
        <span>{fmtLong(today)}</span>
      </div>
      {!runs.length && (
        <div className="m-empty">Nothing booked in the next {FORWARD_DAYS} days.</div>
      )}
      <div className="m-list">
        {runs.map((r) => {
          const status = STATUSES[r.status];
          const isJob = !['leave', 'toil', 'unavailable'].includes(r.status);
          return (
            <button key={r.key} className="m-card" style={{ '--job': r.job_color || '#475569' }} onClick={() => onOpenJob(r.job_id)}>
              <div className="m-card-top">
                <span className={`m-when${r.start <= today ? ' is-now' : ''}`}>{runWhen(r, today)}</span>
                <span className="m-dates">{dateSpan(r.start, r.end)}{r.days > 1 ? ` · ${r.days} days` : ''}</span>
              </div>
              <div className="m-card-name">
                {isJob && r.job_code && <span className="m-code">{r.job_code}</span>}
                {r.job_name}
              </div>
              {status && (
                <span className="m-status" style={{ color: status.color }}>● {status.label}</span>
              )}
              {r.notes.slice(0, 2).map((n) => (
                <div key={n.date} className="m-note">{fmtShort(n.date)}: {n.text}</div>
              ))}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ── Job sheet ──

function JobSheet({ jobId, user, equipment, onClose, onOpenItem }) {
  const [card, setCard] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getJobCard(jobId).then(setCard).catch((e) => setError(e.message));
  }, [jobId]);

  const job = card?.job;
  const mine = (rows) => rows.filter((r) => !r.person_id || r.person_id === user.memberId);
  const flights = card ? mine(card.flights) : [];
  const stays = card ? mine(card.accommodation) : [];
  const site = job && mapsUrl({ lat: job.site_lat, lng: job.site_lng, address: job.site_address });
  const status = job && JOB_STATUSES[job.status];

  return (
    <Drawer
      title={job ? `${job.code} · ${job.name}` : 'Job'}
      subtitle={job ? [job.client, job.roster_start && dateSpan(job.roster_start, job.roster_end)].filter(Boolean).join(' · ') : ''}
      onClose={onClose}
    >
      {error && <div className="banner banner-danger">{error}</div>}
      {!card && !error && <div className="m-empty">Loading…</div>}
      {job && (
        <>
          <Section title="Job">
            {status && <KV label="Status"><span style={{ color: status.color }}>● {status.label}</span></KV>}
            <KV label="Lead">{job.lead_name}</KV>
            <KV label="Job number">{job.job_number}</KV>
            <KV label="Site">
              {job.site_address
                ? (site ? <a href={site} target="_blank" rel="noopener noreferrer">{job.site_address} ↗</a> : job.site_address)
                : null}
            </KV>
            <KV label="Site contact">{job.site_contact ? <Contact text={job.site_contact} /> : null}</KV>
            {job.description && <div className="m-desc">{job.description}</div>}
            <div className="m-links">
              {job.file_url && <a className="btn" href={job.file_url} target="_blank" rel="noopener noreferrer">Job file ↗</a>}
              {job.sharepoint_url && <a className="btn" href={job.sharepoint_url} target="_blank" rel="noopener noreferrer">SharePoint ↗</a>}
            </div>
          </Section>

          {(flights.length > 0 || stays.length > 0) && (
            <Section title="My travel">
              {flights.map((f) => (
                <div key={f.id} className="m-row">
                  <div className="m-row-main">
                    <strong>{{ out: 'Out', return: 'Return' }[f.direction] || 'Flight'} · {[f.airline, f.flight_number].filter(Boolean).join(' ')}</strong>
                    <span>{f.depart_airport} {when(f.depart_at)} → {f.arrive_airport} {when(f.arrive_at)}</span>
                    {f.booking_ref && <span>Ref {f.booking_ref}</span>}
                  </div>
                </div>
              ))}
              {stays.map((a) => (
                <div key={a.id} className="m-row">
                  <div className="m-row-main">
                    <strong>{a.venue || 'Accommodation'}</strong>
                    {a.address && (
                      <a href={mapsUrl({ address: a.address })} target="_blank" rel="noopener noreferrer">{a.address} ↗</a>
                    )}
                    <span>{[a.check_in && `In ${fmtShort(a.check_in.slice(0, 10))}`, a.check_out && `out ${fmtShort(a.check_out.slice(0, 10))}`].filter(Boolean).join(', ')}</span>
                    {a.booking_ref && <span>Ref {a.booking_ref}</span>}
                  </div>
                </div>
              ))}
            </Section>
          )}

          {card.crew.length > 0 && (
            <Section title={`Crew · ${card.crew.length}`}>
              {card.crew.map((c) => (
                <div key={c.id} className="m-row">
                  <div className="m-row-main">
                    <strong>{c.name}{c.id === user.memberId ? ' (you)' : ''}</strong>
                    <span>{dateSpan(c.from_date, c.to_date)}</span>
                  </div>
                </div>
              ))}
            </Section>
          )}

          {card.equipment.length > 0 && (
            <Section title={`Kit · ${card.equipment.length}`}>
              {card.equipment.map((k) => {
                const item = equipment.find((e) => e.id === k.equipment_id);
                return (
                  <button key={k.id} className="m-row m-row-btn" onClick={() => item && onOpenItem(item)} disabled={!item}>
                    <div className="m-row-main">
                      <strong>{k.equipment_name} {item && <DgIcon item={item} />}</strong>
                      <span>{[k.category, k.serial_number].filter(Boolean).join(' · ')}</span>
                    </div>
                    {item?.serviceable === 0 && <span className="tag tag-danger">U/S</span>}
                    <span className="m-chev">›</span>
                  </button>
                );
              })}
            </Section>
          )}
        </>
      )}
    </Drawer>
  );
}

// ── Equipment ──

function KitTab({ user, equipment, schedule, locations, today, onOpenItem }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [onMine, setOnMine] = useState(false);

  const mineIds = useMemo(() => {
    const onMine = kitOnMyJobs(schedule, user.memberId, today);
    return new Set(equipment.filter((e) => onMine.has(e.id)).map((e) => e.id));
  }, [schedule, equipment, user.memberId, today]);
  const seen = useMemo(() => new Map(locations.filter((l) => l.seen_at).map((l) => [l.id, l])), [locations]);
  const categories = EQUIPMENT_CATEGORIES.filter((c) => equipment.some((e) => e.equipment_category === c));

  const match = makeMatcher(query);
  const shown = equipment
    .filter((e) => !category || e.equipment_category === category)
    .filter((e) => !onMine || mineIds.has(e.id))
    .filter((e) => match(e.name, e.serial_number, e.equipment_category, e.description, e.location))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="m-title"><h1>Equipment</h1><span>{shown.length} of {equipment.length}</span></div>
      <input
        className="m-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search name, serial, category…"
      />
      <div className="m-chips">
        {mineIds.size > 0 && (
          <button className={`chip${onMine ? ' is-active' : ''}`} onClick={() => setOnMine((v) => !v)}>On my jobs · {mineIds.size}</button>
        )}
        <button className={`chip${!category ? ' is-active' : ''}`} onClick={() => setCategory('')}>All</button>
        {categories.map((c) => (
          <button key={c} className={`chip${category === c ? ' is-active' : ''}`} onClick={() => setCategory(category === c ? '' : c)}>{c}</button>
        ))}
      </div>
      {!shown.length && <div className="m-empty">No equipment matches.</div>}
      <div className="m-list">
        {shown.map((e) => {
          const { now, next } = kitStatus(schedule, e.id, today);
          const loc = seen.get(e.id);
          const where = loc && mapsUrl({ lat: loc.lat, lng: loc.lng });
          return (
            <div key={e.id} className="m-card m-kit" onClick={() => onOpenItem(e)} role="button" tabIndex={0}
                 onKeyDown={(ev) => { if (ev.key === 'Enter') onOpenItem(e); }}>
              <div className="m-card-name">
                {e.name} <DgIcon item={e} />
                {e.serviceable === 0 && <span className="tag tag-danger">U/S</span>}
              </div>
              <div className="m-sub">{[e.equipment_category, e.serial_number, e.location].filter(Boolean).join(' · ')}</div>
              <div className="m-sub">
                {now
                  ? <>On <strong>{now.job_code || now.job_name}</strong> until {fmtShort(now.end)}</>
                  : next
                    ? <>Free · next <strong>{next.job_code || next.job_name}</strong> from {fmtShort(next.start)}</>
                    : 'Free'}
              </div>
              {where && (
                <a className="m-loc" href={where} target="_blank" rel="noopener noreferrer" onClick={(ev) => ev.stopPropagation()}>
                  📍 Seen {ago(loc.seen_at)} ↗
                </a>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Me ──

function MeTab({ user, me, members, layout, onLogout, showToast }) {
  const [vocs, setVocs] = useState(null);
  const [picking, setPicking] = useState(false);
  const [vocFor, setVocFor] = useState(null);
  useEffect(() => {
    if (user.isViewer) return;
    getVocs(user.memberId).then(setVocs).catch(() => setVocs([]));
  }, [user.memberId, user.isViewer]);
  return (
    <>
      <div className="m-title"><h1>{user.isViewer ? 'Viewer' : user.name}</h1></div>
      <Section title="Account">
        <KV label="Email">{user.email}</KV>
        <KV label="Role">{user.isAdmin ? 'Admin' : user.isViewer ? 'Viewer' : 'User'}</KV>
        <KV label="Home base">{me?.location}</KV>
      </Section>
      {canRecordVocs(user) && (
        <Section title="Validation of Competency">
          <button className="btn btn-primary m-wide" onClick={() => setPicking(true)}>Record a VOC</button>
        </Section>
      )}
      {vocs && (
        <Section title="My VOCs">
          <VocList vocs={vocs} isAdmin={false} />
        </Section>
      )}
      {picking && (
        <PersonPicker
          members={members.filter((m) => m.id !== user.memberId)}
          onClose={() => setPicking(false)}
          onPick={(m) => { setPicking(false); setVocFor(m); }}
        />
      )}
      {vocFor && (
        <VocDrawer
          member={vocFor}
          currentUser={user}
          onClose={() => setVocFor(null)}
          showToast={showToast}
        />
      )}
      <Section title="Layout">
        <p className="m-help">
          This phone layout opens automatically on small screens. The full
          layout has the planning timelines and every setting.
        </p>
        <button className="btn m-wide" onClick={() => layout.setChoice('full')}>Switch to full layout</button>
      </Section>
      <button className="btn btn-danger m-wide" onClick={onLogout}>Sign out</button>
    </>
  );
}

// Who the VOC is for: everyone but you, searchable by name, role or state.
function PersonPicker({ members, onClose, onPick }) {
  const [q, setQ] = useState('');
  const match = makeMatcher(q);
  const shown = members.filter((m) => match(m.name, m.role, m.location));
  return (
    <Drawer title="Record a VOC" subtitle="Who is being assessed?" onClose={onClose}>
      <input
        className="np-select m-search"
        type="search"
        placeholder="Search people…"
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="opt-list" style={{ marginTop: 10 }}>
        {shown.map((m) => (
          <button key={m.id} className="opt" onClick={() => onPick(m)}>
            <span className="opt-name">{m.name}</span>
            <span className="opt-hint">{[m.role, m.location].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
        {shown.length === 0 && <div className="rl-sub">Nobody matches.</div>}
      </div>
    </Drawer>
  );
}
