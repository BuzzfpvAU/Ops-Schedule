# Equipment Extended Fields Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add serial number, dimensions, weight, serviceable status, and SDS link fields to equipment; show warning icon for unserviceable equipment in the schedule.

**Architecture:** Extend the existing `team_members` table with 5 new columns via idempotent ALTER TABLE migrations. Update the POST/PUT API routes to handle the new fields. Update the EquipmentManager form and list UI, and add a warning icon in ScheduleGrid for unserviceable equipment.

**Tech Stack:** SQLite (better-sqlite3), Express.js, React (JSX)

**Spec:** `docs/superpowers/specs/2026-03-22-equipment-fields-design.md`

---

## Chunk 1: Database & API

### Task 1: Database Migration

**Files:**
- Modify: `server/src/db.js:92-109` (add after existing migrations)

- [ ] **Step 1: Add migration columns to db.js**

After line 109 (the `is_viewer` migration), add:

```javascript
  // Migrate: add equipment-specific columns
  if (!columns.includes('serial_number')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN serial_number TEXT DEFAULT ''`);
  }
  if (!columns.includes('dimensions')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN dimensions TEXT DEFAULT ''`);
  }
  if (!columns.includes('weight')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN weight TEXT DEFAULT ''`);
  }
  if (!columns.includes('serviceable')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN serviceable INTEGER DEFAULT 1`);
  }
  if (!columns.includes('sds_url')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN sds_url TEXT DEFAULT ''`);
  }
```

- [ ] **Step 2: Verify migration runs without errors**

Run: `cd /Users/buzzbot/Ops-Schedule && node -e "import('./server/src/db.js').then(m => { const db = m.initDb(); console.log(db.pragma('table_info(team_members)').map(c => c.name).join(', ')); db.close(); })"`

Expected: Column list includes `serial_number, dimensions, weight, serviceable, sds_url`

- [ ] **Step 3: Commit**

```bash
git add server/src/db.js
git commit -m "feat: add equipment extended field migrations (serial, dimensions, weight, serviceable, sds_url)"
```

---

### Task 2: API Route — POST (create)

**Files:**
- Modify: `server/src/routes/teams.js:37,41-44`

- [ ] **Step 1: Update POST destructuring and INSERT**

At line 37, expand the destructuring:
```javascript
    const { name, role, location, timezone, color, sort_order, is_equipment, info_url, email, password, is_admin, serial_number, dimensions, weight, serviceable, sds_url } = req.body;
