# Authentication System Documentation

## Overview

This template includes a complete OAuth-based authentication system with automatic route protection. Authentication is handled via OverSkill's OAuth provider with JWT tokens.

## Roles: this app already has them

**Read this before writing any access-control code.** This app was created with
platform roles already in place. You do not create them, and you must not build
anything that re-creates them.

| Role | Who has it | What it means |
|---|---|---|
| `admin` | The person who created this app, always, from the moment the app exists | Full access. Manages members. |
| `member` | Anyone the owner lets in by hand from the Overskill editor | Belongs here. Use it to gate anything that is not for the general public. |
| `pro_member` ("Pro Member") | Anyone who buys a paid plan, when this app sells one | The paid tier. Already seeded when the prompt implies a paid plan. Do not invent a second paid role. |

Signing in is **not** the same as being a member. A signed-in visitor with no
role is just signed in, so a member gate is a real gate, not decoration.

**Roles do not nest, so always write a member gate as `anyOf`:**

```tsx
<RequireRole anyOf={['admin', 'member']}>
  <MembersOnlyArea />
</RequireRole>
```

`<RequireRole role="member">` on its own would shut the app's **owner** out of
their own members' area — they hold `admin`, and `admin` does not imply
`member`. Every "members only" gate you write takes both.

Three consequences for the code you write:

**1. Gate admin-only UI with `<RequireRole>`, and trust that the role exists.**

```tsx
<RequireRole role="admin" fallback={<p>Only admins can change these settings.</p>}>
  <SettingsPanel />
</RequireRole>
```

`<RequireRole>` also takes `anyOf`, `allOf`, and `permission` — see
`src/components/RequireRole.tsx`. It is a UI gate: it decides what RENDERS, and nothing
more. The server re-checks **authentication** and **row ownership** on its own. It does
**not** re-check a role — unless you tell it to, with `required_role` (below).

**2. Roles are NOT data in this app.** They live on the Overskill platform, not in this
app's database. Never create a `roles`, `members`, `team_members`, `permissions`, or
`user_roles` entity, and never write a table to track who is an admin — you would be
building a second, wrong answer to a question the platform already answers. Read the
current user's roles with the `useRoles()` hook (`src/hooks/use-roles.ts`), which reads
them from the signed token.

**3. Do not build a member-administration screen.** No invite form, no "manage users"
table, no role-assignment dropdown. The app's owner adds people, assigns roles, and
removes access from the Overskill editor — that surface already exists and is the only
one that can actually authorize the change. If someone asks for user management inside
the app, point them at the editor instead of building a copy of it.

If this app sells a paid plan, buyers are granted the `pro_member` role
automatically when their purchase becomes active, and it is taken away when the
purchase ends. That happens on the platform side; there is nothing to write here
for it. Gate paid surfaces with `anyOf={['admin', 'pro_member']}` (or include
`member` if free members should see the same thing). Do not create another
"Pro Member" / `premium` role — it already exists or will exist when the plan
is created.

### The server-side half of a paid gate: `required_role` on the ENTITY

**This is the one that bites.** `<RequireRole>` hides the component. The data behind it
is served by `/api/entities/<name>`, and that endpoint answers a `public` or
`public_with_author` GET **before it ever reads the Authorization header**. So a paywall
built out of `<RequireRole>` alone renders the upsell correctly to a visitor and still
hands them every row the moment they open a network tab:

```
$ curl https://your-app.overskill.app/api/entities/lounge_slots   # no token at all
200 OK  [ ...every row of the $29/mo content... ]
```

Put the role on the entity as well. When you create the entity that holds paid content,
pass `required_role`:

```
os-create-entity({
  entity_name: "lounge_slot",
  user_scoping: "public",          // who OWNS the row: admin-curated content
  required_role: "pro_member",     // who may SEE it: paying members only
  columns: [...]
})
```

The entity API then refuses before it reads a row — **401** for an anonymous caller,
**403** for a signed-in caller without the role — and `admin` always passes so the owner
can maintain what they sell. On an entity that already exists, use
`os-update-entity-scope({ entity_name: "lounge_slot", required_role: "pro_member" })`;
it changes no rows.

Keep the `<RequireRole>` too. The two do different jobs: the server one is the gate,
the client one is what renders the upsell instead of an error.

Which entities need it:

| Entity | Gate it? |
|---|---|
| The paid schedule / library / lounge the owner curates | `public` + `required_role: "pro_member"` |
| Rows paying members create for themselves (bookings, posts) | `public_with_author` + `required_role: "pro_member"` |
| An invite-only members' area | the same, with `required_role: "member"` |
| Marketing pages, public catalogs, anything free | no `required_role` — leave it off |

