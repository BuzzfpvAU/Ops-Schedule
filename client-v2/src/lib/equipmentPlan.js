// Equipment planning: what is free in a window, and where each item is.
// Pure functions over data the V2 app already loads. See
// docs/superpowers/specs/2026-09-28-equipment-planning-view-design.md.
import { addDays, diffDays, rangeOf } from './dates.js';
import { isWork } from './model.js';

export const LAST_JOB_DAYS = 14;

export const BASE_CITIES = {
  WA: { city: 'Perth', lat: -31.95, lng: 115.86 },
  NSW: { city: 'Sydney', lat: -33.87, lng: 151.21 },
  QLD: { city: 'Brisbane', lat: -27.47, lng: 153.03 },
  VIC: { city: 'Melbourne', lat: -37.81, lng: 144.96 },
  SA: { city: 'Adelaide', lat: -34.93, lng: 138.6 },
  TAS: { city: 'Hobart', lat: -42.88, lng: 147.33 },
  NT: { city: 'Darwin', lat: -12.46, lng: 130.84 },
  ACT: { city: 'Canberra', lat: -35.28, lng: 149.13 },
};

export const AVAIL_TONE = { free: 'ok', partial: 'warn', booked: 'danger', unserviceable: 'mute' };
const AVAIL_ORDER = { free: 0, partial: 1, booked: 2, unserviceable: 3 };

export function bookedIndex(schedule) {
  const idx = new Map();
  for (const en of schedule || []) {
    if (!en.job_id || !isWork(en)) continue;
    if (!idx.has(en.team_member_id)) idx.set(en.team_member_id, new Map());
    idx.get(en.team_member_id).set(en.date, en);
  }
  return idx;
}

export function planWindow(preset, today, custom) {
  if (preset === 'custom' && custom?.from && custom?.to) {
    return custom.from <= custom.to ? { from: custom.from, to: custom.to } : { from: custom.to, to: custom.from };
  }
  const n = preset === '7' ? 7 : 14;
  return { from: today, to: addDays(today, n - 1) };
}

export function availability(item, booked, win) {
  const days = rangeOf(win.from, win.to);
  const freeDays = days.filter((d) => !booked?.has(d)).length;
  const totalDays = days.length;
  if (item.serviceable === 0) return { status: 'unserviceable', freeDays, totalDays };
  if (freeDays === totalDays) return { status: 'free', freeDays, totalDays };
  if (freeDays === 0) return { status: 'booked', freeDays, totalDays };
  return { status: 'partial', freeDays, totalDays };
}

export function availText(a) {
  switch (a.status) {
    case 'free': return 'Free';
    case 'partial': return `Free ${a.freeDays} of ${a.totalDays} days`;
    case 'booked': return 'Booked';
    default: return 'Unserviceable';
  }
}

function agoText(iso, nowMs) {
  const mins = Math.round((nowMs - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

function siteOf(job) {
  if (!job) return { where: '', lat: null, lng: null };
  const where = (job.site_address || '').split(',')[0].trim() || job.state || '';
  const has = Number.isFinite(job.site_lat) && Number.isFinite(job.site_lng);
  return { where, lat: has ? job.site_lat : null, lng: has ? job.site_lng : null };
}

export function resolveLocation(item, { ping, staleDays = 3, booked, jobsById, windowStart, nowMs = Date.now() }) {
  const none = { lat: null, lng: null, approx: false, jobId: null };
  if (ping?.seen_at && Number.isFinite(ping.lat) && nowMs - Date.parse(ping.seen_at) <= staleDays * 86400000) {
    const place = ping.place || `${ping.lat.toFixed(2)}, ${ping.lng.toFixed(2)}`;
    return { ...none, source: 'tag', label: `📍 ${place} · ${agoText(ping.seen_at, nowMs)} (tag)`, lat: ping.lat, lng: ping.lng };
  }
  const on = booked?.get(windowStart);
  if (on) {
    const job = jobsById?.get(on.job_id);
    const s = siteOf(job);
    const code = job?.code || on.job_code || 'job';
    return { ...none, source: 'booked', label: `📍 On job ${code}${s.where ? ` · ${s.where}` : ''} (booked)`, lat: s.lat, lng: s.lng, jobId: on.job_id };
  }
  const before = [...(booked?.keys() || [])].filter((d) => d < windowStart).sort().pop();
  if (before && diffDays(before, windowStart) <= LAST_JOB_DAYS) {
    const en = booked.get(before);
    const job = jobsById?.get(en.job_id);
    const s = siteOf(job);
    const ago = diffDays(before, windowStart);
    const code = job?.code || en.job_code || 'job';
    return { ...none, source: 'last_job', label: `📍 Last on ${code}, ended ${ago} day${ago === 1 ? '' : 's'} ago`, lat: s.lat, lng: s.lng, jobId: en.job_id };
  }
  if (item.location) {
    const base = BASE_CITIES[item.location];
    return { ...none, source: 'home', label: `📍 ${item.location} base (home)`, lat: base?.lat ?? null, lng: base?.lng ?? null, approx: !!base };
  }
  return { ...none, source: 'unknown', label: '📍 Unknown' };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => (AVAIL_ORDER[a.avail.status] - AVAIL_ORDER[b.avail.status])
    || (a.item.name || '').localeCompare(b.item.name || ''));
}

export function summary(rows) {
  const out = { free: 0, partial: 0, booked: 0, unserviceable: 0 };
  for (const r of rows) out[r.avail.status] += 1;
  return out;
}

// Every map location is one numbered bubble — "1" included, so a lone item is
// as easy to spot as a busy site. Colour is the shared availability of what
// is there, or "mixed"; approximate (home-base) only if every item is.
export function bubbleFor(list) {
  const tones = new Set(list.map((p) => p.tone));
  return {
    count: list.length,
    tone: tones.size === 1 ? list[0].tone : 'mixed',
    approx: list.every((p) => p.approx),
  };
}
