// AuthHeader - User profile dropdown with avatar
// Shows logged-in user with dropdown menu for profile actions

import React from 'react';
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { overskill } from '@/lib/auth'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { User, Settings, LogOut } from 'lucide-react'

interface UserData {
  email: string
  name?: string
  image?: string | null
}

export function AuthHeader() {
  const [user, setUser] = useState<UserData | null>(null)
  const navigate = useNavigate()

  // Auto-hide for public apps (landing pages, marketing sites, etc.)
  // Only show for apps that require authentication
  const visibility = import.meta.env.VITE_APP_VISIBILITY || 'public'

  useEffect(() => {
    if (visibility === 'public') return

    overskill.auth.checkSession()
      .then(u => setUser(u))
      .catch(() => setUser(null))
  }, [visibility])

  // Public apps don't need auth UI
  if (visibility === 'public') {
    return null
  }

  if (!user) return null

  // Generate initials from name or email
  const initials = user.name
    ?.split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || user.email[0].toUpperCase()

  const handleLogout = async () => {
    await overskill.auth.logout()
    // Use React Router navigate (SPA) instead of window.location.href (full page reload)
    navigate('/logged-out')
  }

  const handleProfile = () => {
    navigate('/profile')
  }

  const handleSettings = () => {
    navigate('/settings')
  }

  return (
    <div className="fixed top-4 right-4 z-50">
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-2 outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-full">
          <Avatar className="h-9 w-9 cursor-pointer ring-2 ring-background shadow-md hover:ring-primary/20 transition-all">
            <AvatarImage src={user.image ?? undefined} alt={user.name || user.email} />
            <AvatarFallback className="bg-gradient-to-br from-blue-500 to-purple-600 text-white text-sm font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium leading-none">
                {user.name || 'User'}
              </p>
              <p className="text-xs leading-none text-muted-foreground">
                {user.email}
              </p>
            </div>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={handleProfile} className="cursor-pointer">
            <User className="mr-2 h-4 w-4" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleSettings} className="cursor-pointer">
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={handleLogout}
            className="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