**The gate covers `/api/entities` ONLY.** A `requires_auth: false` custom endpoint that reads a
gated table re-opens the leak: `checkRoleGate` runs in the entity API's dispatcher and nowhere
else, so a public custom route serves the paid rows to an anonymous caller no matter what
`required_role` the table carries. Read gated data through `/api/entities`, or through a custom
endpoint with `requires_auth: true`.

## How It Works

### 1. OAuth Flow

```
User clicks "Login" → Redirects to OverSkill OAuth → User authorizes → 
Callback with code → Server exchanges for token → Token stored in localStorage → 
User redirected to app
```

### 2. Automatic Route Protection

The template supports **automatic route protection** based on the `VITE_APP_VISIBILITY` environment variable:

```typescript
// Configure in OverSkill Dashboard → Settings → Environment Variables
VITE_APP_VISIBILITY=login_required  // All routes require authentication
VITE_POST_LOGIN_ROUTE=/dashboard   // Where to redirect after login
```

When `VITE_APP_VISIBILITY` is set to a protected mode, `App.tsx` automatically wraps all app routes in `<ProtectedRoute>` which enforces authentication before rendering content.

### 3. Visibility Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `public` | No restrictions | Landing pages, marketing sites |
| `login_required` | Must be logged in | Task managers, dashboards, SaaS apps |
| `purchase_required` | Must have active subscription | Paid apps, premium features |
| `domain_restricted` | Email must match allowed domains | Internal tools, company apps |

### 4. Components

#### ProtectedRoute Component

Location: `src/components/ProtectedRoute.tsx`

```tsx
import { ProtectedRoute } from '@/components/ProtectedRoute'

// Wrap any route that requires authentication
<Route path="/dashboard" element={
  <ProtectedRoute>
    <Dashboard />
  </ProtectedRoute>
} />
```

The `ProtectedRoute` component:
- Calls `checkAppAccess()` from `lib/auth.ts`
- Shows loading state while checking
- Redirects to `/login` if not authenticated
- Renders content if authenticated

#### AuthHeader Component

Location: `src/components/AuthHeader.tsx`

A dropdown menu showing user avatar, profile info, and actions. Uses shadcn/ui `DropdownMenu` and `Avatar` components.

**Features:**
- Avatar with initials fallback (supports profile images)
- Dropdown with user name/email display
- Profile and Settings navigation
- Log out action with destructive styling
- Auto-hides for `public` visibility apps

**Usage:**
```tsx
// Already included in App.tsx - just import where needed
import { AuthHeader } from '@/components/AuthHeader'

// Renders in fixed top-right position
<AuthHeader />
```

**Customization:**

`src/components/AuthHeader.tsx` is platform-owned and read-only. All file writes
are refused, including small edits to dropdown items or avatar styling. Use it
as-is, or build an app-owned header/layout using `useAuth()` or
`overskill.auth.logout()` from `@/lib/auth`. Keep visible Logout and Settings
actions, and navigate to `/logged-out` after logout.

Keep app-specific state cleanup in its owning context or app-owned logout
handler. The bundled AuthHeader already navigates to `/logged-out` after logout;
if retaining it, inspect your context's mounting and routing before observing
that transition for cleanup. Do not change protected auth files. Do not assume
another component's logout updates every `useAuth()` instance: the template
hook has local state, `overskill:auth-cleared` reports an HTTP 401 rather than
every logout, and no `onAuthStateChange` API is provided. Session-integrity
cleanup does not reset arbitrary application contexts or their persisted state.

### 5. Auth Utilities

Location: `src/lib/auth.ts`

```typescript
import { overskill, requireAuth, checkAppAccess, getCurrentUser } from '@/lib/auth'

// Check if user is logged in (async)
const user = await overskill.auth.checkSession()

// Get current user with profile data
const user = await getCurrentUser()

// Require auth (redirects if not logged in)
const user = await requireAuth()

// Check app-level access (handles all visibility modes)
const hasAccess = await checkAppAccess()

// Logout
await overskill.auth.logout()
```

### 6. Pre-Built Auth Pages

These pages are included and ready to use:

- `/login` - OAuth redirect page
- `/callback` - OAuth callback handler
- `/access-denied` - Domain restriction error
- `/logged-out` - Logout confirmation

**Do not modify these pages** unless you need custom styling. The OAuth flow is handled automatically.

## Usage Examples

### Example 1: Full App with Login Required

