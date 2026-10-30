import { Link, useNavigate } from 'react-router-dom'
import { useAuth, overskill } from '@/lib/auth'
import AppBrand from '@/components/AppBrand'
import { Button } from '@/components/ui/button'
import { Settings } from 'lucide-react'

export function ShopHeader({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const logout = async () => {
    await overskill.auth.logout()
    navigate('/logged-out')
  }
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link to={admin ? '/admin' : '/dashboard'} className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <AppBrand name="Shopwatch" icon={<span data-app-icon className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Settings aria-hidden="true" className="h-5 w-5" /></span>} className="flex items-center gap-3" />
          {admin && <span className="hidden rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground sm:inline-flex">Admin</span>}
        </Link>
        <nav aria-label="Account navigation" className="flex items-center gap-2 sm:gap-3">
          <span className="hidden max-w-48 truncate text-sm text-muted-foreground md:inline">{user?.email}</span>
          {admin && <Button asChild variant="ghost" size="sm"><Link to="/dashboard">My stores</Link></Button>}
          {!admin && <Button asChild variant="ghost" size="sm"><Link to="/admin">Admin</Link></Button>}
          <Button asChild variant="outline" size="sm"><Link to="/settings">Settings</Link></Button>
          <Button type="button" variant="ghost" size="sm" onClick={logout}>Log out</Button>
        </nav>
      </div>
    </header>
  )
}