```

Replace the INSERT statement (lines 41-44) with:
```javascript
    req.db.prepare(`
      INSERT INTO team_members (id, name, role, location, timezone, color, sort_order, is_equipment, info_url, serial_number, dimensions, weight, serviceable, sds_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, role || '', location || '', timezone || 'Australia/Sydney', color || '#3B82F6', sort_order || 0, is_equipment || 0, info_url || '', serial_number || '', dimensions || '', weight || '', serviceable !== undefined ? (serviceable ? 1 : 0) : 1, sds_url || '');
```

- [ ] **Step 2: Verify with curl**

Run server locally, then:
```bash
curl -s -X POST http://localhost:3001/api/team-members \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"Test Equipment","is_equipment":1,"serial_number":"SN-123","serviceable":true}' | jq '.serial_number, .serviceable'
```

Expected: `"SN-123"` and `1`

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/teams.js
git commit -m "feat: accept equipment extended fields in POST /team-members"
```

---

### Task 3: API Route — PUT (update)

**Files:**
- Modify: `server/src/routes/teams.js:70,74-87`

- [ ] **Step 1: Update PUT destructuring and UPDATE statement**

At line 70, expand the destructuring:
```javascript
    const { name, role, location, timezone, color, sort_order, info_url, email, password, is_admin, serial_number, dimensions, weight, serviceable, sds_url } = req.body;
```

Replace the UPDATE statement (lines 74-87) with:
```javascript
    req.db.prepare(`
      UPDATE team_members
      SET name = ?, role = ?, location = ?, timezone = ?, color = ?, sort_order = ?, info_url = ?,
          serial_number = ?, dimensions = ?, weight = ?, serviceable = ?, sds_url = ?,
          updated_at = datetime('now', '+10 hours')
      WHERE id = ?
    `).run(
      name || existing.name,
      role ?? existing.role,
      location ?? existing.location,
      timezone || existing.timezone,
      color || existing.color,
      sort_order ?? existing.sort_order,
      info_url ?? existing.info_url,
      serial_number ?? existing.serial_number ?? '',
      dimensions ?? existing.dimensions ?? '',
      weight ?? existing.weight ?? '',
      serviceable !== undefined ? (serviceable ? 1 : 0) : (existing.serviceable ?? 1),
      sds_url ?? existing.sds_url ?? '',
      req.params.id
    );
```

- [ ] **Step 2: Commit**

```bash
git add server/src/routes/teams.js
git commit -m "feat: accept equipment extended fields in PUT /team-members/:id"
```

---

## Chunk 2: Equipment Manager UI

### Task 4: Update Form State

**Files:**
- Modify: `client/src/components/EquipmentManager.jsx:21-23,47-54,57-64`

- [ ] **Step 1: Update default form state (line 21-23)**

Replace:
```javascript
  const [form, setForm] = useState({
    name: '', role: 'Equipment', location: '', timezone: 'Australia/Sydney', color: '#64748b', sort_order: 100, info_url: ''
  });
```

With:
```javascript
  const [form, setForm] = useState({
    name: '', role: 'Equipment', location: '', timezone: 'Australia/Sydney', color: '#64748b', sort_order: 100, info_url: '',
    serial_number: '', dimensions: '', weight: '', serviceable: true, sds_url: ''
  });
```

- [ ] **Step 2: Update openCreate (lines 47-54)**

Replace:
```javascript
  const openCreate = () => {
    setEditing(null);
    setForm({
      name: '', role: 'Equipment', location: '', timezone: 'Australia/Sydney',
      color: DEFAULT_COLORS[equipmentItems.length % DEFAULT_COLORS.length],
      sort_order: 100 + equipmentItems.length, info_url: ''
    });
    setShowModal(true);
  };
```

With:
```javascript
  const openCreate = () => {
    setEditing(null);
    setForm({
      name: '', role: 'Equipment', location: '', timezone: 'Australia/Sydney',
      color: DEFAULT_COLORS[equipmentItems.length % DEFAULT_COLORS.length],
      sort_order: 100 + equipmentItems.length, info_url: '',
      serial_number: '', dimensions: '', weight: '', serviceable: true, sds_url: ''
    });
    setShowModal(true);
  };
```

- [ ] **Step 3: Update openEdit (lines 57-64)**

Replace:
```javascript
  const openEdit = (item) => {
    setEditing(item);
    setForm({
      name: item.name, role: item.role || 'Equipment', location: item.location,
      timezone: item.timezone, color: item.color, sort_order: item.sort_order, info_url: item.info_url || ''
    });
    setShowModal(true);
  };
```

With:
```javascript
  const openEdit = (item) => {
    setEditing(item);
    setForm({
      name: item.name, role: item.role || 'Equipment', location: item.location,
      timezone: item.timezone, color: item.color, sort_order: item.sort_order, info_url: item.info_url || '',
      serial_number: item.serial_number || '', dimensions: item.dimensions || '',
      weight: item.weight || '', serviceable: item.serviceable !== 0, sds_url: item.sds_url || ''
    });
    setShowModal(true);
  };
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/EquipmentManager.jsx
git commit -m "feat: add equipment extended fields to form state"
```

---

### Task 5: Update Form Modal

**Files:**
- Modify: `client/src/components/EquipmentManager.jsx:186-249` (form fields in modal)

- [ ] **Step 1: Restructure the form fields**

Replace the form body (everything between `<form onSubmit={handleSubmit}>` and `<div className="modal-actions">`) with the new field order:

```jsx
              <div className="form-group">
                <label>Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. DJI M300 RTK"
                  required
                />
              </div>

              <div className="form-group">
                <label>Type / Description</label>
                <input
                  type="text"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  placeholder="e.g. Drone, Camera, Vehicle"
                />
              </div>

              <div className="form-group">
                <label>Serial Number</label>
                <input
                  type="text"
                  value={form.serial_number}
                  onChange={(e) => setForm({ ...form, serial_number: e.target.value })}
                  placeholder="e.g. 1ZNBC4A00CC000123"
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Dimensions (L x W x H)</label>
                  <input
                    type="text"
                    value={form.dimensions}
                    onChange={(e) => setForm({ ...form, dimensions: e.target.value })}
                    placeholder="e.g. 500 x 400 x 200 mm"
                  />
                </div>
                <div className="form-group">
                  <label>Weight</label>
                  <input
                    type="text"
                    value={form.weight}
                    onChange={(e) => setForm({ ...form, weight: e.target.value })}
                    placeholder="e.g. 6.3 kg"
                  />
                </div>
              </div>

              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="checkbox"
                  id="serviceable-checkbox"
                  checked={form.serviceable}
                  onChange={(e) => setForm({ ...form, serviceable: e.target.checked })}
                  style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
                />
                <label htmlFor="serviceable-checkbox" style={{ margin: 0, cursor: 'pointer' }}>Serviceable</label>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>State / Location</label>
                  <select
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    required
                  >
                    <option value="">Select state...</option>
                    {LOCATIONS.map(loc => (
                      <option key={loc} value={loc}>{loc}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Sort Order</label>
                  <input
                    type="number"
                    value={form.sort_order}
                    onChange={(e) => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Color</label>
                <div className="color-swatch-grid">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      className={`color-swatch${form.color === c ? ' selected' : ''}`}
                      style={{ background: c }}
                      onClick={() => setForm({ ...form, color: c })}
                      title={c}
                    />
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  SDS Link
                  {form.sds_url && (
                    <a href={form.sds_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Open SDS link" style={{ color: 'var(--accent)', display: 'inline-flex' }}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6.5 3.5H3a1 1 0 00-1 1V13a1 1 0 001 1h8.5a1 1 0 001-1V9.5M9.5 2h4.5v4.5M14 2L7.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </a>
                  )}
                </label>
                <input
                  type="url"
                  value={form.sds_url}
                  onChange={(e) => setForm({ ...form, sds_url: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Tagz.au Link
                  {form.info_url && (
                    <a href={form.info_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Open Tagz.au link" style={{ color: 'var(--accent)', display: 'inline-flex' }}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6.5 3.5H3a1 1 0 00-1 1V13a1 1 0 001 1h8.5a1 1 0 001-1V9.5M9.5 2h4.5v4.5M14 2L7.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </a>
                  )}
                </label>
                <input
                  type="url"
                  value={form.info_url}
                  onChange={(e) => setForm({ ...form, info_url: e.target.value })}
                  placeholder="https://tagz.au/..."
                />
              </div>
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/EquipmentManager.jsx
git commit -m "feat: restructure equipment form with new fields and link icons"
```

---

### Task 6: Update Equipment List Display

**Files:**
- Modify: `client/src/components/EquipmentManager.jsx:130-163` (list item rendering)

- [ ] **Step 1: Update the list item to show new fields and badges**

Replace the list item div content (lines 130-163) with:

```jsx
                    <div key={item.id} className="list-item equipment-list-item">
                      <div className="list-item-info">
                        <div className="member-avatar equipment-avatar clickable" style={{ background: item.color, cursor: 'pointer' }} onClick={() => openEdit(item)} title="Edit equipment">
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M7 1v4M5 3h4M2 7h10v5H2z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                            {item.name}
                            {item.serviceable === 0 && (
                              <span title="Unserviceable" style={{ color: '#f59e0b', fontSize: 14 }}>&#9888;</span>
                            )}
                            {item.sds_url && (
                              <a href={item.sds_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Safety Data Sheet" style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center' }}>
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6.5 3.5H3a1 1 0 00-1 1V13a1 1 0 001 1h8.5a1 1 0 001-1V9.5M9.5 2h4.5v4.5M14 2L7.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              </a>
                            )}
                            {item.info_url && (
                              <a href={item.info_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Tagz.au link" style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center' }}>
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6.5 3.5H3a1 1 0 00-1 1V13a1 1 0 001 1h8.5a1 1 0 001-1V9.5M9.5 2h4.5v4.5M14 2L7.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              </a>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                            {item.role || 'Equipment'}
                            {item.serial_number && <span> &middot; S/N: {item.serial_number}</span>}
                          </div>
                          {(item.dimensions || item.weight) && (
                            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>
                              {item.dimensions && <span>{item.dimensions}</span>}
                              {item.dimensions && item.weight && <span> &middot; </span>}
                              {item.weight && <span>{item.weight}</span>}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="list-item-actions">
                        <button className="btn btn-sm" onClick={() => openEdit(item)}>Edit</button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDelete(item)}>Remove</button>
                      </div>
                    </div>
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/EquipmentManager.jsx
git commit -m "feat: show serial number, dimensions, weight, and badges in equipment list"
```

---

## Chunk 3: Schedule Grid Warning Icon & Deploy

### Task 7: Add Warning Icon in Schedule Grid

**Files:**
- Modify: `client/src/components/ScheduleGrid.jsx:765-766` (equipment name in schedule rows)

- [ ] **Step 1: Add unserviceable warning icon after equipment name**

At line 765-766, replace:
```jsx
                                <span className="name" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  {item.name}
```

With:
```jsx
                                <span className="name" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  {item.name}
                                  {item.serviceable === 0 && (
                                    <span title="Unserviceable" style={{ color: '#f59e0b', fontSize: 13 }}>&#9888;</span>
                                  )}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/ScheduleGrid.jsx
git commit -m "feat: show warning icon for unserviceable equipment in schedule"
```

---

### Task 8: Update ScheduleGrid Edit Modal (for equipment)

**Files:**
- Modify: `client/src/components/ScheduleGrid.jsx:1193-1197` (inline edit modal for equipment)

- [ ] **Step 1: Find the equipment edit modal section and verify it exists**

The ScheduleGrid has an inline edit modal at ~line 1193 that shows the info_url field for equipment. This modal should also be updated to include the new fields, or at minimum not break. Since the full EquipmentManager modal is the primary editing UI, just rename the label here:

Replace (around line 1195):
```jsx
                  <label>Info / Documentation Link</label>
```

With:
```jsx
                  <label>Tagz.au Link</label>
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/ScheduleGrid.jsx
git commit -m "feat: rename equipment link label to Tagz.au in schedule edit modal"
```

---

### Task 9: Mirror to Deploy & Push

**Files:**
- Copy: `server/src/db.js` -> `deploy/server/src/db.js`
- Copy: `server/src/routes/teams.js` -> `deploy/server/src/routes/teams.js`
- Copy: `client/src/components/EquipmentManager.jsx` -> `deploy/client/src/components/EquipmentManager.jsx`
- Copy: `client/src/components/ScheduleGrid.jsx` -> `deploy/client/src/components/ScheduleGrid.jsx`

- [ ] **Step 1: Copy all changed files to deploy/**

```bash
cp server/src/db.js deploy/server/src/db.js
cp server/src/routes/teams.js deploy/server/src/routes/teams.js
cp client/src/components/EquipmentManager.jsx deploy/client/src/components/EquipmentManager.jsx
cp client/src/components/ScheduleGrid.jsx deploy/client/src/components/ScheduleGrid.jsx
```

- [ ] **Step 2: Commit deploy changes**

```bash
cd deploy && git add -A && git commit -m "feat: equipment extended fields - serial, dimensions, weight, serviceable, SDS link" && git push origin main
```

- [ ] **Step 3: Commit submodule reference in main repo**

```bash
cd /Users/buzzbot/Ops-Schedule && git add deploy && git commit -m "chore: update deploy submodule with equipment fields"
```

---

### Task 10: Verify on Live

- [ ] **Step 1: Wait for Hostinger deployment, then verify**

Open the live site. Go to Equipment tab. Edit an equipment item. Verify:
- All 5 new fields appear in the form in correct order
- Serviceable checkbox defaults to checked
- SDS Link and Tagz.au Link have clickable external link icons
- Saving works without errors
- Setting an item to unserviceable shows ⚠️ in both equipment list and schedule grid
- Existing equipment data is preserved (no fields lost)
