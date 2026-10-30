// Role management hook for OverSkill generated apps
// Provides easy access to user roles and permissions from JWT app_context

import React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react'
import { overskill } from '@/lib/auth'
import type { AppPermissions } from '@/lib/auth'

export type { AppContext } from '@/lib/auth'

export interface UseRolesReturn {
  // Current state
  roles: string[]
  permissions: AppPermissions
  isLoading: boolean

  // Role checks
  hasRole: (roleKey: string) => boolean
  hasAnyRole: (roleKeys: string[]) => boolean
  hasAllRoles: (roleKeys: string[]) => boolean

  // Permission checks
  hasPermission: (permissionKey: string) => boolean
  getPermission: <T = boolean | number | string>(key: string, defaultValue?: T) => T

  // Refresh function (for when roles change externally)
  refreshRoles: () => Promise<void>

  // #2374: silently re-mint the JWT once per mount when a role check fails, so
  // a role granted server-side after the 24h token was issued applies without a
  // logout->login. No-op after the first call (and on SDKs predating refresh()).
  // While a refresh is in flight, isLoading stays true so role-gated UI shows
  // the loading state instead of flashing the denial fallback.
  attemptRoleRefresh: () => Promise<void>
}

/**
 * useRoles - Access user roles and permissions from the JWT app_context
 *
 * Usage:
 * ```tsx
 * function PremiumFeature() {
 *   const { hasRole, hasPermission, getPermission } = useRoles()
 *
 *   if (!hasRole('premium')) {
 *     return <UpgradePrompt />
 *   }
 *
 *   const maxProjects = getPermission<number>('max_projects', 5)
 *   const canExport = hasPermission('can_export')
 *
 *   return <FeatureContent />
 * }
 * ```
 */
export function useRoles(): UseRolesReturn {
  const [roles, setRoles] = useState<string[]>([])
  const [permissions, setPermissions] = useState<AppPermissions>({})
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  // #2374: ensure the silent JWT refresh happens at most once per mount.
  const hasAttemptedSilentRefresh = useRef(false)

  const loadRolesFromToken = useCallback(async () => {
    try {
      const user = await overskill.auth.checkSession()

      if (user?.app_context) {
        setRoles(user.app_context.roles || [])
        setPermissions(user.app_context.permissions || {})
      } else {
        // No app_context means user might be on platform token, not app-specific
        setRoles([])
        setPermissions({})
      }
    } catch (error) {
      console.warn('[useRoles] Failed to load roles:', error)
      setRoles([])
      setPermissions({})
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRolesFromToken()
  }, [loadRolesFromToken])

  // #2374: re-mint the JWT once from current server-side roles, then reload.
  // Called by role-gated UI (RequireRole) when its check fails on first load —
  // most legitimate role-holders pass on the silent retry, so a just-granted
  // admin no longer has to logout->login. Idempotent (ref guard) and a no-op on
  // older bundled SDKs that predate overskill.auth.refresh().
  const attemptRoleRefresh = useCallback(async () => {
    if (hasAttemptedSilentRefresh.current) return
    hasAttemptedSilentRefresh.current = true

    const refreshFn = (overskill.auth as any)?.refresh
    if (typeof refreshFn !== 'function') return

    try {
      setIsRefreshing(true)
      const refreshedUser = await refreshFn.call(overskill.auth)
      if (refreshedUser !== null) {
        await loadRolesFromToken()
      }
    } catch (error) {
      console.warn('[useRoles] Silent role refresh failed:', error)
    } finally {
      setIsRefreshing(false)
    }
  }, [loadRolesFromToken])

  // Role check functions
  const hasRole = useCallback((roleKey: string): boolean => {
    return roles.includes(roleKey)
  }, [roles])

  const hasAnyRole = useCallback((roleKeys: string[]): boolean => {
    return roleKeys.some(key => roles.includes(key))
  }, [roles])

  const hasAllRoles = useCallback((roleKeys: string[]): boolean => {
    return roleKeys.every(key => roles.includes(key))
  }, [roles])

  // Permission check functions
  const hasPermission = useCallback((permissionKey: string): boolean => {
    const value = permissions[permissionKey]
    // Treat truthy values as having permission
    return Boolean(value)
  }, [permissions])

  const getPermission = useCallback(<T = boolean | number | string>(
    key: string,
    defaultValue?: T
  ): T => {
    const value = permissions[key]
    if (value === undefined) {
      return defaultValue as T
    }
    return value as T
  }, [permissions])

  const refreshRoles = useCallback(async () => {
    setIsLoading(true)
    await loadRolesFromToken()
  }, [loadRolesFromToken])

  return {
    roles,
    permissions,
    // #2374: stay "loading" while a silent refresh is in flight so role-gated
    // UI renders the loading state, not the denial fallback, until the
    // refreshed roles are known.
    isLoading: isLoading || isRefreshing,
    hasRole,
    hasAnyRole,
    hasAllRoles,
    hasPermission,
    getPermission,
    refreshRoles,
    attemptRoleRefresh
  }
}

export default useRoles
