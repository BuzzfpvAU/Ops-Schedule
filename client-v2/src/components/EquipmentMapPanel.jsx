import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getEquipmentLocationHistory } from '../api.js';
import { bubbleFor } from '../lib/equipmentPlan.js';

const TONE_COLOR = { ok: '#2b8a3e', warn: '#e67700', danger: '#c92a2a', mute: '#868e96' };
const keyOf = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

// Where the equipment is, for the rows the timeline is showing. Selection is
// owned by the parent so the row list and the map always agree.
export default function EquipmentMapPanel({ points, sites, notOnMap, selectedId, onSelect }) {
  const el = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const trail = useRef(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([-25.5, 134], 4);
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    let errors = 0;
    tiles.on('tileerror', () => { errors += 1; if (errors > 8) setBroken(true); });
    layer.current = L.layerGroup().addTo(m);
    trail.current = L.layerGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => { ro.disconnect(); m.remove(); };
  }, []);

  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    for (const s of sites) {
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'eqm-site', html: `<span title="${s.code}">🏗<b>${s.code}</b></span>`, iconSize: null }),
        interactive: false,
      }).addTo(g);
    }
    const groups = new Map();
    for (const p of points) {
      const k = keyOf(p);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const list of groups.values()) {
      const p = list[0];
      const sel = list.some((x) => x.id === selectedId);
      const b = bubbleFor(list);
      const cls = `eqm-count tone-${b.tone}${b.approx ? ' is-approx' : ''}${sel ? ' is-sel' : ''}`;
      const m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: 'eqm-group', html: `<span class="${cls}">${b.count}</span>`, iconSize: [26, 26] }),
        zIndexOffset: sel ? 1000 : 0,
      });
      if (list.length === 1) {
        m.on('click', () => onSelect(p.id)).bindTooltip(p.name);
      } else {
        const box = document.createElement('div');
        box.className = 'eqm-popup';
        for (const x of list) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = x.name;
          btn.onclick = () => onSelect(x.id);
          box.appendChild(btn);
        }
        m.bindPopup(box).bindTooltip(`${list.length} items`);
      }
      m.addTo(g);
    }
  }, [points, sites, selectedId, onSelect]);

  // Pan to the selection and draw its 7-day trail when it has a tag.
  useEffect(() => {
    const m = map.current;
    trail.current?.clearLayers();
    const p = points.find((x) => x.id === selectedId);
    if (!m || !p) return;
    m.panTo([p.lat, p.lng]);
    if (p.source !== 'tag') return;
    let alive = true;
    getEquipmentLocationHistory(p.id, 7).then((rows) => {
      if (!alive || !rows?.length) return;
      L.polyline(rows.map((r) => [r.lat, r.lng]), { color: '#3b5bdb', weight: 2, opacity: 0.7 }).addTo(trail.current);
    }).catch(() => {});
    return () => { alive = false; };
  }, [selectedId, points]);

  const fit = () => {
    const all = [...points, ...sites].map((p) => [p.lat, p.lng]);
    if (all.length) map.current.fitBounds(all, { padding: [30, 30], maxZoom: 11 });
  };

  return (
    <div className="eqm">
      <div className="eqm-map" ref={el}>
        {broken && <div className="eqm-broken">Map unavailable — the timeline still works.</div>}
      </div>
      <div className="eqm-foot">
        <button type="button" className="btn" onClick={fit}>Fit</button>
        {notOnMap.length > 0 && (
          <details className="eqm-nomap">
            <summary>Not on map ({notOnMap.length})</summary>
            {notOnMap.map((r) => (
              <button type="button" key={r.id} className="rl-loc" onClick={() => onSelect(r.id)}>{r.name} — {r.label}</button>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}
