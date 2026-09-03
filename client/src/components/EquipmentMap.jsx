import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getEquipmentLocations, getEquipmentLocationHistory, reportEquipmentLocation } from '../api.js';

const AUSTRALIA_CENTER = [-25.2744, 133.7751];
const STALE_MS = 24 * 60 * 60 * 1000;
const VERY_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function timeAgo(iso) {
  if (!iso) return 'Never seen';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function staleness(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff > VERY_STALE_MS) return 'very-stale';
  if (diff > STALE_MS) return 'stale';
  return 'fresh';
}

function pinHtml(item) {
  const state = staleness(item.seen_at);
  return `<div class="eq-pin ${state}" style="--pin:${item.color || '#64748b'}"><span class="eq-pin-dot"></span></div>`;
}

export default function EquipmentMap({ showToast }) {
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const trailRef = useRef(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { item } | null
  const [form, setForm] = useState({ lat: '', lng: '', accuracy: '' });
  const [pickMode, setPickMode] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Map init (once) ──
  useEffect(() => {
    const map = L.map(mapDivRef.current, { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    map.setView(AUSTRALIA_CENTER, 4);
    markersRef.current = L.layerGroup().addTo(map);
    trailRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // ── Map click: pick-mode fills the form ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e) => {
      if (pickMode) {
        setForm(f => ({ ...f, lat: e.latlng.lat.toFixed(6), lng: e.latlng.lng.toFixed(6) }));
        setPickMode(false);
      }
    };
    map.on('click', handler);
    return () => map.off('click', handler);
  }, [pickMode]);

  // ── Data load ──
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const rows = await getEquipmentLocations();
      setItems(rows);
    } catch (err) {
      showToast('Failed to load locations: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  // ── Markers re-render on items change ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !markersRef.current) return;
    const group = markersRef.current;
    group.clearLayers();
    trailRef.current.clearLayers();

    const withLocation = items.filter(i => i.lat != null && i.lng != null);

    withLocation.forEach(item => {
      const icon = L.divIcon({ className: '', html: pinHtml(item), iconSize: [22, 30], iconAnchor: [11, 28] });
      const popup = document.createElement('div');
      popup.innerHTML = `
        <div class="eq-popup">
          <div class="eq-popup-name">${escapeHtml(item.name)}</div>
          <div class="eq-popup-meta">${escapeHtml(item.role || 'Equipment')}${item.serial_number ? ' · S/N ' + escapeHtml(item.serial_number) : ''}</div>
          ${item.airtag_name ? `<div class="eq-popup-meta">AirTag: ${escapeHtml(item.airtag_name)}</div>` : ''}
          <div class="eq-popup-last">Last seen: ${escapeHtml(timeAgo(item.seen_at))}</div>
          <div class="eq-popup-meta">${item.seen_at ? new Date(item.seen_at).toLocaleString('en-AU', { timeZone: 'Australia/Perth' }) : ''}</div>
          ${item.battery ? `<div class="eq-popup-meta">Battery: ${escapeHtml(item.battery)}</div>` : ''}
          ${item.accuracy != null ? `<div class="eq-popup-meta">Accuracy: ±${Math.round(item.accuracy)} m</div>` : ''}
          <div class="eq-popup-meta">Source: ${item.source === 'airtag' ? 'AirTag' : 'Manual'}</div>
        </div>`;
      const marker = L.marker([item.lat, item.lng], { icon }).addTo(group).bindPopup(popup);

      // Draw last-30d trail when the popup opens
      marker.on('popupopen', async () => {
        try {
          const trail = await getEquipmentLocationHistory(item.id, 30);
          if (!trailRef.current) return;
          trailRef.current.clearLayers();
          if (trail.length > 1) {
            L.polyline(trail.map(t => [t.lat, t.lng]), { color: item.color || '#64748b', weight: 2, opacity: 0.6, dashArray: '4 6' }).addTo(trailRef.current);
          }
        } catch { /* trail is optional */ }
      });
    });

    if (withLocation.length > 0) {
      const firstLoad = !mapRef.current._fitted;
      if (firstLoad) {
        map.fitBounds(L.latLngBounds(withLocation.map(i => [i.lat, i.lng])), { padding: [40, 40], maxZoom: 6 });
        mapRef.current._fitted = true;
      }
    }
  }, [items]);

  const flyTo = (item) => {
    if (item.lat == null || item.lng == null) {
      showToast('No location recorded for this equipment yet', 'info');
      return;
    }
    mapRef.current?.flyTo([item.lat, item.lng], 12);
    // open the matching popup
    markersRef.current?.eachLayer(m => {
      const ll = m.getLatLng();
      if (Math.abs(ll.lat - item.lat) < 1e-6 && Math.abs(ll.lng - item.lng) < 1e-6) m.openPopup();
    });
  };

  const openSetLocation = (item) => {
    setModal({ item });
    setForm({ lat: item.lat != null ? item.lat : '', lng: item.lng != null ? item.lng : '', accuracy: '' });
  };

  const saveLocation = async (e) => {
    e.preventDefault();
    const lat = parseFloat(form.lat);
    const lng = parseFloat(form.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      showToast('Enter valid latitude (-90..90) and longitude (-180..180)', 'error');
      return;
    }
    try {
      setSaving(true);
      await reportEquipmentLocation({
        member_id: modal.item.id,
        lat, lng,
        accuracy: form.accuracy ? parseFloat(form.accuracy) : null,
        source: 'manual',
      });
      showToast(`Location saved for ${modal.item.name}`, 'success');
      setModal(null);
      setPickMode(false);
      await load();
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const locatedCount = items.filter(i => i.lat != null).length;

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3>Equipment Map</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="equipment-count-badge">{locatedCount}/{items.length} located</span>
            <button className="btn" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
          </div>
        </div>

        <div className="eq-map-layout">
          <div className="eq-map-sidebar">
            <div className="eq-map-legend">
              <span><span className="eq-legend-dot fresh" /> Fresh (&lt;24h)</span>
              <span><span className="eq-legend-dot stale" /> Stale (1–7d)</span>
              <span><span className="eq-legend-dot very-stale" /> Very stale (&gt;7d)</span>
            </div>
            {items.length === 0 && !loading && (
              <p style={{ color: 'var(--text-dim)', padding: 16, fontSize: 13 }}>No equipment registered.</p>
            )}
            {items.map(item => (
              <div key={item.id} className={`eq-map-row ${item.lat == null ? 'no-loc' : ''}`}>
                <span className="eq-map-dot" style={{ background: item.color || '#64748b' }} />
                <div className="eq-map-row-info">
                  <div className="eq-map-row-name" title={item.name}>{item.name}</div>
                  <div className={`eq-map-row-last ${staleness(item.seen_at)}`}>{timeAgo(item.seen_at)}</div>
                </div>
                <div className="eq-map-row-actions">
                  <button className="btn btn-sm" title="Locate on map" onClick={() => flyTo(item)} disabled={item.lat == null}>◎</button>
                  <button className="btn btn-sm" title="Set location" onClick={() => openSetLocation(item)}>📍</button>
                </div>
              </div>
            ))}
          </div>
          <div className="eq-map-container">
            <div ref={mapDivRef} style={{ height: '100%', width: '100%' }} />
          </div>
        </div>
      </div>

      {modal && (
        <div className="modal-overlay" onClick={() => { setModal(null); setPickMode(false); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Set Location — {modal.item.name}</h2>
            <p className="modal-subtitle">Record where this equipment is now.</p>
            <form onSubmit={saveLocation}>
              <div className="form-group">
                <button
                  type="button"
                  className={`btn ${pickMode ? 'btn-primary' : ''}`}
                  onClick={() => setPickMode(p => !p)}
                >
                  {pickMode ? '✓ Click the map to drop a pin…' : 'Pick on map'}
                </button>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Latitude *</label>
                  <input type="number" step="any" value={form.lat} onChange={e => setForm({ ...form, lat: e.target.value })} placeholder="-31.9505" required />
                </div>
                <div className="form-group">
                  <label>Longitude *</label>
                  <input type="number" step="any" value={form.lng} onChange={e => setForm({ ...form, lng: e.target.value })} placeholder="115.8605" required />
                </div>
              </div>
              <div className="form-group">
                <label>Accuracy (metres, optional)</label>
                <input type="number" min="0" step="any" value={form.accuracy} onChange={e => setForm({ ...form, accuracy: e.target.value })} placeholder="e.g. 25" />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => { setModal(null); setPickMode(false); }}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Location'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
