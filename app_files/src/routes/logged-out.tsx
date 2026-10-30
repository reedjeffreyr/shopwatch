// Logged Out Confirmation Page
// Shows clear "logged out successfully" state after user signs out
// Provides explicit "Sign In Again" button (no auto-redirect)
//
// NOTE: Uses semantic design tokens (bg-background, text-foreground, etc.)
// so this page automatically adapts to theme changes via the Theme Editor.

import React from 'react';
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export default function LoggedOut() {
  const navigate = useNavigate()
  const appName = import.meta.env.VITE_APP_NAME || 'App'
  const platformUrl = import.meta.env.VITE_PLATFORM_URL || 'https://www.overskill.com'

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full">
        <div className="bg-card rounded-xl shadow-2xl p-8 text-center border border-border">
          {/* Success Icon - intentionally green (universal success indicator) */}
          <div className="w-20 h-20 bg-gradient-to-br from-green-400 to-green-600 rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg">
            <svg
              className="w-10 h-10 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>

          {/* Heading */}
          <h1 className="text-2xl font-bold text-foreground mb-3">
            Successfully Logged Out
          </h1>

          {/* Message */}
          <p className="text-muted-foreground mb-8">
            You have been securely logged out of <span className="font-semibold text-foreground">{appName}</span>.
            Your data is safe and secure.
          </p>

          {/* Action Buttons */}
          <div className="space-y-3">
            <Button
              onClick={() => navigate('/login')}
              className="w-full font-medium py-3 rounded-lg shadow-lg hover:shadow-xl transition-all"
            >
              <svg className="w-5 h-5 mr-2 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
              </svg>
              Sign In Again
            </Button>

            <a
              href="/"
              className="block w-full py-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              or return to home page
            </a>
          </div>

          {/* Info Note */}
          <div className="mt-8 pt-6 border-t border-border">
            <p className="text-xs text-muted-foreground">
              You are still logged into OverSkill. To sign out completely,
              visit <a href={`${platformUrl}/account`} className="text-primary hover:underline">your OverSkill account</a>.
            </p>
          </div>
        </div>

        {/* Additional Info */}
        <div className="mt-4 text-center">
          <p className="text-sm text-muted-foreground">
            Questions? <a href="mailto:support@overskill.com" className="text-primary hover:underline">Contact Support</a>
          </p>
        </div>
      </div>
    </div>
  )
}
