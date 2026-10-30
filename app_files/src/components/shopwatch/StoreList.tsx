import { Link } from 'react-router-dom'
import { ArrowUpRight, Clock3, Globe, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ShopStore } from '@/lib/shopwatch'
import { formatMoment } from '@/lib/shopwatch'
import { StatusPill } from '@/components/shopwatch/StatusPill'

export function StoreList({ stores, onCheck, checkingId }: { stores: ShopStore[]; onCheck: (storeId: string, refresh?: boolean) => void; checkingId: string | null }) {
  if (!stores.length) return <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center"><Globe aria-hidden="true" className="mx-auto h-8 w-8 text-muted-foreground" /><h3 className="mt-3 font-display text-xl font-bold">No stores connected yet</h3><p className="mt-2 text-sm text-muted-foreground">Add a public Shopify storefront to save its starting point and see its current status here.</p></div>
  return (
    <ul className="space-y-3" aria-label="Monitored stores">
      {stores.map((store) => (
        <li key={store.id} className="min-w-0 rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-muted/40 sm:p-5">
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Link to={`/dashboard/store/${encodeURIComponent(store.id)}`} className="min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex min-w-0 items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><Globe aria-hidden="true" className="h-5 w-5" /></span><div className="min-w-0"><h3 className="truncate font-display text-lg font-bold">{store.store_name || store.store_url}</h3><p className="truncate text-sm text-muted-foreground">{store.store_url}</p><div className="mt-2 flex flex-wrap items-center gap-3"><StatusPill status={store.status} /><span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 aria-hidden="true" className="h-3.5 w-3.5" />Checked {formatMoment(store.last_checked_at)}</span></div></div></div>
            </Link>
            <div className="flex shrink-0 items-center gap-2 sm:justify-end"><Button type="button" size="sm" variant="outline" disabled={checkingId === store.id} onClick={() => onCheck(store.id)} className="min-h-10 gap-2"> <RefreshCw aria-hidden="true" className={`h-4 w-4 ${checkingId === store.id ? 'animate-spin' : ''}`} />{checkingId === store.id ? 'Checking' : 'Check now'}</Button><Button asChild type="button" variant="ghost" size="icon" aria-label={`Open ${store.store_name || store.store_url}`}><Link to={`/dashboard/store/${encodeURIComponent(store.id)}`}><ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link></Button></div>
          </div>
        </li>
      ))}
    </ul>
  )
}