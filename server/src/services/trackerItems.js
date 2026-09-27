// Find My items the tracker Mac holds keys for, and how each maps to
// equipment. The Mac reports its inventory every run; admins choose what is
// tracked in V2 Settings. See docs/superpowers/specs/2026-09-27-tracker-tag-management-design.md.

const STALE_KEY = 'tracker_stale_days';
const DEFAULT_STALE_DAYS = 3;

export function normaliseTagName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[‘’]/g, "'");
}

// Equipment an unlinked tag could adopt by name: active, not already linked,
// and the only equipment item with that normalised name.
function autoLinkTarget(db, name) {
  const wanted = normaliseTagName(name);
  if (!wanted) return null;
  const candidates = db.prepare(`
    SELECT tm.id, tm.airtag_name FROM team_members tm
    WHERE tm.is_equipment = 1 AND tm.active = 1 AND TRIM(COALESCE(tm.airtag_name, '')) != ''
      AND NOT EXISTS (SELECT 1 FROM tracker_items ti WHERE ti.equipment_id = tm.id)
  `).all().filter((r) => normaliseTagName(r.airtag_name) === wanted);
  const all = db.prepare(`
    SELECT airtag_name FROM team_members
    WHERE is_equipment = 1 AND active = 1 AND TRIM(COALESCE(airtag_name, '')) != ''
  `).all().filter((r) => normaliseTagName(r.airtag_name) === wanted);
  return candidates.length === 1 && all.length === 1 ? candidates[0].id : null;
}

export function upsertInventory(db, items, nowIso) {
  const find = db.prepare('SELECT identifier FROM tracker_items WHERE identifier = ?');
  const insert = db.prepare(`
    INSERT INTO tracker_items (identifier, account, name, emoji, model, serial_number, kind,
                               included, equipment_id, first_seen_at, last_inventory_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE tracker_items SET account = ?, name = ?, emoji = ?, model = ?, serial_number = ?,
                             kind = ?, last_inventory_at = ?
    WHERE identifier = ? AND purged_at IS NULL
  `);
  db.transaction(() => {
    for (const it of items) {
      const identifier = String(it.identifier || '').trim();
      if (!identifier) continue;
      const kind = it.kind === 'device' ? 'device' : 'tag';
      const fields = [
        String(it.account || ''), String(it.name || ''), String(it.emoji || ''),
        String(it.model || ''), String(it.serial_number || ''), kind,
      ];
      if (find.get(identifier)) {
        update.run(...fields, nowIso, identifier);
      } else {
        const link = kind === 'tag' ? autoLinkTarget(db, it.name) : null;
        insert.run(identifier, ...fields, link ? 1 : 0, link, nowIso, nowIso);
      }
    }
  })();
  return db.prepare('SELECT identifier FROM tracker_items WHERE included = 1 AND removed_at IS NULL ORDER BY identifier')
    .all().map((r) => r.identifier);
}

// Of the identifiers the Mac just reported, those an admin removed — the Mac
// deletes their key files.
export function removedAmong(db, identifiers) {
  const removed = new Set(db.prepare('SELECT identifier FROM tracker_items WHERE removed_at IS NOT NULL')
    .all().map((r) => r.identifier));
  return [...new Set(identifiers)].filter((id) => removed.has(id)).sort();
}

export function removeItem(db, identifier, nowIso) {
  const r = db.prepare(`
    UPDATE tracker_items SET removed_at = ?, included = 0, equipment_id = NULL
    WHERE identifier = ?
  `).run(nowIso, identifier);
  return r.changes > 0;
}

export function restoreItem(db, identifier) {
  const r = db.prepare(`
    UPDATE tracker_items SET removed_at = NULL
    WHERE identifier = ? AND removed_at IS NOT NULL AND purged_at IS NULL
  `).run(identifier);
  return r.changes > 0;
}

// Take a removed item off every list for good. Only the identifier matters
// from here on — it keeps the item removed if the account is exported again.
export function purgeItem(db, identifier, nowIso) {
  const r = db.prepare(`
    UPDATE tracker_items SET purged_at = ?, name = '', emoji = '', model = '', serial_number = '',
                             last_seen_at = NULL, battery = NULL
    WHERE identifier = ? AND removed_at IS NOT NULL AND purged_at IS NULL
  `).run(nowIso, identifier);
  return r.changes > 0;
}

export function getStaleDays(db) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(STALE_KEY);
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULT_STALE_DAYS;
}

export function setStaleDays(db, days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 60) throw new RangeError('stale_days must be a whole number from 1 to 60');
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(STALE_KEY, String(n));
  return n;
}

export function itemStatus(row, latestByAccount, staleDays, nowMs) {
  const latest = latestByAccount[row.account];
  if (latest && row.last_inventory_at < latest) return 'missing';
  if (!row.included) return 'excluded';
  if (!row.equipment_id) return 'unlinked';
  if (!row.last_seen_at) return 'waiting';
  const ageMs = nowMs - Date.parse(row.last_seen_at);
  if (ageMs > staleDays * 86400000) return 'stale';
  return 'ok';
}

export function listItems(db, nowMs = Date.now()) {
  const staleDays = getStaleDays(db);
  const rows = db.prepare(`
    SELECT ti.*, tm.name AS equipment_name
    FROM tracker_items ti
    LEFT JOIN team_members tm ON tm.id = ti.equipment_id
    WHERE ti.removed_at IS NULL
    ORDER BY ti.account, ti.kind = 'device', ti.name COLLATE NOCASE, ti.identifier
  `).all();
  const latestByAccount = {};
  for (const r of rows) {
    if (!latestByAccount[r.account] || r.last_inventory_at > latestByAccount[r.account]) {
      latestByAccount[r.account] = r.last_inventory_at;
    }
  }
  const removed = db.prepare(`
    SELECT identifier, account, name, emoji, kind, removed_at FROM tracker_items
    WHERE removed_at IS NOT NULL AND purged_at IS NULL ORDER BY removed_at DESC
  `).all();
  return {
    stale_days: staleDays,
    items: rows.map((r) => ({ ...r, status: itemStatus(r, latestByAccount, staleDays, nowMs) })),
    removed,
  };
}
