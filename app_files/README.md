# OverSkill App Template (2025 Edition)

Production-ready base template for OverSkill AI-generated applications. Built with **entity-first**, **zero-backend-code** philosophy that delivers professional apps in seconds.

## 🚀 Core Features

- **React 18+ with TypeScript** - Modern React with full type safety
- **Vite + React Router** - Lightning-fast builds and client-side routing
- **Tailwind CSS + shadcn/ui** - Beautiful, accessible UI components
- **Entity-First Database** - Built-in data storage with zero configuration
- **overskill-sdk** - Simple SDK for all data operations (no backend code!)
- **Edge Deployment** - Global CDN via Cloudflare Workers
- **Auth Pages** - Pre-built login and OAuth flows
- **Dark Mode** - System preference detection and manual toggle

## 📦 overskill-sdk - Zero Backend Code

**The magic of OverSkill apps:** No backend code needed! The `overskill-sdk` handles all data operations:

```typescript
import { overskill } from '@/lib/auth'

// List data
const todos = await overskill.entities.todo.list()

// Create data
await overskill.entities.todo.create({
  title: 'Buy groceries',
  completed: false
})

// Update data
await overskill.entities.todo.update(id, {
  completed: true
})

// Delete data
await overskill.entities.todo.delete(id)
```

**That's it!** No API routes, no database setup, no backend servers. Just React components and SDK calls.

## 📁 Project Structure

```
/
├── src/
│   ├── components/         # React components
│   │   └── ui/            # shadcn/ui component library
│   ├── lib/               # Core utilities
│   │   ├── auth.ts        # OverSkill SDK client (overskill instance)
│   │   ├── analytics.ts   # Usage tracking
│   │   └── utils.ts       # Helper functions
│   ├── routes/            # Auth pages (login, callback, etc.)
│   ├── pages/             # App pages (Index, NotFound)
│   ├── App.tsx            # Main app with routing
│   ├── main.tsx           # Application entry
│   └── index.css          # Global styles
├── public/                # Static assets
├── package.json           # Dependencies (includes overskill-sdk)
├── tsconfig.json          # TypeScript config
├── vite.config.ts         # Build configuration
└── tailwind.config.js     # Tailwind + shadcn/ui config
```

## 🗄️ Entities (Database Tables)

Entities are created automatically by the OverSkill AI. Each entity becomes a database table with:

- **Automatic Schema** - Columns defined by AI based on your app needs
- **User Isolation** - Each user sees only their own data (secure by default)
- **Zero Configuration** - No database setup, migrations, or connection strings
- **Instant API** - CRUD endpoints automatically created

**Example Entity:**
```
Entity: todo
Columns:
  - title (text, required)
  - completed (boolean, default: false)
  - priority (select: low, medium, high)
  - due_date (date)

Automatically provides:
  - overskill.entities.todo.list()
  - overskill.entities.todo.create(data)
  - overskill.entities.todo.update(id, data)
  - overskill.entities.todo.delete(id)
```

## 🔐 Authentication & Route Protection

**OverSkill includes a complete OAuth-based authentication system with automatic route protection.**

### Pre-Built Auth Pages

These pages are ready to use (no need to create):

- `/login` - OAuth login redirect (platform-owned; normally follows the app theme)
- `/callback` - OAuth callback handler
- `/access-denied` - Domain restriction page
- `/logged-out` - Logout confirmation

### Automatic Route Protection

Control who can access your app using `VITE_APP_VISIBILITY`:

```typescript
// In OverSkill Dashboard → Settings → Environment Variables

// Option 1: Public (default) - No login required
VITE_APP_VISIBILITY=public

// Option 2: Login Required - Must authenticate to access ANY route
VITE_APP_VISIBILITY=login_required
VITE_POST_LOGIN_ROUTE=/dashboard  // Where to redirect after login

// Option 3: Domain Restricted - Only specific email domains allowed
VITE_APP_VISIBILITY=domain_restricted
VITE_ALLOWED_DOMAINS=company.com,partner.com

// Option 4: Purchase Required - Must have active subscription
VITE_APP_VISIBILITY=purchase_required
```

