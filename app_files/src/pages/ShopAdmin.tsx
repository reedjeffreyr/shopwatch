import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, Store as StoreIcon } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ShopHeader } from '@/components/shopwatch/ShopHeader'
import { StatusPill } from '@/components/shopwatch/StatusPill'
import { AdminAlertList } from '@/components/shopwatch/AdminAlertList'
import type { FixRequest, ShopStore, ShopwatchData } from '@/lib/shopwatch'
import { formatMoment, shopwatchRequest } from '@/lib/shopwatch'
import { toast } from 'sonner'
import type React from 'react'

type AdminData = ShopwatchData
const EMPTY: AdminData = { stores: [], checks: [], alerts: [], fix_requests: [] }
type LoadState = 'loading' | 'success' | 'error'

export default function ShopAdmin() {
  const { user, loading: authLoading } = useAuth()
  const [data, setData] = useState<AdminData>(EMPTY)
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [storeUrl, setStoreUrl] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (authLoading || !user) { setState('error'); setError('Sign in to open the admin dashboard.'); return }
    setState('loading'); setError('')
    try { setData(await shopwatchRequest<AdminData>('/api/shopwatch/admin-overview')); setState('success') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'We could not load the admin dashboard.'); setState('error') }
  }, [authLoading, user])

  useEffect(() => { if (authLoading) return; if (!user) { setState('error'); setError('Sign in to open the admin dashboard.'); return }; void load() }, [authLoading, user, load])

  async function addForClient(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    try {
      const added = await shopwatchRequest<{ store: ShopStore }>('/api/shopwatch/admin-add-store', { method: 'POST', body: JSON.stringify({ store_url: storeUrl, owner_email: ownerEmail }) })
      setStoreUrl(''); setOwnerEmail('')
      try {
        const firstCheck = await shopwatchRequest<{ baseline_saved?: boolean; summary: string }>('/api/shopwatch/run-check', { method: 'POST', body: JSON.stringify({ store_id: added.store.id, refresh_baseline: true }) })
        toast.success(firstCheck.baseline_saved ? 'Client store added and its starting point was saved.' : `Client store added. First check: ${firstCheck.summary}`)
      } catch (reason) {
        toast.error(`Store added, but its first check failed: ${reason instanceof Error ? reason.message : 'Please retry from the store list.'}`)
      }
      await load()
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : 'We could not add this client store.') }
    finally { setSaving(false) }
  }

  async function checkStore(store: ShopStore) {
    setCheckingId(store.id)
    try { await shopwatchRequest('/api/shopwatch/run-check', { method: 'POST', body: JSON.stringify({ store_id: store.id }) }); await load() }
    catch (reason) { toast.error(reason instanceof Error ? reason.message : 'The store check failed.') }
    finally { setCheckingId(null) }
  }

  async function setRequestStatus(request: FixRequest, status: string) {
    try { await shopwatchRequest('/api/shopwatch/admin-fix-status', { method: 'PATCH', body: JSON.stringify({ request_id: request.id, status }) }); await load() }
    catch (reason) { toast.error(reason instanceof Error ? reason.message : 'We could not update this request.') }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ShopHeader admin />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8 sm:py-12">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold uppercase tracking-[0.12em] text-muted-foreground">Operations</p><h1 className="mt-2 font-display text-4xl font-extrabold tracking-tight sm:text-5xl">Storewatch admin</h1><p className="mt-3 max-w-2xl text-lg text-muted-foreground">Every monitored storefront and every request for help, with the most urgent stores first.</p></div><p className="text-sm text-muted-foreground">Signed in as <span className="font-semibold text-foreground">{user?.email || 'your account'}</span></p></div>

        {state === 'error' && <div role="alert" className="mt-6 flex items-center justify-between gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4"><p className="text-sm text-destructive">{error}</p>{user && <Button type="button" variant="outline" onClick={() => void load()}>Try again</Button>}</div>}
        {state === 'loading' && <p role="status" className="mt-8 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Loading cross-store monitoring data…</p>}

        {state === 'success' && <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-12">
          <div className="min-w-0 space-y-7 lg:col-span-7">
            <section aria-labelledby="client-add-heading" className="rounded-2xl border border-border bg-card p-5 sm:p-6"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><StoreIcon aria-hidden="true" className="h-5 w-5" /></span><div><h2 id="client-add-heading" className="font-display text-xl font-bold">Add a store for a client</h2><p className="text-sm text-muted-foreground">This adds the store to your admin-managed monitoring list without charging the client.</p></div></div><form onSubmit={addForClient} className="mt-5 grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="client-store-url">Public HTTPS store URL</Label><Input id="client-store-url" type="url" required value={storeUrl} onChange={(event) => setStoreUrl(event.target.value)} placeholder="https://client-store.com" className="min-h-11 text-base md:text-sm" /></div><div className="space-y-2"><Label htmlFor="client-owner-email">Store owner email</Label><Input id="client-owner-email" type="email" required value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="owner@example.com" className="min-h-11 text-base md:text-sm" /></div><Button type="submit" disabled={saving} className="min-h-11 sm:col-span-2">{saving ? 'Adding…' : 'Add client store'}</Button></form></section>

            <section aria-labelledby="admin-stores-heading" className="space-y-4"><div className="flex items-center justify-between gap-4"><div><h2 id="admin-stores-heading" className="font-display text-2xl font-bold">All monitored stores</h2><p className="mt-1 text-sm text-muted-foreground">Broken and attention-needed stores appear first.</p></div><Button type="button" variant="ghost" size="sm" onClick={() => void load()}>Refresh</Button></div>{data.stores.length === 0 ? <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center"><p className="font-semibold">No stores are being monitored yet.</p><p className="mt-1 text-sm text-muted-foreground">Add your first client store above.</p></div> : <ul className="space-y-3">{data.stores.map((store) => <li key={store.id} className="min-w-0 rounded-2xl border border-border bg-card p-4"><div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h3 className="truncate font-display text-lg font-bold">{store.store_name || store.store_url}</h3><p className="truncate text-sm text-muted-foreground">{store.store_url}</p><p className="mt-1 truncate text-xs text-muted-foreground">Owner: {store.owner_email} · Checked {formatMoment(store.last_checked_at)}</p><div className="mt-2"><StatusPill status={store.status} /></div></div><Button type="button" size="sm" variant="outline" disabled={checkingId === store.id} onClick={() => void checkStore(store)} className="min-h-10 gap-2"><RefreshCw aria-hidden="true" className={`h-4 w-4 ${checkingId === store.id ? 'animate-spin' : ''}`} />{checkingId === store.id ? 'Checking…' : 'Check now'}</Button></div></li>)}</ul>}</section>
          </div>

          <aside className="min-w-0 space-y-6 lg:col-span-5"><section aria-labelledby="admin-alerts-heading" className="rounded-2xl border border-border bg-card p-5 sm:p-6"><h2 id="admin-alerts-heading" className="font-display text-xl font-bold">Recent alerts</h2><p className="mt-1 text-sm text-muted-foreground">Plain-language problems and storefront changes across every monitored store.</p><AdminAlertList alerts={data.alerts} stores={data.stores} /></section><section aria-labelledby="fix-requests-heading" className="rounded-2xl border border-border bg-card p-5 sm:p-6"><div className="flex items-start justify-between gap-3"><div><h2 id="fix-requests-heading" className="font-display text-xl font-bold">Fix requests</h2><p className="mt-1 text-sm text-muted-foreground">Requests from verified store owners.</p></div><AlertTriangle aria-hidden="true" className="h-5 w-5 text-primary" /></div>{data.fix_requests.length === 0 ? <div className="mt-5 rounded-xl bg-background p-4"><p className="text-sm font-semibold">No requests yet</p><p className="mt-1 text-sm text-muted-foreground">Requests from a store detail page will appear here.</p></div> : <ol className="mt-5 space-y-3">{data.fix_requests.map((request) => <li key={request.id} className="min-w-0 rounded-xl border border-border bg-background p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{request.store_url}</p><span className="rounded-full border border-border px-2.5 py-1 text-xs font-semibold">{request.status.replace('_', ' ')}</span></div><p className="mt-2 text-sm text-muted-foreground">{request.issue_summary}</p><p className="mt-2 truncate text-xs text-muted-foreground">{request.owner_email} · {formatMoment(request.created_at)}</p><label className="mt-3 block text-xs font-semibold" htmlFor={`request-status-${request.id}`}>Request status</label><select id={`request-status-${request.id}`} value={request.status} onChange={(event) => void setRequestStatus(request, event.target.value)} className="mt-1 min-h-10 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"><option value="new">New</option><option value="in_progress">In progress</option><option value="done">Done</option></select></li>)}</ol>}</section></aside>
        </div>}
      </main>
    </div>
  )
}