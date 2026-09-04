// Reverse geocoding for the equipment list — "📍 Perth, WA" quick reference
// under each item.
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

// 'lat,lng' (3dp) -> Promise<string|null> (the resolved label, if any)
const cache = new Map();

export function geocodeKey(lat, lng) {
  return `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;
}

export function reverseGeocode(lat, lng) {
  const key = geocodeKey(lat, lng);
  if (!cache.has(key)) {
    cache.set(key, fetchPlace(lat, lng));
  }
  return cache.get(key);
}

async function fetchPlace(lat, lng) {
  const photon = await fromPhoton(lat, lng);
  if (photon) return photon;
  const bdc = await fromBigDataCloud(lat, lng);
  return bdc;
}

function shortState(state) {
  return (state && STATE_SHORT[state]) || state || '';
}

async function fromPhoton(lat, lng) {
  try {
    const url = `https://photon.komoot.io/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.features?.[0]?.properties;
    if (!p) return null;
    const place = p.city || p.district || p.locality || p.town || p.village || '';
    return [place, shortState(p.state)].filter(Boolean).join(', ') || null;
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
    const place = j.locality || j.city || '';
    const state = shortState(j.principalSubdivision);
    if (!place && !state) return null; // ocean / no-man's-land → no label
    return [place, state].filter(Boolean).join(', ') || null;
  } catch {
    return null; // geocode is decorative — never break the list over it
  }
}
