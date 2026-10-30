import { useState, type FormEvent } from 'react'
import { Plus, Store } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function StoreForm({ onAdd, disabled }: { onAdd: (storeUrl: string) => Promise<void>; disabled?: boolean }) {
  const [storeUrl, setStoreUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try { await onAdd(storeUrl.trim()); setStoreUrl('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'We could not add that store. Please check the URL and try again.') }
    finally { setSubmitting(false) }
  }
  return (
    <form onSubmit={submit} className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Store aria-hidden="true" className="h-5 w-5" /></span><div><h2 className="font-display text-xl font-bold">Add a storefront</h2><p className="mt-1 text-sm text-muted-foreground">Use its public HTTPS address. We’ll check it once and save today’s starting point.</p></div></div>
      <label htmlFor="shop-url" className="mt-5 block text-sm font-semibold">Storefront URL</label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row"><Input id="shop-url" type="url" inputMode="url" autoComplete="url" className="min-h-11 text-base md:text-sm" placeholder="https://your-store.com" value={storeUrl} onChange={(event) => setStoreUrl(event.target.value)} required aria-describedby={error ? 'shop-url-error' : undefined} /><Button type="submit" disabled={disabled || submitting} className="min-h-11 shrink-0 gap-2"><Plus aria-hidden="true" className="h-4 w-4" />{submitting ? 'Adding store…' : 'Add store'}</Button></div>
      {error && <p id="shop-url-error" role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </form>
  )
}