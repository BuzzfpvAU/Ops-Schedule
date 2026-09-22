import { useCallback, useEffect, useRef } from 'react';

// Hold-to-switch between the two interfaces.
//
// Progress is painted straight onto the element as a CSS variable rather than
// held in React state: this sits in the app shell, and re-rendering the whole
// timeline sixty times a second for three seconds would make the hold stutter
// on exactly the devices where it matters.
//
// Three seconds is long enough that silence reads as a broken tap, so the
// caller is expected to show the --hold variable as progress.
//
// NOTE: deliberately duplicated in client-v2/src/lib/useHoldToSwitch.js. The
// two front ends are independent builds with their own dependencies; sharing
// one file across them would couple the builds for the sake of forty lines.
export default function useHoldToSwitch(onComplete, ms = 3000) {
  const elRef = useRef(null);
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const firedRef = useRef(false);

  const paint = (p) => {
    elRef.current?.style.setProperty('--hold', String(p));
  };

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    startRef.current = 0;
    paint(0);
  }, []);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const tick = useCallback(() => {
    const elapsed = Date.now() - startRef.current;
    const p = Math.min(1, elapsed / ms);
    paint(p);
    if (p >= 1) {
      if (!firedRef.current) {
        firedRef.current = true;
        stop();
        onComplete();
      }
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [ms, onComplete, stop]);

  const start = useCallback((e) => {
    // Primary button only — a right-click should open the context menu.
    if (e.button !== undefined && e.button !== 0) return;
    firedRef.current = false;
    startRef.current = Date.now();
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  return {
    ref: elRef,
    handlers: {
      onPointerDown: start,
      onPointerUp: stop,
      onPointerLeave: stop,
      onPointerCancel: stop,
      // Without this a long press on touch pops the selection callout and
      // swallows the gesture.
      onContextMenu: (e) => e.preventDefault(),
    },
  };
}
