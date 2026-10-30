import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Camera, RefreshCw, Send, Settings2 } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ShopHeader } from '@/components/shopwatch/ShopHeader'
import { StatusPill } from '@/components/shopwatch/StatusPill'
import { CheckResults } from '@/components/shopwatch/CheckResults'
import type { ShopStore, ShopwatchData, StoreCheck } from '@/lib/shopwatch'
import { formatMoment, parseIssues, shopwatchRequest } from '@/lib/shopwatch'
import { toast } from 'sonner'

type LoadState = 'loading' | 'success' | 'error'
export default function StoreDetail() {
  const { storeId = '' } = useParams()
  const { user, loading: authLoading } = useAuth()
  const [data, setData] = useState<ShopwatchData>({ stores: [], checks: [], alerts: [], fix_requests: [] })
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [alertEmail, setAlertEmail] = useState('')
  const [ignoredTerms, setIgnoredTerms] = useState('')
  const [summary, setSummary] = useState('')

  const load = useCallback(async () => {
    if (authLoading || !user) { setState('error'); setError('Sign in to view this store.'); return }
    setState('loading'); setError('')
    try {
      const result = await shopwatchRequest<ShopwatchData>('/api/shopwatch/owner-data')
      setData(result)
      const store = result.stores.find((row) => String(row.id) === storeId)
      if (!store) { setError('This store is not connected to your account.'); setState('error'); return }
      setAlertEmail(store.alert_email || store.owner_email)
      setIgnoredTerms(store.ignored_terms || '')
      setState('success')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'We could not load this store.'); setState('error') }
  }, [authLoading, user, storeId])

  useEffect(() => { if (authLoading) return; if (!user) { setState('error'); setError('Sign in to view this store.'); return }; void load() }, [authLoading, user, load])
  const store: ShopStore | undefined = data.stores.find((row) => String(row.id) === storeId)
  const checks = useMemo(() => data.checks.filter((check) => String(check.store_id) === storeId).sort((a, b) => new Date(b.checked_at).getTime() - new Date(a.checked_at).getTime()), [data.checks, storeId])
  const alerts = useMemo(() => data.alerts.filter((alert) => String(alert.store_id) === storeId), [data.alerts, storeId])

  async function runCheck(refresh = false) {
    if (!store) return
    if (refresh && !window.confirm('Save this visit as the new starting point for future comparisons?')) return
    setRunning(true)
    try {
      const result = await shopwatchRequest<{ summary: string; baseline_saved?: boolean }>('/api/shopwatch/run-check', { method: 'POST', body: JSON.stringify({ store_id: store.id, refresh_baseline: refresh }) })
      setSummary(result.summary)
      await load()
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : 'We could not check this store.') }
    finally { setRunning(false) }
  }

  async function requestHelp() {
    if (!store) return
    setRequesting(true)
    try {
      const latestAlert = alerts.find((alert) => alert.status === 'open')
      const latestCheck = checks[0]
      const issue = latestAlert?.message || latestCheck?.summary || 'Please review this storefront.'
      const result = await shopwatchRequest<{ email_accepted: boolean; email_error?: string }>('/api/shopwatch/fix-request', { method: 'POST', body: JSON.stringify({ store_id: store.id, issue_summary: issue }) })
      toast.success(result.email_accepted ? 'Fix request sent for review.' : 'Fix request saved. Email notification was not accepted; we will retry from the admin dashboard.')
      await load()
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : 'We could not send your fix request.') }
    finally { setRequesting(false) }
  }

  async function saveSettings() {
    if (!store) return
    setSaving(true)
    try {
      await shopwatchRequest('/api/shopwatch/store-settings', { method: 'PATCH', body: JSON.stringify({ store_id: store.id, alert_email: alertEmail, ignored_terms: ignoredTerms }) })
      toast.success('Store settings saved.')
      await load()
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : 'We could not save these settings.') }
    finally { setSaving(false) }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ShopHeader />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8 sm:py-12">
        <Link to="/dashboard" className="inline-flex min-h-10 items-center gap-2 rounded-md text-sm font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft aria-hidden="true" className="h-4 w-4" />All stores</Link>
        {state === 'loading' && <p role="status" className="mt-6 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Loading store details…</p>}
        {state === 'error' && <div role="alert" className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-5"><p className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" className="mt-3" onClick={() => void load()}>Try again</Button></div>}
        {state === 'success' && store && <>
          <header className="mt-6 flex flex-col justify-between gap-5 border-b border-border pb-6 sm:flex-row sm:items-end"><div className="min-w-0"><p className="text-sm font-semibold uppercase tracking-[0.12em] text-muted-foreground">Store details</p><h1 className="mt-2 truncate font-display text-3xl font-extrabold sm:text-5xl">{store.store_name || store.baseline_title || 'Your storefront'}</h1><a href={store.store_url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex max-w-full truncate text-sm text-accent underline underline-offset-4">{store.store_url}</a><div className="mt-3 flex flex-wrap items-center gap-3"><StatusPill status={store.status} /><span className="text-xs text-muted-foreground">Last checked {formatMoment(store.last_checked_at)}</span></div></div><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={running} onClick={() => void runCheck(false)} className="min-h-11 gap-2"><RefreshCw aria-hidden="true" className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />{running ? 'Checking…' : 'Check now'}</Button><Button type="button" disabled={running} onClick={() => void runCheck(true)} className="min-h-11 gap-2"><Camera aria-hidden="true" className="h-4 w-4" />Refresh starting point</Button></div></header>
          {summary && <p role="status" className="mt-4 rounded-xl border border-accent/20 bg-accent/5 p-4 text-sm text-foreground">{summary}</p>}

          <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-12">
            <div className="min-w-0 space-y-8 lg:col-span-7">
              <section aria-labelledby="baseline-heading" className="rounded-2xl border border-border bg-card p-5 sm:p-6"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Camera aria-hidden="true" className="h-5 w-5" /></span><div><h2 id="baseline-heading" className="font-display text-xl font-bold">Saved starting point</h2><p className="text-sm text-muted-foreground">The reference used for change comparisons.</p></div></div>{store.baseline_screenshot_url ? <img src={store.baseline_screenshot_url} alt={`Saved storefront screenshot for ${store.store_name || store.store_url}`} loading="lazy" className="mt-5 aspect-[16/9] w-full rounded-xl border border-border object-cover" /> : <div className="mt-5 grid aspect-[16/9] place-items-center rounded-xl border border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">A screenshot will appear after the first successful capture.</div>}<p className="mt-3 text-sm text-muted-foreground">{store.baseline_title ? `Page title: ${store.baseline_title}` : 'Starting point has not been saved yet.'}</p><Button type="button" variant="outline" disabled={running} onClick={() => void runCheck(true)} className="mt-4 min-h-10">Save this visit as the starting point</Button></section>

              <section aria-labelledby="check-history-heading" className="rounded-2xl border border-border bg-card p-5 sm:p-6"><h2 id="check-history-heading" className="font-display text-xl font-bold">Check history</h2>{checks.length === 0 ? <p className="mt-4 rounded-xl bg-background p-4 text-sm text-muted-foreground">No checks have been recorded yet.</p> : <ol className="mt-4 space-y-4">{checks.map((check: StoreCheck) => <li key={check.id} className="min-w-0 rounded-xl border border-border bg-background p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold">{check.summary}</p><p className="mt-1 text-xs text-muted-foreground">{formatMoment(check.checked_at)}</p></div><StatusPill status={check.status} /></div>{parseIssues(check).length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{parseIssues(check).map((item, index) => <li key={`${check.id}-${index}`}>{item}</li>)}</ul>}{<CheckResults check={check} />} {check.screenshot_url && <img src={check.screenshot_url} alt={`Storefront screenshot captured ${formatMoment(check.checked_at)}`} loading="lazy" className="mt-4 aspect-[16/9] w-full rounded-lg border border-border object-cover" />}</li>)}</ol>}</section>
            </div>

            <aside className="min-w-0 space-y-6 lg:col-span-5">
              <section className="rounded-2xl border border-primary/25 bg-primary/5 p-5 sm:p-6"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Need another set of hands?</p><h2 className="mt-2 font-display text-2xl font-bold">Ask for help fixing this</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">We’ll include this store, the latest issue we found, and your account email in a fix request for the Shopwatch admin.</p><Button type="button" disabled={requesting || running} onClick={() => void requestHelp()} className="mt-5 min-h-11 w-full gap-2"><Send aria-hidden="true" className="h-4 w-4" />{requesting ? 'Sending request…' : 'Get help fixing this'}</Button></section>

              <section className="rounded-2xl border border-border bg-card p-5 sm:p-6"><div className="flex items-center gap-2"><Settings2 aria-hidden="true" className="h-5 w-5 text-accent" /><h2 className="font-display text-xl font-bold">Alert preferences</h2></div><p className="mt-1 text-sm text-muted-foreground">Choose where alerts go and what content should be ignored.</p><div className="mt-5 space-y-4"><div className="space-y-2"><Label htmlFor="alert-email">Alert email</Label><Input id="alert-email" type="email" autoComplete="email" className="min-h-11 text-base md:text-sm" value={alertEmail} onChange={(event) => setAlertEmail(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="ignored-terms">Ignore changing text</Label><Textarea id="ignored-terms" className="min-h-24 text-base md:text-sm" placeholder="One phrase per line, e.g. rotating offer text" value={ignoredTerms} onChange={(event) => setIgnoredTerms(event.target.value)} /><p className="text-xs text-muted-foreground">These phrases are excluded from homepage text comparisons and the starting-point layout checks. HTTP errors, broken images, links, and cart failures are still reported.</p></div><Button type="button" variant="outline" disabled={saving} onClick={() => void saveSettings()} className="min-h-11 w-full">{saving ? 'Saving…' : 'Save preferences'}</Button></div></section>
            </aside>
          </div>
        </>}
      </main>
    </div>
  )
}