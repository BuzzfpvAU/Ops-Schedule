# Drag-and-Drop Schedule Assignments

## Problem
Users (admins) need to quickly rearrange job assignments on the schedule grid by dragging them between days and team members, rather than deleting and recreating entries manually.

## Requirements
- Drag job assignments to different days and/or different team members/equipment
- Multi-day spans move together as a unit
- Allow multiple jobs per person per day temporarily during planning, with visual collision warnings
- Admin-only — regular users cannot drag
- Must not interfere with existing drag-to-scroll behavior
- Touch/mobile support is out of scope for this iteration

## Approach: HTML5 Drag and Drop with Press-and-Hold Activation

### Drag Activation
- `mousedown` on a `.task-bar` starts a 300ms timer (tunable constant at top of file)
- Movement threshold: 5px (also tunable constant)
- If mouse moves >5px before timer fires: cancel drag, allow grid scroll as normal
- If timer fires: activate drag mode — set `draggable="true"`, initiate HTML5 drag
- Visual feedback on activation: subtle lift effect (scale + shadow) on the task-bar

### During Drag
- Browser renders ghost preview of the task-bar
- Drop target cells highlight on `dragover`:
  - Green highlight for empty cells
  - Orange/red highlight for occupied cells (collision warning)
- Multi-day spans: all target cells in the range are highlighted

### Cancel
- Press Escape or drop outside grid to cancel, no changes made

### Multi-Day Span Definition
A "span" is consecutive calendar days (including weekends) for the same `team_member_id` with the same `job_id` and `status`. This matches the existing span-merging algorithm in ScheduleGrid (lines 225-253). The entire span always moves together — there is no modifier key to break a span. To move a single day out of a span, the user should first split it via the existing assignment editor.

If part of a span would land outside the loaded date range on drop, the drop is blocked (drop target shows red / not-allowed cursor).

### Drop Logic — Atomic Move Endpoint
A new `POST /api/schedule/move` endpoint handles the entire move in a single SQLite transaction:

**Request payload:**
```json
{
  "entry_ids": ["uuid1", "uuid2", "uuid3"],
  "target_member_id": "uuid",
  "target_start_date": "2026-04-07"
}
```

**Server logic (single transaction):**
1. Look up all source entries by IDs — if any ID is not found, reject entire request (400)
2. Validate `target_member_id` exists — if not, reject (400)
3. Calculate date offsets from first source entry to `target_start_date`
4. Insert new entries at target member + offset dates (preserving job_id, status, notes)
5. Delete source entries
6. Return new entries

**Error cases:**
- Any `entry_ids` not found → 400, no changes made
- `target_member_id` not found → 400, no changes made
- Transaction failure → 500, all changes rolled back

**Client-side:** Optimistic UI — move entries locally first, revert on API failure with toast.

## Database Change
- Remove `UNIQUE(team_member_id, date)` constraint from `schedule_entries` table
- New migration to remove the constraint. SQLite doesn't support `DROP CONSTRAINT`, so the migration must:
  1. `BEGIN TRANSACTION`
  2. `CREATE TABLE schedule_entries_new (...)` — same schema but without `UNIQUE(team_member_id, date)`
  3. `INSERT INTO schedule_entries_new SELECT * FROM schedule_entries`
  4. `DROP TABLE schedule_entries`
  5. `ALTER TABLE schedule_entries_new RENAME TO schedule_entries`
  6. Recreate all indexes (`idx_schedule_date`, `idx_schedule_member`, `idx_schedule_job`, `idx_schedule_member_date`)
  7. `COMMIT`
  - This runs inside the existing migration system in `db.js`

### Impact on Existing Endpoints
Removing the unique constraint affects several existing endpoints that rely on it:

