import { Router } from 'express';
import { geocodePlace } from '../services/geocodeSite.js';

// Town lookup for the equipment "Near" filter. Cached for a day and limited
// per user so typing cannot hammer the free Photon service.
const router = Router();
const TTL_MS = 24 * 3600 * 1000;
const MAX_CACHE = 500;
const PER_MINUTE = 30;
const cache = new Map();
const hits = new Map();
let lookup = (q) => geocodePlace(q);

export function setPlaceLookup(fn) {
  lookup = fn || ((q) => geocodePlace(q));
  cache.clear();
  hits.clear();
}

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length > 120) return res.status(400).json({ error: 'Type a place name' });
  const key = q.toLowerCase();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < TTL_MS) return res.json(cached.value);

  const who = req.user?.memberId || req.ip;
  const recent = (hits.get(who) || []).filter((t) => now - t < 60000);
  if (recent.length >= PER_MINUTE) return res.status(429).json({ error: 'Too many lookups — try again shortly' });
  recent.push(now);
  hits.set(who, recent);

  const pos = await lookup(q);
  const value = pos ? { found: true, lat: pos.lat, lng: pos.lng, label: pos.label || q } : { found: false };
  cache.set(key, { at: now, value });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  res.json(value);
});

export default router;
