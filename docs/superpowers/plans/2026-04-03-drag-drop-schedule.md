# Drag-and-Drop Schedule Assignments Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable admins to drag-and-drop job assignments between days and team members on the schedule grid, with multi-day span support and collision warnings.

**Architecture:** HTML5 Drag and Drop API with press-and-hold activation (300ms). Server-side atomic move endpoint wraps delete+create in a single SQLite transaction. Database unique constraint removed to allow temporary collisions during planning. Client-side `scheduleMap` changes from single-entry to array-of-entries per cell.

**Tech Stack:** React (existing), HTML5 DnD API, Express/SQLite (existing), better-sqlite3

**Spec:** `docs/superpowers/specs/2026-04-03-drag-drop-schedule-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/src/db.js` | Modify | Migration to remove UNIQUE constraint |
| `server/src/routes/schedule.js` | Modify | New move endpoint, update existing endpoints for multi-entry |
| `client/src/api.js` | Modify | Add `moveScheduleEntries()`, update status/notes callers to use entry ID |
| `client/src/components/ScheduleGrid.jsx` | Modify | Drag-and-drop logic, scheduleMap→arrays, collision rendering |
| `client/src/styles.css` | Modify | Drag feedback, collision highlights, stacked cell styles |

---

## Chunk 1: Database Migration & Server Endpoints

### Task 1: Database Migration — Remove UNIQUE Constraint

**Files:**
- Modify: `server/src/db.js` (after line 90, before the "Migrate: add auth columns" section)

- [ ] **Step 1: Add migration to remove UNIQUE(team_member_id, date) constraint**

In `server/src/db.js`, add this migration block after the CREATE TABLE / CREATE INDEX statements (after line 90) and before the "Migrate: add auth columns" section (line 92):

