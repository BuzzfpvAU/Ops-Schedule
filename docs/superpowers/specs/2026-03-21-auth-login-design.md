# Authentication & Role-Based Access Control — Design Spec

## Context

The Ops Schedule app currently has no authentication. Anyone can access all features — assign jobs, manage team members, edit schedules. A dropdown in the header lets users pick their name, but this is purely cosmetic with no access control.

This design adds email/password login (with passkey as an alternative), two permission levels (admin and user), and password reset functionality. The goal is to protect schedule data while letting team members self-serve for notes, TOIL, leave, and unavailability on their own row.

## Roles

### Admin
- Full access to all features
- Assign any job to any team member
- Manage team members (CRUD), jobs (CRUD), equipment (CRUD)
- Set email/password for team members
- Force-reset any user's password
- Promote/demote other users to admin
- Access all tabs: Schedule, Jobs/Projects, Team, Equipment

### User
- View the full schedule grid (read-only for other members' rows)
- On their own row only: add/remove Note, TOIL, Leave, or Not Available
- Cannot assign jobs, manage team members, manage jobs, or manage equipment
- Access Schedule tab only (Team, Jobs/Projects, Equipment tabs hidden)
- Can register passkeys and change their own password

**Leave vs Not Available:** "Leave" is for permanent staff with leave entitlements. "Not Available" is for casual team members without formal leave.

**"Leave" status:** This is a new status that must be added to the `STATUSES` constant in `api.js` and all related UI code as part of this work. It is not currently in the codebase.

## Database Changes

### Modified table: `team_members`

New columns:
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `email` | TEXT | UNIQUE | Login identifier. Nullable during migration. |
| `password_hash` | TEXT | | bcryptjs hash. Nullable until admin sets password. |
| `is_admin` | INTEGER | DEFAULT 0 | 0 = user, 1 = admin |
| `must_change_password` | INTEGER | DEFAULT 0 | Set to 1 after admin force-reset. User must set new password on next login. |

The existing `role` and `active` fields remain unchanged (`active` already exists in the schema for soft-delete).

### New table: `passkey_credentials`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PRIMARY KEY | WebAuthn credential ID (Base64-encoded binary from authenticator, not UUID) |
| `team_member_id` | TEXT | FK → team_members, ON DELETE CASCADE | Owner |
| `public_key` | TEXT | NOT NULL | Stored public key |
| `counter` | INTEGER | NOT NULL, DEFAULT 0 | Sign counter for replay protection |
| `created_at` | TEXT | DEFAULT datetime('now') | |

### New table: `password_reset_tokens`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `team_member_id` | TEXT | FK → team_members, ON DELETE CASCADE | |
| `token_hash` | TEXT | NOT NULL | Hashed reset token |
| `expires_at` | TEXT | NOT NULL | 1 hour from creation |
| `used` | INTEGER | DEFAULT 0 | Prevents reuse |

## Auth Endpoints

### Login

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/login` | POST | None | Email + password login. Returns JWT in httpOnly SameSite=Lax cookie (7-day expiry). No silent refresh — users re-authenticate after expiry. |
| `/api/auth/logout` | POST | Any | Clears JWT cookie. |
| `/api/auth/me` | GET | Any | Returns current user info from JWT. Refreshes `is_admin` from DB on each call. |
| `/api/auth/setup` | POST | None | First-time admin registration. Only works when no users have credentials. |
| `/api/auth/change-password` | POST | Logged in | User changes their own password (requires current password). |

### Passkey

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/passkey/register-options` | POST | Logged in | Returns WebAuthn registration challenge. |
| `/api/auth/passkey/register-verify` | POST | Logged in | Verifies and stores passkey credential. |
| `/api/auth/passkey/login-options` | POST | None | Returns WebAuthn login challenge (by email). |
| `/api/auth/passkey/login-verify` | POST | None | Verifies assertion, returns JWT cookie. |

**WebAuthn requirements:** Passkeys require HTTPS in production. The Relying Party ID is derived from `APP_URL`. Passkey features are unavailable over plain HTTP (buttons hidden). WebAuthn challenges are stored temporarily in a server-side map with 5-minute expiry.

### Password Reset

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/forgot-password` | POST | None | Generates token, sends email via Resend. Rate-limited: 3 requests per email per hour. |
| `/api/auth/reset-password` | POST | None | Validates token, sets new password. |
| `/api/auth/admin-reset-password` | POST | Admin | Force-sets temporary password for any user, sets `must_change_password = 1`. |

### Rate Limiting

- `/api/auth/login`: Max 5 attempts per IP per 15 minutes
- `/api/auth/forgot-password`: Max 3 requests per email per hour
- Implemented via simple in-memory tracking (adequate for team-sized app)

## Middleware

### `requireAuth`
- Applied to all `/api/*` routes except: `/api/auth/login`, `/api/auth/setup`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/passkey/login-options`, `/api/auth/passkey/login-verify`, `/api/health`
- Authenticated auth routes (`/api/auth/change-password`, `/api/auth/admin-reset-password`, `/api/auth/passkey/register-*`, `/api/auth/logout`, `/api/auth/me`) still require auth
- Reads JWT from httpOnly cookie
- Validates signature and expiry
- Looks up current `is_admin` and `active` status from database (not just JWT claims) to handle real-time demotion/deactivation
- Attaches `req.user = { memberId, isAdmin }` to request
- Returns 401 if missing/invalid/deactivated

### `requireAdmin`
- Applied after `requireAuth` on protected routes
- Checks `req.user.isAdmin === true`
- Returns 403 if not admin

## Permission Enforcement

### Server-side (API)

| Resource | Admin | User |
|----------|-------|------|
| `PUT /api/schedule` (job assignment) | Any member | Blocked (403) |
| `PUT /api/schedule/bulk` | Any member | Blocked (403) |
| `PUT /api/schedule` (note/TOIL/leave/unavailable) | Any member | Own row only, server checks `status` is in allowed list |
| `DELETE /api/schedule/member/:id/date/:date` | Any member | Own row only (server validates `:id` matches `req.user.memberId` AND entry `status` is note/toil/leave/unavailable) |
| `/api/team-members` CRUD | Full access | Blocked (403) |
| `/api/jobs` CRUD | Full access | Blocked (403) |
| `/api/schedule/status` | Any member | Own entries only, server validates `memberId` matches `req.user.memberId` |
| `/api/notifications` | Full access | Own notifications only, server enforces `memberId` URL param matches `req.user.memberId` |
| `/api/seed` | Admin only (or disabled in production) | Blocked (403) |
| Equipment CRUD (via `/api/team-members` with `is_equipment`) | Full access | Blocked (403) |

**Distinguishing user entries from admin assignments:** The server checks the `status` field of the schedule entry. Statuses `note`, `toil`, `leave`, `unavailable` are user-allowed types. Statuses `tentative`, `confirmed` are admin-only (job assignments). Users cannot create or delete entries with admin-only statuses.

**Equipment rows:** Equipment items (`is_equipment = 1`) cannot log in. Only admins can assign jobs or modify equipment schedule entries. Users see equipment rows as read-only (same as other members' rows).

### Client-side (UI)

**Header changes:**
- Remove user-select dropdown
- Show logged-in user's name + role badge (Admin/User) + logout button

**Tab visibility (user):**
- Show: Schedule
- Hide: Jobs/Projects, Team, Equipment

**Schedule grid (user):**
- Other members' rows and all equipment rows: view-only, no click handler
- Own row (empty cell click): dropdown shows only Note, TOIL, Leave, Not Available — no job search, no days selector, no multi-day assignment button
- Own row (existing entry): can clear only entries with status note/toil/leave/unavailable, not job assignments placed by admin (clear button hidden for admin-assigned entries)

## Login Page

- Centered card design matching the app's dark theme
- Email + password fields
- "Sign In" primary button
- Divider with "or"
- "Sign in with Passkey" secondary button (hidden if not HTTPS)
- "Forgot password?" link below (hidden if `RESEND_API_KEY` not configured)
- On first-ever visit (no users with credentials in DB): shows "Create Admin Account" registration form instead

## Password Reset Flow

### Self-service (email)
1. User clicks "Forgot password?" on login page
2. Enters email address
3. Server generates reset token (UUID), hashes it, stores in `password_reset_tokens` with 1-hour expiry
4. Sends email via Resend with reset link: `https://yoursite.com/reset-password?token=xxx`
5. User clicks link, enters new password (minimum 8 characters)
6. Server validates token, updates `password_hash`, marks token as used

### Admin force-reset
1. Admin goes to Team tab, clicks a team member
2. "Reset Password" button generates a temporary password
3. Server sets `must_change_password = 1` on the team member
4. Admin communicates temporary password to the team member out-of-band
5. On next login, user is prompted to set a new password before proceeding

### Fallback
If `RESEND_API_KEY` is not configured:
- Email self-service reset is disabled (link hidden on login page)
- Reset tokens are logged to server console for development/testing
- Admin force-reset always works regardless

## CORS & Cookie Configuration

**Cookie settings:**
- `httpOnly: true` — not accessible via JavaScript
- `SameSite: 'Lax'` — prevents CSRF on state-changing requests from cross-origin
- `secure: true` in production (HTTPS only)
- `path: '/'`

**CORS changes:**
- Configure `cors()` with explicit `origin` matching the frontend URL
- Set `credentials: true` to allow cookies
- All client `fetch()` calls must include `credentials: 'include'`

**Development:** Vite dev server (port 5173) proxies to Express (port 3001). CORS origin set to `http://localhost:5173`.

**Production:** Single Express server serves both API and static frontend from same origin. CORS can be restrictive or disabled.

## Migration Strategy

1. Schema migration adds `email`, `password_hash`, `is_admin`, `must_change_password` columns to `team_members` (all nullable/defaulted)
2. Creates `passkey_credentials` and `password_reset_tokens` tables
3. Adds `leave` to the `STATUSES` constant in `api.js` with color `#22c55e`
4. First visit after migration: no users have credentials → show "Create Admin Account" page
5. First user registers with email + password → automatically set as `is_admin = 1` (protected by `INSERT WHERE NOT EXISTS` to prevent race condition)
6. Admin then sets email + password for each team member via Team tab
7. Team members without credentials cannot log in until admin configures them

## New Dependencies

### Server
- `bcryptjs` — password hashing (pure JS, no native bindings — reliable on Hostinger)
- `jsonwebtoken` — JWT creation/verification
- `@simplewebauthn/server` — WebAuthn server-side operations
- `resend` — email sending for password reset (optional)

### Client
- `@simplewebauthn/browser` — WebAuthn browser-side API

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Secret key for signing JWTs. Minimum 256 bits. Generate with: `openssl rand -base64 32` |
| `RESEND_API_KEY` | No | Resend API key for password reset emails. If not set, email reset disabled, tokens logged to console. |
| `APP_URL` | No | Base URL for reset email links and WebAuthn RP ID. Defaults to `http://localhost:5173`. |
| `DATABASE_PATH` | No | Custom database file path (existing). |

## Password Requirements

- Minimum 8 characters
- No additional complexity rules (appropriate for a team tool)
- bcryptjs with cost factor 12

## Verification

1. **Login flow**: Navigate to app without cookie → redirected to login page → enter email/password → redirected to schedule
2. **Passkey flow**: Register passkey from profile → log out → log in with passkey → schedule loads
3. **Admin permissions**: Log in as admin → all tabs visible → can assign jobs to any member → can manage team/jobs/equipment
4. **User permissions**: Log in as user → only Schedule tab → can click own row → dropdown shows Note/TOIL/Leave/Not Available only → other rows not clickable
5. **Server enforcement**: Use curl to hit admin-only endpoints with user JWT → expect 403
6. **User delete restriction**: User tries to delete an admin-assigned entry on their row → expect 403
7. **Equipment rows**: User cannot click equipment rows; admin can assign to equipment
8. **Password reset (email)**: Click forgot password → receive email → click link → set new password → log in with new password
9. **Password reset (admin)**: Admin resets user's password → user logs in with temporary password → forced to set new password
10. **First-time setup**: Fresh database → shows "Create Admin Account" → first user becomes admin
11. **Deactivated user**: Admin deactivates user → user's next API call returns 401 even with valid JWT
12. **Seed endpoint**: Non-admin user cannot access `/api/seed`
13. **CORS**: Cross-origin requests without credentials are rejected
