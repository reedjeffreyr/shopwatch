import { statusClass, statusLabel } from '@/lib/shopwatch'

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex min-h-7 items-center rounded-full border px-3 py-1 text-xs font-semibold ${statusClass(status)}`}>
      <span aria-hidden="true" className="mr-2 h-1.5 w-1.5 rounded-full bg-current" />
      {statusLabel(status)}
    </span>
  )
}