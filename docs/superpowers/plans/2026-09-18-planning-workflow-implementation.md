# Planning Workflow + Equipment Allocation — Implementation Plan (taskz.id)

> **For agentic workers:** REQUIRED: Use subagent-driven development or executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Date:** 18 Sep 2026 · **Author:** Hermes Agent
> **Companion design:** `../specs/2026-09-18-planning-workflow-design.md` (read it first — gates, rules and rationale live there)
> **Related:** `2026-09-11-airpinpoint-feature-parity.md` (equipment tracking tech: status engine, geofences, QR — Chunk 4 below depends on its Chunk 1)
>
> **Stack:** Express + better-sqlite3 + React/Vite + Leaflet. JWT httpOnly cookies; admin/member/viewer roles. Tests: `npm test` (node --test) in `server/`.
> **Conventions:** additive + idempotent migrations in `server/src/db.js` (pragma table_info pattern); timestamps `datetime('now','+10 hours')`; route order — static paths before `/:id`; mirror code changes into `deploy/` per repo convention; back up prod DB (`~/data/ops-schedule.db`) before deploy; deploy = push → Hostinger flow per `.agent-status.md`.

---

## Chunk 1 — Readiness engine + gated status (server)

**Files:** `server/src/db.js`, new `server/src/services/readiness.js`, `server/src/routes/jobs.js`, new `server/test/readiness.test.js`

- [ ] Migrations: `job_checklist_items.required INTEGER DEFAULT 0`, `job_checklist_items.stage TEXT DEFAULT ''`; `jobs.job_type TEXT DEFAULT ''`; new table `job_requirements (id, job_id, compliance_type, UNIQUE(job_id, compliance_type))`.
- [ ] Backfill: mark the standard Admin + Equipment-check items `required=1`, `stage` per mapping (planning/confirmed/active/complete) in `applyStandardChecklist` (new jobs) — and a one-off idempotent backfill for existing jobs by label match.
- [ ] `readiness.js`: `computeReadiness(db, jobId)` → `{ gates: { crew: {...}, compliance: {...}, kit: {...}, admin: {...}, logistics: {...} }, ready, at_risk, reasons[] }`.
  - crew: distinct rostered members vs `crew_size`; leave/unavailable overlap check.
  - compliance: for each crew member × required types (job_requirements) → valid beyond `roster_end` (fallback planned_end/today); reuse `complianceStatus`.
  - kit: every `job_equipment` row has bookings covering span ± pads; no conflicting bookings (shared conflict helper — see Chunk 3); no unserviceable rows; calibration_due OK (once fields exist, Chunk 5 — guard for absence).
  - admin: `required=1 AND stage IN ('planning','confirmed')` checklist items done OR due_date ≤ roster_start.
  - logistics: flights/accommodation/rentals present or explicitly N/A (checklist items ticked) — advisory only.
- [ ] `POST /api/jobs/:id/status` (admin): validates transition gates; failing → `409 {error, gates}`; success with `override_reason` → apply + record in job notes + notify admins. Wire `PUT /:id` status changes through the same validator (or de-emphasise status in PUT).
- [ ] `GET /api/jobs/:id/readiness` (auth): the payload above.
- [ ] Notifications: gate-failure attempt → admins; status change → job crew; at-risk sweep helper `flagAtRiskJobs(db)` (called on list endpoints or a tiny admin endpoint for now — no cron in prod).
- [ ] Tests: unit-test readiness service against seeded scenarios (crew short, lapsed cert, unbooked kit, done/not-done admin items); endpoint tests for 409 payload + override path.
- [ ] `npm test` green; curl smoke: create job → status=confirmed fails with reasons → fix inputs → passes.

**Verify:** local server + seeded DB; advance a job through each failure mode and confirm the 409 reason list matches reality.

## Chunk 2 — Workflow UI

**Files:** `client/src/components/JobCard.jsx`, `JobManager.jsx`, `MyJobs.jsx`, `client/src/api.js`, `client/src/styles.css`

- [ ] JobCard: workflow stepper (Planning → Confirmed → Active → Complete) with derived `ready/at_risk` state; Readiness panel grouped by gate with ✓/⚠/✗ + reasons; "Advance" button → shows unmet gates, admin can override with reason (modal).
- [ ] JobManager list: at-risk badge; "Needs attention" filter (unallocated / at-risk / gate-failing) — reuse unallocated logic in the list endpoint if cheap, else client-derived.
- [ ] MyJobs: readiness chip + personal kit list (from job card equipment where `assigned_to` = me or just the job kit).
- [ ] api.js: `getJobReadiness`, `setJobStatus`.
- [ ] Verify: build passes; manual flows as admin + member; 403s respected (override admin-only).

## Chunk 3 — Allocation upgrade (buffers, conflicts, confirm, kits)

**Files:** `server/src/db.js`, `server/src/routes/jobs.js`, new `server/src/services/conflicts.js`, `server/test/equipmentConflicts.test.js`, `client/src/components/JobPlanner.jsx`, `JobCard.jsx`, `EquipmentManager.jsx`

