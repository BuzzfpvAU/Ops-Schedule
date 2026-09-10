import React, { useState, useEffect, useRef } from 'react';
import { quickScheduleEntry, deleteScheduleEntry, createNotification, STATUSES } from '../api.js';
import { canDeleteEntry } from '../utils/individualSchedule.js';

const QUICK_STATUSES = ['toil', 'leave', 'unavailable'];

// Bottom sheet for one day: add a note or a status, remove your own entries.
export default function DayActionSheet({ date, entries, member, user, onClose, onChanged, showToast }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const noteInputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (noteOpen) noteInputRef.current?.focus();
  }, [noteOpen]);

  const label = date.date.toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  const notify = (message) => {
    createNotification({
      team_member_id: member.id,
      type: 'assigned',
      message,
      date: date.dateStr,
    }).catch(() => {});
  };

  const submit = async (status, text) => {
    if (busy) return;
    setBusy(true);
    try {
      await quickScheduleEntry({
        date: date.dateStr,
        status,
        text,
        team_member_id: member.id,
      });
      notify(status === 'note'
        ? `Note added for ${date.dateStr}: ${text}`
        : `Marked as ${STATUSES[status].label} on ${date.dateStr}`);
      onChanged();
      showToast(status === 'note' ? 'Note added' : `Marked as ${STATUSES[status].label}`, 'success');
      onClose();
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry) => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteScheduleEntry(entry.id);
      onChanged();
      showToast('Entry removed', 'success');
      onClose();
    } catch (err) {
      showToast('Failed to remove: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removable = entries.filter(e => canDeleteEntry(user, e));

  return (
    <div className="ind-sheet-overlay" onClick={onClose}>
      <div className="ind-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Actions for ${label}`}>
        <div className="ind-sheet-grip" />
        <div className="ind-sheet-header">
          <div>
            <div className="ind-sheet-title">{label}</div>
            <div className="ind-sheet-sub">{member.name}</div>
          </div>
          <button className="ind-sheet-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        {noteOpen ? (
          <form
            className="ind-sheet-note"
            onSubmit={(e) => { e.preventDefault(); if (noteText.trim()) submit('note', noteText.trim()); }}
          >
            <input
              ref={noteInputRef}
              type="text"
              value={noteText}
              placeholder="Site induction, CASA paperwork…"
              onChange={(e) => setNoteText(e.target.value)}
              maxLength={80}
            />
            <div className="ind-sheet-note-actions">
              <button type="button" className="btn" onClick={() => setNoteOpen(false)}>Back</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !noteText.trim()}>Add note</button>
            </div>
          </form>
        ) : (
          <div className="ind-sheet-actions">
            <button className="ind-action ind-action-note" onClick={() => setNoteOpen(true)} disabled={busy}>
              Add note
            </button>
            {QUICK_STATUSES.map(status => (
              <button
                key={status}
                className={`ind-action ind-action-${status}`}
                onClick={() => submit(status)}
                disabled={busy}
              >
                {STATUSES[status].label}
              </button>
            ))}
          </div>
        )}

        {removable.length > 0 && !noteOpen && (
          <div className="ind-sheet-remove">
            <div className="ind-sheet-remove-label">Remove</div>
            {removable.map(entry => (
              <button key={entry.id} className="ind-remove-row" onClick={() => remove(entry)} disabled={busy}>
                <span className="ind-remove-dot" style={{ background: STATUSES[entry.status]?.color || entry.job_color }} />
                <span className="ind-remove-name">{entry.job_name}</span>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
