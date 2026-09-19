import { useEffect, useState } from 'react';

// The label column is a fixed pixel width because the timeline's geometry
// depends on it. On a phone a desktop-sized column would leave almost no room
// for the dates, so it steps down with the viewport.
function widthFor(w) {
  if (w < 480) return 170;
  if (w < 760) return 210;
  return 280;
}

export default function useLabelWidth() {
  const [width, setWidth] = useState(() =>
    widthFor(typeof window === 'undefined' ? 1200 : window.innerWidth));

  useEffect(() => {
    const onResize = () => setWidth(widthFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return width;
}
