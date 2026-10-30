/**
 * Profile Settings Page
 *
 * A comprehensive, customizable settings page for OverSkill apps.
 *
 * ============================================================================
 * LLM CUSTOMIZATION GUIDE
 * ============================================================================
 *
 * This page is designed to be easily customized by AI. Key customization points:
 *
 * 1. APP-SPECIFIC PREFERENCES (Line ~180)
 *    - Add app-specific toggles like "Enable feature X", "Show advanced options"
 *    - Follow the existing Switch pattern for consistency
 *
 * 2. CUSTOM PROFILE FIELDS (Line ~240)
 *    - Add app-specific profile fields like "Company name", "Phone", "Bio"
 *    - Use the Input/Textarea components from @/components/ui
 *
 * 3. SUBSCRIPTION/BILLING SECTION (Line ~280)
 *    - Uncomment and customize for apps with paid features
 *    - Integrate with Stripe or other payment providers
 *
 * 4. DATA EXPORT FORMAT (Line ~320)
 *    - Customize what data is included in exports
 *    - Add app-specific entity exports
 *
 * 5. THE HONESTY RULE (handleSave, Line ~160) — READ BEFORE ADDING A FIELD
 *    - Every editable input MUST be persisted by handleSave, or be read-only.
 *    - Never report success for a field you did not actually write.
 *    - Ticket OS-SNK9B2: this page shipped an editable "Display Name" input
 *      bound to state that handleSave never saved anywhere, and toasted
 *      "Settings saved successfully" anyway. Customers typed a name, were
 *      told it saved, refreshed, and got the old one back. A false success is
 *      worse than a missing feature — it costs the customer their trust in
 *      everything else the app claims to have saved.
 *
 * IMPORTANT: Do NOT modify:
 * - OAuth authentication display (users can't change OAuth-linked email)
 * - The read-only Display Name field. The signed-in user's name is issued by
 *   the OverSkill platform in their session; there is NO app-level API that
 *   can change it (no worker route, no SDK method, and app_users has no name
 *   column). Making the input editable again re-creates OS-SNK9B2.
 * - OverSkill branding section (required for free tier)
 * - Core security information display
 * ============================================================================
 */

import React from 'react';
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { overskill } from '@/lib/auth'
import { useEntitlement } from 'overskill-sdk'
import { useWalletBalance } from '@/hooks/useWalletBalance'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'

// UI Components
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Progress } from '@/components/ui/progress'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

// Icons
import {
  ArrowLeft,
  User,
  Settings,
  Bell,
  Moon,
  Shield,
  ExternalLink,
  Download,
  Trash2,
  CheckCircle2,
  Mail,
  Calendar,
  Activity,
  CreditCard,
  Coins,
  Link2,
} from 'lucide-react'

// Types
interface UserData {
  id?: string
  email: string
  name?: string
  image?: string | null
  created_at?: string
}

interface UserPreferences {
  emailNotifications: boolean
  // ========================================
  // LLM: Add app-specific preference fields here
  // Example: lowStockAlerts: boolean
  // Example: weeklyDigest: boolean
  // ========================================
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()

  // User state
  const [user, setUser] = useState<UserData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Form state
  const [preferences, setPreferences] = useState<UserPreferences>({
    emailNotifications: true,
    // LLM: Initialize app-specific preferences here
  })

  // DERIVED, NOT FORM STATE (OS-SNK9B2). The user's name rides in their
  // OverSkill session and nothing in a generated app can write it back, so it
  // is read straight off the session instead of being held in editable state
  // that would silently discard whatever the user typed.
  const displayName = user?.name || ''

  // ========================================
  // LLM: Add app-specific form state here
  // Example: const [companyName, setCompanyName] = useState('')
  // Example: const [phoneNumber, setPhoneNumber] = useState('')
  // ========================================

  // Load user data on mount
  useEffect(() => {
    loadUserData()
  }, [])

