# Mobile Individual Schedule View — Design

**Date:** 2026-09-10
**Status:** Approved

## Problem

The schedule is a wide horizontal table: rows are team members, columns are dates.
It works on a desktop monitor and is unusable on a phone — the member column plus
42 day columns cannot fit, and the drag/resize interactions are mouse-driven.

Field staff check their own schedule on a phone. They need a view that reads top
to bottom and lets them mark their own days.

## Scope

A per-person vertical calendar that replaces the grid on narrow viewports.

- Defaults to the logged-in user, switchable to any team member.
- Reached by viewport width only (≤768px). No desktop entry point, no new tab.
- Editing is limited to note / TOIL / leave / unavailable on your own days.
  Admins get the same actions on any day. Job assignment stays on desktop.

Out of scope: job assignment, drag/resize, multi-day spans, equipment editing.

## Architecture

App already owns the schedule data and the infinite-scroll date range. The new
view is a sibling of `ScheduleGrid` fed by the same props, chosen by viewport:

```
App
├── useIsNarrow()                  → matchMedia('(max-width: 768px)')
├── ScheduleGrid       (wide)
└── IndividualSchedule (narrow)
    └── DayActionSheet             → note / TOIL / leave / unavailable
```

`ScheduleGrid` is not modified. No second data layer: `IndividualSchedule`
filters the same `schedule` array and calls the same `onLoadMore` /
`onScheduleRefresh` callbacks.

### Units

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `useIsNarrow.js` | Report whether the viewport is ≤768px, reactively | `window.matchMedia` |
| `individualSchedule.js` | Pure logic: group entries by date, decide editability | nothing |
| `IndividualSchedule.jsx` | Render the vertical calendar, own scroll behaviour | the two above, api.js |
| `DayActionSheet.jsx` | Present day actions, call the quick-entry API | api.js |

The pure logic lives in `individualSchedule.js` so it can be tested without a DOM.

## Rendering

One row per date in `allDates`, ordered ascending:

- Left rail: weekday abbreviation and day number. Today is accented; weekends dim.
- Right: one card per schedule entry — job code, job name, status, notes.
  Card colour comes from the job colour, with a status-coloured left border.
- Empty days render "Free" with a `+` affordance when the day is editable.
- A sticky month header appears whenever the month changes.
- On mount the list scrolls today into view.

## Infinite scroll

IntersectionObserver sentinels at the top and bottom of the list call the
existing `onLoadMore('past')` / `onLoadMore('future')`.

Prepending past days shifts content down. Before the range grows the component
records `scrollHeight`; after the new rows render it adds the delta to
`scrollTop`, so the day the user was looking at stays put.

## Editing

Tapping an editable day opens `DayActionSheet`: Add note, TOIL, Leave,
Unavailable, plus delete for entries with a user-allowed status.

A day is editable when the viewed member is the logged-in user, or the user is
an admin. Viewers can never edit.

### Server change: `POST /api/schedule/quick`

The client currently creates the backing job (`TOIL`, `LEAVE`, `NOT-AVAIL`,
`NOTE-*`) itself via `POST /api/jobs`, which is `requireAdmin`. A non-admin
adding a note — or the first TOIL entry before that job exists — gets a 403.
This is a live bug in the desktop grid, not only a mobile concern.

New endpoint, mounted on the existing authed `/api/schedule` router:

```
POST /api/schedule/quick
  { date, status, text?, team_member_id? }
```

- `status` must be one of `note`, `toil`, `leave`, `unavailable`.
- `team_member_id` defaults to `req.user.memberId`; non-admins may not pass a
  different one; viewers are rejected.
- The special job is found or created server-side, inside the same transaction
  as the entry, so a non-admin never needs job-write permission.
- Note text maps to a job named after the text, code `NOTE-<slug>`, reusing an
  existing job with the same name rather than creating duplicates.

Responds with the created entry, matching the shape `GET /api/schedule` returns.

## Testing

The repository has no test runner. Tests use `node --test` (built in, no new
dependency), run with `npm test` from the repo root.

- `individualSchedule.test.js` — grouping entries by date; days with no entries;
  multiple entries on one day; editability for own / other / admin / viewer.
- `scheduleQuick.test.js` — endpoint against an in-memory database: non-admin
  writes own day; non-admin blocked from another member's day; invalid status
  rejected; second call for the same status reuses the job rather than
  duplicating it.

Browser verification at a 375px viewport covers scroll anchoring and the sheet.

## Styling

New rules appended to `styles.css` under an `.ind-` prefix, using the existing
custom properties. The existing `@media (max-width: 768px)` block gains
horizontal scrolling for `.nav-tabs`, which overflows on a phone today.
