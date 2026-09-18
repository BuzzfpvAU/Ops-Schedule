# Job Planning Workflow + Equipment Allocation & Tracking — Design (taskz.id)

> **Date:** 18 Sep 2026 · **Author:** Hermes Agent (from Grant's brief)
> **Brief:** "Find the best-in-class planning workflow and replicate it in taskz.id. Best process for planning jobs for field services, and also track and allocate equipment."
> **Companion:** implementation plan → `plans/2026-09-18-planning-workflow-implementation.md`
> **Research base:** an 8-stage lifecycle, 14 scheduling patterns and 7 mobilisation gates distilled from the documented workflows of Microsoft Dynamics 365 Field Service, Salesforce Field Service, ServiceTitan, ServiceM8, Jobber, simPRO, Assignar, Kynection and Fieldmagic, plus the equipment allocation/custody models of Cheqroom and MapTrack. Numbered sources at the end.

---

## 1. Brief & scope

Replicate a best-in-class field-service planning workflow inside taskz.id:

1. **Job planning end-to-end** — intake → plan → schedule → mobilise → execute → close-out, with **gates** that stop a job advancing until it is genuinely ready.
2. **Equipment allocation** — kits, bookings, buffers, conflict handling, confirmation — wired into that workflow.
3. **Equipment tracking** — custody + live status so "where is the gear, who is responsible for it" is answerable from the job.

**In scope:** stages 1–6 + 8 (improvement) of the standard lifecycle; equipment lifecycle from register to utilisation.
**Out of scope (by design):** invoicing/payments (finance systems own this; taskz does not grow a billing engine), route optimisation / auto-dispatch (low value at this fleet size — revisit later), client portal, capacity/zone modelling.

## 2. Current state (verified in code, 18 Sep 2026)

| Area | What exists today |
|---|---|
| Jobs | `jobs`: status planning/confirmed/active/complete/cancelled, `crew_size`, `planned_start/end`, `lead_id`, state derived from lead base, site address/contact, SharePoint link, job number. **Status is a free dropdown — no gates.** |
| Readiness checklists | `job_checklist_items` (accommodation/flights/vehicles/equipment/admin), standard template applied on create, ticked by admins. No required/critical tier, no stage grouping, no reminders. |
| Crew | `schedule_entries` (member × job × date; tentative/confirmed + leave/TOIL/note/unavailable). Job is "unallocated" while rostered crew < `crew_size`. `member_compliance` per person with expired/expiring/valid computed vs job start. |
| Equipment register | `team_members` is_equipment=1: category, serial, dimensions, weight, `serviceable`, SDS/info links, `airtag_name`. |
| Equipment allocation | `job_equipment` kit rows; assigning adopts the job timeframe → books equipment as schedule_entries for every rostered date; ± day per-row controls; conflicts shown faintly in JobPlanner; delete clears booking. |
| Equipment tracking | `equipment_locations` (AirTag tracker + manual updates), EquipmentMap with trails + staleness. **No custody, no status model, no geofences** — specced in the AirPinpoint parity plan (`plans/2026-09-11-…`). |
| Planner | `JobPlanner.jsx`: job-scoped grid (people + equipment), other-bookings window, drag/resize editing. Conflicts are visual only. |
| Notifications | `notifications` + bell + Resend wired. No workflow triggers yet. |

## 3. The target workflow

### 3.1 Stage model

| # | Stage | What happens | taskz home |
|---|---|---|---|
| 1 | **Intake & qualify** | Log the request as a job: client, site, scope, timing, owner, next action. | Jobs tab (`JobManager`) — add `job_type` (§6). |
| 2 | **Scope & plan** | Job type prefills crew size, checklist and kit; plan flights/accommodation/rentals/gear; set required compliance. | JobCard + standard checklist + kits. |
| 3 | **Schedule & dispatch** | Allocate compliant crew + gear to a date window with no conflicts; unallocated work stays visibly queued. | ScheduleGrid + JobPlanner + unallocated line. |
| 4 | **Mobilise (gates)** | Prove safe/legal/resourced before travel: compliance current, gear packed + serviceable + allocated, logistics done, site access confirmed. | **New: readiness gates + gated transitions.** |
| 5 | **Execute** | Field work with status visibility and evidence capture. | Planner day notes/statuses; field status strip (§4.5). |
| 6 | **Close-out** | Gear returned + serviceability checked; checklists complete; follow-ups logged. | **New: close-out gate + return checklist.** |

Principles taken from the leaders:

- **Work types drive everything.** A job type carries defaults — duration, crew size, required skills/compliance, checklist, kit — so scheduling is a *matching problem*, not data entry [81][82].
- **Eligibility is ALL-matching.** A worker is eligible only if they hold *every* requirement; a window with no eligible resource shows unavailable rather than silently booking an unqualified person [82][88].
- **Compliance gates dispatch.** Expired certificates trigger alerts ahead of expiry (≈90/30-day reminders) and block scheduling/dispatch instead of being discovered on site [88][89].
- **Gates never fail silently.** A failed gate returns the job to an action-required state with a named owner; it cannot proceed [85][86][87].
- **Conflicts are first-class.** Overlaps on people *and* equipment are prevented or explicitly flagged and resolvable — never silently accepted [82][90][95].

### 3.2 Status transitions + gates

Keep the five statuses; add **computed readiness** and **gate validation on transition**:

| Transition | Gate (all must pass; ⚠ = warn-only, overridable with reason) |
|---|---|
| planning → **confirmed** | ① **Crew:** rostered crew ≥ `crew_size`; no crew member has leave/unavailable entries overlapping the span. ② **Compliance:** every crew member holds all required compliance types for the job, valid beyond the job end date. ③ **Kit:** every kit item allocated and booked for span ± pads; no unresolved booking conflicts; no unserviceable or out-of-calibration items. ④ **Admin:** gate-critical checklist items done or due-dated ≤ start (site inductions, SWMS/JSA, site access, client contact). ⑤ Logistics (⚠): flights/accommodation/rentals done or marked not required. |
| confirmed → **active** | "Confirmed" gates still true at start date; equipment checklist items (pack/charge/serviceability) done; kit custody checked out (⚠ until custody ships — §4.5). |
| active → **complete** | Close-out items done: gear returned & checked in, serviceability check recorded, reports delivered, day notes closed. |
| any → **cancelled** | Reason required; releases bookings; notifies crew [86][87]. |

**Derived flags:** `ready` (all Confirmed gates pass) and `at_risk` (gates unmet while start ≤ 7 days away — or a confirmed job regressed, e.g. a certificate lapsed or gear went unserviceable). Surface on the Jobs list + daily admin notification [87]. **Override** records who/why and is permission-controlled [95].

**Unscheduled work stays visible.** The unallocated line already exists; add a Jobs-list "Needs attention" filter (unallocated / at-risk / gate-failing) so nothing hides [78][87].

### 3.3 Scheduling patterns adopted

| Pattern | taskz application |
|---|---|
| Unallocated queue | Exists (unallocated line + `crew_size`); upgrade with the Needs-attention filter [78][87]. |
| Skills & compliance matching | New: per-job **required compliance** list (from job type + per-job additions); crew rows flag members failing the check [82][88][89]. |
| Conflict detection | Upgrade faint-conflicts → **write-time warning** naming the clashing job; hard flag at the Confirm gate; block vs override by permission [90][95]. |
| Drag-drop board; crew assignment | Exists (grid + planner) — keep [78][82]. |
| Buffers | Equipment booking pads (§4.4) [94]. |
| Queued holds with expiry | Light-touch: checklist items already carry due dates; add due reminders only [85]. |
| Travel time, zones, route optimisation, auto-dispatch | Deliberately skipped (small fleet, multi-day remote jobs). Future note only [78][82]. |

### 3.4 Notifications

On transition (crew notified; override → admins) [86]. At-risk daily sweep at 7/3/1 days out (admins) [87]. Compliance: expiring within job span at confirm + **scheduled reminders ≈90/30 days before any expiry** [88][89]. Allocation: conflict created; kit item unserviceable; calibration overdue [91][95]. Custody: overdue return [96]. Release: job cancelled → crew [86].

## 4. Equipment — allocation & tracking model

### 4.1 Lifecycle

**Register → Kit → Allocate (book) → Prepare (pack/charge/check) → Deploy (custody out) → In-field (tracked) → Return (custody in + serviceability) → Maintain → Utilisation.** [97][99]

### 4.2 Register (extend)

Add: `calibration_due`, `last_service_at`, `service_interval_days`, `home_location`. Simple calibration/service scheduling — not a CMMS [91].

### 4.3 Kits

- `equipment_kits` + `equipment_kit_items`: named kits ("Standard drone kit", "Bridge inspection kit") tied to job types.
- "Apply kit" adds missing `job_equipment` rows + bookings; the kit is a template, the job kit is a live copy. Unserviceable items are skipped with a warning.
- Kits are applied **whole** (no partial selection) — the locked-kit pattern: guarantees every required item goes out [97].
- Kit availability is **derived**, not stored: available / partially available / out, computed from member statuses so the JobCard can warn "2 of 6 kit items unavailable" [97].

### 4.4 Allocate (bookings, buffers, conflicts)

- `job_equipment` gains: `status` (tentative|confirmed), `pad_before` / `pad_after` (default 1/1 — the "buffer time" pattern: protected days either side of the job for pack-out, transport and turnaround) [94].
- Bookings cover span ± pads; pad days render distinctly in the planner.
- **Conflict rule:** overlap with another job's booking → flag with the clashing job named; the gate blocks Confirm unless an admin uses the override-with-reason flow (the "ignore conflicts" permission pattern) [95].
- **Calibration rule:** `calibration_due` before job end → amber; overdue → red + blocks Confirm (override allowed) [91].
- **Confirm allocation** = job-level action setting all rows confirmed; tentative vs confirmed visible in planner + JobCard [96].
- The planner's "unbooked kit" list stays visible until every item is booked — the pack-out gate input [91].

### 4.5 Deploy & custody

Two custody shapes (the check-out vs custody split) [96]:

- **Date-based check-out (job deployment):** checkout ties gear to a member/job with an expected return (job end + pad). Overdue → alert. Extend = adjust the return date. Records who signed it out (the scan/manual handover) [96].
- **Long-term custody (no job):** item assigned indefinitely to a person (or vehicle), removed from the booking pool, checked by periodic spotchecks — v1 = assign + display, spotcheck reminders later [96][98].
- **Custodian is a first-class field:** person, crew, job or site; handover takes seconds (QR scan via tagz.au, or manual admin action); history preserved — "who had it, how long" [99].
- Implementation rides the AirPinpoint parity plan's status engine (`unknown|available|checked_out|delivered` + `equipment_events`) — **with job linkage**: checkout records `to = member + job`; JobCard gets "Check out kit / Check in kit" actions; planner rows show status chips [96][99].
- **Field status strip** on an Active job's card: per kit item — status, last seen, source (airtag / manual / qr) [99][100].

### 4.6 Return, maintain, utilise

- Close-out checklist: "Gear returned & checked in", "Serviceability inspected", "Batteries charged/stored". Damage → mark unserviceable (event recorded; excluded from future kit application).
- Maintenance view: "Due ≤30 days" / "Overdue" from `calibration_due` / `service_interval_days` [91].
- **Maintenance requests (v2 candidate):** any crew member can flag an item ("needs service / repair / calibration") → creates a maintenance request tied to that equipment; an assignee tracks it to close with notes and an optional post-service checklist — the Cheqroom work-order pattern [101]. An item under service can be set unserviceable to block allocation meanwhile.
- **Utilisation v1 report:** per item, booked days ÷ available days; idle list; overdue maintenance; unserviceable list — from assignment intervals and reservations [100].

## 5. UI mapping

| Surface | Change |
|---|---|
| JobCard | Workflow stepper + readiness panel grouped by gate (✓/⚠/✗ with reasons) + Advance button listing unmet gates + override modal; kit section: status/conflict/calibration badges, kit availability, Check out / Check in actions; Active jobs get the field status strip. |
| JobPlanner | Equipment allocation-status chips; conflict badges + tooltip; hatched pad days; "Confirm allocation"; crew compliance flags. |
| JobManager | At-risk badge + "Needs attention" filter. |
| MyJobs | Readiness summary + personal kit list. |
| EquipmentManager | Calibration/service fields, kit membership, due-maintenance views. |
| EquipmentMap | Per AirPinpoint parity plan (unchanged scope). |

## 6. Data model summary (all additive migrations)

- `jobs`: `job_type` TEXT ''.
- `job_checklist_items`: `required` INTEGER 0, `stage` TEXT '' (planning|confirmed|active|complete).
- New `job_requirements` (job_id, compliance_type).
- New `equipment_kits` (id, name, notes), `equipment_kit_items` (kit_id, equipment_id).
- `job_equipment`: `status` TEXT 'tentative', `pad_before` INTEGER 1, `pad_after` INTEGER 1; custody reuses parity plan's status columns.
- `team_members` (equipment): `calibration_due` TEXT '', `last_service_at` TEXT '', `service_interval_days` INTEGER 0, `home_location` TEXT ''.
- Parity plan adds (unchanged): `equipment_status`, `equipment_events`, geofences.

## 7. API summary

- `GET /api/jobs/:id/readiness` → per-gate status, reasons, at_risk.
- `POST /api/jobs/:id/status` {status, override_reason?} → validates gates; 409 + gate payload when failing.
- `GET/POST/DELETE /api/jobs/:id/requirements`.
- `GET/POST/PUT/DELETE /api/equipment/kits`; `POST /api/jobs/:id/apply-kit` {kit_id}.
- `POST /api/jobs/:id/equipment/:jeId/confirm`; pads via existing booking endpoint; conflicts checked by a shared service used at booking time and at the Confirm gate.
- Custody: parity plan endpoints (`POST /api/equipment/:id/checkout|checkin`) extended with `job_id`.
- Reports: `GET /api/equipment/utilisation?from&to`.

## 8. Implementation chunks (detail in companion plan)

1. **Readiness engine + gated status** (server): migrations, readiness service, `POST /status`, notifications; tests.
2. **Workflow UI**: stepper, readiness panel, advance/override flow, Needs-attention, MyJobs.
3. **Allocation upgrade**: pads, conflict service, allocation status + confirm, kits + apply-kit, planner/JobCard UI.
4. **Custody bridge** (needs parity plan Chunk 1): job-linked checkout/checkin, status chips, field status strip, overdue alerts.
5. **Maintenance & utilisation**: calibration fields, due lists, allocation warnings, report.
6. **Compliance matrix + reminders**: required types per job, crew eligibility flags, 90/30-day reminders.

## 9. Open decisions (for Grant)

1. **Gate strength:** block + override-with-reason (recommended) vs warn-only.
2. **Gate-critical items** from the current standard checklist — proposed: all Admin + equipment pack/charge/serviceability; flights/accommodation advisory.
3. **Pad defaults** 1/1 per equipment booking (per-job override; 0 allowed) — recommended.
4. **Calibration data:** manual entry v1 (recommended).
5. **Chunk order** 1→2→3→4→5→6 (4 depends on parity-plan Chunk 1; 6 is independent).
6. **`job_type`:** free-text now, defaults/templates later — or defer entirely.

## Sources

[78] https://learn.microsoft.com/en-us/dynamics365/field-service/work-with-schedule-board — Microsoft – Use the schedule board (D365 Field Service)
[81] https://developer.salesforce.com/docs/atlas.en-us.field_service_dev.meta/field_service_dev/fsl_dev_soap_core.htm — Salesforce – Field Service core data model (work types)
[82] https://help.servicetitan.com/docs/plan-your-team-s-capacity — ServiceTitan – Plan your team's capacity (skills, shifts, buffers)
[85] https://support.servicem8.com/help-center/servicem8-add-ons/servicem8-add-ons/queues-overview — ServiceM8 – Queues overview (holds with expiry)
[86] http://support.servicem8.com/help-center/desktop/basics/new-to-servicem8-start-with-a-job-walkthrough — ServiceM8 – Job lifecycle walkthrough
[87] https://help.getjobber.com/hc/en-us/articles/39133110680343-Jobs-List-Page-and-Key-Metrics — Jobber – Jobs list & key metrics (action required)
[88] https://assignar.com/workforce-management — Assignar – Workforce & compliance management (only schedule compliant workers)
[89] https://support.assignar.com/hc/en-au/articles/4406378218255-Add-Edit-Archive-Worker-Skills-Competencies-Inductions — Assignar – Worker skills, competencies & inductions
[90] https://www.kynection.com.au/scheduler — Kynection – Scheduler (conflict-free allocation)
[91] https://www.kynection.com.au/solutions/scheduling-assets-equipment — Kynection – Scheduling assets & equipment
[94] https://knowledge.cheqroom.com/helpcenter/using_buffer_time_to_protect_equipment — Cheqroom – Buffer time between bookings
[95] https://knowledge.cheqroom.com/helpcenter/preventing_booking_conflicts — Cheqroom – Preventing booking conflicts (permissions)
[96] https://knowledge.cheqroom.com/helpcenter/standard_check_outs_vs_long_term_custody — Cheqroom – Check-out vs long-term custody
[97] https://knowledge.cheqroom.com/helpcenter/kits_overview — Cheqroom – Kits (statuses, locked kits, bulk items)
[98] https://knowledge.cheqroom.com/helpcenter/how_to_use_and_manage_spotchecks — Cheqroom – Spotchecks (custody audits)
[99] https://maptrack.com/use_cases/equipment_custody — MapTrack – Equipment custody
[100] https://maptrack.com/use_cases/equipment_utilization — MapTrack – Equipment utilisation
[101] https://knowledge.cheqroom.com/helpcenter/how-to-submit-a-maintenance-request — Cheqroom – Submit a maintenance request (equipment work orders)