  const loadUserData = async () => {
    try {
      const userData = await overskill.auth.checkSession()
      if (!userData) {
        navigate('/login')
        return
      }
      setUser(userData)

      // Load saved preferences from localStorage or API
      const savedPrefs = localStorage.getItem('app_preferences')
      if (savedPrefs) {
        setPreferences(JSON.parse(savedPrefs))
      }

      // ========================================
      // LLM: Load app-specific profile data here
      // Example: Load from overskill.entities.user_profile.list()
      // ========================================

    } catch (error) {
      console.error('Failed to load user data:', error)
      toast.error('Failed to load profile')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Save preferences to localStorage
      localStorage.setItem('app_preferences', JSON.stringify(preferences))

      // ========================================
      // LLM: Save app-specific profile data here
      //
      // ⚠️ ONLY CLAIM WHAT YOU ACTUALLY SAVED (ticket OS-SNK9B2). The success
      // message below is deliberately scoped to preferences, because
      // preferences are the only thing this function writes. Widen the message
      // when — and only when — you have widened the write.
      //
      // To add a persisted profile field:
      //   1. AWAIT the write here so a failure lands in the catch below:
      //        await overskill.entities.user_profile.upsert({
      //          user_id: user?.id,
      //          company_name: companyName,
      //        })
      //   2. Read it back in loadUserData(), or a refresh shows the old value.
      //   3. Never swallow the error — a user who sees "saved" must have saved.
      // ========================================

      toast.success('Preferences saved')
    } catch (error) {
      console.error('Failed to save settings:', error)
      toast.error("Couldn't save your preferences. Please try again.")
    } finally {
      setSaving(false)
    }
  }

  const handleExportData = async () => {
    try {
      toast.info('Preparing data export...')

      // Collect user data for export
      const exportData = {
        profile: {
          email: user?.email,
          name: displayName,
          created_at: user?.created_at,
        },
        preferences,
        // ========================================
        // LLM: Add app-specific data to export
        // Example:
        // tasks: await overskill.entities.task.list(),
        // categories: await overskill.entities.category.list(),
        // ========================================
        exported_at: new Date().toISOString(),
      }

      // Download as JSON
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `my-data-${new Date().toISOString().split('T')[0]}.json`
      a.click()
      URL.revokeObjectURL(url)

      toast.success('Data exported successfully')
    } catch (error) {
      console.error('Export failed:', error)
      toast.error('Failed to export data')
    }
  }

  const handleDeleteAccount = async () => {
    try {
      // ========================================
      // LLM: Implement account deletion logic
      // This should delete all user data from entities
      // Example:
      // await overskill.entities.task.deleteAll()
      // await overskill.entities.user_profile.delete(user?.id)
      // ========================================

      await overskill.auth.logout()
      toast.success('Account deleted')
      navigate('/logged-out')
    } catch (error) {
      console.error('Delete failed:', error)
      toast.error('Failed to delete account')
    }
  }

  // Generate user initials
  const initials = user?.name
    ?.split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || user?.email?.[0]?.toUpperCase() || '?'

  // Format member since date
  const memberSince = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : 'Recently'

