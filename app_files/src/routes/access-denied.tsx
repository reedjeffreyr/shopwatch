// Access Denied Page - Pre-generated in template
// Shown when domain_restricted apps receive login from unauthorized domain

import React from 'react';
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { overskill } from '@/lib/auth'

export default function AccessDeniedPage() {
  const appName = import.meta.env.VITE_APP_NAME || 'OverSkill App'
  // Prefer the RUNTIME email allow-list injected by the Worker
  // (APP_CONFIG.allowedEmailDomains, present when :runtime_app_visibility is
  // ON) over the stale build-time bake (VITE_ALLOWED_DOMAINS) — same SoT logic
  // as checkAppAccess() in lib/auth.ts. After the BUG 1 fix, a domain_restricted
  // app with ZERO allowed domains ALLOWS all authenticated users, so this page
  // should never be reached with an empty list — but it still renders sanely if
  // it somehow is (empty list => no bullet items, generic copy).
  const runtimeAllowed =
    typeof window !== 'undefined' ? (window as any).APP_CONFIG?.allowedEmailDomains : undefined
  const allowedDomainsRaw =
    runtimeAllowed !== undefined && runtimeAllowed !== null
      ? runtimeAllowed
      : (import.meta.env.VITE_ALLOWED_DOMAINS || '')
  const allowedDomains: string[] = allowedDomainsRaw.split(',').filter((d: string) => d)
  const platformUrl = import.meta.env.VITE_PLATFORM_URL || 'https://www.overskill.com'

  return (
    <div className="min-h-screen flex items-center justify-center bg-destructive p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="text-6xl mb-4">🚫</div>
          <CardTitle className="text-2xl font-bold">Access Restricted</CardTitle>
          <CardDescription>
            This app is only available to specific domains
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="bg-muted border border-border rounded-lg p-4">
            <p className="text-sm text-muted-foreground mb-2">Allowed domains:</p>
            <ul className="list-disc list-inside text-sm text-foreground">
              {allowedDomains.map(domain => (
                <li key={domain}>{domain}</li>
              ))}
            </ul>
          </div>

          <p className="text-sm text-muted-foreground">
            Please login with an email address from one of the allowed domains.
          </p>

          <div className="flex gap-2">
            <Button
              onClick={() => overskill.auth.logout().then(() => overskill.auth.login())}
              variant="default"
              className="flex-1"
            >
              Try Different Account
            </Button>

            <Button
              onClick={() => window.location.href = platformUrl}
              variant="outline"
              className="flex-1"
            >
              Back to OverSkill
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
