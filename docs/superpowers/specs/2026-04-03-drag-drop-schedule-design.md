# Drag-and-Drop Schedule Assignments

## Problem
Users (admins) need to quickly rearrange job assignments on the schedule grid by dragging them between days and team members, rather than deleting and recreating entries manually.

## Requirements
- Drag job assignments to different days and/or different team members/equipment
- Multi-day spans move together as a unit
- Allow multiple jobs per person per day temporarily during planning, with visual collision warnings
- Admin-only — regular users cannot drag
- Must not interfere with existing drag-to-scroll behavior

## Approach: HTML5 Drag and Drop with Press-and-Hold Activation

### Drag Activation
- `mousedown` on a `.task-bar` starts a 200ms timer
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

### Drop Logic
- **Single-day assignment:** Create new entry at target member + date, delete source entry
- **Multi-day span:** Move all consecutive days with same job+status together. Each day offset from drag start to drop target. Example: 3-day span Mon-Wed dragged to Wed → creates Wed/Thu/Fri, deletes Mon/Tue/Wed
- **API calls:**
  - `PUT /api/schedule/bulk` to create entries at new location
  - `DELETE /api/schedule/:id` for each source entry
  - Optimistic UI: move locally first, revert on API failure with toast

## Database Change
- Remove `UNIQUE(team_member_id, date)` constraint from `schedule_entries` table
- New migration to drop the constraint
- This allows multiple jobs per person per day during planning

## Collision Handling
- When a cell has 2+ assignments, show them stacked (split cell height or small colored bars)
- Orange border/background highlight on collision cells as a warning
- Collisions persist until user manually resolves them

## Permissions
- Only admins can drag — non-admin users see no drag affordance
- Server-side: existing admin checks on bulk PUT and DELETE endpoints already enforce this

## Edge Cases
- **Auto-scroll:** Grid scrolls horizontally when dragging near left/right edges
- **Unloaded dates:** Trigger existing infinite-scroll load-more if dragging past loaded range
- **Equipment rows:** Treated identically to team member rows
- **Status preservation:** Moved entries keep their original status (tentative, confirmed, etc.)
- **Notes preservation:** Notes are preserved on move

## Files to Modify
- `server/src/db.js` — migration to remove unique constraint
- `client/src/components/ScheduleGrid.jsx` — drag-and-drop handlers, collision UI, auto-scroll
- `client/src/components/ScheduleGrid.css` — drag visual feedback, collision highlights
- `client/src/api.js` — possibly a new move/batch endpoint if needed
- `server/src/routes/schedule.js` — possibly a new move endpoint combining create+delete atomically

## Verification
- Admin: press-and-hold on a task bar → drag activates with lift effect
- Drag single-day job to empty cell on same row → moves correctly
- Drag single-day job to different team member → reassigns
- Drag multi-day span → all days move together
- Drag onto occupied cell → both jobs shown, collision highlight appears
- Non-admin: task bars are not draggable
- Quick click on task bar → still opens assignment dropdown (no drag)
- Quick swipe across task bar → grid scrolls normally (no drag)
- Drag near grid edge → auto-scrolls
