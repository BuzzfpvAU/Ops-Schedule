import { useEffect, useRef, useState } from 'react';

// ── Drag a timeline bar by whole days ──────────────────────────────────
//
// Press on a bar and drag: the bar follows the pointer, snapped to days,
// and on release its onCommit gets the number of days moved. Within EDGE_PX
// of either end (when resizing is allowed) the drag moves just that end.
// A press that never travels past CLICK_PX is a click, handed to onClick,
// so a bar can still be clicked to open whatever it opened before.
//
// The caller renders the preview from dragStyle(); nothing is saved until
// release, and Escape cancels.

const EDGE_PX = 7;
const CLICK_PX = 4;

export default function useBarDrag({ colW, enabled = true, resizable = false }) {
  const [drag, setDrag] = useState(null); // { key, days, edge }
  const cur = useRef(null);
  const colWRef = useRef(colW);
  colWRef.current = colW;

  // Window listeners must be the same function objects to come off again,
  // so they are made once and read everything else through refs.
  const listeners = useRef(null);
  if (!listeners.current) {
    const stop = (commit) => {
      const d = cur.current;
      cur.current = null;
      window.removeEventListener('pointermove', listeners.current.move);
      window.removeEventListener('pointerup', listeners.current.up);
      window.removeEventListener('keydown', listeners.current.key);
      document.body.classList.remove('is-dragging-bar');
      setDrag(null);
      if (!d || !commit) return;
      if (!d.moved) d.onClick?.(d.press);
      else if (d.days !== 0) d.onCommit?.(d.days, d.edge);
    };
    listeners.current = {
      stop,
      move: (e) => {
        const d = cur.current;
        if (!d || !d.canDrag) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < CLICK_PX) return;
        d.moved = true;
        document.body.classList.add('is-dragging-bar');
        let days = Math.round(dx / colWRef.current);
        // An end cannot pass the other end: the bar always keeps one day.
        if (d.edge === 'start') days = Math.min(days, d.span - 1);
        if (d.edge === 'end') days = Math.max(days, -(d.span - 1));
        if (days !== d.days) {
          d.days = days;
          setDrag({ key: d.key, days, edge: d.edge });
        }
      },
      up: () => stop(true),
      key: (e) => { if (e.key === 'Escape') stop(false); },
    };
  }

  useEffect(() => () => listeners.current.stop(false), []);

  // Spread onto the bar element.
  const bind = (key, span, { onCommit, onClick } = {}) => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      let edge;
      if (enabled && resizable && rect.width > EDGE_PX * 3) {
        if (e.clientX - rect.left <= EDGE_PX) edge = 'start';
        else if (rect.right - e.clientX <= EDGE_PX) edge = 'end';
      }
      cur.current = {
        key, span, edge, x: e.clientX, days: 0, moved: false,
        canDrag: enabled && !!onCommit,
        press: { clientX: e.clientX, rect },
        onCommit, onClick,
      };
      window.addEventListener('pointermove', listeners.current.move);
      window.addEventListener('pointerup', listeners.current.up);
      window.addEventListener('keydown', listeners.current.key);
    },
    // The release above already acted; keep the click off the track.
    onClick: (e) => e.stopPropagation(),
  });

  // Inline style for the bar being dragged: moved, or one end stretched.
  const dragStyle = (key) => {
    if (!drag || drag.key !== key) return null;
    const px = drag.days * colW;
    if (drag.edge === 'start') return { marginLeft: px, width: `calc(100% - ${px}px)`, zIndex: 5 };
    if (drag.edge === 'end') return { width: `calc(100% + ${px}px)`, zIndex: 5 };
    return { transform: `translateX(${px}px)`, zIndex: 5 };
  };

  return { drag, bind, dragStyle };
}
