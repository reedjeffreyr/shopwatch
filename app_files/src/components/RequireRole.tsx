// RequireRole Component - Role-based access control for UI components
// Only renders children if user has the required role(s)

import React from 'react';
import { useEffect } from 'react'
import { useRoles } from '@/hooks/use-roles'

interface RequireRoleProps {
  children: React.ReactNode

  // Single role requirement
  role?: string

  // Multiple roles - user must have at least one (OR logic)
  anyOf?: string[]

  // Multiple roles - user must have all (AND logic)
  allOf?: string[]

  // Single permission requirement
  permission?: string

  // What to show if user doesn't have access
  fallback?: React.ReactNode

  // Show loading state while checking
  showLoading?: boolean
}

/**
 * RequireRole - Conditionally render content based on user roles/permissions
 *
 * Usage:
 * ```tsx
 * // Single role
 * <RequireRole role="admin">
 *   <AdminPanel />
 * </RequireRole>
 *
 * // Any of multiple roles
 * <RequireRole anyOf={['admin', 'moderator']}>
 *   <ModeratorTools />
 * </RequireRole>
 *
 * // All roles required
 * <RequireRole allOf={['premium', 'verified']}>
 *   <ExclusiveFeature />
 * </RequireRole>
 *
 * // Permission-based
 * <RequireRole permission="can_export">
 *   <ExportButton />
 * </RequireRole>
 *
 * // With fallback content
 * <RequireRole role="premium" fallback={<UpgradePrompt />}>
 *   <PremiumFeature />
 * </RequireRole>
 * ```
 */
export function RequireRole({
  children,
  role,
  anyOf,
  allOf,
  permission,
  fallback = null,
  showLoading = false
}: RequireRoleProps) {
  const { hasRole, hasAnyRole, hasAllRoles, hasPermission, isLoading, attemptRoleRefresh } = useRoles()

  // Whether the currently-loaded role/permission set fails this gate.
  let denied = false
  if (role && !hasRole(role)) denied = true
  if (anyOf && anyOf.length > 0 && !hasAnyRole(anyOf)) denied = true
  if (allOf && allOf.length > 0 && !hasAllRoles(allOf)) denied = true
  if (permission && !hasPermission(permission)) denied = true

  // #2374: when the check fails on first load, silently re-mint the JWT once.
  // A role granted server-side after the 24h token was issued is otherwise
  // invisible until logout->login. attemptRoleRefresh() no-ops after the first
  // call and flips isLoading while in flight, so we keep rendering the loading
  // state below (not the fallback) until the refreshed roles are known. If the
  // user still lacks the role after the refresh, the fallback shows as before.
  useEffect(() => {
    if (!isLoading && denied) {
      void attemptRoleRefresh()
    }
  }, [isLoading, denied, attemptRoleRefresh])

  // Show loading state if requested (also covers the in-flight silent refresh)
  if (isLoading && showLoading) {
    return (
      <div className="animate-pulse bg-muted rounded h-8 w-full" />
    )
  }

  // Skip rendering while loading (to prevent flash of fallback content)
  if (isLoading) {
    return null
  }

  // Check failed even after the one-shot silent refresh — show the fallback.
  if (denied) {
    return <>{fallback}</>
  }

  // All checks passed, render children
  return <>{children}</>
}

/**
 * RequirePermission - Alias for permission-based access control
 *
 * Usage:
 * ```tsx
 * <RequirePermission permission="can_export">
 *   <ExportButton />
 * </RequirePermission>
 * ```
 */
export function RequirePermission({
  permission,
  children,
  fallback = null
}: {
  permission: string
  children: React.ReactNode
  fallback?: React.ReactNode
}) {
  return (
    <RequireRole permission={permission} fallback={fallback}>
      {children}
    </RequireRole>
  )
}

export default RequireRole