```javascript
  // Migrate: remove UNIQUE(team_member_id, date) to allow multiple entries per cell
  const hasUniqueConstraint = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='schedule_entries'"
  ).get();
  if (hasUniqueConstraint && hasUniqueConstraint.sql.includes('UNIQUE(team_member_id, date)')) {
    console.log('Migrating: removing UNIQUE(team_member_id, date) constraint...');
    db.transaction(() => {
    db.exec(`
      CREATE TABLE schedule_entries_new (
        id TEXT PRIMARY KEY,
        team_member_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        date TEXT NOT NULL,
        notes TEXT DEFAULT '',
        status TEXT DEFAULT 'tentative',
        created_at TEXT DEFAULT (datetime('now', '+10 hours')),
        updated_at TEXT DEFAULT (datetime('now', '+10 hours')),
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      INSERT INTO schedule_entries_new SELECT * FROM schedule_entries;
      DROP TABLE schedule_entries;
      ALTER TABLE schedule_entries_new RENAME TO schedule_entries;
      CREATE INDEX idx_schedule_date ON schedule_entries(date);
      CREATE INDEX idx_schedule_member ON schedule_entries(team_member_id);
      CREATE INDEX idx_schedule_job ON schedule_entries(job_id);
      CREATE INDEX idx_schedule_member_date ON schedule_entries(team_member_id, date);
    `);
    })();
    console.log('Migration complete: UNIQUE constraint removed');
  }
```

- [ ] **Step 2: Update initial CREATE TABLE to not include UNIQUE constraint**

Also update the initial `CREATE TABLE IF NOT EXISTS schedule_entries` block (line 58-70) to remove the `UNIQUE(team_member_id, date)` line, so new databases are created without it:

Change line 69 from:
```
      UNIQUE(team_member_id, date)
```
to remove that line entirely. The closing `);` on line 70 stays.

- [ ] **Step 3: Test the migration**

Run: `cd server && node -e "import('./src/db.js').then(m => { const db = m.initDb(); console.log('OK'); process.exit(0); })"`

Expected: "Migrating: removing UNIQUE..." message (if existing DB), then "OK". Verify by checking:
```bash
cd server && node -e "import('./src/db.js').then(m => { const db = m.initDb(); const sql = db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table' AND name='schedule_entries'\").get(); console.log(sql.sql); process.exit(0); })"
```
Should NOT contain "UNIQUE".

- [ ] **Step 4: Commit**

```bash
git add server/src/db.js
git commit -m "feat: migration to remove UNIQUE(team_member_id, date) constraint

Allows multiple schedule entries per member per day for drag-and-drop
collision support during planning."
```

---

### Task 2: New POST /api/schedule/move Endpoint

**Files:**
- Modify: `server/src/routes/schedule.js` (add new route before the DELETE routes, around line 191)

- [ ] **Step 1: Add the atomic move endpoint**

Add this route in `server/src/routes/schedule.js` before the `DELETE /:id` route (before line 192):

```javascript
// POST move schedule entries atomically (admin only)
router.post('/move', requireAdmin, (req, res) => {
  const { entry_ids, target_member_id, target_start_date } = req.body;
  if (!entry_ids || !Array.isArray(entry_ids) || entry_ids.length === 0) {
    return res.status(400).json({ error: 'entry_ids array is required' });
  }
  if (!target_member_id || !target_start_date) {
    return res.status(400).json({ error: 'target_member_id and target_start_date are required' });
  }

  // Validate target member exists
  const targetMember = req.db.prepare('SELECT id FROM team_members WHERE id = ?').get(target_member_id);
  if (!targetMember) {
    return res.status(400).json({ error: 'Target member not found' });
  }

  // Look up all source entries
  const placeholders = entry_ids.map(() => '?').join(',');
  const sourceEntries = req.db.prepare(
    `SELECT * FROM schedule_entries WHERE id IN (${placeholders}) ORDER BY date ASC`
  ).all(...entry_ids);

  if (sourceEntries.length !== entry_ids.length) {
    const found = new Set(sourceEntries.map(e => e.id));
    const missing = entry_ids.filter(id => !found.has(id));
    return res.status(400).json({ error: `Entries not found: ${missing.join(', ')}` });
  }

  // Calculate date offset from first source entry to target start date
  const firstSourceDate = new Date(sourceEntries[0].date);
  const targetDate = new Date(target_start_date);
  const dayOffset = Math.round((targetDate - firstSourceDate) / 86400000);

  // Perform move in a single transaction
  const moveTransaction = req.db.transaction(() => {
    const newEntries = [];
    const insertStmt = req.db.prepare(`
      INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const deleteStmt = req.db.prepare('DELETE FROM schedule_entries WHERE id = ?');

    for (const entry of sourceEntries) {
      // Calculate new date
      const oldDate = new Date(entry.date);
      const newDate = new Date(oldDate);
      newDate.setDate(newDate.getDate() + dayOffset);
      const newDateStr = newDate.toISOString().slice(0, 10);
      const newId = uuidv4();

      insertStmt.run(newId, target_member_id, entry.job_id, newDateStr, entry.notes || '', entry.status || 'tentative');
      deleteStmt.run(entry.id);

      newEntries.push({
        id: newId,
        team_member_id: target_member_id,
        job_id: entry.job_id,
        date: newDateStr,
        notes: entry.notes,
        status: entry.status
      });
    }
    return newEntries;
  });

  try {
    const newEntries = moveTransaction();

    // Fetch full entries with joins for the response
    const newPlaceholders = newEntries.map(() => '?').join(',');
    const fullEntries = req.db.prepare(`
      SELECT
        se.id, se.team_member_id, se.job_id, se.date, se.notes, se.status,
        tm.name as member_name, tm.color as member_color, tm.timezone,
        j.code as job_code, j.name as job_name, j.color as job_color,
        j.file_url as job_file_url, j.description as job_description
      FROM schedule_entries se
      JOIN team_members tm ON se.team_member_id = tm.id
      JOIN jobs j ON se.job_id = j.id
      WHERE se.id IN (${newPlaceholders})
      ORDER BY se.date ASC
    `).all(...newEntries.map(e => e.id));

    res.json({
      success: true,
      entries: fullEntries,
      _notification: {
        type: 'moved',
        team_member_id: target_member_id,
        dates: fullEntries.map(e => e.date)
      }
    });
  } catch (err) {
    console.error('Move transaction failed:', err);
    res.status(500).json({ error: 'Move failed: ' + err.message });
  }
});
```

- [ ] **Step 2: Add requireAdmin to DELETE /:id**

Change line 193 from:
```javascript
router.delete('/:id', (req, res) => {
```
to:
```javascript
router.delete('/:id', requireAdmin, (req, res) => {
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/schedule.js
git commit -m "feat: add POST /api/schedule/move atomic endpoint, secure DELETE by ID"
```

---

### Task 3: Update Existing Server Endpoints for Multi-Entry

**Files:**
- Modify: `server/src/routes/schedule.js`

- [ ] **Step 1: Update PUT / (single assign) for multi-entry support**

Replace the existing `PUT /` route handler (lines 55-115) with:

```javascript
// PUT assign/update a schedule entry (upsert)
router.put('/', (req, res) => {
  const { team_member_id, job_id, date, notes, status, entry_id } = req.body;
  if (!team_member_id || !job_id || !date) {
    return res.status(400).json({ error: 'team_member_id, job_id, and date are required' });
  }

  // Permission check for non-admins
  if (!req.user.isAdmin) {
    if (team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }
    if (!USER_ALLOWED_STATUSES.includes(status)) {
      return res.status(403).json({ error: 'You can only add notes, TOIL, leave, or unavailable entries' });
    }
  }

  let id;
  let isNew = true;
  let previousJobId = null;

  if (entry_id) {
    // Update specific entry by ID
    const existing = req.db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(entry_id);
    if (!existing) {
      return res.status(404).json({ error: 'Schedule entry not found' });
    }
    previousJobId = existing.job_id;
    req.db.prepare(`
      UPDATE schedule_entries
      SET job_id = ?, notes = ?, status = ?, updated_at = datetime('now', '+10 hours')
      WHERE id = ?
    `).run(job_id, notes || '', status || existing.status || 'tentative', entry_id);
    id = entry_id;
    isNew = false;
  } else {
    // Check for existing entries by member+date
    const existing = req.db.prepare(
      'SELECT * FROM schedule_entries WHERE team_member_id = ? AND date = ?'
    ).all(team_member_id, date);

    if (existing.length === 1) {
      // Exactly one: update it (preserves non-admin upsert behavior)
      previousJobId = existing[0].job_id;
      req.db.prepare(`
        UPDATE schedule_entries
        SET job_id = ?, notes = ?, status = ?, updated_at = datetime('now', '+10 hours')
        WHERE id = ?
      `).run(job_id, notes || '', status || existing[0].status || 'tentative', existing[0].id);
      id = existing[0].id;
      isNew = false;
    } else {
      // Zero or multiple: insert new
      id = uuidv4();
      req.db.prepare(`
        INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, team_member_id, job_id, date, notes || '', status || 'tentative');
    }
  }

  const entry = req.db.prepare(`
    SELECT
      se.id, se.team_member_id, se.job_id, se.date, se.notes, se.status,
      tm.name as member_name,
      j.code as job_code, j.name as job_name, j.color as job_color
    FROM schedule_entries se
    JOIN team_members tm ON se.team_member_id = tm.id
    JOIN jobs j ON se.job_id = j.id
    WHERE se.id = ?
  `).get(id);

  const isChanged = !isNew && previousJobId !== job_id;

  res.json({
    ...entry,
    _notification: {
      type: isNew ? 'assigned' : (isChanged ? 'changed' : 'updated'),
      team_member_id,
      date
    }
  });
});
```

- [ ] **Step 2: Update PUT /bulk to always INSERT (no upsert)**

Replace the bulk route's upsert statement (lines 166-171) with:

```javascript
  const insert = req.db.prepare(`
    INSERT INTO schedule_entries (id, team_member_id, job_id, date, notes, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = req.db.transaction((dates) => {
    for (const date of dates) {
      insert.run(uuidv4(), team_member_id, job_id, date, notes || '', status || 'tentative');
    }
  });
```

- [ ] **Step 3: Update PUT /status to use entry_id**

Replace the status route (lines 118-136) with:

```javascript
// PUT update status only (by entry_id)
router.put('/status', (req, res) => {
  const { entry_id, team_member_id, date, status } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  if (entry_id) {
    // Update by entry ID
    const existing = req.db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(entry_id);
    if (!existing) return res.status(404).json({ error: 'Schedule entry not found' });

    if (!req.user.isAdmin && existing.team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }

    req.db.prepare(`
      UPDATE schedule_entries SET status = ?, updated_at = datetime('now', '+10 hours') WHERE id = ?
    `).run(status, entry_id);
    res.json({ success: true });
  } else if (team_member_id && date) {
    // Backward-compatible: update all entries for member+date
    if (!req.user.isAdmin && team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }

    const result = req.db.prepare(`
      UPDATE schedule_entries SET status = ?, updated_at = datetime('now', '+10 hours')
      WHERE team_member_id = ? AND date = ?
    `).run(status, team_member_id, date);
    if (result.changes === 0) return res.status(404).json({ error: 'Schedule entry not found' });
    res.json({ success: true });
  } else {
    return res.status(400).json({ error: 'entry_id or (team_member_id + date) required' });
  }
});
```

- [ ] **Step 4: Update PUT /notes to use entry_id**

Replace the notes route (lines 139-157) with:

```javascript
// PUT update notes only (by entry_id)
router.put('/notes', (req, res) => {
  const { entry_id, team_member_id, date, notes } = req.body;

  if (entry_id) {
    const existing = req.db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(entry_id);
    if (!existing) return res.status(404).json({ error: 'Schedule entry not found' });

    if (!req.user.isAdmin && existing.team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }

    req.db.prepare(`
      UPDATE schedule_entries SET notes = ?, updated_at = datetime('now', '+10 hours') WHERE id = ?
    `).run(notes || '', entry_id);
    res.json({ success: true });
  } else if (team_member_id && date) {
    if (!req.user.isAdmin && team_member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only modify your own schedule' });
    }

    const result = req.db.prepare(`
      UPDATE schedule_entries SET notes = ?, updated_at = datetime('now', '+10 hours')
      WHERE team_member_id = ? AND date = ?
    `).run(notes || '', team_member_id, date);
    if (result.changes === 0) return res.status(404).json({ error: 'Schedule entry not found' });
    res.json({ success: true });
  } else {
    return res.status(400).json({ error: 'entry_id or (team_member_id + date) required' });
  }
});
```

- [ ] **Step 5: Update DELETE /member/:memberId/date/:date for multi-entry permission check**

Replace the non-admin permission check (lines 211-221) with:

```javascript
  // Permission check for non-admins
  if (!req.user.isAdmin) {
    if (req.params.memberId !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only clear your own schedule' });
    }
    // Check ALL entries for this cell — if any has a non-user-allowed status, reject
    const entries = req.db.prepare(
      'SELECT status FROM schedule_entries WHERE team_member_id = ? AND date = ?'
    ).all(req.params.memberId, req.params.date);
    const hasAdminEntry = entries.some(e => !USER_ALLOWED_STATUSES.includes(e.status));
    if (hasAdminEntry) {
      return res.status(403).json({ error: 'You cannot remove admin-assigned entries' });
    }
  }
```

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/schedule.js
git commit -m "feat: update schedule endpoints for multi-entry-per-cell support"
```

---

### Task 4: Client API Layer — Add moveScheduleEntries

**Files:**
- Modify: `client/src/api.js`

- [ ] **Step 1: Add moveScheduleEntries function**

Add after the `clearScheduleEntry` function (after line 124):

```javascript
export async function moveScheduleEntries(entryIds, targetMemberId, targetStartDate) {
  return api('/schedule/move', {
    method: 'POST',
    body: JSON.stringify({
      entry_ids: entryIds,
      target_member_id: targetMemberId,
      target_start_date: targetStartDate,
    }),
  });
}
```

- [ ] **Step 2: Update updateScheduleStatus to support entry_id**

Replace the existing `updateScheduleStatus` function (lines 104-109) with:

```javascript
export async function updateScheduleStatus(entryIdOrMemberId, dateOrStatus, statusOrUndefined) {
  // Support both: (entryId, status) and (memberId, date, status) for backward compat
  if (statusOrUndefined !== undefined) {
    return api('/schedule/status', {
      method: 'PUT',
      body: JSON.stringify({ team_member_id: entryIdOrMemberId, date: dateOrStatus, status: statusOrUndefined }),
    });
  }
  return api('/schedule/status', {
    method: 'PUT',
    body: JSON.stringify({ entry_id: entryIdOrMemberId, status: dateOrStatus }),
  });
}
```

- [ ] **Step 3: Update updateScheduleNotes to support entry_id**

Replace the existing `updateScheduleNotes` function (lines 111-116) with:

```javascript
export async function updateScheduleNotes(entryIdOrMemberId, dateOrNotes, notesOrUndefined) {
  // Support both: (entryId, notes) and (memberId, date, notes) for backward compat
  if (notesOrUndefined !== undefined) {
    return api('/schedule/notes', {
      method: 'PUT',
      body: JSON.stringify({ team_member_id: entryIdOrMemberId, date: dateOrNotes, notes: notesOrUndefined }),
    });
  }
  return api('/schedule/notes', {
    method: 'PUT',
    body: JSON.stringify({ entry_id: entryIdOrMemberId, notes: dateOrNotes }),
  });
}
```

- [ ] **Step 4: Add moveScheduleEntries to imports in ScheduleGrid.jsx**

In `client/src/components/ScheduleGrid.jsx` line 3, add `moveScheduleEntries` to the import:

```javascript
import { assignSchedule, bulkAssignSchedule, clearScheduleEntry, createNotification, updateScheduleStatus, updateScheduleNotes, createJob, getJobs as fetchJobs, updateTeamMember, moveScheduleEntries, STATUSES } from '../api.js';
```

- [ ] **Step 5: Commit**

```bash
git add client/src/api.js client/src/components/ScheduleGrid.jsx
git commit -m "feat: add moveScheduleEntries API and entry_id support for status/notes"
```

---

## Chunk 2: Client-Side scheduleMap, Collision UI, and Drag-and-Drop

### Task 5: Convert scheduleMap to Arrays

**Files:**
- Modify: `client/src/components/ScheduleGrid.jsx`

This task changes the core data structure from single-entry to array-of-entries per cell, and updates all lookups.

- [ ] **Step 1: Update scheduleMap construction (line 217-220)**

Replace:
```javascript
  const scheduleMap = {};
  for (const entry of schedule) {
    scheduleMap[`${entry.team_member_id}-${entry.date}`] = entry;
  }
```

With:
```javascript
  const scheduleMap = {};
  for (const entry of schedule) {
    const key = `${entry.team_member_id}-${entry.date}`;
    if (!scheduleMap[key]) scheduleMap[key] = [];
    scheduleMap[key].push(entry);
  }
```

- [ ] **Step 2: Update memberSpans to use first entry from array**

In the `memberSpans` useMemo (line 231), update the entry lookup:

Replace:
```javascript
        const entry = scheduleMap[`${member.id}-${weekDates[i].dateStr}`];
```
With:
```javascript
        const entries = scheduleMap[`${member.id}-${weekDates[i].dateStr}`];
        const entry = entries ? entries[0] : null;
```

And replace (line 236):
```javascript
            const nextEntry = scheduleMap[`${member.id}-${weekDates[end].dateStr}`];
```
With:
```javascript
            const nextEntries = scheduleMap[`${member.id}-${weekDates[end].dateStr}`];
            const nextEntry = nextEntries ? nextEntries[0] : null;
```

Also update the span to include all entries and a collision flag. The collision check must examine all days in the span, not just the first day. Replace (line 243):
```javascript
          spans.push({ startIdx: i, length: end - i, entry });
```
With:
```javascript
          // Check if ANY day in this span has multiple entries (collision)
          let hasCollision = false;
          const firstDayEntries = entries || [entry];
          for (let ci = i; ci < end; ci++) {
            const dayEntries = scheduleMap[`${member.id}-${weekDates[ci].dateStr}`];
            if (dayEntries && dayEntries.length > 1) {
              hasCollision = true;
              break;
            }
          }
          spans.push({ startIdx: i, length: end - i, entry, entries: firstDayEntries, hasCollision });
```

- [ ] **Step 3: Update dropdown lookup (line 847)**

Replace:
```javascript
        const existingEntry = scheduleMap[`${dropdown.memberId}-${dropdown.date}`];
        const isPopulated = !!existingEntry;
```
With:
```javascript
        const existingEntries = scheduleMap[`${dropdown.memberId}-${dropdown.date}`] || [];
        const existingEntry = existingEntries[0];
        const isPopulated = existingEntries.length > 0;
```

- [ ] **Step 4: Update handleStatusChange and notes onBlur to use entry_id (lines 365, 878)**

In `handleStatusChange` (line 363-409), update the `updateScheduleStatus` calls to pass entry IDs.

Replace line 367:
```javascript
        await updateScheduleStatus(memberId, date, newStatus);
```
With:
```javascript
        const entries = scheduleMap[`${memberId}-${date}`];
        if (entries && entries.length > 0) {
          await updateScheduleStatus(entries[0].id, newStatus);
        }
```

And replace lines 399-401 (the `Promise.all` for linked entries):
```javascript
        await Promise.all(
          linkedEntries.map(e => updateScheduleStatus(memberId, e.date, newStatus))
        );
```
With:
```javascript
        await Promise.all(
          linkedEntries.map(e => updateScheduleStatus(e.id, newStatus))
        );
```

For notes, in the dropdown's `onBlur` handler for the notes textarea (around line 878), update the `updateScheduleNotes` call to use entry_id:
```javascript
// Change from:
await updateScheduleNotes(dropdown.memberId, dropdown.date, newNotes);
// To:
await updateScheduleNotes(existingEntry.id, newNotes);
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ScheduleGrid.jsx
git commit -m "feat: convert scheduleMap to arrays for multi-entry support"
```

---

### Task 6: Collision Cell Rendering

**Files:**
- Modify: `client/src/components/ScheduleGrid.jsx` (task-cell rendering ~line 682-735)
- Modify: `client/src/styles.css`

- [ ] **Step 1: Update task-cell rendering for collisions**

In the cell rendering for team members (around line 682-715), update the filled cell branch to show collision state.

Replace the existing filled cell `<td>` block (lines 687-715) with:

```jsx
                        <td
                          key={d.dateStr}
                          colSpan={span.length}
                          className={`task-cell filled ${d.isToday ? 'today' : ''} ${span.hasCollision ? 'collision' : ''}`}
                        >
                          {span.hasCollision ? (
                            <div className="collision-stack" onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              const relativeX = e.clientX - rect.left;
                              const dayWidth = rect.width / span.length;
                              const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                              const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                              handleCellClick(member.id, clickedDate, e);
                            }}>
                              {span.entries.slice(0, 3).map((e, idx) => {
                                const si = STATUSES[e.status || 'tentative'] || STATUSES.tentative;
                                return (
                                  <div key={e.id} className="collision-bar" style={{ '--task-color': si.color, '--task-text': getTextColor(si.color) }}>
                                    <span className="task-label">{e.job_code || e.job_name}</span>
                                  </div>
                                );
                              })}
                              {span.entries.length > 3 && (
                                <div className="collision-more">+{span.entries.length - 3}</div>
                              )}
                            </div>
                          ) : (
                            <div
                              className={`task-bar ${isMulti ? 'multi-day' : 'single-day'} status-${statusKey}`}
                              style={{
                                '--task-color': statusInfo.color,
                                '--task-text': getTextColor(statusInfo.color),
                              }}
                              title={`${span.entry.job_name} [${statusInfo.label}]${span.entry.job_description ? '\n' + span.entry.job_description : ''}`}
                              onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const relativeX = e.clientX - rect.left;
                                const dayWidth = rect.width / span.length;
                                const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                                const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                                handleCellClick(member.id, clickedDate, e);
                              }}
                            >
                              <span className="task-label">
                                {span.entry.job_name || span.entry.job_code}
                              </span>
                              {isMulti && (
                                <span className="task-days">{span.length}d</span>
                              )}
                            </div>
                          )}
                        </td>
```

Apply the identical collision pattern to equipment rows (around lines 794-812). Replace the equipment filled cell rendering with:

```jsx
                                <td key={d.dateStr} colSpan={span.length} className={`task-cell filled ${d.isToday ? 'today' : ''} ${span.hasCollision ? 'collision' : ''}`}>
                                  {span.hasCollision ? (
                                    <div className="collision-stack" onClick={(e) => {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      const relativeX = e.clientX - rect.left;
                                      const dayWidth = rect.width / span.length;
                                      const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                                      const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                                      handleCellClick(item.id, clickedDate, e);
                                    }}>
                                      {span.entries.slice(0, 3).map((ent) => {
                                        const si = STATUSES[ent.status || 'tentative'] || STATUSES.tentative;
                                        return (
                                          <div key={ent.id} className="collision-bar" style={{ '--task-color': si.color, '--task-text': getTextColor(si.color) }}>
                                            <span className="task-label">{ent.job_code || ent.job_name}</span>
                                          </div>
                                        );
                                      })}
                                      {span.entries.length > 3 && <div className="collision-more">+{span.entries.length - 3}</div>}
                                    </div>
                                  ) : (
                                    <div className={`task-bar ${isMulti ? 'multi-day' : 'single-day'} status-${statusKey}`} style={{ '--task-color': statusInfo.color, '--task-text': getTextColor(statusInfo.color) }} title={`${span.entry.job_name} [${statusInfo.label}]${span.entry.job_description ? '\n' + span.entry.job_description : ''}`}
                                      onMouseDown={isAdmin ? (ev) => handleTaskBarMouseDown(ev, span, item.id) : undefined}
                                      onDragStart={handleDragStart}
                                      onDragEnd={handleDragEnd}
                                      onClick={(e) => {
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        const relativeX = e.clientX - rect.left;
                                        const dayWidth = rect.width / span.length;
                                        const dayOffset = Math.min(Math.floor(relativeX / dayWidth), span.length - 1);
                                        const clickedDate = weekDates[span.startIdx + dayOffset].dateStr;
                                        handleCellClick(item.id, clickedDate, e);
                                      }}>
                                      <span className="task-label">{span.entry.job_name || span.entry.job_code}</span>
                                      {isMulti && <span className="task-days">{span.length}d</span>}
                                    </div>
                                  )}
                                </td>
```

- [ ] **Step 2: Add collision CSS styles**

Add to `client/src/styles.css` (after the existing `.task-bar` styles, around line 970):

```css
/* Collision / stacked cells */
.task-cell.collision {
  border: 2px solid #f59e0b;
  padding: 1px;
}

.collision-stack {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  height: 100%;
  cursor: pointer;
  min-height: 32px;
}

.collision-bar {
  background: var(--task-color);
  color: var(--task-text);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  display: flex;
  align-items: center;
  min-height: 14px;
}

.collision-more {
  font-size: 9px;
  color: var(--text-secondary);
  text-align: center;
  line-height: 1;
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ScheduleGrid.jsx client/src/styles.css
git commit -m "feat: collision cell rendering with stacked colored bars and warning border"
```

---

### Task 7: Drag-and-Drop — Press-and-Hold Activation & Drag Handlers

**Files:**
- Modify: `client/src/components/ScheduleGrid.jsx`
- Modify: `client/src/styles.css`

This is the core drag-and-drop implementation.

- [ ] **Step 1: Add drag constants and state**

At the top of the `ScheduleGrid` component function (after line 12), add:

```javascript
  // Drag-and-drop constants (tunable)
  const DRAG_HOLD_MS = 300;
  const DRAG_MOVE_THRESHOLD = 5;

  // Drag-and-drop state
  const dragHoldTimer = useRef(null);
  const dragSource = useRef(null); // { entryIds, memberId, startDate, spanLength }
  const [dragOverCell, setDragOverCell] = useState(null); // { memberId, dateStr }
  const [isDragActive, setIsDragActive] = useState(false);
```

- [ ] **Step 2: Add press-and-hold mousedown handler for task bars**

Add this handler function (after the drag state declarations):

```javascript
  // Press-and-hold to activate drag on task bars
  // Strategy: on mousedown, start a 300ms timer. If mouse moves >5px before timer,
  // cancel (allow scroll). If timer fires, set draggable="true" on the element.
  // The user's continued mouse movement will then naturally trigger the browser's
  // native dragstart event. We do NOT dispatch a synthetic DragEvent (browsers
  // ignore synthetic drag events for security reasons).
  const handleTaskBarMouseDown = useCallback((e, span, memberId) => {
    if (!isAdmin) return;
    e.stopPropagation(); // Prevent grid drag-to-scroll

    const startX = e.clientX;
    const startY = e.clientY;
    const taskBarEl = e.currentTarget;

    // Collect entry IDs for the entire span
    const entryIds = [];
    for (let i = 0; i < span.length; i++) {
      const dateStr = weekDates[span.startIdx + i].dateStr;
      const entries = scheduleMap[`${memberId}-${dateStr}`];
      if (entries && entries.length > 0) {
        entryIds.push(entries[0].id);
      }
    }
    const startDateStr = weekDates[span.startIdx].dateStr;

    const cleanup = () => {
      clearTimeout(dragHoldTimer.current);
      document.removeEventListener('mousemove', onMoveBeforeHold);
      document.removeEventListener('mouseup', onMouseUpBeforeHold);
    };

    const onMoveBeforeHold = (ev) => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (dx > DRAG_MOVE_THRESHOLD || dy > DRAG_MOVE_THRESHOLD) {
        // User moved too much before hold time — cancel drag, let scroll happen
        cleanup();
      }
    };
    const onMouseUpBeforeHold = () => {
      cleanup();
    };

    document.addEventListener('mousemove', onMoveBeforeHold);
    document.addEventListener('mouseup', onMouseUpBeforeHold);

    dragHoldTimer.current = setTimeout(() => {
      cleanup();
      // Activate drag — set draggable so the user's natural mouse movement
      // triggers the browser's native dragstart
      dragSource.current = { entryIds, memberId, startDate: startDateStr, spanLength: span.length };
      setIsDragActive(true);
      taskBarEl.setAttribute('draggable', 'true');
      taskBarEl.classList.add('dragging');
    }, DRAG_HOLD_MS);
  }, [isAdmin, weekDates, scheduleMap]);
```

- [ ] **Step 3: Add dragstart, dragend handlers**

```javascript
  const handleDragStart = useCallback((e) => {
    if (!dragSource.current) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(dragSource.current));
  }, []);

  const handleDragEnd = useCallback((e) => {
    e.currentTarget.setAttribute('draggable', 'false');
    e.currentTarget.classList.remove('dragging');
    setIsDragActive(false);
    setDragOverCell(null);
    dragSource.current = null;
  }, []);
```

- [ ] **Step 4: Add dragover and drop handlers for cells**

```javascript
  const handleCellDragOver = useCallback((e, memberId, dateStr) => {
    if (!dragSource.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverCell({ memberId, dateStr });
  }, []);

  const handleCellDragLeave = useCallback(() => {
    setDragOverCell(null);
  }, []);

  const handleCellDrop = useCallback(async (e, memberId, dateStr) => {
    e.preventDefault();
    setDragOverCell(null);
    setIsDragActive(false);

    const source = dragSource.current;
    if (!source) return;
    dragSource.current = null;

    // Check if drop target range is within loaded dates
    const targetStartIdx = weekDates.findIndex(d => d.dateStr === dateStr);
    if (targetStartIdx < 0) return;
    const targetEndIdx = targetStartIdx + source.spanLength - 1;
    if (targetEndIdx >= weekDates.length) {
      showToast('Cannot move: target extends beyond loaded dates', 'error');
      return;
    }

    // If dropped on same position, no-op
    if (memberId === source.memberId && dateStr === source.startDate) return;

    // Optimistic UI: immediately move entries in local schedule state
    // We do this by triggering a refresh after the API call, but showing
    // a loading state via the "moved" toast immediately
    showToast('Moving assignment...', 'info');
    try {
      await moveScheduleEntries(source.entryIds, memberId, dateStr);
      showToast('Assignment moved', 'success');
      onScheduleRefresh();
    } catch (err) {
      showToast('Failed to move: ' + err.message, 'error');
      onScheduleRefresh(); // Revert by reloading server state
    }
  }, [weekDates, showToast, onScheduleRefresh]);
```

- [ ] **Step 5: Add auto-scroll during drag**

```javascript
  // Auto-scroll grid edges during drag
  const autoScrollRef = useRef(null);
  const handleGridDragOver = useCallback((e) => {
    if (!dragSource.current || !gridRef.current) return;
    e.preventDefault();
    const el = gridRef.current;
    const rect = el.getBoundingClientRect();
    const edgeZone = 60;

    clearInterval(autoScrollRef.current);
    if (e.clientX < rect.left + edgeZone) {
      autoScrollRef.current = setInterval(() => { el.scrollLeft -= 8; }, 16);
    } else if (e.clientX > rect.right - edgeZone) {
      autoScrollRef.current = setInterval(() => { el.scrollLeft += 8; }, 16);
    }
  }, []);

  useEffect(() => {
    return () => clearInterval(autoScrollRef.current);
  }, []);

  // Escape key cancels active drag
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && isDragActive) {
        setIsDragActive(false);
        setDragOverCell(null);
        dragSource.current = null;
        clearInterval(autoScrollRef.current);
        // Remove draggable from any active task-bar
        const dragging = document.querySelector('.task-bar.dragging');
        if (dragging) {
          dragging.setAttribute('draggable', 'false');
          dragging.classList.remove('dragging');
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isDragActive]);
```

- [ ] **Step 6: Wire up handlers to JSX — task-bar elements**

Update the task-bar `<div>` rendering in the filled cell branch (for both team members and equipment). Add `onMouseDown`, `onDragStart`, and `onDragEnd` to each `.task-bar`:

For the non-collision task-bar div, add these props:

```jsx
onMouseDown={isAdmin ? (e) => handleTaskBarMouseDown(e, span, member.id) : undefined}
onDragStart={handleDragStart}
onDragEnd={handleDragEnd}
```

- [ ] **Step 7: Wire up handlers to JSX — drop target cells**

Add `onDragOver`, `onDragLeave`, `onDrop` to every `<td className="task-cell ...">` (both filled and empty, both team members and equipment):

```jsx
onDragOver={isDragActive ? (e) => handleCellDragOver(e, member.id, d.dateStr) : undefined}
onDragLeave={isDragActive ? handleCellDragLeave : undefined}
onDrop={isDragActive ? (e) => handleCellDrop(e, member.id, d.dateStr) : undefined}
```

For multi-day spans, the `dateStr` for filled cells should compute from the span's start: use `weekDates[span.startIdx].dateStr`.

Also add `onDragOver` to the grid container div for auto-scroll:
```jsx
<div className="schedule-grid" ref={gridRef} onDragOver={isDragActive ? handleGridDragOver : undefined}>
```

- [ ] **Step 8: Add drag-over visual feedback class to cells**

For each `<td>` cell, add a conditional class when it's the current drag target:

```jsx
className={`task-cell ... ${dragOverCell && dragOverCell.memberId === member.id && dragOverCell.dateStr === d.dateStr ? 'drag-over' : ''}`}
```

Also check if the drag-over cell already has entries to add a collision-warning class:

```jsx
${dragOverCell && dragOverCell.memberId === member.id && dragOverCell.dateStr === d.dateStr && scheduleMap[`${member.id}-${d.dateStr}`]?.length > 0 ? 'drag-over-collision' : ''}
```

- [ ] **Step 9: Commit**

```bash
git add client/src/components/ScheduleGrid.jsx
git commit -m "feat: drag-and-drop handlers with press-and-hold activation and auto-scroll"
```

---

### Task 8: Drag-and-Drop CSS

**Files:**
- Modify: `client/src/styles.css`

- [ ] **Step 1: Add drag feedback styles**

Add to `client/src/styles.css`:

```css
/* Drag-and-drop feedback */
.task-bar.dragging {
  opacity: 0.5;
  transform: scale(1.02);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  cursor: grabbing;
}

.task-bar[draggable="true"] {
  cursor: grab;
}

.task-cell.drag-over {
  background: rgba(34, 197, 94, 0.15) !important;
  outline: 2px dashed #22c55e;
  outline-offset: -2px;
}

.task-cell.drag-over-collision {
  background: rgba(245, 158, 11, 0.15) !important;
  outline: 2px dashed #f59e0b;
  outline-offset: -2px;
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/styles.css
git commit -m "feat: drag-and-drop visual feedback CSS"
```

---

### Task 9: Final Testing & Push

- [ ] **Step 1: Start the dev server and verify**

Run: `npm run dev`

Test manually:
1. Log in as admin
2. Press-and-hold (~300ms) on a task bar → should see lift effect, drag activates
3. Quick click on task bar → assignment dropdown opens (no drag)
4. Quick swipe on task bar → grid scrolls (no drag)
5. Drag single-day job to empty cell on same row → moves
6. Drag single-day job to different team member → reassigns
7. Drag multi-day span → all days move together
8. Drag onto occupied cell → both shown stacked, orange border
9. Log in as non-admin → task bars not draggable
10. Drag near grid edge → auto-scrolls

- [ ] **Step 2: Verify existing functionality**

1. Assign a job from dropdown → still works
2. Bulk assign → still works
3. Clear a cell → clears all entries
4. Change status → still works
5. Update notes → still works

- [ ] **Step 3: Push to main**

```bash
git push origin main
```
