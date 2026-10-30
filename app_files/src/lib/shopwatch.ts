import { getAuthToken } from '@/lib/auth'

export interface ShopStore {
  id: string
  owner_email: string
  owner_user_id?: string
  store_url: string
  store_name?: string
  status: string
  last_check_status?: string
  last_checked_at?: string
  baseline_title?: string
  baseline_signature?: string
  baseline_screenshot_url?: string
  baseline_load_ms?: number
  baseline_scripts_json?: string
  ignored_terms?: string
  alert_email?: string
  weekly_summary?: boolean
  is_client_managed?: boolean
}

export interface StoreCheck {
  id: string
  store_id: string
  checked_at: string
  status: string
  summary: string
  issues_json?: string
  homepage_status?: number
  collection_status?: number
  product_status?: number
  cart_status?: number
  checkout_status?: number
  add_to_cart_status?: string
  load_ms?: number
  screenshot_url?: string
}

export interface StoreAlert {
  id: string
  store_id: string
  severity: string
  title: string
  message: string
  status: string
  screenshot_url?: string
  created_at: string
}

export interface FixRequest {
  id: string
  store_id: string
  owner_email: string
  store_url: string
  issue_summary: string
  status: string
  created_at: string
}

export interface ShopwatchData {
  stores: ShopStore[]
  checks: StoreCheck[]
  alerts: StoreAlert[]
  fix_requests: FixRequest[]
}

export function statusLabel(status?: string): string {
  if (status === 'broken') return 'Broken'
  if (status === 'needs_attention') return 'Needs attention'
  if (status === 'checking') return 'Checking'
  return 'All good'
}

export function statusClass(status?: string): string {
  if (status === 'broken') return 'border-destructive/40 bg-destructive/10 text-destructive'
  if (status === 'needs_attention') return 'border-primary/30 bg-primary/10 text-primary'
  if (status === 'checking') return 'border-border bg-muted text-muted-foreground'
  return 'border-accent/30 bg-accent/10 text-accent'
}

export function formatMoment(value?: string): string {
  if (!value) return 'Not checked yet'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not checked yet' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export async function shopwatchRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAuthToken()
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const ref = typeof data.ref === 'string' ? ` (ref: ${data.ref})` : ''
    throw new Error(`${typeof data.error === 'string' ? data.error : 'Request failed'}${ref}`)
  }
  return data as T
}

export function parseIssues(check: StoreCheck): string[] {
  try {
    const values = JSON.parse(check.issues_json || '[]')
    return Array.isArray(values) ? values.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}