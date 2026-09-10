# HANDOFF — 2026-09-10

## What this covers

Mobile individual schedule view. Built, committed, **not deployed**.

## State

- **Branch:** `main`, 3 commits ahead of `origin/main` — nothing pushed
- **Commits:** `4efc9fc` (spec), `4e60850` (feature), plus this handoff
- **Live:** https://taskz.id still runs the previous build (`ce951e2`)
- **Tests:** `npm test` — 24 passing

## Pending: finish the deploy

Blocked on credentials, not on code. Both legs failed from the agent shell:

- `git push` → `remote: Invalid username or token`. The osxkeychain GitHub
  entry is stale and `gh` is not logged in (`gh auth login` fixes it).
- `ssh hermes@srv1713679.hstgr.cloud` → `Permission denied (publickey,password)`.
  The agent socket under `~/.ssh/agent/` does not answer a non-interactive
  shell; `ssh-add -l` hangs against it.

Run, in order:

```
git push origin main
```

```
ssh hermes@srv1713679.hstgr.cloud 'export PATH=/opt/alt/alt-nodejs20/root/bin:$PATH && cd ~/domains/taskz.id/nodejs && git reset --hard origin/main && npm install && npm run build && touch tmp/restart.txt'
```

Then confirm https://taskz.id returns 200 and open it on a phone.

Rollback is `git reset --hard ce951e2` in `~/domains/taskz.id/nodejs`
followed by `touch tmp/restart.txt`. No schema migration ships with this
change, so a rollback needs no database work.

## What the change does

Viewports of 768px or less render `IndividualSchedule` — one person's days
stacked vertically — instead of the horizontal team grid. Wider viewports
are untouched. It opens on the logged-in user and switches to any member.
Tapping one of your own days opens a sheet: note, TOIL, leave, unavailable,
and remove for entries you added.

`POST /api/schedule/quick` is new. `POST /api/jobs` is admin-only, and the
note/TOIL flow creates its backing job client-side, so a non-admin adding a
note — or the first TOIL entry before that job exists — got a 403. The
desktop grid has the same bug; the new endpoint resolves the job server-side
inside the entry transaction. `DELETE /api/schedule/:id` now also accepts a
member removing their own note-type entry, where it was admin-only before.

Design doc: `docs/superpowers/specs/2026-09-10-mobile-individual-view-design.md`

## Verify after deploying

Checked locally as a non-admin: add TOIL, add a note, remove your own entry,
and confirm another member's days are read-only with no sheet.

**Not verified anywhere yet — check this on a real phone.** Scrolling to
either end of the list should load another fortnight, and prepending past
days should hold your scroll position. The Claude Code browser pane stayed
hidden for the whole session, which puts the page in `visibilityState:
'hidden'` and suspends both IntersectionObserver and scroll events, so the
loader never fired there. If it is broken the list simply caps at its
initial six-week window; nothing else breaks.

## Local-only, not committed

- `.claude/launch.json` points the dev servers at Node 22 (`~/.local/bin`).
  `better-sqlite3` is compiled for 22, so the API will not boot under
  Homebrew's Node 26. Gitignored.
- A throwaway `mobiletest@example.com` member was created in the local dev
  database to test as a non-admin, then deleted along with the note job it
  created. Prod was never touched.

## Still open from before

Unchanged by this work — see `.agent-status.md`:

- AirTag go-live (Apple sign-in, key export, launchd job)
- `deploy/` gitlink dirty, with no `.gitmodules` mapping
- Shared viewer credentials hardcoded in `server/src/db.js`
