import type { StoreCheck } from '@/lib/shopwatch'

type Result = { label: string; value: string; problem?: boolean }

function httpResult(label: string, code?: number): Result {
  const value = Number(code)
  if (!value) return { label, value: 'Not checked' }
  return { label, value: value >= 400 ? `HTTP ${value} — issue` : `HTTP ${value}`, problem: value >= 400 }
}

export function CheckResults({ check }: { check: StoreCheck }) {
  const addResult: Result = check.add_to_cart_status === 'working'
    ? { label: 'Add to cart', value: 'Working' }
    : check.add_to_cart_status === 'failed'
      ? { label: 'Add to cart', value: 'Failed', problem: true }
      : { label: 'Add to cart', value: 'Not checked' }
  const results = [
    httpResult('Homepage', check.homepage_status),
    httpResult('Collection', check.collection_status),
    httpResult('Product', check.product_status),
    httpResult('Cart', check.cart_status),
    httpResult('Checkout', check.checkout_status),
    addResult,
    { label: 'Homepage response', value: Number(check.load_ms) > 0 ? `${check.load_ms} ms` : 'Not checked' },
  ]

  return (
    <div className="mt-4 rounded-lg border border-border bg-card p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Shopper-path checks</h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3">
        {results.map((result) => (
          <div key={result.label} className="min-w-0">
            <dt className="truncate text-xs text-muted-foreground">{result.label}</dt>
            <dd className={`mt-0.5 break-words text-sm font-semibold tabular-nums ${result.problem ? 'text-destructive' : 'text-foreground'}`}>{result.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}