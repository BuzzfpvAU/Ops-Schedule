// Pure helpers for the Settings → Tracking tag list.

export const STATUS_TONE = {
  missing: 'mute', excluded: 'mute', unlinked: 'warn', waiting: 'warn', stale: 'danger', ok: 'ok',
};

export function groupItems(items) {
  const byAccount = new Map();
  for (const it of items || []) {
    if (!byAccount.has(it.account)) byAccount.set(it.account, { account: it.account, tags: [], devices: [] });
    byAccount.get(it.account)[it.kind === 'device' ? 'devices' : 'tags'].push(it);
  }
  return [...byAccount.values()];
}

export function headerCounts(items) {
  const tags = (items || []).filter((i) => i.kind !== 'device');
  return {
    tags: tags.length,
    tracked: tags.filter((i) => i.included && i.equipment_id).length,
    stale: tags.filter((i) => i.status === 'stale').length,
    devicesHidden: (items || []).filter((i) => i.kind === 'device' && !i.included).length,
  };
}

function ageText(iso, nowMs) {
  const mins = Math.round((nowMs - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

export function statusText(item, nowMs = Date.now()) {
  switch (item.status) {
    case 'missing': return 'Missing from last export';
    case 'excluded': return 'Not included';
    case 'unlinked': return 'Not linked';
    case 'waiting': return 'Waiting for first report';
    case 'stale': {
      const days = Math.floor((nowMs - Date.parse(item.last_seen_at)) / 86400000);
      return `Stale · ${days} day${days === 1 ? '' : 's'}`;
    }
    default:
      return `Seen ${ageText(item.last_seen_at, nowMs)}${item.battery ? ` · ${item.battery}` : ''}`;
  }
}
