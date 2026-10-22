import { useCallback, useEffect, useState } from 'react';

// ── Phone or full layout ────────────────────────────────────────────
// Phones get the field view (MobileApp) automatically; anything wider gets
// the planning timeline. Either can be overridden from the other — the
// choice is remembered on the device, and "auto" goes back to detecting.

// Portrait phones, and phones turned sideways (wide but very short with a
// touch screen), but not a tablet or a narrowed desktop window.
export const PHONE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-height: 500px)';
const KEY = 'v2.layout';

export function pickLayout(choice, isPhone) {
  if (choice === 'mobile' || choice === 'full') return choice;
  return isPhone ? 'mobile' : 'full';
}

function readChoice() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'mobile' || v === 'full' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export default function useLayout() {
  const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_QUERY) : null;
  const [isPhone, setIsPhone] = useState(() => !!query?.matches);
  const [choice, setChoiceState] = useState(readChoice);

  useEffect(() => {
    if (!query) return undefined;
    const onChange = (e) => setIsPhone(e.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Choosing the layout this device would get anyway clears the override,
  // so detection carries on working if the screen changes.
  const setChoice = useCallback((next) => {
    const value = next === pickLayout('auto', isPhone) ? 'auto' : next;
    try {
      if (value === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
    } catch { /* private mode: the choice lasts this visit only */ }
    setChoiceState(value);
  }, [isPhone]);

  return { layout: pickLayout(choice, isPhone), isPhone, choice, setChoice };
}
