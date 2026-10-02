import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtShort } from '../lib/dates.js';

// Project notes, shown beside the job card. An entry is either standalone
// (about the project as a whole) or linked to a timeline cell — a crew or
// equipment row on a particular day — in which case it also shows as a short
// snippet on that day of the timeline. The log only ever appends, so a
// movement keeps its history: dispatched one day, arrived the next.

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'standalone', label: 'Standalone' },
  { key: 'linked', label: 'Linked' },
];

export default function NotesPanel({
  notes, rows, link, onLinkChange, focusTick, onAdd, onRemove, isViewer, busy,
}) {
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('all');
  const inputRef = useRef(null);

  // Clicking a cell on the timeline hands us a link; put the cursor in the box
  // so the note can be typed straight away.
  useEffect(() => {
    if (focusTick) inputRef.current?.focus();
  }, [focusTick]);

  const rowName = useMemo(() => new Map(rows.map((r) => [r.id, r.name])), [rows]);

  const shown = useMemo(() => {
    const list = notes.filter((n) => (
      filter === 'all' || (filter === 'linked' ? !!n.entity_id : !n.entity_id)
    ));
    // Newest first: the panel is a feed, the timeline carries the dates.
    return [...list].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }, [notes, filter]);

  const submit = async () => {
    if (!draft.trim() || busy) return;
    const ok = await onAdd(draft.trim(), link);
    if (ok) setDraft('');
  };

  const isFocused = (n) => !!link && n.entity_id === link.rowId && n.date === link.date;

  return (
    <div className="np">
      <div className="np-filters" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className={`np-filter${filter === f.key ? ' is-active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!isViewer && (
        <div className="np-compose">
          <textarea
            ref={inputRef}
            className="note-input"
            placeholder={link ? 'e.g. Dispatched to KTA, tracking 12345' : 'Add a project note…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
            }}
          />
          <div className="np-link">
            <select
              className="np-select"
              value={link?.rowId || ''}
              onChange={(e) => {
                const rowId = e.target.value;
                onLinkChange(rowId ? { rowId, date: link?.date || '' } : null);
              }}
              aria-label="Link this note to a row on the timeline"
            >
              <option value="">Standalone (not on timeline)</option>
              {rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {link && (
              <input
                type="date"
                className="np-date"
                value={link.date}
                onChange={(e) => onLinkChange({ ...link, date: e.target.value })}
                aria-label="Day on the timeline"
              />
            )}
          </div>
          <div className="np-actions">
            <button
              className="btn btn-primary"
              disabled={busy || !draft.trim() || (link && !link.date)}
              onClick={submit}
            >
              Add note
            </button>
            <span className="rl-sub">⌘/Ctrl + Enter</span>
          </div>
        </div>
      )}
      {isViewer && <div className="banner banner-warn" style={{ margin: 10 }}>Viewers cannot add notes.</div>}

      <div className="np-list">
        {shown.length === 0 && (
          <div className="np-empty">
            {notes.length === 0
              ? 'No notes yet. Click a day on the timeline to add one against it, or write a standalone note above.'
              : 'Nothing in this filter.'}
          </div>
        )}
        {shown.map((n) => (
          <div className={`log-entry${isFocused(n) ? ' is-focused' : ''}${n.entity_id ? '' : ' is-standalone'}`} key={n.id}>
            {n.entity_id && (
              <button
                type="button"
                className="np-chip"
                title="Link the composer to this day"
                onClick={() => onLinkChange({ rowId: n.entity_id, date: n.date })}
              >
                {n.entity_name || rowName.get(n.entity_id) || 'Unknown'} · {fmtShort(n.date)}
              </button>
            )}
            <div className="log-text">{n.text}</div>
            <div className="log-meta">
              <span>{n.author_name || 'unknown'} · {(n.created_at || '').slice(0, 16)}</span>
              {!isViewer && (
                <button className="btn btn-danger" disabled={busy} onClick={() => onRemove(n.id)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
