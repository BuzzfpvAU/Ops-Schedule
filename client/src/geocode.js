// Reverse geocoding for the equipment list — "📍 Perth, WA" quick reference
// under each item, plus the short state for "Group by State" (tracked state).
//
// Two free, key-less, CORS-enabled providers are chained:
//   1. Photon (OSM data, https://photon.komoot.io) — best place names, but its
//      index is sparse in remote/outback Australia and can return no feature.
//   2. BigDataCloud reverse-geocode-client (https://api.bigdatacloud.net) —
//      full admin-boundary coverage, used when Photon comes up empty.
//
// Results are cached forever at module level keyed by coordinate rounded to
// ~110 m, so each spot is only ever looked up once per page load.

const STATE_SHORT = {
  'Western Australia': 'WA',
  'New South Wales': 'NSW',
  'Queensland': 'QLD',
  'Victoria': 'VIC',
  'South Australia': 'SA',
  'Tasmania': 'TAS',
  'Northern Territory': 'NT',
  'Australian Capital Territory': 'ACT',
};

function shortState(state) {
  return (state && STATE_SHORT[state]) || state || '';
}

// 'lat,lng' (3dp) -> Promise<{label, state}|null>; label is "Place, ST",
// state is the short state code. Null when nothing resolvable (ocean etc).
const cache = new Map();

export function geocodeKey(lat, lng) {
  return `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;
}

export function geocodeDetail(lat, lng) {
  const key = geocodeKey(lat, lng);
  if (!cache.has(key)) {
    cache.set(key, fetchDetail(lat, lng));
  }
  return cache.get(key);
}

// Convenience wrappers (existing call sites use these)
export function reverseGeocode(lat, lng) {
  return geocodeDetail(lat, lng).then(d => (d && d.label) || null);
}

export function reverseGeocodeState(lat, lng) {
  return geocodeDetail(lat, lng).then(d => (d && d.state) || null);
}

function detail(label, state) {
  return { label: label || null, state: state || null };
}

async function fetchDetail(lat, lng) {
  const photon = await fromPhoton(lat, lng);
  if (photon) return photon;
  return fromBigDataCloud(lat, lng);
}

async function fromPhoton(lat, lng) {
  try {
    const url = `https://photon.komoot.io/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.features?.[0]?.properties;
    if (!p) return null;
    const state = shortState(p.state);
    const place = p.city || p.district || p.locality || p.town || p.village || '';
    if (!place && !state) return null;
    return detail([place, state].filter(Boolean).join(', '), state);
  } catch {
    return null;
  }
}

async function fromBigDataCloud(lat, lng) {
  try {
    const url = 'https://api.bigdatacloud.net/data/reverse-geocode-client'
      + `?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&localityLanguage=en`;
    const res = await fetch(url); // the endpoint 307s to its canonical host; fetch follows
    if (!res.ok) return null;
    const j = await res.json();
    const state = shortState(j.principalSubdivision);
    const place = j.locality || j.city || '';
    if (!place && !state) return null; // ocean / no-man's-land → no label
    return detail([place, state].filter(Boolean).join(', '), state);
  } catch {
    return null; // geocode is decorative — never break the list over it
  }
}