  // OverSkill platform URL
  const platformUrl = import.meta.env.VITE_PLATFORM_URL || 'https://www.overskill.com'

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-xl font-semibold">Profile Settings</h1>
              <p className="text-sm text-muted-foreground">Manage your account and preferences</p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Left Column - Profile Card & Links */}
          <div className="space-y-6">

            {/* Profile Card */}
            <Card>
              <CardContent className="pt-6">
                <div className="text-center">
                  <Avatar className="h-20 w-20 mx-auto ring-4 ring-background shadow-lg">
                    <AvatarImage src={user?.image ?? undefined} />
                    <AvatarFallback className="bg-gradient-to-br from-blue-500 to-purple-600 text-white text-xl font-semibold">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <h2 className="mt-4 font-semibold text-lg">{displayName || 'User'}</h2>
                  <p className="text-sm text-muted-foreground">{user?.email}</p>

                  <Separator className="my-4" />

                  <div className="text-left space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Account Type</span>
                      <span className="font-medium">Personal</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Member Since</span>
                      <span className="font-medium">{memberSince}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Status</span>
                      <Badge variant="outline" className="text-green-600 border-green-600">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Active
                      </Badge>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* OverSkill Links */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Link2 className="h-4 w-4" />
                  OverSkill Account
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <a
                  href={`${platformUrl}/account`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between p-2 rounded-md hover:bg-muted transition-colors text-sm"
                >
                  <span>My OverSkill Dashboard</span>
                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                </a>
                <a
                  href={`${platformUrl}/account/activity`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between p-2 rounded-md hover:bg-muted transition-colors text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Activity className="h-4 w-4" />
                    Activity Log
                  </span>
                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                </a>

                {/* PLATFORM-MANAGED: Billing & Subscription link.
                    Auto-renders only when the app is on a managed payment
                    backend (whop / stripe_connect). On free / external /
                    shopify apps the link is hidden so creators don't see
                    a dead link to a buyer portal that doesn't apply. */}
                {isManagedBackend() && (
                  <a
                    href={`${platformUrl}/account/app_subscriptions`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-2 rounded-md hover:bg-muted transition-colors text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <CreditCard className="h-4 w-4" />
                      Billing & Subscription
                    </span>
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  </a>
                )}

                <Separator className="my-2" />

                <div className="text-center py-2">
                  <a
                    href={platformUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Powered by <span className="font-semibold">OverSkill</span>
                  </a>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Right Column - Settings Forms */}
          <div className="lg:col-span-2 space-y-6">

            {/* Personal Information */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  Personal Information
                </CardTitle>
                <CardDescription>
                  Your account details
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* READ-ONLY BY DESIGN (OS-SNK9B2) — see the header note.
                      The name comes from the signed-in user's OverSkill
                      session and no app-level API can change it, so the field
                      must not accept typing it can't keep. */}
                  <div className="space-y-2">
                    <Label htmlFor="displayName">Display Name</Label>
                    <Input
                      id="displayName"
                      value={displayName}
                      disabled
                      placeholder="Your name"
                      className="bg-muted"
                    />
                    <p className="text-xs text-muted-foreground">
                      Your name comes from your{' '}
                      <a
                        href={`${platformUrl}/account`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-foreground"
                      >
                        Overskill account
                      </a>
                      . Change it there and it updates here next time you sign in.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email Address</Label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          id="email"
                          value={user?.email || ''}
                          disabled
                          className="pl-10 bg-muted"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Email cannot be changed (OAuth account)
                    </p>
                  </div>
                </div>

                {/* ================================================
                    LLM: ADD CUSTOM PROFILE FIELDS HERE

                    ⚠️ AN EDITABLE FIELD NEEDS A PERSISTED HOME (OS-SNK9B2).
                    Before you add one of these inputs, create the entity that
                    stores it, save it in handleSave(), and load it back in
                    loadUserData(). An input whose value vanishes on refresh —
                    while the page says "saved" — is the bug this template
                    already shipped once.

                    Examples:

                    <div className="space-y-2">
                      <Label htmlFor="company">Company Name</Label>
                      <Input
                        id="company"
                        value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)}
                        placeholder="Your company"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="bio">Bio</Label>
                      <Textarea
                        id="bio"
                        value={bio}
                        onChange={(e) => setBio(e.target.value)}
                        placeholder="Tell us about yourself"
                        rows={3}
                      />
                    </div>
                    ================================================ */}
              </CardContent>
            </Card>

            {/* App Preferences */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  App Preferences
                </CardTitle>
                <CardDescription>
                  Customize your app experience
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Dark Mode */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Moon className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Dark Mode</p>
                      <p className="text-sm text-muted-foreground">
                        Toggle between light and dark themes
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={theme === 'dark'}
                    onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
                  />
                </div>

                <Separator />

                {/* Email Notifications */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Bell className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Email Notifications</p>
                      <p className="text-sm text-muted-foreground">
                        Receive updates and alerts via email
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={preferences.emailNotifications}
                    onCheckedChange={(checked) =>
                      setPreferences(p => ({ ...p, emailNotifications: checked }))
                    }
                  />
                </div>

                {/* ================================================
                    LLM: ADD APP-SPECIFIC PREFERENCES HERE

                    ⚠️ REMINDER TOGGLES REQUIRE AN ENGINE (ticket OS-V7HMWA).
                    A toggle like "Due Date Reminders" is HALF a feature. If you
                    add any reminder/notification toggle you MUST also create:
                      1. A preference ENTITY persisting the opt-in (a toggle in
                         local React state delivers nothing), wired to
                         overskill.push.subscribe() from a user gesture.
                      2. The ENGINE: an os-create-scheduled-task whose
                         handler_code reads that entity and calls
                         sendPush(env).send({ appUserId, title, body, url })
                         for each due user (+ writes the in-app notification
                         entity row when the app has an inbox).
                    Never ship the toggle alone, and never write copy promising
                    "our servers will remind you" unless the task exists.

                    If you add a "test notification" button: a local
                    reg.showNotification() only proves THIS DEVICE can render a
                    notification — label it "Test on this device (local)" and
                    ALSO wire "Send a real test through the server" to
                    POST /api/push/test (built into every deployed worker;
                    Bearer auth; sends a real relay push to the caller).

                    Examples for a task manager:

                    <Separator />

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <AlertTriangle className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <p className="font-medium">Due Date Reminders</p>
                          <p className="text-sm text-muted-foreground">
                            Get notified before tasks are due
                          </p>
                        </div>
                      </div>
                      <Switch
                        checked={preferences.dueDateReminders}
                        onCheckedChange={(checked) =>
                          setPreferences(p => ({ ...p, dueDateReminders: checked }))
                        }
                      />
                    </div>

                    Examples for an inventory app:

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
                    ================================================ */}
              </CardContent>
            </Card>

            {/* Account Security */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5" />
                  Account Security
                </CardTitle>
                <CardDescription>
                  Your account security information
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="bg-muted/50 rounded-lg p-4 border">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
                    <div>
                      <p className="font-medium">OAuth Authentication</p>
                      <p className="text-sm text-muted-foreground">
                        Your account is secured through OAuth provider authentication.
                        No password management needed.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" asChild>
                    <a
                      href={`${platformUrl}/account/activity`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Activity className="h-4 w-4 mr-2" />
                      View Login Activity
                    </a>
                  </Button>
                  <Button variant="outline" asChild>
                    <a
                      href={`${platformUrl}/account/connected_apps`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Link2 className="h-4 w-4 mr-2" />
                      Connected Apps
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* PLATFORM-MANAGED: Subscription card.
                Auto-renders only when the app is on a managed payment
                backend (whop / stripe_connect). Reads live entitlement
                state via useEntitlement() — no fetch wiring needed.

                LLM customization: you can extend the card with
                app-specific perks lists, feature gates, plan-comparison
                tables, etc. DO NOT change the `isManagedBackend()`
                guard or the entitlement-driven conditional logic —
                those are platform-managed. */}
            <SubscriptionCard />
            {/* SubscriptionCard component is defined at the bottom of
                this file for LLM customization — see comments there. */}

            {/* PLATFORM-MANAGED: AI Credits (buyer wallet) card.
                Auto-renders ONLY when this app has buyer credit wallets
                enabled AND the signed-in user has a wallet — reads live
                state via useWalletBalance() (@/hooks/useWalletBalance).
                On every other app it renders nothing: zero visual noise.
                See the component definition at the bottom of this file. */}
            <WalletCreditsCard />

            {/* Danger Zone */}
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <Trash2 className="h-5 w-5" />
                  Danger Zone
                </CardTitle>
                <CardDescription>
                  Irreversible actions for your account
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={handleExportData}>
                    <Download className="h-4 w-4 mr-2" />
                    Export My Data
                  </Button>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive">
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete Account
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This action cannot be undone. This will permanently delete your
                          account and remove all your data from our servers.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleDeleteAccount}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete Account
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Save Actions */}
        <div className="flex justify-center gap-4 mt-8 pt-6 border-t">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                Saving...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Save Changes
              </>
            )}
          </Button>
          <Button variant="outline" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </main>
    </div>
  )
}

// ============================================================================
// PLATFORM-MANAGED: SubscriptionCard
// ============================================================================
//
// Local copy of `isManagedBackend()` — not yet re-exported from
// overskill-sdk@0.5.0 (only the hook is). Replicates the predicate
// from packages/overskill-sdk/src/react.tsx:294. When the SDK bumps
// to expose this publicly we can switch to the import. Until then,
// the inline version keeps the auto-rendering logic self-contained
// in the template without an SDK dependency.
function isManagedBackend(): boolean {
  const root: any =
    typeof window !== 'undefined'
      ? window
      : typeof globalThis !== 'undefined'
      ? globalThis
      : null
  const backend = root?.OVERSKILL?.PAYMENT_BACKEND
  return backend === 'whop' || backend === 'stripe_connect'
}
//
// Does this app actually SELL subscriptions? (issue #4518)
//
// isManagedBackend() alone is NOT this question. `payment_backend` is the
// platform's default rail — "whop" on essentially every generated app,
// including apps that have never sold anything — so gating the card on it
// meant a members-area app rendered "No active subscription / Free" to every
// visitor, including customers holding an active paid plan (ticket
// OS-6CH7XR). The buyer entitlement rail this card reads is EMPTY BY
// CONSTRUCTION on an app with no plans, so the empty list was never evidence
// of anything.
//
// The worker injects this from the app's real plan state at deploy time
// (worker_api_template.rb → SUBSCRIPTION_PLANS_OFFERED). Absent on workers
// deployed before that shipped → false → the card stays silent, which is the
// correct answer when we don't know.
function offersSubscriptions(): boolean {
  const root: any =
    typeof window !== 'undefined'
      ? window
      : typeof globalThis !== 'undefined'
      ? globalThis
      : null
  const offered = root?.OVERSKILL?.SUBSCRIPTION_PLANS_OFFERED
  return offered === true || offered === 'true'
}
//
// Auto-renders the buyer's subscription state on /settings using live data
// from useEntitlement() (overskill-sdk). Hides itself on free / external /
// shopify apps so creators don't see a dead "Subscription" card on apps
// that don't take money.
//
// Render branches (issue #4518 tightened branches 1 and 2):
//   1. App is NOT on a managed payment backend → returns null
//   1b. App does not SELL subscriptions (no active plans) → returns null.
//      There is no "your subscription" on such an app, so any verdict the
//      card renders is false. This is the #4518 fix: the old code gated on
//      payment_backend alone, which is "whop" on ~every generated app.
//   1c. Buyer has no active entitlement AND the entitlement state is
//      UNRESOLVED (fetch failed / signed out / auth settling) → returns
//      null. Absence of a record is not evidence of absence of a plan.
//   2. App sells subscriptions, state resolved, buyer holds nothing →
//      "Upgrade" CTA pointing at /pricing (the marketplace listing or
//      whichever pricing route the creator wired up). This branch is now
//      the only one that may say "No active subscription", and it only
//      runs when both halves of that claim are backed by evidence.
//   3. Buyer has an active entitlement → "Active" badge + plan_id
//      (B7b shape) + "Manage subscription" button pointing at the
//      OverSkill buyer portal (PR #1046)
//
// LLM customization rules:
//   - DO extend the card body with app-specific perks lists, feature
//     gates, multi-tier comparison, badges for tier names, etc.
//   - DO change the empty-state copy ("Upgrade your account") to match
//     your app's voice.
//   - DO NOT remove the isManagedBackend() guard — that's what hides
//     the card on free apps.
//   - DO NOT remove the offersSubscriptions() guard or the
//     entitlementResolved guard, and DO NOT render subscription state
//     from `entitlement.list.length === 0` alone. Those three are one
//     rule: never assert what the buyer is subscribed to on evidence
//     that cannot support the assertion (issue #4518 / OS-6CH7XR).
//   - DO NOT remove the useEntitlement() call — that's what makes the
//     card auto-render with live data instead of stale placeholders.
//   - DO NOT hardcode a plan_id in the conditional — let entitlement
//     drive it. Hardcoding is the bug we shipped in jQmoVj's first
//     Pricing.tsx (issue from May 25 2026).
function SubscriptionCard() {
  // window.APP_CONFIG.BRIDGE_URL is the OverSkill platform URL,
  // injected at runtime by the worker (worker_api_template.rb).
  const platformUrl =
    (typeof window !== 'undefined' && (window as any).APP_CONFIG?.BRIDGE_URL) ||
    'https://www.overskill.com'

  const entitlement = useEntitlement()

  // Short-circuit on non-managed backends — same predicate the
  // useEntitlement hook uses internally to return permissive defaults.
  if (!isManagedBackend()) return null

  // Does this app sell subscriptions at all? If not, there is no such thing
  // as "your subscription" here and the card has nothing truthful to say —
  // render nothing, exactly like WalletCreditsCard auto-hides on apps
  // without buyer wallets. (issue #4518)
  const appSellsSubscriptions = offersSubscriptions()
  if (!appSellsSubscriptions) return null

  // Is the entitlement list an ANSWER, or just the absence of one?
  // overskill-sdk >= 0.5.7 reports this directly; on older SDKs fall back to
  // the best signal available (a settled fetch that did not error).
  const entitlementResolved =
    typeof (entitlement as any).resolved === 'boolean'
      ? (entitlement as any).resolved
      : !entitlement.isLoading && entitlement.error === null

  // Loading state — entitlement check is in flight.
  if (entitlement.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Subscription
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="py-6 text-center text-sm text-muted-foreground">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mx-auto mb-2" />
            Checking subscription...
          </div>
        </CardContent>
      </Card>
    )
  }

  const activePlan = entitlement.activePlan()
  const hasActive = activePlan !== null

  // No active plan AND we never got a straight answer (fetch failed, signed
  // out, auth still settling): stay silent. An empty entitlement list is not
  // proof of "Free" — rendering it as one is what told a customer with an
  // active $97/mo plan that she had no subscription (issue #4518). The card
  // reappears on the next successful poll; the SDK re-fetches every 30s.
  if (!hasActive && !entitlementResolved) return null

  return (
    <Card data-testid="subscription-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5" />
          Subscription
        </CardTitle>
        <CardDescription>
          {hasActive ? 'Manage your active subscription' : 'Upgrade to unlock all features'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasActive ? (
          <>
            <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border">
              <div>
                <p className="font-medium">
                  {activePlan!.tier_name || 'Active subscription'}
                </p>
                {/* Price line — only renders when the Phase 2 KV
                    enrichment shipped the amount + interval. Older
                    apps without enrichment fall back gracefully. */}
                {formatPlanPrice(activePlan!) && (
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {formatPlanPrice(activePlan!)}
                  </p>
                )}
                {/* Renews / cancels copy with period_end */}
                {activePlan!.period_end && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {activePlan!.cancel_at_period_end
                      ? `Cancels on ${formatDate(activePlan!.period_end)}`
                      : `Renews on ${formatDate(activePlan!.period_end)}`}
                  </p>
                )}
                {activePlan!.features.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {activePlan!.features.length}{' '}
                    {activePlan!.features.length === 1 ? 'feature' : 'features'} included
                  </p>
                )}
              </div>
              <Badge variant={activePlan!.cancel_at_period_end ? 'outline' : 'default'}>
                {activePlan!.cancel_at_period_end ? 'Cancelling' : 'Active'}
              </Badge>
            </div>

            {/* Manage subscription button — uses the per-backend
                manage_url from Phase 2 enrichment when present, falls
                back to the OverSkill buyer portal for older payloads. */}
            <Button asChild className="w-full" variant="outline">
              <a
                href={activePlan!.manage_url || `${platformUrl}/account/app_subscriptions`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Manage subscription
                <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border">
              <div>
                <p className="font-medium">No active subscription</p>
                <p className="text-sm text-muted-foreground">
                  Get access to all features
                </p>
              </div>
              <Badge variant="secondary">Free</Badge>
            </div>

            <Button asChild className="w-full">
              <a href="/pricing">View plans</a>
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ── SubscriptionCard helpers ─────────────────────────────────────────
//
// formatPlanPrice + formatDate are isolated from the component so the
// formatting is testable + replaceable. Both gracefully no-op when the
// underlying field is missing — Phase 1 KV payloads don't have
// `interval` / `currency` etc., so the card has to render without them.

function formatPlanPrice(entitlement: any): string | null {
  const cents = entitlement?.recurring_amount_cents
  const interval = entitlement?.interval
  const currency = entitlement?.currency

  if (typeof cents !== 'number' || cents <= 0) return null
  if (!interval) return null

  const amount = formatCurrency(cents, currency)
  const intervalLabel = humanizeInterval(interval)
  return `${amount}${intervalLabel}`
}

function formatCurrency(cents: number, currency?: string): string {
  const code = (currency || 'USD').toUpperCase()
  const value = cents / 100
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      // Drop trailing zeros for whole-dollar prices ($1 not $1.00). This is
      // the canonical OverSkill display style used in /pricing markup.
      minimumFractionDigits: value % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    // Unknown currency code or Intl unavailable — fall back to plain $
    return `$${value.toFixed(2)}`
  }
}

function humanizeInterval(interval: string): string {
  switch (interval) {
    case 'day':
      return '/day'
    case 'week':
      return '/week'
    case 'biweekly':
      return '/2wk'
    case 'month':
      return '/month'
    case 'bimonthly':
      return '/2mo'
    case 'quarter':
      return '/quarter'
    case 'semiannual':
      return '/6mo'
    case 'year':
      return '/year'
    default:
      if (interval.startsWith('every_') && interval.endsWith('_days')) {
        const days = interval.replace(/^every_|_days$/g, '')
        return ` / ${days}d`
      }
      return ` / ${interval}`
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return iso.slice(0, 10) // ISO date fallback
  }
}

// ============================================================================
// PLATFORM-MANAGED: WalletCreditsCard (buyer credit wallets, Jul 2026)
// ============================================================================
//
// Shows the signed-in buyer their remaining AI credit allowance on apps
// where the creator enabled buyer credit wallets (an AI allowance included
// with each paid plan, drained by the app's AI features). Data comes from
// useWalletBalance() → GET /api/wallet/balance on this app's own worker.
//
// Render contract (mirrors SubscriptionCard's auto-hide convention):
//   1. Wallets not enabled for this app, user signed out, or user has no
//      wallet → component renders NOTHING (most apps never show this card).
//   2. Wallet present → balance, included allotment + usage meter,
//      "resets on <date>", and a Top up button pointing at the SAME
//      top-up URL the API's out-of-credits (402) error returns.
//
// LLM customization rules:
//   - DO restyle the card body / copy to match your app's voice, and feel
//     free to surface the same hook elsewhere (chat composer, dashboard).
//   - DO NOT remove the `hasWallet` guard — that's what hides the card on
//     apps without buyer wallets.
//   - DO NOT hardcode credit amounts or the top-up URL — always read them
//     from the hook (`wallet.balance`, `wallet.top_up_url`).
function WalletCreditsCard() {
  const { hasWallet, wallet, isLoading } = useWalletBalance()

  // Nothing while loading and nothing when wallets don't apply — the card
  // pops in only for buyers who actually have a credit allowance.
  if (isLoading || !hasWallet || !wallet) return null

  const balance = Math.max(wallet.balance, 0)
  const included = wallet.included_credits && wallet.included_credits > 0 ? wallet.included_credits : null
  const percentLeft = included ? Math.max(0, Math.min(100, (balance / included) * 100)) : null
  const exhausted = wallet.balance <= 0
  const runningLow = !exhausted && percentLeft !== null && percentLeft <= 15

  return (
    <Card data-testid="wallet-credits-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5" />
          AI Credits
        </CardTitle>
        <CardDescription>
          Your included AI usage allowance for this app
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-4 bg-muted/50 rounded-lg border space-y-3">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-2xl font-semibold tabular-nums">
                {formatCredits(balance)}
              </p>
              <p className="text-sm text-muted-foreground">
                {included
                  ? `of ${formatCredits(included)} credits remaining`
                  : 'credits remaining'}
              </p>
            </div>
            {exhausted ? (
              <Badge variant="destructive">Out of credits</Badge>
            ) : runningLow ? (
              <Badge variant="outline">Running low</Badge>
            ) : null}
          </div>

          {percentLeft !== null && <Progress value={percentLeft} />}

          {wallet.period_resets_at && (
            <p className="text-xs text-muted-foreground">
              Allowance resets on {formatDate(wallet.period_resets_at)}
            </p>
          )}
        </div>

        {exhausted && (
          <p className="text-sm text-muted-foreground">
            You've used all of your included AI credits. Top up or upgrade
            to keep using AI features.
          </p>
        )}

        {/* Same destination the out-of-credits (402) error points at —
            the plan's configured top-up URL, '/pricing' fallback. */}
        <Button asChild className="w-full" variant={exhausted || runningLow ? 'default' : 'outline'}>
          <a href={wallet.top_up_url}>
            {exhausted ? 'Top up credits' : 'Get more credits'}
          </a>
        </Button>
      </CardContent>
    </Card>
  )
}

function formatCredits(value: number): string {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.floor(value))
  } catch {
    return String(Math.floor(value))
  }
}