**How it works:**
- When you set `VITE_APP_VISIBILITY=login_required`, ALL routes are automatically wrapped in `<ProtectedRoute>`
- The `ProtectedRoute` component checks authentication before rendering content
- If not logged in → redirects to `/login`
- If logged in → renders the protected content
- **Zero code changes needed** - it's automatic!

### Mixed Public/Protected Routes

For apps with some public pages and some protected pages:

```typescript
// Set visibility to public (don't use global protection)
VITE_APP_VISIBILITY=public

// Then manually wrap protected routes in App.tsx:
import { ProtectedRoute } from '@/components/ProtectedRoute'

<Routes>
  {/* Public routes */}
  <Route path="/" element={<LandingPage />} />
  
  {/* Protected routes */}
  <Route path="/dashboard" element={
    <ProtectedRoute>
      <Dashboard />
    </ProtectedRoute>
  } />
</Routes>
```

### Using Auth in Components

```typescript
import { overskill } from '@/lib/auth'

// Check if user is logged in
const user = await overskill.auth.checkSession()

if (!user) {
  // User not logged in
  window.location.href = '/login'
}

// Get current user info
const currentUser = await overskill.auth.me()
console.log(currentUser.name, currentUser.email)

// Logout
await overskill.auth.logout()
```

### Complete Documentation

See [AUTH_SYSTEM.md](./AUTH_SYSTEM.md) for complete authentication documentation including:
- How the OAuth flow works
- All visibility modes explained
- Security best practices
- Architecture diagrams
- Troubleshooting guide

## 🎨 UI Components

**shadcn/ui Component Library** - Complete accessible component system:
- Accordion, Alert, Avatar, Badge, Button, Card, Checkbox
- Dialog, Dropdown, Form, Input, Select, Tabs, Toast
- And 40+ more components, all pre-installed

```typescript
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

<Button variant="default">Click me</Button>
<Card className="p-6">Content here</Card>
```

**Icons** - Lucide React icons available:
```typescript
import { Menu, X, Check, Star, Heart } from 'lucide-react'

<Menu className="w-6 h-6" />
```

## 💻 Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Type check
npm run type-check
```

## 🌐 Deployment

Apps are automatically deployed to **Cloudflare Workers** (global edge network):

- **Edge Performance** - ~50ms response time globally
- **Auto-Scaling** - Handles any traffic volume
- **Zero DevOps** - No servers to manage
- **Cost-Effective** - Pay only for what you use

Deployment is automatic when you save changes in OverSkill.

## 📊 App Visibility Settings

Control who can access your app (configured in OverSkill dashboard):

- **Public** - Anyone can access (no login required)
- **Login Required** - Users must login with OverSkill
- **Purchase Required** - Users must have active subscription
- **Domain Restricted** - Only specific email domains allowed

## 🔧 Environment Variables

### ⚠️ IMPORTANT: Do NOT Use .env Files

**OverSkill apps do NOT use .env files.** This is intentional and superior to traditional approaches.

❌ **DO NOT CREATE:**
- `.env`
- `.env.local`
- `.env.development`
- `.env.production`

✅ **INSTEAD:** Configure ALL variables in **OverSkill Dashboard → Settings → Environment Variables**

**Why OverSkill's approach is better:**

| Feature | Traditional .env Files | OverSkill Dashboard |
|---------|----------------------|-------------------|
| **Storage** | Plain-text files | Encrypted database |
| **Security** | Secrets in files ⚠️ | Secrets encrypted ✅ |
| **Source of truth** | Multiple files (.env, .env.local, etc.) | Single database |
| **Deployment** | Manual management | Automatic |
| **Team access** | Hidden in local files | Visible in dashboard |
| **Version control** | Git (secrets risk!) | UI with audit log |
| **Conflicts** | .env vs .env.local | None (single source) |

**Note:** The `.env.example` file is for REFERENCE ONLY. It shows common variable patterns but is NOT loaded by your app.

### Automatic Variables (Provided by OverSkill)

These are automatically injected into every app:

| Variable | Type | Description | Example |
|----------|------|-------------|---------|
| `VITE_APP_ID` | Client | Your app's unique identifier | `abc123def456` |
| `VITE_APP_NAME` | Client | Your app's display name | `My Amazing App` |
| `VITE_SUPABASE_URL` | Client | Database connection URL | `https://xxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Client | Database access key (RLS-protected) | `eyJ...` |
| `VITE_OWNER_ID` | Client | App owner's identifier | `team_123...` |
| `VITE_ENVIRONMENT` | Client | Deployment environment | `development` or `production` |
| `VITE_OAUTH_CLIENT_ID` | Client | OAuth client ID (future) | `oauth_...` |
| `VITE_PLATFORM_URL` | Client | Platform base URL | `https://www.overskill.com` |

