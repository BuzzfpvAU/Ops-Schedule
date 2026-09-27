// Job site → map position, looked up once per address and never on the
// request path: saving a job must not wait on a third-party service.
const PHOTON = 'https://photon.komoot.io/api/';

// A place name → { lat, lng, label }, biased to Australia; null on any failure.
export async function geocodePlace(address, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const q = String(address || '').trim();
  if (!q) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=1&lat=-25&lon=134`;
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'taskz.id ops-schedule' } });
    if (!res.ok) return null;
    const body = await res.json();
    const f = body?.features?.[0];
    const c = f?.geometry?.coordinates;
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
    const p = f.properties || {};
    return { lat: c[1], lng: c[0], label: [p.name, p.state].filter(Boolean).join(', ') || q };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function geocodeAddress(address, opts) {
  const pos = await geocodePlace(address, opts);
  return pos ? { lat: pos.lat, lng: pos.lng } : null;
}

let geocoder = (a) => geocodeAddress(a);
export function setGeocoder(fn) {
  geocoder = fn || ((a) => geocodeAddress(a));
}

export function refreshSitePosition(db, jobId) {
  const job = db.prepare('SELECT site_address, site_geocoded_address FROM jobs WHERE id = ?').get(jobId);
  if (!job) return Promise.resolve();
  const addr = String(job.site_address || '').trim();
  if (!addr) {
    db.prepare('UPDATE jobs SET site_lat = NULL, site_lng = NULL, site_geocoded_address = NULL WHERE id = ?').run(jobId);
    return Promise.resolve();
  }
  if (addr === job.site_geocoded_address) return Promise.resolve();
  return Promise.resolve()
    .then(() => geocoder(addr))
    .then((pos) => {
      if (pos) {
        db.prepare('UPDATE jobs SET site_lat = ?, site_lng = ?, site_geocoded_address = ? WHERE id = ?')
          .run(pos.lat, pos.lng, addr, jobId);
      } else {
        db.prepare('UPDATE jobs SET site_lat = NULL, site_lng = NULL, site_geocoded_address = NULL WHERE id = ?').run(jobId);
      }
    })
    .catch((err) => console.error('site geocode failed', jobId, err?.message));
}
