# Shared View-Only Access

## Overview

Add a shared view-only account that lets external users view the schedule without edit access. Admins can share the login credentials via email from the Team screen.

## Viewer Account

- **Email:** `view@auav.com.au`
- **Password:** `rh2FpFcU34xvDs`
- Fixed credentials — cannot be changed via forgot-password flow.
- Created automatically on database migration.

## Database Changes

### Schema

Add column to `team_members`:

```sql
ALTER TABLE team_members ADD COLUMN is_viewer INTEGER DEFAULT 0;
```

### Migration

Insert the viewer account if it doesn't exist:

```sql
INSERT INTO team_members (id, name, email, password_hash, is_viewer, is_admin, active)
VALUES (uuid, 'Viewer', 'view@auav.com.au', bcrypt_hash, 1, 0, 1);
```

## Server Changes

### Auth Middleware (`server/src/middleware/auth.js`)

- Include `isViewer` in JWT payload via `signToken()`
- Add `isViewer` to `req.user` object in `requireAuth`
- Add `requireNonViewer` middleware that rejects viewer accounts from write endpoints

### Auth Routes (`server/src/routes/auth.js`)

- **Login:** Works normally for viewer account. Return `isViewer: true` in response.
- **`/auth/init`:** Include `isViewer` in the user object.
- **Forgot password:** Skip viewer accounts — don't generate reset token, return generic success message.
- **Change password:** Block for viewer accounts.

### New Endpoint: Share Viewer Access

`POST /api/auth/share-viewer-access` (requires auth + admin)

**Request:** `{ recipientEmail: string }`

**Behavior:**
1. Validate `recipientEmail` is a valid email
2. Send email via Resend with the viewer login credentials
3. Return `{ success: true }`

**Email content:** Simple HTML email with the app URL, viewer email, and password.

### Query Filtering

All queries that list team members for display should filter out viewer accounts:

- `GET /api/team-members` — add `AND is_viewer = 0`
- Schedule queries that join team_members — add `AND is_viewer = 0`

## Client Changes

### Auth Context

Add `isViewer` to the user state from login/init responses.

### App.jsx — Tab Visibility

When `user.isViewer`:
- Show only Schedule tab
- Hide: Jobs/Projects, Team, Equipment
- Hide admin-only UI elements (notifications bell, settings)

### Header

- Show "Viewer" badge when `user.isViewer`
- Hide passkey icon, notifications, and settings for viewer

### TeamManager.jsx — Share Button

Admin-only UI addition:
- "Share View Access" button at top of Team Manager
- Opens modal with:
  - Email input field
  - "Send" button
- On submit: calls `POST /api/auth/share-viewer-access` with the entered email
- Shows success/error feedback

## Email Template

Subject: "Ops Schedule — View Access"

Body includes:
- App URL (from `process.env.APP_URL`)
- Login email: `view@auav.com.au`
- Password: `rh2FpFcU34xvDs`
- Brief instruction to log in and view the schedule

## Security Considerations

- Viewer account is read-only — server enforces this via middleware on all write endpoints
- Viewer credentials are shared, so the account should never have write access
- Password reset is blocked for the viewer account
- Viewer account is excluded from team member listings so it doesn't appear in the schedule grid

## Files to Modify

1. `server/src/db.js` — schema migration, viewer account creation
2. `server/src/middleware/auth.js` — `isViewer` in JWT/user, `requireNonViewer` middleware
3. `server/src/routes/auth.js` — login response, forgot-password skip, share-viewer-access endpoint
4. `server/src/routes/teams.js` — filter viewer from listings
5. `server/src/routes/schedule.js` — filter viewer from schedule queries (if needed)
6. `server/src/utils/email.js` — add `sendViewerAccessEmail()` function
7. `client/src/context/AuthContext.jsx` — add `isViewer` to user state
8. `client/src/App.jsx` — conditional tab rendering for viewer
9. `client/src/components/TeamManager.jsx` — share view access button and modal
10. `deploy/` — mirror all server and client changes