```typescript
// Configure in OverSkill Dashboard → Settings → Environment Variables:
// VITE_APP_VISIBILITY=login_required
// VITE_POST_LOGIN_ROUTE=/tasks

// App.tsx - ALL routes automatically protected!
<Routes>
  <Route path="/tasks" element={<Tasks />} />
  <Route path="/settings" element={<Settings />} />
  {/* Both routes require login automatically */}
</Routes>
```

### Example 2: Mixed Public/Protected Routes

```typescript
// Configure in OverSkill Dashboard → Settings → Environment Variables:
// VITE_APP_VISIBILITY=public  // Don't use global protection

// App.tsx - Manually wrap protected routes
<Routes>
  {/* Public routes */}
  <Route path="/" element={<LandingPage />} />
  <Route path="/about" element={<About />} />
  
  {/* Protected routes */}
  <Route path="/dashboard" element={
    <ProtectedRoute>
      <Dashboard />
    </ProtectedRoute>
  } />
</Routes>
```

### Example 3: Using Auth in Components

```tsx
import { overskill } from '@/lib/auth'
import { useEffect, useState } from 'react'

export function TaskList() {
  const [user, setUser] = useState(null)
  
  useEffect(() => {
    // Get current user
    overskill.auth.checkSession().then(setUser)
  }, [])
  
  const handleLogout = async () => {
    await overskill.auth.logout()
    window.location.href = '/logged-out'
  }
  
  return (
    <div>
      <p>Welcome, {user?.name}!</p>
      <button onClick={handleLogout}>Logout</button>
    </div>
  )
}
```

### Example 4: Domain-Restricted App

```typescript
// Configure in OverSkill Dashboard → Settings → Environment Variables:
// VITE_APP_VISIBILITY=domain_restricted
// VITE_ALLOWED_DOMAINS=company.com,partner.com
// VITE_POST_LOGIN_ROUTE=/dashboard

// Only emails ending in @company.com or @partner.com can access
// Others see /access-denied page
```

## How App.tsx Handles Protection

The `App.tsx` file checks the visibility setting and automatically wraps routes:

```tsx
// App.tsx
const appVisibility = import.meta.env.VITE_APP_VISIBILITY || 'public';
const requiresGlobalAuth = ['login_required', 'purchase_required', 'domain_restricted'].includes(appVisibility);

// Routes are conditionally wrapped based on visibility
<Route path="/" element={
  requiresGlobalAuth ? (
    <ProtectedRoute>
      <Index />
    </ProtectedRoute>
  ) : (
    <Index />
  )
} />
```

This means:
- ✅ Set `VITE_APP_VISIBILITY=login_required` → All routes protected automatically
- ✅ Set `VITE_APP_VISIBILITY=public` → Routes are public (unless manually wrapped)
- ✅ No code changes needed to enable/disable global protection

## Common Patterns

### Pattern 1: SaaS App (Login Required)

**When to use:** Task managers, dashboards, CRMs, internal tools

```bash
# Configure in OverSkill Dashboard → Settings → Environment Variables:
VITE_APP_VISIBILITY=login_required
VITE_POST_LOGIN_ROUTE=/dashboard
```

Result: ALL routes require login automatically. No manual `<ProtectedRoute>` needed.

### Pattern 2: Marketing Site with Member Area

**When to use:** Public landing page + protected dashboard

```bash
# Configure in OverSkill Dashboard → Settings → Environment Variables:
VITE_APP_VISIBILITY=public
```

Then manually wrap protected routes:
```tsx
<Route path="/" element={<LandingPage />} />  {/* Public */}
<Route path="/app" element={
  <ProtectedRoute>
    <Dashboard />
  </ProtectedRoute>
} />  {/* Protected */}
```

### Pattern 3: Freemium App (Purchase Required)

**When to use:** Free tier + paid features

```bash
# Configure in OverSkill Dashboard → Settings → Environment Variables:
VITE_APP_VISIBILITY=purchase_required
```

Result: Only users with active subscriptions can access the app.

## Post-Login Redirect Behavior

### How It Works

After successful OAuth login, users are redirected based on this priority order:

1. **Custom Redirect** - If user clicked login with `?redirect=/custom` parameter
   - Stored in `sessionStorage` by login.tsx
   - Cleared after use (one-time redirect)

2. **VITE_POST_LOGIN_ROUTE** - Environment variable (most common)
   - Set in OverSkill dashboard under "Environment Variables"
   - Example: `VITE_POST_LOGIN_ROUTE=/dashboard`
   - Persistent across all logins

