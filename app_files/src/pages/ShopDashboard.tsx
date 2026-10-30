import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, ArrowRight, Clock3, ShieldCheck } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { StoreForm } from '@/components/shopwatch/StoreForm'
import { StoreList } from '@/components/shopwatch/StoreList'
import { StatusPill } from '@/components/shopwatch/StatusPill'
import type { ShopStore, ShopwatchData } from '@/lib/shopwatch'
import { formatMoment, shopwatchRequest } from '@/lib/shopwatch'

const EMPTY: ShopwatchData = { stores: [], checks: [], alerts: [], fix_requests: [] }
type LoadState = 'loading' | 'success' | 'error'

export default function ShopDashboard() {
  const { user, loading: authLoading } = useAuth()
  const [data, setData] = useState<ShopwatchData>(EMPTY)
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [checkingId, setCheckingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (authLoading || !user) { setData(EMPTY); setError('Sign in to view your stores.'); setState('error'); return }
    setState('loading')
    setError('')
    try { setData(await shopwatchRequest<ShopwatchData>('/api/shopwatch/owner-data')); setState('success') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'We could not load your stores.'); setState('error') }
  }, [authLoading, user])

  useEffect(() => {
    if (authLoading) return
    if (!user) { setData(EMPTY); setError('Sign in to view your stores.'); setState('error'); return }
    void load()
  }, [authLoading, user, load])

  const checkNow = useCallback(async (storeId: string, refreshBaseline = false) => {
    setCheckingId(storeId)
    try {
      const result = await shopwatchRequest<{ baseline_saved?: boolean }>('/api/shopwatch/run-check', { method: 'POST', body: JSON.stringify({ store_id: storeId, refresh_baseline: refreshBaseline }) })
      await load()
      if (result.baseline_saved) setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'We could not check this store.')
      setState('error')
    } finally { setCheckingId(null) }
  }, [load])

  const addStore = useCallback(async (storeUrl: string) => {
    const result = await shopwatchRequest<{ store: ShopStore }>('/api/shopwatch/add-store', { method: 'POST', body: JSON.stringify({ store_url: storeUrl }) })
    await load()
    if (result.store?.id) await checkNow(result.store.id, true)
  }, [load, checkNow])

  const attentionCount = useMemo(() => data.stores.filter((store) => store.status === 'broken' || store.status === 'needs_attention').length, [data.stores])
  const history = useMemo(() => {
    const names = new Map(data.stores.map((store) => [store.id, store.store_name || store.store_url]))
    const alerts = data.alerts.map((alert) => ({ key: `alert-${alert.id}`, time: alert.created_at, label: alert.title, note: alert.message, status: alert.severity, store: names.get(alert.store_id) }))
    const checks = data.checks.slice(0, 10).map((check) => ({ key: `check-${check.id}`, time: check.checked_at, label: check.summary, note: '', status: check.status, store: names.get(check.store_id) }))
    return [...alerts, ...checks].filter((item) => item.store).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 8)
  }, [data])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main id="main-content" className="mx-auto max-w-7xl px-4 py-8 sm:px-8 sm:py-12">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div><p className="text-sm font-semibold uppercase tracking-[0.12em] text-muted-foreground">Store owner view</p><h1 className="mt-2 font-display text-4xl font-extrabold tracking-tight sm:text-5xl">Your stores, watched.</h1><p className="mt-3 max-w-2xl text-lg text-muted-foreground">A clear view of storefront health, recent checks, and anything that deserves your attention.</p></div>
          <p className="text-sm text-muted-foreground">Signed in as <span className="font-semibold text-foreground">{user?.email || 'your account'}</span></p>
        </div>

        {state === 'error' && <div role="alert" className="mt-6 flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm text-destructive">{error}</p>{user && <Button type="button" variant="outline" onClick={() => void load()}>Try again</Button>}</div>}
        {state === 'loading' && <p role="status" className="mt-8 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Loading your store list…</p>}

        {state === 'success' && <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <section className="min-w-0 rounded-2xl border border-border bg-card p-5"><p className="text-sm text-muted-foreground">Stores monitored</p><p className="mt-2 font-display text-4xl font-extrabold tabular-nums">{data.stores.length}</p></section>
          <section className="min-w-0 rounded-2xl border border-border bg-card p-5"><div className="flex items-center gap-2 text-sm text-muted-foreground"><AlertCircle aria-hidden="true" className="h-4 w-4" />Needs attention</div><p className="mt-2 font-display text-4xl font-extrabold tabular-nums">{attentionCount}</p><p className="mt-1 text-xs text-muted-foreground">Each store also has a written status label.</p></section>
          <section className="min-w-0 rounded-2xl border border-border bg-card p-5"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Clock3 aria-hidden="true" className="h-4 w-4" />Checks recorded</div><p className="mt-2 font-display text-4xl font-extrabold tabular-nums">{data.checks.length}</p></section>
        </div>}

        <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-12">
          <div className="min-w-0 space-y-7 lg:col-span-7">
            <StoreForm onAdd={addStore} disabled={state !== 'success'} />
            <section aria-labelledby="stores-heading" className="space-y-4"><div className="flex items-center justify-between gap-4"><div><h2 id="stores-heading" className="font-display text-2xl font-bold">Monitored stores</h2><p className="mt-1 text-sm text-muted-foreground">Open a store to see its history, starting point and settings.</p></div><Button type="button" variant="ghost" size="sm" onClick={() => void load()}>Refresh list</Button></div>{state === 'success' && <StoreList stores={data.stores} onCheck={checkNow} checkingId={checkingId} />}</section>
            {data.stores.length > 0 && <p className="rounded-xl border border-border bg-muted/50 p-4 text-sm leading-relaxed text-muted-foreground"><ShieldCheck aria-hidden="true" className="mr-2 inline h-4 w-4 text-accent" />Checks visit public storefront pages and use a temporary cart test only. They do not place an order.</p>}
          </div>

          <aside className="min-w-0 space-y-6 lg:col-span-5">
            <section className="rounded-2xl border border-border bg-card p-5 sm:p-6" aria-labelledby="timeline-heading"><div className="flex items-start justify-between gap-4"><div><h2 id="timeline-heading" className="font-display text-xl font-bold">Recent activity</h2><p className="mt-1 text-sm text-muted-foreground">Checks and alerts from your stores.</p></div><span className="rounded-lg bg-muted p-2 text-muted-foreground"><Clock3 aria-hidden="true" className="h-4 w-4" /></span></div>{state === 'success' && !history.length ? <div className="mt-5 rounded-xl bg-background p-4"><p className="text-sm font-semibold">No check history yet</p><p className="mt-1 text-sm text-muted-foreground">Add a store to save its first starting point.</p></div> : <ol className="mt-5 space-y-0">{history.map((event) => <li key={event.key} className="relative border-l border-border pb-5 pl-5 last:pb-0"><span aria-hidden="true" className={`absolute -left-1.5 top-1 h-3 w-3 rounded-full border-2 border-card ${event.status === 'healthy' ? 'bg-accent' : 'bg-primary'}`} /><p className="text-sm font-semibold">{event.label}</p><p className="mt-1 text-xs text-muted-foreground">{event.store} · {formatMoment(event.time)}</p><StatusPill status={event.status} />{event.note && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{event.note}</p>}<Button asChild variant="link" className="mt-1 h-auto px-0 py-1"><Link to={`/dashboard/store/${encodeURIComponent(data.stores.find((store) => (store.store_name || store.store_url) === event.store)?.id || '')}`}>Open store <ArrowRight aria-hidden="true" className="ml-1 h-3.5 w-3.5" /></Link></Button></li>)}</ol>}</section>
            <section className="rounded-2xl border border-accent/20 bg-accent/5 p-5"><h2 className="font-display text-lg font-bold">How the starting point works</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">The first check records a comparison point. After an intentional redesign, open a store and refresh its starting point so expected content changes don’t keep appearing in the comparison.</p></section>
          </aside>
        </div>
      </main>
    </div>
  )
}