import { useState, useEffect } from 'react';

const QUERY = '(max-width: 768px)';

// True while the viewport is phone-sized. Reacts to rotation and resizing.
export default function useIsNarrow() {
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e) => setIsNarrow(e.matches);
    mql.addEventListener('change', onChange);
    setIsNarrow(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isNarrow;
}