3. **Default** - Home page (`/`) if nothing else is set

### Token Extraction Flow

The OAuth callback uses a two-phase token extraction system:

**Phase 1: Early Extraction (lib/auth.ts)**
- Runs at module import time (before React)
- Extracts `access_token` from URL hash
- Stores in `localStorage.overskill_token`
- Sets flag in `sessionStorage` to prevent re-extraction
- **Does NOT handle redirect** (that's callback.tsx's job)

**Phase 2: Redirect Handling (callback.tsx)**
- Runs when `/callback` page mounts
- Checks if token was already extracted
- Determines redirect destination (custom > env var > default)
- Uses React Router to navigate (no page reload)

### Common Issues

**Issue:** "I set VITE_POST_LOGIN_ROUTE but users go to `/`"
- **Cause:** Hard page reload clears sessionStorage before callback.tsx runs
- **Fix:** Ensure no `window.location.reload()` calls in App.tsx
- **Verify:** Check browser console for `[OAuth Callback]` logs

**Issue:** "Custom redirect from login.tsx doesn't work"
- **Cause:** sessionStorage cleared by page reload
- **Fix:** App.tsx should NOT reload the page on token extraction
- **Workaround:** Use VITE_POST_LOGIN_ROUTE instead of custom redirects

### Testing Post-Login Routes

```bash
# 1. Set VITE_POST_LOGIN_ROUTE in OverSkill dashboard
VITE_POST_LOGIN_ROUTE=/dashboard

# 2. Test login flow
- Click "Login" button
- Complete OAuth
- Verify you land on /dashboard (not /)

# 3. Check browser console
[lib/auth] Token extracted from URL hash, storing in localStorage
[lib/auth] Token stored, hash cleared. callback.tsx will handle redirect.
[OAuth Callback] Token available, handling post-login redirect
[OAuth Callback] VITE_POST_LOGIN_ROUTE is set: /dashboard
[OAuth Callback] Final post-login route: /dashboard
[OAuth Callback] Navigating to: /dashboard
```

### Example: Custom Login Button with Redirect

```tsx
import { Link } from 'react-router-dom'

function MyComponent() {
  return (
    <Link to="/login?redirect=/tasks">
      Go to Tasks (login if needed)
    </Link>
  )
}
```

After login, user will land on `/tasks` (custom redirect takes priority over VITE_POST_LOGIN_ROUTE).

## Troubleshooting

### Issue: Routes not protected despite login_required

**Cause:** `VITE_APP_VISIBILITY` not set correctly

**Fix:** Check **Dashboard → Settings → Environment Variables** has `VITE_APP_VISIBILITY=login_required`

### Issue: Redirect loop on login

**Cause:** `VITE_POST_LOGIN_ROUTE` points to route that redirects to login

**Fix:** Set `VITE_POST_LOGIN_ROUTE` to a valid authenticated route (like `/dashboard`)

### Issue: User logged in but sees empty data

**Cause:** Entity is `user_scoped` but app visibility is `public`

**Fix:** Set `VITE_APP_VISIBILITY=login_required` to enforce authentication

### Issue: Can't access any routes after deploying

**Cause:** OAuth credentials not configured

**Fix:** Ensure `VITE_OAUTH_CLIENT_ID` is set in production environment variables

## Security Best Practices

1. **Always use login_required for user_scoped entities**
   - User-scoped data requires authentication to work properly
   - Setting public visibility with user_scoped data = broken UX

2. **Never store sensitive data in localStorage**
   - Only JWT tokens should be stored
   - Use overskill-sdk for all data operations

3. **Use domain_restricted for internal tools**
   - Restrict access to company email domains
   - Example: `VITE_ALLOWED_DOMAINS=company.com`

4. **Set appropriate VITE_POST_LOGIN_ROUTE**
   - Redirect users to the main app view after login
   - Don't redirect to public pages (confusing UX)

## Building Custom Profile/Onboarding Features

If your app needs to collect additional user information (profile data, preferences, onboarding steps), build it as a custom feature rather than using a generic signup flow.

### Recommended Approach

1. **Create a UserProfile entity** with the fields your app needs
2. **Build a profile page** at `/profile` or `/onboarding`
3. **Check profile completion** on protected routes if needed

### Example: Custom Onboarding Flow