### Custom Variables

Add your own via **OverSkill Dashboard → Settings → Environment Variables**

#### Naming Rules

**Client-Side Variables (Browser-Accessible):**
- ✅ **MUST** have `VITE_` prefix
- ✅ Accessible via `import.meta.env.VITE_YOUR_KEY`
- ⚠️ **Visible to anyone** (browser DevTools)
- ✅ Use for: Public keys, feature flags, API endpoints, configuration

```typescript
// ✅ CORRECT: Client-side public values
const stripeKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY
const mapsKey = import.meta.env.VITE_GOOGLE_MAPS_KEY
const featureEnabled = import.meta.env.VITE_ENABLE_DARK_MODE === 'true'
```

**Server-Side Variables (Secure):**
- ✅ **NO** `VITE_` prefix
- ✅ Only accessible in Cloudflare Workers (future feature)
- 🔒 **Never exposed** to client
- ✅ Use for: API secrets, tokens, passwords

```typescript
// ✅ CORRECT: Server-side secrets (Workers only)
// These are configured in dashboard but NOT accessible in client code
// STRIPE_SECRET_KEY
// OPENAI_API_KEY
// DATABASE_PASSWORD
```

#### Security Rules (CRITICAL!)

| Scenario | Variable Name | Secret? | Prefix? | ✅/❌ |
|----------|--------------|---------|---------|------|
| Stripe public key | `VITE_STRIPE_PUBLISHABLE_KEY` | No | ✅ VITE_ | ✅ Correct |
| Stripe secret key | `STRIPE_SECRET_KEY` | Yes | ❌ No prefix | ✅ Correct |
| OpenAI API key | `OPENAI_API_KEY` | Yes | ❌ No prefix | ✅ Correct |
| Feature flag | `VITE_ENABLE_FEATURE_X` | No | ✅ VITE_ | ✅ Correct |
| Secret with VITE_ | `VITE_SECRET_KEY` | Yes | ✅ VITE_ | ❌ **BLOCKED** |

⚠️ **The dashboard will prevent you from creating `VITE_*` secrets** (would expose to browser!)

#### Common Use Cases

**Stripe Integration:**
```typescript
// Dashboard → Add Variables:
// 1. VITE_STRIPE_PUBLISHABLE_KEY = pk_test_... (not secret)
// 2. STRIPE_SECRET_KEY = sk_test_... (secret)

// In your React component:
const stripe = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY)
```

**OpenAI Integration:**
```typescript
// Dashboard → Add Variables:
// 1. OPENAI_API_KEY = sk-... (secret, server-side only)

// API calls happen server-side (future Workers feature)
// Client code doesn't need this variable
```

**Feature Flags:**
```typescript
// Dashboard → Add Variables:
// 1. VITE_ENABLE_DARK_MODE = true (not secret)
// 2. VITE_SHOW_BETA_FEATURES = false (not secret)

// In your React component:
const darkModeEnabled = import.meta.env.VITE_ENABLE_DARK_MODE === 'true'
if (darkModeEnabled) {
  // Show dark mode toggle
}
```

**Google Maps:**
```typescript
// Dashboard → Add Variables:
// 1. VITE_GOOGLE_MAPS_KEY = AIza... (not secret - domain restricted)

// In your React component:
<GoogleMap apiKey={import.meta.env.VITE_GOOGLE_MAPS_KEY} />
```

### How to Add Variables

1. Go to **OverSkill Dashboard**
2. Select your app
3. Navigate to **Settings → Environment Variables**
4. Click **"Add Variable"**
5. Enter:
   - **Variable Name:** `VITE_YOUR_KEY` (uppercase, underscores)
   - **Value:** The actual value
   - **Description:** What it's used for (optional but helpful)
   - **Mark as secret:** Check if it's sensitive (API keys, tokens, passwords)
