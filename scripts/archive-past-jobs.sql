-- Bulk-archive every job flagged "Past": active, not yet archived, and whose
-- LAST rostered day is before today (server convention: datetime +10 hours).
-- This mirrors the exact rule behind the amber "Past" chip in the Jobs list
-- (client: roster_end && roster_end < today-AEST, excluding already-archived).
-- Hidden system rows (NOTE-*, TOIL, LEAVE, NOT-AVAIL) are filtered out of the
-- admin Jobs list, so they are skipped here too — they never show a Past chip.
--
-- Safe: soft flag only (reversible via Unarchive). Always back up first:
--   sqlite3 ~/data/ops-schedule.db ".backup 'ops-schedule.db.bak-YYYYMMDD-sweep'"
-- Run:
--   sqlite3 ~/data/ops-schedule.db < scripts/archive-past-jobs.sql
.bail on
SELECT 'archived before: ' || COUNT(*) FROM jobs WHERE archived = 1;
BEGIN;
UPDATE jobs SET archived = 1,
                archived_at = datetime('now', '+10 hours'),
                updated_at = datetime('now', '+10 hours')
WHERE active = 1 AND archived = 0
  AND code NOT LIKE 'NOTE-%'
  AND code NOT IN ('TOIL', 'LEAVE', 'NOT-AVAIL')
  AND (SELECT MAX(e.date) FROM schedule_entries e WHERE e.job_id = jobs.id) < date('now', '+10 hours');
SELECT 'archived by this sweep: ' || changes();
COMMIT;
SELECT 'archived after: ' || COUNT(*) FROM jobs WHERE archived = 1;
