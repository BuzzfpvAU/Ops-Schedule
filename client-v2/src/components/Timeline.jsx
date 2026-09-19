import React, { useEffect, useMemo, useRef } from 'react';
import { DOW, monthBands, isWeekend, parseISO, today as todayIso } from '../lib/dates.js';

// ── Timeline ────────────────────────────────────────────────────────────
// The Gantt engine shared by all three views. One scroll container holds
// everything, and `position: sticky` pins the date header to the top and the
// label column to the left — so the grid scrolls freely in both axes without
// the two-container scroll-sync that tends to judder.
//
// Callers supply groups of rows; a row supplies its own bars with absolute
// day indices. Lane stacking is the caller's job (see lib/model.js) because
// each view has its own idea of what may overlap.

export const LANE_H = 22;
export const LANE_GAP = 3;
export const ROW_PAD = 6;

export function rowHeight(lanes) {
  return Math.max(1, lanes) * LANE_H + (Math.max(1, lanes) - 1) * LANE_GAP + ROW_PAD * 2;
}

export default function Timeline({
  days,
  colW,
  labelWidth = 260,
  groups,
  collapsed = {},
  onToggleGroup,
  renderLabel,
  renderBar,
  onCellClick,
  dayLabels = 'full',
  emptyMessage = 'Nothing to show in this window.',
  scrollRef,
}) {
  const innerRef = useRef(null);
  const ref = scrollRef || innerRef;
  const bands = useMemo(() => monthBands(days), [days]);
  const gridW = days.length * colW;
  const today = todayIso();
  const todayIdx = days.indexOf(today);
  const centeredRef = useRef(false);

  // Bring today into view once, rather than every re-render.
  useEffect(() => {
    if (centeredRef.current || todayIdx < 0 || !ref.current) return;
    const el = ref.current;
    el.scrollLeft = Math.max(0, todayIdx * colW - el.clientWidth / 3);
    centeredRef.current = true;
  }, [todayIdx, colW, ref]);

  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="tl" ref={ref} style={{ '--label-w': `${labelWidth}px`, '--col-w': `${colW}px` }}>
      <div className="tl-inner" style={{ width: labelWidth + gridW }}>

        {/* Header: month band over day cells */}
        <div className="tl-head">
          <div className="tl-corner" style={{ width: labelWidth }} />
          <div className="tl-head-cols" style={{ width: gridW }}>
            <div className="tl-months">
              {bands.map((b) => (
                <div
                  key={b.key}
                  className="tl-month"
                  style={{ left: b.startIdx * colW, width: b.span * colW }}
                  title={`${b.label} ${b.year}`}
                >
                  <span>{b.label} {String(b.year).slice(2)}</span>
                </div>
              ))}
            </div>
            <div className="tl-days">
              {days.map((iso, i) => {
                const d = parseISO(iso);
                const weekend = isWeekend(iso);
                const monday = d.getDay() === 1;
                const isToday = iso === today;
                let label = null;
                if (dayLabels === 'full') {
                  label = (
                    <>
                      {/* Full weekday name: there is room for it now that
                          the narrowest level using this mode is 39px. */}
                      <span className="tl-dow">{DOW[d.getDay()]}</span>
                      <span className="tl-dom">{d.getDate()}</span>
                    </>
                  );
                } else if (dayLabels === 'dom') {
                  // Date only: the weekday letter does not fit, but weekend
                  // shading still shows where the weeks break.
                  label = <span className="tl-dom">{d.getDate()}</span>;
                } else if (dayLabels === 'mondays' && monday) {
                  label = <span className="tl-dom">{d.getDate()}</span>;
                }
                return (
                  <div
                    key={iso}
                    className={`tl-day${weekend ? ' is-weekend' : ''}${isToday ? ' is-today' : ''}${monday ? ' is-monday' : ''}`}
                    style={{ left: i * colW, width: colW }}
                    title={iso}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="tl-body">
          {/* Column washes sit behind every row so weekends and today read as
              continuous vertical stripes rather than per-row decoration. */}
          <div className="tl-wash" style={{ left: labelWidth, width: gridW }}>
            {days.map((iso, i) =>
              isWeekend(iso) ? (
                <div key={iso} className="tl-wash-weekend" style={{ left: i * colW, width: colW }} />
              ) : null
            )}
            {todayIdx >= 0 && (
              <div className="tl-wash-today" style={{ left: todayIdx * colW, width: colW }} />
            )}
          </div>

          {totalRows === 0 && <div className="tl-empty" style={{ left: labelWidth }}>{emptyMessage}</div>}

          {groups.map((group) => {
            const isCollapsed = !!collapsed[group.key];
            return (
              <div className="tl-group" key={group.key}>
                <div className="tl-group-head">
                  <button
                    type="button"
                    className="tl-group-label"
                    style={{ width: labelWidth }}
                    onClick={() => onToggleGroup?.(group.key)}
                    aria-expanded={!isCollapsed}
                  >
                    <span className={`tl-caret${isCollapsed ? ' is-collapsed' : ''}`} aria-hidden="true">▾</span>
                    <span className="tl-group-name">{group.label ?? group.key}</span>
                    <span className="tl-group-count">{group.rows.length}</span>
                    {group.meta}
                  </button>
                  <div className="tl-group-rule" style={{ width: gridW }} />
                </div>

                {!isCollapsed && group.rows.map((row) => {
                  const h = rowHeight(row.lanes || 1);
                  return (
                    <div className="tl-row" key={row.id} style={{ height: h }}>
                      <div className="tl-label" style={{ width: labelWidth }}>
                        {renderLabel(row)}
                      </div>
                      <div
                        className="tl-track"
                        style={{ width: gridW, height: h }}
                        onClick={
                          onCellClick
                            ? (e) => {
                                // Bars stop propagation themselves; anything
                                // reaching here is a click on bare track.
                                const rect = e.currentTarget.getBoundingClientRect();
                                const idx = Math.floor((e.clientX - rect.left) / colW);
                                if (idx < 0 || idx >= days.length) return;
                                onCellClick(row, days[idx], e);
                              }
                            : undefined
                        }
                      >
                        {(row.bars || []).map((bar, bi) => {
                          const startIdx = bar.startIdx;
                          const span = bar.span;
                          if (span <= 0) return null;
                          return (
                            <div
                              key={bar.key ? `${bar.key}-${bi}` : bi}
                              className="tl-bar-slot"
                              style={{
                                left: startIdx * colW,
                                width: span * colW,
                                top: ROW_PAD + (bar.lane || 0) * (LANE_H + LANE_GAP),
                                height: LANE_H,
                              }}
                            >
                              {renderBar(bar, row)}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