6. Click **"Add Variable"**
7. **Deploy** (happens automatically on next save)

### Accessing Variables

**In React Components:**
```typescript
// Access any VITE_ variable
const value = import.meta.env.VITE_YOUR_KEY

// Check if variable exists
if (import.meta.env.VITE_FEATURE_FLAG) {
  // Variable is set
}

// Type-safe access (create vite-env.d.ts)
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_STRIPE_PUBLISHABLE_KEY: string
  readonly VITE_GOOGLE_MAPS_KEY: string
  // Add more as needed
}
```

**In Vite Config:**
```typescript
// vite.config.ts
export default {
  define: {
    // Variables available at build time
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version)
  }
}
```

### Variable Reference

See `.env.example` for a comprehensive list of common variable patterns and examples.

### Troubleshooting

**Variable is undefined:**
- ✅ Check variable name has `VITE_` prefix for client-side access
- ✅ Verify variable is added in dashboard
- ✅ Redeploy the app (changes take effect on deployment)
- ✅ Check for typos in variable name

**Secret value exposed:**
- ❌ You marked a `VITE_*` variable as secret (not allowed!)
- ✅ Remove `VITE_` prefix for secrets
- ✅ Secrets should only be server-side variables

## 🤖 AI-First Development

This template is optimized for **OverSkill AI**:

### Entity-First Workflow
```
1. You describe your app: "Create a todo list"
2. AI creates entities: todo (title, completed, priority)
3. AI generates components: Using overskill-sdk for data
4. App deploys: Works immediately!
5. Zero backend code written
```

### Built for AI Generation
- **Smart Defaults** - Sensible configurations that work out of the box
- **Clean Structure** - Easy for AI to understand and navigate
- **Type Safety** - TypeScript catches errors before deployment
- **Component Library** - shadcn/ui provides consistent UI patterns

## 🏗️ Architecture

**Entity-First, Zero Backend:**
- ✅ Define entities (AI does this automatically)
- ✅ Use overskill-sdk for all data operations
- ✅ No API routes needed (platform provides them)
- ✅ No database setup (automatic)
- ✅ No backend servers (edge-deployed)
- ✅ $1-2/month operational cost per app

**Technology Stack:**
- **Frontend:** React + TypeScript + Tailwind CSS
- **Data:** overskill-sdk (entity-first database SDK)
- **Build:** Vite (fast, modern)
- **Deploy:** Cloudflare Workers (edge performance)
- **UI:** shadcn/ui (accessible components)

## 📝 Best Practices

**Data Operations:**
```typescript
// ✅ DO: Use overskill-sdk
const items = await overskill.entities.item.list()

// ❌ DON'T: Write fetch calls
const items = await fetch('/api/items').then(r => r.json())
```

**Component Structure:**
```typescript
// ✅ DO: Small, focused components
export function TodoItem({ todo }) { ... }  // 50 lines

// ❌ DON'T: Large monolithic components
export function TodoApp() { ... }  // 500 lines
```

**Error Handling:**
```typescript
// ✅ DO: Let errors bubble (AI can see and fix them)
const todos = await overskill.entities.todo.list()

// ❌ DON'T: Hide errors with try/catch
try { ... } catch { /* silent */ }
```

## 🎯 What Makes This Special

**Compared to Traditional Templates:**
- ❌ Traditional: Setup database, create API routes, write backend code
- ✅ OverSkill: Define entities, use SDK, deploy

**Compared to Other AI Platforms:**
- ❌ Others: Generate code that breaks, unclear data model
- ✅ OverSkill: Entity-first (clear data), SDK-based (reliable)

**Result:** Professional apps in seconds, not hours or days.

---

## 📚 Documentation

**overskill-sdk:**
- npm: https://www.npmjs.com/package/overskill-sdk
- Docs: Complete API reference in package README

**OverSkill Platform:**
- Dashboard: https://overskill.app/dashboard
- Docs: https://docs.overskill.app

**Support:**
- Email: support@overskill.app
- Issues: Report in OverSkill dashboard

---

*Generated by OverSkill AI • Template Version: overskill_v2_20260814*
*Powered by React, TypeScript, Vite, Tailwind CSS, and overskill-sdk*
