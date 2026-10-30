import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Clock3, Shield, Store, ScanSearch } from 'lucide-react'
import AppBrand from '@/components/AppBrand'
import { Button } from '@/components/ui/button'

const promises = [
  'Home, collection, product, cart and checkout paths',
  'A saved starting point to compare against',
  'Clear alerts when something needs attention',
]

function PreviewStatus({ label, status }: { label: string; status: string }) {
  const good = status === 'All good'
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/70 py-3 last:border-0">
      <span className="text-sm text-foreground">{label}</span>
      <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold ${good ? 'border-accent/30 bg-accent/10 text-accent' : 'border-primary/30 bg-primary/10 text-primary'}`}>
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />{status}
      </span>
    </div>
  )
}

export default function Index() {
  useEffect(() => {
    const priorTitle = document.title
    const description = document.querySelector("meta[name='description']")
    const priorDescription = description?.getAttribute('content')
    document.title = 'Shopwatch — Catch storefront breakage before lost sales'
    description?.setAttribute('content', 'Monitor your Shopify storefront’s key pages, save a known-good starting point, and get plain-language alerts when something needs attention.')
    return () => {
      document.title = priorTitle
      if (priorDescription !== null && description) description.setAttribute('content', priorDescription)
    }
  }, [])

  return (
    <div className="min-h-screen overflow-hidden bg-background text-foreground">
      <header className="border-b border-border/80 bg-background/90">
        <nav aria-label="Main navigation" className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <AppBrand name="Shopwatch" icon={<Shield aria-hidden="true" className="h-5 w-5" />} className="flex items-center gap-3" />
          <Button asChild variant="outline" className="min-h-11 px-5">
            <Link to="/login">Sign in</Link>
          </Button>
        </nav>
      </header>

      <main>
        <section className="relative mx-auto grid max-w-7xl items-center gap-12 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-12 lg:gap-8 lg:py-24">
          <div aria-hidden="true" className="pointer-events-none absolute -right-32 top-8 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative z-10 lg:col-span-7">
            <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <Store aria-hidden="true" className="h-4 w-4 text-accent" /> A steady second set of eyes on your store
            </p>
            <h1 data-element-id="hero-heading" className="max-w-3xl font-display text-5xl font-extrabold leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
              Find the break <span className="text-primary">before</span> your customers do.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
              Shopwatch checks the important paths through your storefront and tells you, in plain language, when something no longer looks right.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="min-h-12 gap-2 px-6 active:scale-[0.96] transition-transform">
                <Link to="/login">Create your account <ArrowRight aria-hidden="true" className="h-4 w-4" /></Link>
              </Button>
              <a href="#how-it-works" className="inline-flex min-h-12 items-center justify-center rounded-md border border-border bg-card px-6 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">See what gets checked</a>
            </div>
            <ul className="mt-8 grid gap-3 text-sm text-muted-foreground sm:grid-cols-1">
              {promises.map((item) => <li key={item} className="flex items-start gap-2"><Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent" /><span>{item}</span></li>)}
            </ul>
          </div>

          <aside aria-label="Example store health dashboard" className="relative z-10 min-w-0 lg:col-span-5 lg:translate-y-6">
            <div className="absolute -right-3 -top-4 hidden h-16 w-16 place-items-center rounded-2xl border border-border bg-card text-accent shadow-sm sm:grid"><ScanSearch aria-hidden="true" className="h-7 w-7" /></div>
            <div className="rounded-2xl border border-border bg-card p-5 shadow-xl sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Store health</p><h2 className="mt-2 truncate font-display text-2xl font-bold">Your storefront</h2><p className="mt-1 truncate text-sm text-muted-foreground">example-store.myshopify.com</p></div>
                <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />All good</span>
              </div>
              <div className="mt-6 rounded-xl border border-border bg-background px-4">
                <PreviewStatus label="Homepage" status="All good" />
                <PreviewStatus label="Collection page" status="All good" />
                <PreviewStatus label="Product page" status="All good" />
                <PreviewStatus label="Cart & checkout" status="All good" />
              </div>
              <div className="mt-5 flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                <Clock3 aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
                <div><p className="text-sm font-semibold">A change worth a closer look</p><p className="mt-1 text-sm text-muted-foreground">“The add-to-cart button stopped responding after a storefront change.”</p></div>
              </div>
              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Illustrative preview. Connect a store to save its starting point and begin checks.</p>
            </div>
          </aside>
        </section>

        <section id="how-it-works" className="border-y border-border bg-card">
          <div className="mx-auto grid max-w-7xl gap-10 px-5 py-14 sm:px-8 md:grid-cols-3 md:gap-8 md:py-20">
            <article className="min-w-0"><p className="font-display text-sm font-bold uppercase tracking-widest text-primary">01 / Save</p><h2 className="mt-3 font-display text-2xl font-bold">Start with how it looks today</h2><p className="mt-3 leading-relaxed text-muted-foreground">Add your storefront and save a known-good starting point. Refresh it after changes you meant to make.</p></article>
            <article className="min-w-0 md:translate-y-8"><p className="font-display text-sm font-bold uppercase tracking-widest text-accent">02 / Check</p><h2 className="mt-3 font-display text-2xl font-bold">Follow the shopper’s path</h2><p className="mt-3 leading-relaxed text-muted-foreground">Review the homepage, collection, a product, cart and checkout route without placing an order.</p></article>
            <article className="min-w-0"><p className="font-display text-sm font-bold uppercase tracking-widest text-muted-foreground">03 / Explain</p><h2 className="mt-3 font-display text-2xl font-bold">Know what needs a look</h2><p className="mt-3 leading-relaxed text-muted-foreground">Get a readable alert with the affected page and a clear way to request help.</p></article>
          </div>
        </section>

        <section className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-14 sm:px-8 sm:py-20 md:flex-row md:items-center md:justify-between">
          <div className="max-w-2xl"><p className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Made for the moments between launches</p><h2 className="mt-3 font-display text-3xl font-bold sm:text-4xl">Spend less time wondering if the store still works.</h2><p className="mt-3 text-lg text-muted-foreground">Bring your storefront into Shopwatch and keep its important paths visible in one calm dashboard.</p></div>
          <Button asChild size="lg" className="min-h-12 shrink-0 gap-2 px-6"><Link to="/login">Add a store <ArrowRight aria-hidden="true" className="h-4 w-4" /></Link></Button>
        </section>
      </main>
      <footer className="border-t border-border"><div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8"><span>Shopwatch · Storefront checks, clear follow-up.</span><span>Designed to explain the issue, not amplify the panic.</span></div></footer>
    </div>
  )
}