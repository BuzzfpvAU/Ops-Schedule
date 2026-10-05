// Training and certification rules. Pure, so the planning view and the team
// page agree on what "may have expired" means.
//
// A record means the person has held the certificate. The planner lists
// everyone who has held every required one and warns about the ones that may
// have lapsed, rather than hiding people — whether an expired cert matters is
// a call for whoever is planning the job.
import { addDays } from './dates.js';

export const EXPIRING_SOON_DAYS = 60;

// Worst first; used to sort candidates and pick a row's overall warning.
export const CERT_SEVERITY = { expired: 4, lapses: 3, soon: 2, nodate: 1, valid: 0, never: 0 };

// Held-index value for a certificate that never expires. A string so it can
// sit in the same map as ISO dates; certStatus checks for it first.
export const NO_EXPIRY = 'never';

export const CERT_LABEL = {
  expired: 'Expired',
  lapses: 'Expires during job',
  soon: 'Expiring soon',
  nodate: 'No expiry recorded',
  valid: 'Current',
  never: 'No expiry',
};

export function certStatus(expiry, { today, jobEnd } = {}) {
  if (expiry === NO_EXPIRY) return 'never';
  if (!expiry) return 'nodate';
  if (today && expiry < today) return 'expired';
  if (jobEnd && expiry < jobEnd) return 'lapses';
  if (today && expiry <= addDays(today, EXPIRING_SOON_DAYS)) return 'soon';
  return 'valid';
}

/** member id → (cert type id → expiry date | null) */
export function heldIndex(rows) {
  const idx = new Map();
  for (const r of rows || []) {
    if (!idx.has(r.member_id)) idx.set(r.member_id, new Map());
    idx.get(r.member_id).set(r.cert_type_id, r.no_expiry ? NO_EXPIRY : (r.expiry_date || null));
  }
  return idx;
}

/**
 * People who have held every required certificate, best first. Each carries
 * a per-certificate status so the row can say what to check.
 */
export function candidatesFor(members, held, requiredIds, ctx) {
  if (!requiredIds?.length) return [];
  const out = [];
  for (const m of members || []) {
    const mine = held.get(m.id);
    if (!mine || !requiredIds.every((id) => mine.has(id))) continue;
    const checks = requiredIds.map((id) => ({ typeId: id, expiry: mine.get(id), status: certStatus(mine.get(id), ctx) }));
    const worst = checks.reduce((w, c) => (CERT_SEVERITY[c.status] > CERT_SEVERITY[w] ? c.status : w), 'valid');
    out.push({ member: m, checks, worst });
  }
  return out.sort((a, b) => CERT_SEVERITY[a.worst] - CERT_SEVERITY[b.worst] || a.member.name.localeCompare(b.member.name));
}

/** Overall status for one person across everything they hold. */
export function worstStatus(mine, ctx) {
  let worst = 'valid';
  for (const expiry of (mine || new Map()).values()) {
    const s = certStatus(expiry, ctx);
    if (CERT_SEVERITY[s] > CERT_SEVERITY[worst]) worst = s;
  }
  return worst;
}
