import React, { useEffect, useState } from 'react';
import { Section } from './ui.jsx';
import {
  getTrackerItems, updateTrackerItem, deleteTrackerItem, setTrackerStaleDays, getEquipment,
} from '../api.js';
import { groupItems, headerCounts, statusText, STATUS_TONE } from '../lib/tracker.js';

// Every Find My item the tracker Mac holds keys for. Nothing is located
// until it is included here; tags are matched to equipment by their
// permanent identifier, so Find My names no longer matter.

function Row({ item, equipment, holders, onChange, onDelete, busy }) {
  const isDevice = item.kind === 'device';
  const toggle = (e) => {
    const on = e.target.checked;
    if (on && isDevice && !window.confirm(`This will track the location of ${item.name}, a personal device. Continue?`)) return;
    onChange(item, { included: on });
  };
  const link = (e) => {
    const equipment_id = e.target.value || null;
    const holder = equipment_id && holders.get(equipment_id);
    if (holder && holder.identifier !== item.identifier) {
      if (!window.confirm(`${holder.name} is linked to that equipment. Move the link to ${item.name}?`)) return;
      onChange(item, { equipment_id, move: true });
      return;
    }
    onChange(item, { equipment_id });
  };
  return (
    <div className={`tt-row${item.included ? '' : ' is-off'}`}>
      <label className="tt-name">
        <input type="checkbox" checked={!!item.included} onChange={toggle} disabled={busy}
          aria-label={`Track ${item.name || item.identifier}`} />
        <span className="tt-emoji">{item.emoji || (isDevice ? '💻' : '🏷')}</span>
        <span>
          <span className="entry-name">{item.name || item.identifier}</span>
          {isDevice && <span className="tag tag-mute" style={{ marginLeft: 6 }}>Apple device</span>}
          <span className="rl-sub tt-serial">{item.serial_number || item.model || item.identifier}</span>
        </span>
      </label>
      <select className="tt-link" value={item.equipment_id || ''} onChange={link} disabled={busy}
        aria-label={`Equipment for ${item.name || item.identifier}`}>
        <option value="">Not linked</option>
        {equipment.map((eq) => {
          const holder = holders.get(eq.id);
          const other = holder && holder.identifier !== item.identifier;
          return (
            <option key={eq.id} value={eq.id}>
              {eq.name}{other ? ` (linked to ${holder.name})` : ''}
            </option>
          );
        })}
      </select>
      <span className={`tag tag-${STATUS_TONE[item.status] || 'mute'} tt-status`}>{statusText(item)}</span>
      {item.status === 'missing' && (
        <button className="btn btn-danger" disabled={busy} onClick={() => onDelete(item)}>Delete</button>
      )}
    </div>
  );
}

export default function TrackerTags({ showToast }) {
  const [data, setData] = useState(null);
  const [equipment, setEquipment] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [d, eq] = await Promise.all([getTrackerItems(), getEquipment()]);
      setData(d);
      setEquipment(eq.slice().sort((a, b) => a.name.localeCompare(b.name)));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const run = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      await load();
      showToast?.(ok, 'success');
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Section title="Tags"><div className="banner banner-danger">{error}</div></Section>;
  if (!data) return <Section title="Tags"><div className="rl-sub">Loading…</div></Section>;

  const items = data.items;
  const counts = headerCounts(items);
  const holders = new Map(items.filter((i) => i.equipment_id).map((i) => [i.equipment_id, i]));
  const onChange = (item, patch) => run(() => updateTrackerItem(item.identifier, patch), `${item.name} updated — applies on the next sync`);
  const onDelete = (item) => run(() => deleteTrackerItem(item.identifier), `${item.name} removed`);

  return (
    <Section title="Tags">
      <div className="tt-head">
        <span>
          {counts.tags} tag{counts.tags === 1 ? '' : 's'} · {counts.tracked} tracked
          {counts.stale > 0 && <> · <strong className="tt-stale">{counts.stale} stale (&gt; {data.stale_days} days)</strong></>}
          {counts.devicesHidden > 0 && <> · {counts.devicesHidden} device{counts.devicesHidden === 1 ? '' : 's'} hidden</>}
        </span>
        <label className="tt-stale-input">
          Stale after
          <input
            type="number" min="1" max="60" defaultValue={data.stale_days} disabled={busy}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 60) run(() => setTrackerStaleDays(n), `Stale after ${n} days`);
            }}
          />
          days
        </label>
      </div>

      {items.length === 0 && (
        <div className="banner banner-warn">
          Nothing reported yet. The list fills in after the tracker Mac&rsquo;s next sync.
        </div>
      )}

      {groupItems(items).map((g) => (
        <div key={g.account} className="tt-group">
          <div className="tt-account">{g.account}</div>
          {g.tags.map((it) => (
            <Row key={it.identifier} item={it} equipment={equipment} holders={holders}
              onChange={onChange} onDelete={onDelete} busy={busy} />
          ))}
          {g.devices.length > 0 && (
            <details className="tt-devices">
              <summary>{g.devices.length} Apple device{g.devices.length === 1 ? '' : 's'} — hidden</summary>
              {g.devices.map((it) => (
                <Row key={it.identifier} item={it} equipment={equipment} holders={holders}
                  onChange={onChange} onDelete={onDelete} busy={busy} />
              ))}
            </details>
          )}
        </div>
      ))}
    </Section>
  );
}
