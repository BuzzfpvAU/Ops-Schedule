import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { DOW, PAST_DAYS, diffDays, monthBands, isWeekend, parseISO, today as todayIso } from '../lib/dates.js';

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
  renderOverlay,
  onCellClick,
  dayLabels = 'full',
  emptyMessage = 'Nothing to show in this window.',
  scrollRef,
  scrollCmd,
  onReachEdge,
  focusDate,
}) {
  const innerRef = useRef(null);
  const ref = scrollRef || innerRef;
  const bands = useMemo(() => monthBands(days), [days]);
  const gridW = days.length * colW;
  const today = todayIso();
  const todayIdx = days.indexOf(today);
  const centeredRef = useRef(false);

  // Read inside effects that must not re-run when these change.
  const posRef = useRef({ todayIdx, colW });
  posRef.current = { todayIdx, colW };

  // The day index sitting at the left edge. Tracked as an index rather than a
  // pixel offset because pixels stop meaning the same thing the moment colW
  // changes — and because the browser clamps scrollLeft when the content
  // shrinks, so by the time a layout effect runs the pixel value has already
  // lost the information we needed.
  const leadRef = useRef(0);

  const scrollToIndex = (idx) => {
    const el = ref.current;
    if (!el) return;
    leadRef.current = Math.max(0, idx);
    el.scrollLeft = Math.max(0, idx * posRef.current.colW);
  };

  // Open with only a few days of history on screen. More than that is loaded,
  // so there is somewhere to scroll back to.
  useEffect(() => {
    if (centeredRef.current || todayIdx < 0 || !ref.current) return;
    scrollToIndex(todayIdx - PAST_DAYS);
    centeredRef.current = true;
  }, [todayIdx, colW, ref]);

  // Today and the paging arrows arrive as commands rather than state, because
  // pressing them may change nothing else and still has to move the view.
  // Seeded with the current nonce so switching tabs does not replay the last
  // one: a freshly mounted view should open on its own terms.
  const lastCmdRef = useRef(scrollCmd?.nonce || 0);
  useEffect(() => {
    const cmd = scrollCmd;
    if (!cmd || cmd.nonce === lastCmdRef.current) return;
    lastCmdRef.current = cmd.nonce;
    const el = ref.current;
    if (!el) return;
    if (cmd.type === 'today') {
      if (posRef.current.todayIdx >= 0) scrollToIndex(posRef.current.todayIdx);
    } else if (cmd.type === 'page') {
      // Just under a screenful, so a little context carries across the turn.
      const stride = ((el.clientWidth - labelWidth) * 0.85) / posRef.current.colW;
      scrollToIndex(leadRef.current + cmd.dir * stride);
    }
  }, [scrollCmd, ref, labelWidth]);

  // Jump to a specific date once, when a caller names one — opening a single
  // project should land on that project's dates, not wherever the shared
  // window happened to be scrolled.
  const lastFocusRef = useRef(null);
  useEffect(() => {
    if (!focusDate || focusDate === lastFocusRef.current) return;
    const idx = days.indexOf(focusDate);
    if (idx < 0) return;
    lastFocusRef.current = focusDate;
    scrollToIndex(Math.max(0, idx - PAST_DAYS));
  }, [focusDate, days, colW]);

  // Keep the same date under the left edge when the geometry changes: the
  // window grows at the left as you scroll back, and zooming changes what a
  // day is worth in pixels. Both are re-applied from the tracked index.
  const prevGeomRef = useRef({ colW, first: days[0] });
  useLayoutEffect(() => {
    const prev = prevGeomRef.current;
    const first = days[0];
    const grew = prev.first && first && first !== prev.first;
    const zoomed = prev.colW !== colW;
    prevGeomRef.current = { colW, first };
    if (!ref.current || (!grew && !zoomed)) return;

    let lead = leadRef.current;
    if (grew) {
      const prepended = diffDays(first, prev.first);
      if (prepended > 0) lead += prepended;
    }
    scrollToIndex(lead);
  }, [colW, days, ref]);

  // Ask for more dates when the scroll nears either end, and keep the leading
  // index current for the geometry effect above.
  const EDGE_PX = 320;
  const handleScroll = (e) => {
    const el = e.currentTarget;
    leadRef.current = el.scrollLeft / posRef.current.colW;
    if (!onReachEdge) return;
    if (el.scrollLeft < EDGE_PX) onReachEdge(-1);
    else if (el.scrollLeft + el.clientWidth > el.scrollWidth - EDGE_PX) onReachEdge(1);
  };

  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="tl" ref={ref} onScroll={handleScroll} style={{ '--label-w': `${labelWidth}px`, '--col-w': `${colW}px` }}>
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
                        {renderOverlay?.(row)}
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
