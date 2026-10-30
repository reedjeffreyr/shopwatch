import React from 'react';
import { Button } from "@/components/ui/button";
import { useNavigate, useLocation } from "react-router-dom";
import { useEffect } from "react";

export default function NotFound() {
  const navigate = useNavigate();
  const location = useLocation();

  // Report 404 to parent window (editor) if in iframe
  useEffect(() => {
    const isInIframe = window.self !== window.top;

    if (isInIframe) {
      try {
        window.parent.postMessage({
          type: 'route_not_found',
          source: 'overskill-app',
          data: {
            path: location.pathname,
            fullUrl: window.location.href,
            search: location.search,
            timestamp: new Date().toISOString()
          }
        }, '*');

        console.log('[NotFound] Reported 404 to parent for path:', location.pathname);
      } catch (e) {
        console.error('[NotFound] Failed to report to parent:', e);
      }
    }
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">404</h1>
        <p className="text-xl text-muted-foreground">Page not found</p>
        <Button onClick={() => navigate("/")} variant="outline">
          Go Home
        </Button>
      </div>
    </div>
  );
}
