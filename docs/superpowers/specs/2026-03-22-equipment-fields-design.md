# Equipment Extended Fields Design

## Summary

Add new fields to equipment items: serial number, dimensions, weight, serviceable status, and SDS link. Rename and reorder the existing info URL field. Show a warning icon in the schedule view for unserviceable equipment.

## Database Changes

Add 5 new columns to `team_members` table via ALTER TABLE migration in `server/src/db.js`. Runs on startup, idempotent (try/catch per column).

```sql
ALTER TABLE team_members ADD COLUMN serial_number TEXT DEFAULT '';
ALTER TABLE team_members ADD COLUMN dimensions TEXT DEFAULT '';
ALTER TABLE team_members ADD COLUMN weight TEXT DEFAULT '';
ALTER TABLE team_members ADD COLUMN serviceable INTEGER DEFAULT 1;
ALTER TABLE team_members ADD COLUMN sds_url TEXT DEFAULT '';
```

- All new text fields default to empty string
- `serviceable` defaults to 1 (serviceable) — required field
- Existing equipment rows get defaults automatically
- Person records ignore these columns
- Backup live DB before deploying

## API Changes

**File:** `server/src/routes/teams.js`

### POST /team-members (create)
Accept 5 new fields from request body: `serial_number`, `dimensions`, `weight`, `serviceable`, `sds_url`. Insert into corresponding columns.

### PUT /team-members/:id (update)
Add same 5 fields to the UPDATE SET clause.

### GET endpoints
No changes — `SELECT *` returns all columns automatically.

## UI Changes

### Equipment Form (EquipmentManager.jsx modal)

Field order top to bottom:
1. Name (required) — existing
2. Type/Description — existing
3. Serial Number — text input, optional
4. Dimensions (L x W x H) — text input, optional, placeholder "e.g. 500 x 400 x 200 mm"
5. Weight — text input, optional, placeholder "e.g. 6.3 kg"
6. Serviceable — checkbox, checked by default (required)
7. State/Location — existing dropdown
8. Color — existing picker
9. Sort Order — existing
10. SDS Link — URL input, optional, with clickable external link icon
11. Tagz.au Link — renamed from "Info/Documentation Link", moved to bottom, with clickable external link icon

Both URL fields have a clickable external link icon next to the input that opens the URL in a new tab when populated.

### Equipment List View (EquipmentManager.jsx)

- Serial number, dimensions, weight shown as secondary info below equipment name
- Unserviceable items show a warning badge
- SDS and Tagz.au links show as clickable icons in the list row

### Schedule Grid (ScheduleGrid.jsx)

- Unserviceable equipment displays a warning icon next to the equipment name in schedule rows
- No behavioural change — unserviceable equipment can still be assigned to jobs

## Files Modified

| File | Change |
|------|--------|
| `server/src/db.js` | ALTER TABLE migration for 5 columns |
| `server/src/routes/teams.js` | Accept new fields in POST and PUT |
| `client/src/components/EquipmentManager.jsx` | New form fields, reorder, link icons, list display |
| `client/src/components/ScheduleGrid.jsx` | Warning icon for unserviceable equipment |
| `deploy/*` copies of all above | Mirror all changes |

## Files Not Modified

- `client/src/api.js` — already sends/receives arbitrary fields
- `client/src/App.jsx` — no changes needed
- CREATE TABLE schema — columns added via migration only

## Deployment

1. Backup live Hostinger DB before deploying
2. Push changes to deploy/ and git push
3. Migration runs automatically on server restart
4. Verify new fields work on live site

## Testing

1. Migration runs cleanly on existing local DB (no data loss)
2. Create equipment with all new fields — confirm save and display
3. Edit existing equipment — new fields show current values (empty defaults)
4. Mark equipment unserviceable — confirm warning icon in schedule view
5. Test SDS and Tagz.au link icons open URLs in new tab
6. Verify person records unaffected by new columns