```tsx
// src/pages/Onboarding.tsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { overskill } from '@/lib/auth'

export default function Onboarding() {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)

  useEffect(() => {
    overskill.auth.checkSession().then(setUser)
  }, [])

  const handleSubmit = async (data) => {
    // Store in your UserProfile entity
    await overskill.from('user_profiles').insert({
      user_id: user.id,
      ...data,
      completed_at: new Date().toISOString()
    })
    navigate('/dashboard')
  }

  // Render your custom onboarding form
  return (
    <form onSubmit={handleSubmit}>
      {/* Your app-specific fields */}
    </form>
  )
}
```

### Example: Profile Completion Check

```tsx
// In a protected component
const { data: profile } = useQuery({
  queryKey: ['userProfile', user?.id],
  queryFn: () => overskill.from('user_profiles')
    .select('*')
    .eq('user_id', user.id)
    .single(),
  enabled: !!user
})

// Redirect if profile incomplete
useEffect(() => {
  if (user && profile === null) {
    navigate('/onboarding')
  }
}, [user, profile])
```

This approach gives you full control over:
- Which fields to collect
- When to show the onboarding flow
- How to validate and store the data
- Custom UI/UX for your specific app

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         User Browser                          │
│                                                               │
│  ┌──────────────┐      ┌─────────────────┐                  │
│  │  App.tsx     │─────▶│ ProtectedRoute  │                  │
│  │              │      │                 │                  │
│  │ Checks       │      │ Calls           │                  │
│  │ VITE_APP_    │      │ checkAppAccess()│                  │
│  │ VISIBILITY   │      │                 │                  │
│  └──────────────┘      └────────┬────────┘                  │
│                                  │                            │
│                                  ▼                            │
│                        ┌─────────────────┐                   │
│                        │   lib/auth.ts   │                   │
│                        │                 │                   │
│                        │ - checkSession()│                   │
│                        │ - requireAuth() │                   │
│                        │ - getCurrentUser│                   │
│                        └────────┬────────┘                   │
│                                  │                            │
│                                  ▼                            │
│                        ┌─────────────────┐                   │
│                        │ overskill-sdk   │                   │
│                        │                 │                   │
│                        │ JWT token from  │                   │
│                        │ localStorage    │                   │
│                        └─────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
                                  │
                                  │ HTTPS API calls
                                  │ (Authorization: Bearer <token>)
                                  ▼
                    ┌─────────────────────────┐
                    │   OverSkill Platform    │
                    │ (*.overskill.COM - API) │
                    │                         │
                    │ - Validates JWT token   │
                    │ - Returns user data     │
                    │ - Provides entity CRUD  │
                    │ - OAuth: overskill.COM  │
                    │ - NOT overskill.app!    │
                    └─────────────────────────┘
```

## Profile Settings Page

The template includes a comprehensive, customizable settings page at `/settings` (also accessible at `/profile`).

### Pre-Built Features

- **Profile Card**: User avatar, name, email, account status
- **Personal Information**: Display name editing (email is read-only for OAuth)
- **App Preferences**: Dark mode toggle, email notifications
- **Account Security**: OAuth authentication info, login activity links
- **OverSkill Integration**: Links to OverSkill dashboard, activity log
- **Danger Zone**: Data export, account deletion

### Customization Points for AI

The settings page has clearly marked sections for AI customization:

1. **App-Specific Preferences** (~Line 180)
   - Add custom toggles like "Low Stock Alerts", "Due Date Reminders"
   - Follow the existing Switch pattern

2. **Custom Profile Fields** (~Line 240)
   - Add fields like "Company Name", "Phone", "Bio"
   - Use Input/Textarea components

3. **Subscription Section** (~Line 280)
   - Uncomment for apps with paid features
   - Integrate with Stripe

4. **Data Export** (~Line 320)
   - Customize exported data format
   - Include app-specific entities

### Example: Adding a Custom Preference

```tsx
// In the App Preferences section
<Separator />

<div className="flex items-center justify-between">
  <div className="flex items-center gap-3">
    <Package className="h-5 w-5 text-muted-foreground" />
    <div>
      <p className="font-medium">Low Stock Alerts</p>
      <p className="text-sm text-muted-foreground">
        Get notified when items are running low
      </p>
    </div>
  </div>
  <Switch
    checked={preferences.lowStockAlerts}
    onCheckedChange={(checked) =>
      setPreferences(p => ({ ...p, lowStockAlerts: checked }))
    }
  />
</div>
```

### Routes

- `/settings` - Main settings page
- `/profile` - Alias for settings page

Both routes are always protected (require authentication).

## Further Reading

- [overskill-sdk Documentation](https://github.com/overskill/overskill-sdk)
- [OverSkill OAuth Flow](https://docs.overskill.app/oauth)
- [Entity System Guide](https://docs.overskill.app/entities)

