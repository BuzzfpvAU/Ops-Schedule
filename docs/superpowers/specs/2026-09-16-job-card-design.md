# Job Card — expanded job readiness card (taskz.id)

> **Date:** 16 Sep 2026 · **Author:** Hermes Agent (from Grant's brief)
> **Goal:** turn the bare job record (code/name/client/colour) into a full **job readiness card**: all the info and checklists needed to get a job ready to go, plus links crew need in the field.

## 1. Brief (from Grant)

- Job card should have **all the information and checklists to get the job ready to go**
- Link to the **SharePoint directory** per job
- **Job numbers** — the main job number is provided externally, stored as the main job reference
- **Start date + end date based on the gantt chart** (the schedule grid IS the gantt — dates derive from roster entries)
- **Checklists for accommodation, flights, vehicles, notes**
- Flights + accommodation: structured detail (per person), refine later
- Vehicles: owned vehicles are normal equipment (equipment register); **rental = tick box "rental required" → expands to rental details**
- **Job card available to the employees** (with links)

## 2. Data model (all additive + idempotent, existing migration pattern in `server/src/db.js`)

### `jobs` — new columns
| column | type | notes |
|---|---|---|
| `job_number` | TEXT '' | external main job reference (e.g. J2293) |
| `sharepoint_url` | TEXT '' | link to the job's SharePoint folder |
| `status` | TEXT 'planning' | planning \| confirmed \| active \| complete \| cancelled |
| `site_address` | TEXT '' | site / location |
| `site_contact` | TEXT '' | site contact name + phone (free text) |
| `notes` | TEXT '' | free-text notes block on the card |
| `rental_required` | INTEGER 0 | "rental required" tick box on the Vehicles section |

**Start/end dates are NOT stored** — they derive from the gantt (`MIN/MAX schedule_entries.date` per job). The card shows them as "from roster". (Revisit later if pre-roster planned dates are wanted.)

### New tables

```sql
CREATE TABLE job_checklist_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',  -- accommodation|flights|vehicles|equipment|admin|other
  label TEXT NOT NULL,
  notes TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  assigned_to TEXT DEFAULT '',             -- team_member id (optional)
  done INTEGER DEFAULT 0,
  done_by TEXT DEFAULT '',                 -- team_member id
  done_at TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at/updated_at  -- +10h pattern
);

CREATE TABLE job_flights (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
  person_id TEXT DEFAULT '', person_name TEXT DEFAULT '',   -- member or free text
  direction TEXT DEFAULT 'out',            -- out|return|other
  airline TEXT, flight_number TEXT,
  depart_airport TEXT, depart_at TEXT,     -- datetime-local
  arrive_airport TEXT, arrive_at TEXT,
  booking_ref TEXT, notes TEXT, created_at
);

CREATE TABLE job_accommodation (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
  person_id TEXT DEFAULT '', person_name TEXT DEFAULT '',
  venue TEXT, address TEXT,
  check_in TEXT, check_out TEXT,           -- dates
  booking_ref TEXT, notes TEXT, created_at
);

CREATE TABLE job_rentals (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
  company TEXT, vehicle_desc TEXT, rego TEXT,
  pickup_location TEXT, pickup_at TEXT, return_at TEXT,
  booked_under TEXT, booking_ref TEXT, notes TEXT, created_at
);

CREATE TABLE job_equipment (                -- owned gear + owned vehicles assigned to the job
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, equipment_id TEXT NOT NULL,
  assigned_to TEXT DEFAULT '', notes TEXT DEFAULT '', created_at,
  UNIQUE(job_id, equipment_id)
);
```

Vehicles owned = `job_equipment` rows whose equipment has `equipment_category = 'Vehicles'`.
**Add `Vehicles` to `CATEGORIES` in `client/src/equipmentConstants.js`.**

### Standard checklist template (applied optionally)
Applied on job create (checkbox, default on) or via "Apply standard checklist" button; skips labels that already exist on the job.

- **Accommodation:** Book accommodation · Confirm check-in / check-out dates · Send booking details to crew
- **Flights:** Book flights · Confirm flight details with crew · Check baggage / equipment allowances
- **Vehicles:** Assign vehicle · Book rental car (if required) · Confirm pickup / return details
- **Equipment:** Confirm equipment kit list · Charge batteries · Pack equipment cases · Check serviceability / calibration
- **Admin:** Site inductions arranged · SWMS / JSA completed · CASA / airspace approval · Site access passes arranged · Client site contact confirmed

## 3. API (`server/src/routes/jobs.js`)

All under `/api/jobs` (already `requireAuth`). Admin = `requireAdmin` on writes; members may **read** any card. **Checklists are completed by admins only** (Grant, 16 Sep). Per-person compliance CRUD lives under `/api/team-members` (see §3b).

- `GET /` — list + `roster_start`, `roster_end`, `checklist_total`, `checklist_done` (correlated subqueries)
- `GET /mine` — jobs where the current user has roster entries; upcoming first, then past (desc)
- `GET /:id` — full card: `{ job, crew, checklist, flights, accommodation, rentals, equipment }`
  - `crew` = distinct members with roster entries (+ from/to dates) **+ each member's `compliance[]` array flagged expired/expiring/valid against the job start date**
- `POST /` / `PUT /:id` — new fields; POST accepts `applyTemplate: true`
- `POST /:id/checklist` (admin) · `PUT /checklist/:itemId` (admin only) · `DELETE /checklist/:itemId` (admin)
- `POST /:id/checklist/template` (admin) — apply standard checklist
- Flights: `POST /:id/flights` · `PUT /flights/:id` · `DELETE /flights/:id` (admin)
- Accommodation: `POST /:id/accommodation` · `PUT /accommodation/:id` · `DELETE /accommodation/:id` (admin)
- Rentals: `POST /:id/rentals` · `PUT /rentals/:id` · `DELETE /rentals/:id` (admin)
- Equipment: `POST /:id/equipment` · `DELETE /equipment/:id` (admin)

### 3b. Per-person compliance (`/api/team-members`)
`member_compliance` table: `team_member_id, type, reference, site, issued_at, expires_at, file_url, notes`.
- `GET /:id/compliance` (any authed) · `POST /:id/compliance` (admin) · `PUT /compliance/:id` (admin) · `DELETE /compliance/:id` (admin)

Route order: static paths (`/mine`, `/code/:code`) **before** `/:id`.

## 4. UI

### `JobManager.jsx` (admin, Jobs tab)
- List rows enriched: colour dot, code + job number, name, client, **date range + N days**, readiness `x/y` mini-bar, SharePoint/files links, actions as today (iCal, subscribe, edit, remove)
- Row click → **JobCard** (replaces list; back button)
- Create/Edit modal gains: Job number, Status select, SharePoint URL (+"auto-build from job number/client/name" helper using the cwltdgroup root pattern), Site address, Site contact; create modal has "Apply standard checklist" checkbox (default checked)

### `JobCard.jsx` (shared; `readOnly` for crew, edit affordances for admin)
Sections:
1. **Header** — dot + code + status pill + job number; name; client; roster dates "12 Oct → 28 Oct 2026 · 13 days"; links: 📂 SharePoint, 📁 Files, 📅 iCal download, 🔗 subscribe
2. **Crew** — chips (name, from–to)
3. **Readiness** — progress bar `done/total` checklists
4. **Checklists** — grouped by category with per-group counts; tick (rostered members + admin), assignee, due date; admin: add/delete item, apply standard checklist
5. **Flights** — per person rows (direction, airline+number, route + times, booking ref); admin add/edit/delete (inline expander form)
6. **Accommodation** — venue, address, check-in/out, ref, person; admin CRUD
7. **Vehicles** — owned vehicles (from equipment register) + **"Rental required" tick** → reveals rentals list + add form; admin CRUD
8. **Notes** — job notes textarea (admin editable, shown to crew)

### `MyJobs.jsx` (members, Jobs tab — new)
- Mobile-first list of the member's jobs (upcoming first): code + job number, name, dates, readiness
- Tap → JobCard (read + tick checklists + links incl. SharePoint)
- Sharepoint/files links open in new tab

### `App.jsx`
- Jobs tab visible to all non-viewer users; admins get `JobManager`, members get `MyJobs`. Other admin tabs unchanged.

## 5. Verification
- `cd client && npm run build` passes
- Local: login as demo admin → create/edit job with all fields → apply checklist → tick items → add flight/accom/rental/equipment → reload card, verify persistence + readiness counts
- Member view: roster a member on the job → `GET /api/jobs/mine` → card visible, tick works, admin-only actions 403
- Prod deploy via existing Hostinger flow; DB backup of `~/data/ops-schedule.db` first (additive schema = rollback-safe)

## 6. Refinements deferred (Grant: "then will refine")
- Pre-roster planned start/end dates (manual override fields)
- Per-item reminders / notifications when checklist items are due
- Vehicle -> equipment check-out linkage (AirPinpoint parity plan §status engine)
- Checklist item reordering / drag
- PDF job pack export
