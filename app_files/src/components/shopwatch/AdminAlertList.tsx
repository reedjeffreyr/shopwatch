import { ExternalLink } from 'lucide-react'
import { StatusPill } from '@/components/shopwatch/StatusPill'
import type { ShopStore, StoreAlert } from '@/lib/shopwatch'
import { formatMoment } from '@/lib/shopwatch'

export function AdminAlertList({ alerts, stores }: { alerts: StoreAlert[]; stores: ShopStore[] }) {
  const storeById = new Map(stores.map((store) => [String(store.id), store]))
  if (!alerts.length) return <div className="mt-5 rounded-xl bg-background p-4"><p className="text-sm font-semibold">No alerts recorded</p><p className="mt-1 text-sm text-muted-foreground">Alerts from all monitored stores will appear here.</p></div>

  return (
    <ol className="mt-5 space-y-3">
      {alerts.map((alert) => {
        const store = storeById.get(String(alert.store_id))
        return (
          <li key={alert.id} className="min-w-0 rounded-xl border border-border bg-background p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-semibold">{alert.title}</p><p className="mt-1 truncate text-sm text-muted-foreground">{store?.store_name || store?.store_url || 'Store'} · {store?.owner_email || 'Owner unavailable'}</p></div>
              <StatusPill status={alert.severity} />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-foreground">{alert.message}</p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{formatMoment(alert.created_at)} · {alert.status.replace('_', ' ')}</span>{store?.store_url && <a href={store.store_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 font-semibold text-accent underline underline-offset-4">Open storefront <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></a>}</div>
            {alert.screenshot_url && <a href={alert.screenshot_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block"><img src={alert.screenshot_url} alt={`Storefront captured with alert: ${alert.title}`} loading="lazy" className="aspect-[16/9] w-full rounded-lg border border-border object-cover" /></a>}
          </li>
        )
      })}
    </ol>
  )
}