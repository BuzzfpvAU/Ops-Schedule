// One-time invite links for the tag export portal on the tracker Mac.
// Tokens are shown once and stored only as a SHA-256 hash.
import crypto from 'crypto';

export const INVITE_TTL_MS = 24 * 3600 * 1000;
export const INVITE_ATTEMPTS = 3;
// Longer than any export can run (the portal gives up on a session after
// 10 idle minutes), so an attempt still in progress after this was cut off.
export const STUCK_ATTEMPT_MS = 30 * 60 * 1000;
const PORTAL_KEY = 'tracker_portal_status';

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createInvite(db, { label, createdBy }, nowMs = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO tracker_invites (id, token_hash, label, created_by, created_at, expires_at, attempts_left)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, hashToken(token), label, createdBy || null,
    new Date(nowMs).toISOString(), new Date(nowMs + INVITE_TTL_MS).toISOString(), INVITE_ATTEMPTS);
  return { id, token };
}

function isStuck(row, nowMs) {
  if (row.status !== 'in_progress') return false;
  const at = Date.parse(row.attempted_at || '');
  return !Number.isFinite(at) || nowMs - at > STUCK_ATTEMPT_MS;
}

// An attempt the portal never reported back on (it restarted, or the Mac
// slept) counts as a failed attempt, so the link works again while it has
// attempts left instead of reading "expired" for good.
function releaseStuck(db, row, nowMs) {
  if (!isStuck(row, nowMs)) return row;
  const status = row.attempts_left > 0 ? 'pending' : 'failed';
  db.prepare("UPDATE tracker_invites SET status = ?, note = 'attempt interrupted' WHERE id = ? AND status = 'in_progress'")
    .run(status, row.id);
  return { ...row, status, note: 'attempt interrupted' };
}

export function effectiveStatus(row, nowMs = Date.now()) {
  const status = isStuck(row, nowMs) ? (row.attempts_left > 0 ? 'pending' : 'failed') : row.status;
  if (status === 'pending' && Date.parse(row.expires_at) <= nowMs) return 'expired';
  return status;
}

export function listInvites(db, nowMs = Date.now()) {
  return db.prepare(`
    SELECT id, label, created_at, expires_at, attempts_left, status, tags_saved, note
    FROM tracker_invites ORDER BY created_at DESC LIMIT 50
  `).all().map((r) => ({ ...r, status: effectiveStatus(r, nowMs) }));
}

export function checkInvite(db, token, nowMs = Date.now()) {
  if (!token) return { ok: false };
  let row = db.prepare('SELECT * FROM tracker_invites WHERE token_hash = ?').get(hashToken(token));
  if (row) row = releaseStuck(db, row, nowMs);
  if (!row || effectiveStatus(row, nowMs) !== 'pending' || row.attempts_left < 1) return { ok: false };
  return { ok: true, id: row.id, label: row.label, attempts_left: row.attempts_left };
}

function get(db, id) {
  return db.prepare('SELECT * FROM tracker_invites WHERE id = ?').get(id);
}

// Each returns the new status, or null when the transition is not allowed.
export function recordAttempt(db, id, nowMs = Date.now()) {
  let row = get(db, id);
  if (row) row = releaseStuck(db, row, nowMs);
  if (!row || effectiveStatus(row, nowMs) !== 'pending' || row.attempts_left < 1) return null;
  db.prepare("UPDATE tracker_invites SET attempts_left = attempts_left - 1, status = 'in_progress', attempted_at = ? WHERE id = ?")
    .run(new Date(nowMs).toISOString(), id);
  return 'in_progress';
}

export function completeInvite(db, id, tagsSaved) {
  const row = get(db, id);
  if (!row || row.status !== 'in_progress') return null;
  db.prepare("UPDATE tracker_invites SET status = 'done', tags_saved = ? WHERE id = ?")
    .run(Math.max(0, parseInt(tagsSaved, 10) || 0), id);
  return 'done';
}

export function failInvite(db, id, note) {
  const row = get(db, id);
  if (!row || row.status !== 'in_progress') return null;
  const status = row.attempts_left > 0 ? 'pending' : 'failed';
  db.prepare('UPDATE tracker_invites SET status = ?, note = ? WHERE id = ?').run(status, String(note || '').slice(0, 200), id);
  return status;
}

export function markCleanupFailed(db, id, note) {
  const row = get(db, id);
  if (!row) return null;
  db.prepare("UPDATE tracker_invites SET status = 'cleanup_needed', note = ? WHERE id = ?")
    .run(String(note || '').slice(0, 200), id);
  return 'cleanup_needed';
}

export function cancelInvite(db, id, nowMs = Date.now()) {
  const row = get(db, id);
  if (!row || effectiveStatus(row, nowMs) !== 'pending') return null;
  db.prepare("UPDATE tracker_invites SET status = 'cancelled' WHERE id = ?").run(id);
  return 'cancelled';
}

export function recordPortalStatus(db, portal, nowIso) {
  if (!portal || typeof portal !== 'object') return;
  const value = JSON.stringify({ ok: !!portal.ok, version: String(portal.version || ''), at: nowIso });
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(PORTAL_KEY, value);
}

export function portalLastOkAt(db) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(PORTAL_KEY);
  try {
    const v = row ? JSON.parse(row.value) : null;
    return v && v.ok ? v.at : null;
  } catch {
    return null;
  }
}