- [ ] Migrations: `job_equipment.status TEXT DEFAULT 'tentative'`, `pad_before INTEGER DEFAULT 1`, `pad_after INTEGER DEFAULT 1`; new `equipment_kits (id, name, notes, created_at)`, `equipment_kit_items (id, kit_id, equipment_id, UNIQUE(kit_id, equipment_id))`.
- [ ] `conflicts.js`: `findConflicts(db, equipmentId, from, to, excludeJobId)` → overlapping bookings (other jobs) with job code/name; used by booking endpoints (warn payload) and the readiness gate (fail).
- [ ] Booking adjustments: equipment assignment books span ± pads (respect `pad_before/after` on create); booking +/− edits pads (extend/trim); response includes conflict list.
- [ ] `POST /api/jobs/:id/equipment/:jeId/confirm` and job-level confirm-all (sets status confirmed; blocked by conflicts unless override).
- [ ] Kits: CRUD endpoints + `POST /api/jobs/:id/apply-kit` (adds missing kit items, books them, skips unserviceable with warning array).
- [ ] Planner UI: allocation status chip (tentative/confirmed); conflict badge + tooltip listing clashing jobs; hatched pad days; "Confirm allocation" action; kit availability counts on JobCard kit section ("5 of 6 available").
- [ ] Tests: conflict detection (edge cases: touching ranges, pads overlapping, same job excluded); apply-kit idempotency; confirm blocks on conflict; pads respected in booking maths (extend/trim tests port from existing booking test suite).
- [ ] Verify: seed two jobs sharing a drone → overlap shows on planner + blocks confirm → resolve (trim/adjust) → confirm passes.

## Chunk 4 — Custody bridge (depends on parity plan Chunk 1)

**Files:** parity-plan files (`db.js`, `services/geofenceEngine.js`, `routes/equipment.js`) **plus** `server/src/routes/jobs.js`, `client/src/components/JobCard.jsx`, `JobPlanner.jsx`

- [ ] Land parity-plan Chunk 1 first (status columns + `equipment_events` + manual checkout/checkin) — that plan's tasks.
- [ ] Extend checkout/checkin payloads with `job_id`; checkout from job context sets `checked_out_to = member` + event with job ref; "Check out kit to this job" / "Check in kit" buttons on JobCard kit section (admin).
- [ ] Overdue custody: expected return = job end + `pad_after`; daily "overdue return" notification (reuse at-risk sweep).
- [ ] Active-stage JobCard **field status strip**: per kit item — status chip, last seen (from `equipment_locations`), source label; read-only.
- [ ] Planner equipment rows: status chip next to the row name.
- [ ] Tests: checkout/checkin flows with job linkage; event rows written; overdue detection.
- [ ] Verify: local end-to-end — checkout kit to job, see status on card/planner, check back in on completion.

## Chunk 5 — Maintenance & utilisation

**Files:** `server/src/db.js`, `server/src/routes/equipment.js` (or `teams.js` where equipment CRUD lives — check), `server/src/routes/jobs.js` (warning at allocation), `client/src/components/EquipmentManager.jsx`, new report view

- [ ] Migrations: equipment columns `calibration_due`, `last_service_at`, `service_interval_days`, `home_location` (team_members).
- [ ] Allocation warning: item calibration due before job end / overdue → warning in booking response + red badge in kit section; overdue blocks Confirm (via readiness gate — extend Chunk 1's kit check).
- [ ] EquipmentManager: new fields in edit form; "Due ≤30 days" / "Overdue" filter views.
- [ ] `GET /api/equipment/utilisation?from&to` → per item booked days / available days, idle list, overdue list, unserviceable list; small report panel in Equipment tab.
- [ ] Tests: due-list query edge cases (empty dates), utilisation maths on seeded bookings.
- [ ] Verify: seed items with due dates; confirm warnings + report numbers.

## Chunk 6 — Compliance matrix & reminders

**Files:** `server/src/routes/jobs.js`, `server/src/routes/teams.js`, `server/src/db.js`, `client/src/components/JobCard.jsx`, `ComplianceModal.jsx`, notifications helper

- [ ] Requirements UI: JobCard — required compliance types per job (chips + picker); default from job type later.
- [ ] Crew eligibility: crew query gains `eligible: true/false + missing[]` per member (job span rule); planner + card surface flag.
- [ ] Reminders: expiry reminder sweep (≈90/30 days) → member + admins; run on list/login endpoints (no cron in prod).
- [ ] Confirm gate already consumes it (Chunk 1).
- [ ] Tests: eligibility matrix cases; reminder dedupe (don't re-notify same threshold).
- [ ] Verify: seed cert expiring in 20 days → flag at confirm + reminder once.

---

## Risks & decisions

- **No cron in prod** — all sweeps must run opportunistically (on authenticated list endpoints) or via a manual admin action; keep them idempotent and cheap. (See parity plan §3.1 for precedent.)
- **Gate strictness** could annoy ops — ship chunks 1–2 with warn-first defaults toggleable (decision §9.1 in the spec); the override path must be fast.
- **Pads change existing booking maths** — port the existing booking test suite first, then adjust expectations intentionally.
- **Deploy mirroring** — code changes must be mirrored to `deploy/` per repo convention; docs are repo-only.
- **Backup before deploy** — `~/data/ops-schedule.db` (existing flow).
- Out of scope forever: invoicing, route optimisation, client portal.

## Verification & deploy (all chunks)

- Local: `npm test` green + build (`cd client && npm run build`).
- Prod: DB backup → push → Hostinger reset/install/build/restart (`/opt/alt/alt-nodejs20/root/bin` PATH) → verify bundle hash + smoke endpoints (401 not 404 unauth).
