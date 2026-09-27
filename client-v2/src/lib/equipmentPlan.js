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
// ── Phase 2: moves, tag checks, usage, near a place ─────────────────────
export const ROAD_FACTOR = 1.3;
export const KM_PER_DAY = 800;
export const MOVE_LOOKAHEAD_DAYS = 14;
export const SAME_SITE_KM = 1;
export const BASE_MOVE_KM = 250;
export const TAG_SITE_KM = 50;
export const NOT_RETURNED_DAYS = 3;
export const USAGE_DAYS = 30;

export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function jobRuns(booked) {
  const runs = [];
  for (const d of [...(booked?.keys() || [])].sort()) {
    const en = booked.get(d);
    const last = runs[runs.length - 1];
    if (last && last.jobId === en.job_id && diffDays(last.to, d) === 1) last.to = d;
    else runs.push({ jobId: en.job_id, code: en.job_code, from: d, to: d });
  }
  return runs;
}

function sitePoint(job, code) {
  const s = siteOf(job);
  return {
    label: `${job?.code || code || 'job'}${s.where ? ` ${s.where}` : ''}`,
    lat: s.lat, lng: s.lng, jobId: job?.id || null, state: job?.state || '',
  };
}

function differentSite(a, b) {
  if (a.lat != null && b.lat != null) return haversineKm(a, b) > SAME_SITE_KM;
  return a.state !== b.state;
}

function makeMove(itemId, from, to, leaveAfter, dueBy, gapDays) {
  const km = from.lat != null && to.lat != null
    ? Math.round((haversineKm(from, to) * ROAD_FACTOR) / 10) * 10 : null;
  const needDays = km == null ? null : Math.max(1, Math.ceil(km / KM_PER_DAY));
  return { itemId, from, to, leaveAfter, dueBy, gapDays, km, needDays, tight: km != null && gapDays < needDays };
}

export function movesFor(item, { runs, jobsById, win, today }) {
  const until = addDays(win.to, MOVE_LOOKAHEAD_DAYS);
  // Only moves still ahead: a job that has started already has its kit.
  const inRange = (d) => d >= win.from && d <= until && d > today;
  const out = [];
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1];
    const b = runs[i];
    if (a.jobId === b.jobId || !inRange(b.from)) continue;
    const from = sitePoint(jobsById?.get(a.jobId), a.code);
    const to = sitePoint(jobsById?.get(b.jobId), b.code);
    if (!differentSite(from, to)) continue;
    out.push(makeMove(item.id, from, to, a.to, b.from, diffDays(a.to, b.from) - 1));
  }
  const firstIdx = runs.findIndex((r) => inRange(r.from));
  const base = BASE_CITIES[item.location];
  if (firstIdx >= 0 && base) {
    const first = runs[firstIdx];
    const prev = runs[firstIdx - 1];
    const recent = prev && diffDays(prev.to, first.from) <= LAST_JOB_DAYS;
    const to = sitePoint(jobsById?.get(first.jobId), first.code);
    if (!recent && to.lat != null && haversineKm(base, to) > BASE_MOVE_KM) {
      const from = { label: `${item.location} base (${base.city})`, lat: base.lat, lng: base.lng, jobId: null, state: item.location };
      out.unshift(makeMove(item.id, from, to, null, first.from, Math.max(0, diffDays(today, first.from))));
    }
  }
  return out;
}

export function tagChecks(item, { ping, staleDays = 3, runs, jobsById, today, nowMs = Date.now() }) {
  if (!ping?.seen_at || !Number.isFinite(ping.lat) || nowMs - Date.parse(ping.seen_at) > staleDays * 86400000) return [];
  const current = runs.find((r) => r.from <= today && r.to >= today);
  if (current) {
    const s = sitePoint(jobsById?.get(current.jobId), current.code);
    if (s.lat == null) return [];
    const km = Math.round(haversineKm(ping, s));
    return km > TAG_SITE_KM
      ? [{ itemId: item.id, kind: 'not_at_site', km, text: `booked on ${s.label} today, tag ${km} km away` }]
      : [];
  }
  const last = runs.filter((r) => r.to < today).pop();
  if (!last) return [];
  const ago = diffDays(last.to, today);
  const s = sitePoint(jobsById?.get(last.jobId), last.code);
  if (ago >= NOT_RETURNED_DAYS && s.lat != null && haversineKm(ping, s) <= TAG_SITE_KM) {
    return [{ itemId: item.id, kind: 'not_returned', text: `still at ${s.label}, job ended ${ago} days ago` }];
  }
  return [];
}

export function usagePct(booked, today) {
  let n = 0;
  for (const d of booked?.keys() || []) {
    const back = diffDays(d, today);
    if (back >= 1 && back <= USAGE_DAYS) n += 1;
  }
  return Math.round((100 * n) / USAGE_DAYS);
}

export function isIdle(item, booked, today) {
  if (item.serviceable === 0 || item.active === 0) return false;
  for (const d of booked?.keys() || []) {
    const off = diffDays(today, d);
    if (off >= -USAGE_DAYS && off < USAGE_DAYS) return false;
  }
  return true;
}

export function lastUsed(booked, today) {
  return [...(booked?.keys() || [])].filter((d) => d < today).sort().pop() || null;
}

export function nearFilter(rows, place, radiusKm) {
  return rows
    .filter((r) => r.loc?.lat != null && r.loc?.lng != null)
    .map((r) => ({ ...r, distKm: Math.round(haversineKm(place, r.loc)) }))
    .filter((r) => r.distKm <= radiusKm)
    .sort((a, b) => a.distKm - b.distKm);
}