1. **`PUT /api/schedule` (single assign, line 55):** Currently does `SELECT ... WHERE team_member_id = ? AND date = ?` to upsert. Change behavior:
   - If the request includes an `entry_id` field: update that specific entry
   - If no `entry_id`: check for existing entry by member+date. If exactly one exists, update it (preserves current non-admin upsert behavior for notes/TOIL/leave). If zero exist, insert new. If multiple exist, insert new (admin is intentionally stacking).
   - This preserves backward compatibility for non-admin users who update their own entries.

2. **`PUT /api/schedule/bulk` (line 160):** Uses `ON CONFLICT(team_member_id, date) DO UPDATE`. Change to: always INSERT (no upsert). The bulk endpoint is admin-only and used for new multi-day assignments. With collisions allowed, inserting is correct.

3. **`DELETE /api/schedule/member/:memberId/date/:date` (line 209):** Currently deletes by member+date. With multiple entries possible, this deletes ALL entries for that member on that date. This is the correct behavior for "clear this cell." For non-admin permission check: if ANY entry in that cell has a non-user-allowed status, reject the entire delete (safest approach — prevents partial deletion of admin-assigned work).

4. **`PUT /api/schedule/status` and `PUT /api/schedule/notes`:** Change to accept `entry_id` instead of `team_member_id + date`. New payload: `{ entry_id, status }` and `{ entry_id, notes }`. Update client callers (`updateScheduleStatus`, `updateScheduleNotes` in api.js) to pass entry ID. The entry ID is available from the schedule data in each cell.

5. **`DELETE /api/schedule/:id` (line 193):** No change needed — already deletes by ID. **Add `requireAdmin` middleware** — currently any authenticated user can delete any entry.

### Client-side `scheduleMap` Change
Currently `scheduleMap` is `{ "${member_id}-${date}": entry }` (one entry per key). Change to `{ "${member_id}-${date}": [entry, ...] }` (array of entries per key). Update all lookups accordingly.

## Collision Handling
- When a cell has 2+ assignments, split the cell vertically showing stacked colored bars (one per assignment) with truncated job codes
- Orange border on collision cells as a warning
- Clicking a stacked cell shows all assignments in the existing dropdown
- Collisions persist until user manually resolves them

## Permissions
- Only admins can drag — non-admin users see no drag affordance (no press-and-hold activation)
- New `POST /api/schedule/move` endpoint uses `requireAdmin` middleware
- Fix: add `requireAdmin` to `DELETE /api/schedule/:id`

## Edge Cases
- **Auto-scroll:** Grid scrolls horizontally when dragging near left/right edges
- **Unloaded dates:** Drop is blocked if target range extends beyond loaded dates (red not-allowed indicator)
- **Equipment rows:** Treated identically to team member rows
- **Status preservation:** Moved entries keep their original status (tentative, confirmed, etc.)
- **Notes preservation:** Notes are preserved on move
- **Undo:** Out of scope for this iteration. User can manually move the assignment back.

## Files to Modify
- `server/src/db.js` — migration to remove unique constraint (recreate table)
- `server/src/routes/schedule.js` — new `POST /move` endpoint, update existing endpoints for multi-entry-per-cell, add `requireAdmin` to DELETE by ID
- `client/src/api.js` — add `moveScheduleEntries()` function
- `client/src/components/ScheduleGrid.jsx` — drag-and-drop handlers, `scheduleMap` to arrays, collision UI, auto-scroll, press-and-hold logic
- `client/src/components/ScheduleGrid.css` — drag visual feedback, collision highlights, stacked cell styles

## Verification
- Admin: press-and-hold (~300ms) on a task bar → drag activates with lift effect
- Drag single-day job to empty cell on same row → moves correctly
- Drag single-day job to different team member → reassigns
- Drag multi-day span → all days move together
- Drag onto occupied cell → both jobs shown stacked, orange collision border
- Non-admin: task bars are not draggable
- Quick click on task bar → still opens assignment dropdown (no drag)
- Quick swipe across task bar → grid scrolls normally (no drag)
- Drag near grid edge → auto-scrolls horizontally
- Existing bulk assign still works after unique constraint removal
- Existing single assign still works
- Existing delete-by-date clears all entries for that cell
