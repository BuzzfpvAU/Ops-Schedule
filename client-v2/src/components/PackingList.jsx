import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { getJobCard } from '../api.js';
import { today } from '../lib/dates.js';

// ── Equipment packing list ──────────────────────────────────────────────
//
// The load list sent to clients: company letterhead, then one "Line" per
// item of kit on the job with its serial, box size and weight, and what is
// packed in it. Opens in its own tab from the project page and prints to
// A4 (Print → Save as PDF to email it). Rev and date are typed in before
// printing; items can be left off without touching the job.

const BASE = import.meta.env.BASE_URL;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const fmtLetterDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

// "12 kg", "12.5kg", "12" → 12.5; anything unreadable → null.
const kgOf = (w) => {
  const m = String(w || '').replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(kg|g)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2]?.toLowerCase() === 'g' ? n / 1000 : n;
};

const fmtKg = (n) => `${Math.round(n * 10) / 10} kg`;

export default function PackingList({ jobId }) {
  const { user, loading } = useAuth();
  const [card, setCard] = useState(null);
  const [error, setError] = useState('');
  const [rev, setRev] = useState('1');
  const [date, setDate] = useState(today());
  const [left, setLeft] = useState(() => new Set()); // items left off

  useEffect(() => {
    if (!user) return;
    getJobCard(jobId).then(setCard).catch((e) => setError(e.message));
  }, [jobId, user]);

  const job = card?.job;
  useEffect(() => {
    if (job) document.title = `Packing list — ${job.job_number || job.code}`;
  }, [job]);

  const items = useMemo(
    () => (card?.equipment || []).filter((e) => !left.has(e.id)),
    [card, left]
  );

  const weights = items.map((e) => kgOf(e.weight));
  const knownKg = weights.filter((w) => w !== null).reduce((a, b) => a + b, 0);
  const missingWeight = weights.filter((w) => w === null).length;
  const incomplete = (card?.equipment || []).filter((e) => !e.dimensions || !e.weight || !e.contents);

  if (loading) return <div className="pl-status">Loading…</div>;
  if (!user) return <div className="pl-status">Sign in to Ops Schedule first, then reopen the packing list.</div>;
  if (error) return <div className="pl-status">{error}</div>;
  if (!card) return <div className="pl-status">Loading packing list…</div>;

  const toggle = (id) => setLeft((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="pl-screen">
      <div className="pl-tools no-print">
        <strong>Equipment packing list</strong>
        <label>Rev <input value={rev} onChange={(e) => setRev(e.target.value)} style={{ width: 48 }} /></label>
        <label>Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <button type="button" className="pl-print" onClick={() => window.print()}>Print / Save as PDF</button>
        <span className="pl-hint">
          {incomplete.length
            ? `${incomplete.length} item${incomplete.length === 1 ? ' is' : 's are'} missing a box size, weight or contents — fill them in under Equipment → Edit.`
            : 'Untick an item to leave it off this copy.'}
        </span>
      </div>

      <article className="pl-sheet">
        <header className="pl-head">
          <img className="pl-logo" src={`${BASE}letterhead/auav-logo.jpg`} alt="AUAV" />
          <address className="pl-addr">
            <div className="pl-co">Australian UAV Pty Ltd</div>
            <div>32/328 ReserveRoad, Cheltenham</div>
            <div>Victoria, Australia, 3192</div>
            <div><b>ABN:</b> 11 162 391 871</div>
            <div><b>E:</b> <a href="mailto:contact@auav.com.au">contact@auav.com.au</a></div>
            <div><a href="https://www.auav.com.au">www.auav.com.au</a></div>
          </address>
        </header>

        <p className="pl-date">{fmtLetterDate(date)}</p>
        <p className="pl-ref">
          Load list kit breakdown {job.job_number || job.code}{rev ? ` Rev: ${rev}` : ''}
        </p>
        <p className="pl-proj">{[job.name, job.client].filter(Boolean).join(' — ')}</p>

        {(card.equipment || []).length === 0 && (
          <p className="pl-empty">No equipment is assigned to this job yet.</p>
        )}

        {(() => {
          let n = 0;
          return (card.equipment || []).map((e) => {
            const off = left.has(e.id);
            if (!off) n += 1;
            const lines = String(e.contents || '').split('\n').map((l) => l.trim()).filter(Boolean);
            const box = [e.dimensions, e.weight].filter(Boolean).join(' · ');
            return (
              <section key={e.id} className={`pl-line${off ? ' is-off no-print' : ''}`}>
                <h2>
                  <input type="checkbox" className="no-print" checked={!off} onChange={() => toggle(e.id)}
                    title={off ? 'Put back on the list' : 'Leave off this copy'} />
                  {off ? e.equipment_name : `Line ${n}: ${e.equipment_name}`}
                </h2>
                {!off && (
                  <div className="pl-body">
                    {e.serial_number && <p>SN: {e.serial_number}</p>}
                    {box
                      ? <p>Box: {box}</p>
                      : <p className="pl-missing no-print">No box size or weight recorded</p>}
                    {lines.map((l, i) => <p key={i}>{l}</p>)}
                    {!lines.length && <p className="pl-missing no-print">No contents recorded</p>}
                  </div>
                )}
              </section>
            );
          });
        })()}

        {items.length > 0 && (
          <p className="pl-total">
            Total: {items.length} box{items.length === 1 ? '' : 'es'}
            {knownKg > 0 && ` · ${fmtKg(knownKg)}`}
            {missingWeight > 0 && knownKg > 0 && (
              <span className="pl-total-note"> (excludes {missingWeight} without a recorded weight)</span>
            )}
          </p>
        )}

        <img className="pl-watermark" src={`${BASE}letterhead/auav-watermark.png`} alt="" aria-hidden="true" />
      </article>
    </div>
  );
}
